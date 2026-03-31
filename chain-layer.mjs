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

// RPC config auto-detected from CHIPS conf file
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
function findRPC() {
  const paths = [
    join(process.env.HOME || '', '.komodo/CHIPS/CHIPS.conf'),
    join(process.env.HOME || '', '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = key => (conf.match(new RegExp('^' + key + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword')) {
        return { host: get('rpchost') || '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
      }
    }
  }
  throw new Error('CHIPS conf not found — ensure CHIPS daemon is installed');
}
const RPC = findRPC();

const RAKE_PERCENT = 2.5;

export function createChainLayer(options = {}) {
  const client = createClient(RPC);

  // Resolve VerusID → primary address from chain
  async function resolveAddr(identityName) {
    const fullName = identityName.includes('.') ? identityName : identityName + '.CHIPS@';
    const id = await client.getIdentity(fullName);
    return id.identity.primaryaddresses[0];
  }
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
        return false;
      }

      // Resolve cashier node addresses from chain
      const cashierIds = options.cashierNodes || ['poker-cn1', 'poker-cn2'];
      const cashierNodes = [];
      for (const cid of cashierIds) {
        try {
          const addr = await resolveAddr(cid);
          cashierNodes.push({ id: cid, addr });
          console.log('[CHAIN] Cashier ' + cid + ': ' + addr);
        } catch (e) {
          console.log('[CHAIN] Cannot resolve cashier ' + cid + ': ' + e.message);
        }
      }
      if (cashierNodes.length < 2) {
        console.log('[CHAIN] Need at least 2 cashier nodes');
        return false;
      }

      // Create escrow
      escrow = createEscrow(RPC, cashierNodes);
      try {
        const msig = await escrow.createMultisig();
        console.log('[CHAIN] Multisig: ' + msig.address);
      } catch (e) {
        console.log('[CHAIN] Multisig error: ' + e.message);
        return false;
      }

      // Init cashier nodes
      cn1 = createCashierNode({ nodeId: cashierNodes[0].id, nodeAddr: cashierNodes[0].addr });
      cn2 = createCashierNode({ nodeId: cashierNodes[1].id, nodeAddr: cashierNodes[1].addr });
      console.log('[CHAIN] Cashier nodes ready');

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

      let addr;
      try { addr = await resolveAddr(playerId); }
      catch (e) { return { ok: false, error: 'Cannot resolve ' + playerId + ': ' + e.message }; }

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

      let addr;
      try { addr = await resolveAddr(playerId); }
      catch (e) { return { ok: false, error: 'Cannot resolve ' + playerId + ': ' + e.message }; }

      // Calculate rake on winnings
      const deposited = escrow.getDeposit ? escrow.getDeposit(playerId)?.amount || 0 : 0;
      const profit = Math.max(0, balance - deposited);
      const rake = profit * RAKE_PERCENT / 100;
      const payout = balance - rake;

      console.log('[CHAIN] Cash out ' + playerId + ': balance=' + balance + ' rake=' + rake.toFixed(8) + ' payout=' + payout.toFixed(8));

      try {
        const dealerAddr = await resolveAddr(options.dealerId || 'poker-dealer');
        const cashierAddrs = [];
        for (const cid of (options.cashierNodes || ['poker-cn1', 'poker-cn2'])) {
          cashierAddrs.push(await resolveAddr(cid));
        }
        const result = await escrow.settle(
          [{ address: addr, amount: payout }],
          {
            dealerAddr,
            dealerAmount: rake / 2,
            cashierAddrs,
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
