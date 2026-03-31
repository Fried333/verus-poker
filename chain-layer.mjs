/**
 * Chain Layer — connects the poker server to the CHIPS blockchain
 * Handles: deposits, balance tracking, on-chain verification, settlement
 *
 * Usage: import and pass to poker-server as the chain backend
 */

import { createClient } from './verus-rpc.mjs';
import { createEscrow } from './escrow.mjs';
import { createCashierNode } from './cashier-node.mjs';
import { verifyGame } from './protocol.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const DEALER_ADDR = 'RDGUMRNth3VTdBvkLRCsseHa6VajCjB949';

const CASHIER_NODES = [
  { id: 'poker-cn1', addr: 'RGK7nWZX1dwJYpqmK7YnSBuExWwCoskhLu' },
  { id: 'poker-cn2', addr: 'RCGLeG88wArw5ins9LaEmYTtiN8v2t8Pat' }
];

// Known player addresses (registered on CHIPS chain)
const PLAYER_ADDRS = {
  'poker-p1': 'RN2hEjcQ1EcmGGfkGD4JCDNyfT571Eqz64',
  'poker-p2': 'RECGjSHtaiZ92s3TUtyw3F9kqevwdJ7MtB',
  'poker-p3': 'RYZLdqYRsgPrTV7cUqTBDqBt8GJErReBG7',
};

const RAKE_PERCENT = 2.5;

export function createChainLayer(options = {}) {
  const client = createClient(RPC);
  let escrow = null;
  let cn1 = null, cn2 = null;
  let sessionBalances = new Map(); // playerId → CHIPS balance
  let handHistory = [];            // verified hand results
  let ready = false;

  const layer = {
    /**
     * Initialize: create multisig, set up cashier nodes
     */
    async init() {
      console.log('[CHAIN] Connecting to CHIPS daemon...');
      try {
        const info = await client.getInfo();
        console.log('[CHAIN] Chain: ' + info.name + ' Block: ' + info.blocks);
      } catch (e) {
        console.log('[CHAIN] WARNING: Cannot connect to daemon: ' + e.message);
        console.log('[CHAIN] Running in offline mode (virtual chips only)');
        return false;
      }

      // Create escrow
      escrow = createEscrow(RPC, CASHIER_NODES);
      try {
        const msig = await escrow.createMultisig();
        console.log('[CHAIN] Multisig: ' + msig.address);
      } catch (e) {
        console.log('[CHAIN] Multisig error: ' + e.message);
        return false;
      }

      // Init cashier nodes
      cn1 = createCashierNode({ nodeId: 'poker-cn1', nodeAddr: CASHIER_NODES[0].addr });
      cn2 = createCashierNode({ nodeId: 'poker-cn2', nodeAddr: CASHIER_NODES[1].addr });
      console.log('[CHAIN] Cashier nodes ready (poker-cn1, poker-cn2)');

      ready = true;
      return true;
    },

    isReady() { return ready; },

    /**
     * Deposit: player sends CHIPS to multisig
     * Returns { ok, balance, txid } or { ok: false, error }
     */
    async deposit(playerId, amount) {
      if (!ready) return { ok: false, error: 'Chain not initialized' };

      const addr = PLAYER_ADDRS[playerId];
      if (!addr) return { ok: false, error: 'Unknown player: ' + playerId };

      const msigAddr = escrow.getAddress();
      console.log('[CHAIN] ' + playerId + ' depositing ' + amount + ' CHIPS to ' + msigAddr);

      try {
        const opid = await client.sendCurrency(addr, [{
          address: msigAddr,
          amount: amount
        }]);
        const result = await client.waitForOperation(opid, 30000);
        await escrow.recordDeposit(playerId, result.txid, amount);

        const balance = (sessionBalances.get(playerId) || 0) + amount;
        sessionBalances.set(playerId, balance);

        console.log('[CHAIN] ' + playerId + ' deposited. Balance: ' + balance + ' CHIPS. TX: ' + result.txid.substring(0, 16) + '...');
        return { ok: true, balance, txid: result.txid };
      } catch (e) {
        console.log('[CHAIN] Deposit failed: ' + e.message);
        return { ok: false, error: e.message };
      }
    },

    /**
     * Get player's session balance
     */
    getBalance(playerId) {
      return sessionBalances.get(playerId) || 0;
    },

    /**
     * Update balances after a hand
     */
    updateBalances(playerChips) {
      for (const [id, chips] of Object.entries(playerChips)) {
        sessionBalances.set(id, chips);
      }
    },

    /**
     * Verify a hand using cashier nodes (both must agree)
     */
    async verifyHand(handNum, playerData, dealerData, cashierData, numCards) {
      // Local verification first
      const localResult = verifyGame(playerData, dealerData, cashierData, numCards);

      if (!localResult.valid) {
        console.log('[CHAIN] Hand ' + handNum + ' LOCAL VERIFY FAILED: ' + localResult.errors.join(', '));
        handHistory.push({ hand: handNum, valid: false, errors: localResult.errors });
        return { valid: false, errors: localResult.errors };
      }

      // Cashier node verification
      if (cn1 && cn2) {
        try {
          const vote1 = await cn1.verifyHand(playerData, dealerData, cashierData, numCards, handNum);
          const vote2 = await cn2.verifyHand(playerData, dealerData, cashierData, numCards, handNum);
          const consensus = vote1.vote === 'PAY' && vote2.vote === 'PAY';

          console.log('[CHAIN] Hand ' + handNum + ': CN1=' + vote1.vote + ' CN2=' + vote2.vote + ' → ' + (consensus ? 'APPROVED' : 'DISPUTED'));
          handHistory.push({ hand: handNum, valid: consensus, cn1: vote1.vote, cn2: vote2.vote });
          return { valid: consensus };
        } catch (e) {
          console.log('[CHAIN] Cashier verify error: ' + e.message);
        }
      }

      // Fallback to local only
      console.log('[CHAIN] Hand ' + handNum + ' VERIFIED (local only)');
      handHistory.push({ hand: handNum, valid: true, local: true });
      return { valid: true };
    },

    /**
     * Cash out: settle player's balance from multisig
     */
    async cashOut(playerId) {
      if (!ready || !escrow) return { ok: false, error: 'Chain not ready' };

      const balance = sessionBalances.get(playerId);
      if (!balance || balance <= 0) return { ok: false, error: 'No balance to withdraw' };

      // Check all hands verified
      const unverified = handHistory.filter(h => !h.valid);
      if (unverified.length > 0) {
        return { ok: false, error: 'Cannot settle — ' + unverified.length + ' hands failed verification' };
      }

      const addr = PLAYER_ADDRS[playerId];
      if (!addr) return { ok: false, error: 'No address for ' + playerId };

      // Calculate rake on winnings
      const deposited = escrow.getDeposit ? escrow.getDeposit(playerId)?.amount || 0 : 0;
      const profit = Math.max(0, balance - deposited);
      const rake = profit * RAKE_PERCENT / 100;
      const payout = balance - rake;

      console.log('[CHAIN] Cash out ' + playerId + ': balance=' + balance + ' rake=' + rake.toFixed(8) + ' payout=' + payout.toFixed(8));

      try {
        const result = await escrow.settle(
          [{ address: addr, amount: payout }],
          {
            dealerAddr: DEALER_ADDR,
            dealerAmount: rake / 2,
            cashierAddrs: CASHIER_NODES.map(n => n.addr),
            cashierAmount: rake / 2
          }
        );

        sessionBalances.set(playerId, 0);
        console.log('[CHAIN] Settlement TX: ' + (result.txid || 'pending'));
        return { ok: true, txid: result.txid, payout };
      } catch (e) {
        console.log('[CHAIN] Settlement error: ' + e.message);
        return { ok: false, error: e.message };
      }
    },

    /**
     * Get session summary
     */
    getSummary() {
      return {
        balances: Object.fromEntries(sessionBalances),
        hands: handHistory.length,
        verified: handHistory.filter(h => h.valid).length,
        failed: handHistory.filter(h => !h.valid).length
      };
    }
  };

  return layer;
}
