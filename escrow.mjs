/**
 * Escrow — multisig fund management for poker
 * Creates 2-of-2 multisig from cashier nodes for player deposits.
 * Both cashier nodes must agree to release funds.
 */

import { createClient } from './verus-rpc.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

/**
 * Create an escrow manager
 */
export function createEscrow(rpcConfig, cashierNodes) {
  const client = createClient(rpcConfig);
  let multisigAddr = null;
  let redeemScript = null;
  const deposits = new Map(); // playerId → { txid, amount, confirmed }

  return {
    /**
     * Create multisig address from cashier node pubkeys
     */
    async createMultisig() {
      // Get pubkeys for each cashier node
      const pubkeys = [];
      for (const node of cashierNodes) {
        const addrInfo = await client.call('validateaddress', [node.addr]);
        if (!addrInfo.pubkey) {
          throw new Error('No pubkey for ' + node.id + ' at ' + node.addr);
        }
        pubkeys.push(addrInfo.pubkey);
      }

      // Create M-of-N multisig (2-of-2 for our case)
      const M = Math.ceil(cashierNodes.length / 2) + (cashierNodes.length === 2 ? 0 : 0);
      const result = await client.call('addmultisigaddress', [
        cashierNodes.length, // N-of-N for 2 nodes
        pubkeys
      ]);

      multisigAddr = result.address || result;
      redeemScript = result.redeemScript;

      console.log('[ESCROW] Multisig address: ' + multisigAddr);
      console.log('[ESCROW] Required signatures: ' + cashierNodes.length + '-of-' + cashierNodes.length);

      return { address: multisigAddr, redeemScript };
    },

    /**
     * Get the multisig address
     */
    getAddress() { return multisigAddr; },

    /**
     * Record a player deposit
     */
    async recordDeposit(playerId, txid, expectedAmount) {
      // Verify the TX
      try {
        const tx = await client.getTransaction(txid);
        const toMultisig = tx.details?.find(d =>
          d.address === multisigAddr && d.category === 'receive'
        );

        if (!toMultisig) {
          return { ok: false, error: 'TX does not pay to multisig address' };
        }

        const amount = toMultisig.amount;
        if (amount < expectedAmount) {
          return { ok: false, error: 'Insufficient deposit: ' + amount + ' < ' + expectedAmount };
        }

        deposits.set(playerId, {
          txid,
          amount,
          confirmed: tx.confirmations >= 1,
          vout: toMultisig.vout
        });

        return { ok: true, amount, confirmed: tx.confirmations >= 1 };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * Check if a deposit is confirmed
     */
    async checkDeposit(playerId) {
      const dep = deposits.get(playerId);
      if (!dep) return null;

      if (!dep.confirmed) {
        const tx = await client.getTransaction(dep.txid);
        dep.confirmed = tx.confirmations >= 1;
      }
      return dep;
    },

    /**
     * Create a settlement TX (raw, unsigned)
     * payouts: [{ address, amount }]
     */
    async createSettlementTx(payouts, rake = { dealerAddr: null, dealerAmount: 0, cashierAddrs: [], cashierAmount: 0 }) {
      // Collect unspent from multisig
      const unspent = await client.call('listunspent', [0, 9999999, [multisigAddr]]);

      if (unspent.length === 0) {
        throw new Error('No unspent outputs at multisig address');
      }

      // Build inputs from all unspent at multisig
      const inputs = unspent.map(u => ({
        txid: u.txid,
        vout: u.vout
      }));

      const totalIn = unspent.reduce((s, u) => s + u.amount, 0);

      // Build outputs
      const outputs = {};
      let totalOut = 0;

      for (const p of payouts) {
        const amt = parseFloat(p.amount.toFixed(8));
        if (amt > 0) {
          outputs[p.address] = (outputs[p.address] || 0) + amt;
          totalOut += amt;
        }
      }

      // Add rake outputs
      if (rake.dealerAddr && rake.dealerAmount > 0) {
        outputs[rake.dealerAddr] = (outputs[rake.dealerAddr] || 0) + parseFloat(rake.dealerAmount.toFixed(8));
        totalOut += rake.dealerAmount;
      }
      for (const ca of rake.cashierAddrs) {
        if (rake.cashierAmount > 0) {
          const perNode = parseFloat((rake.cashierAmount / rake.cashierAddrs.length).toFixed(8));
          outputs[ca] = (outputs[ca] || 0) + perNode;
          totalOut += perNode;
        }
      }

      // Fee — deduct proportionally from outputs
      const fee = 0.0001;
      if (totalOut + fee > totalIn) {
        // Reduce largest payout to cover fee
        const maxKey = Object.entries(outputs).sort((a, b) => b[1] - a[1])[0][0];
        outputs[maxKey] = parseFloat((outputs[maxKey] - fee).toFixed(8));
        totalOut -= fee;
      }

      const change = parseFloat((totalIn - totalOut - fee).toFixed(8));

      // Add change back to multisig if significant
      if (change > 0.00001) {
        outputs[multisigAddr] = (outputs[multisigAddr] || 0) + change;
      }

      // Create raw TX
      const rawTx = await client.call('createrawtransaction', [inputs, outputs]);
      return { rawTx, inputs, outputs, totalIn, totalOut, fee };
    },

    /**
     * Sign a raw TX (each cashier node calls this)
     */
    async signTx(rawTx) {
      const signed = await client.call('signrawtransaction', [rawTx]);
      return {
        hex: signed.hex,
        complete: signed.complete
      };
    },

    /**
     * Broadcast a fully signed TX
     */
    async broadcastTx(signedHex) {
      return await client.call('sendrawtransaction', [signedHex]);
    },

    /**
     * Full settlement: create → sign → broadcast
     * For 2-of-2: both cashier nodes sign sequentially
     */
    async settle(payouts, rake) {
      console.log('[ESCROW] Creating settlement TX...');
      const { rawTx, totalIn, totalOut, fee } = await this.createSettlementTx(payouts, rake);
      console.log('[ESCROW] In: ' + totalIn.toFixed(8) + ' Out: ' + totalOut.toFixed(8) + ' Fee: ' + fee);

      // First signature
      console.log('[ESCROW] Signing (node 1)...');
      const sig1 = await this.signTx(rawTx);

      if (sig1.complete) {
        // Single-sig or all keys in one wallet
        console.log('[ESCROW] TX fully signed');
        const txid = await this.broadcastTx(sig1.hex);
        console.log('[ESCROW] Settlement TX: ' + txid);
        return { txid, complete: true };
      }

      // Second signature needed
      console.log('[ESCROW] Signing (node 2)...');
      const sig2 = await this.signTx(sig1.hex);

      if (sig2.complete) {
        const txid = await this.broadcastTx(sig2.hex);
        console.log('[ESCROW] Settlement TX: ' + txid);
        return { txid, complete: true };
      }

      return { complete: false, hex: sig2.hex, error: 'Not enough signatures' };
    },

    /**
     * Get deposit summary
     */
    getDeposits() {
      const summary = {};
      for (const [id, dep] of deposits) {
        summary[id] = { amount: dep.amount, confirmed: dep.confirmed, txid: dep.txid };
      }
      return summary;
    },

    /**
     * Get total deposited
     */
    getTotalDeposited() {
      let total = 0;
      for (const [, dep] of deposits) total += dep.amount;
      return total;
    }
  };
}
