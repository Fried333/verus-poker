/**
 * Poker Session Manager — handles buy-ins, cash-outs, and multi-hand sessions
 *
 * Flow:
 * 1. Player sends buy-in TX to house address
 * 2. Session tracks their chip balance in memory
 * 3. Multiple hands play, chips move between players
 * 4. Player requests leave → sits out → cashed out after current hand
 * 5. Disconnect → same as leave request
 * 6. House closes table → all players cashed out
 */

import { createClient } from './verus-rpc.mjs';

// Player states
export const ACTIVE = 'active';        // Playing hands
export const SITTING_OUT = 'sitting_out'; // Requested leave, waiting for hand to finish
export const CASHING_OUT = 'cashing_out'; // Payout TX in progress
export const CASHED_OUT = 'cashed_out';   // Done, paid out
export const DISCONNECTED = 'disconnected'; // Lost connection

export function createSession(rpcConfig, houseId, houseAddr) {
  const client = createClient(rpcConfig);

  // Track all players in the session
  const players = new Map(); // id → { addr, buyinTx, chips, status, sitOutCountdown }

  return {
    /**
     * Process a buy-in: verify TX, credit player chips
     */
    async processBuyin(playerId, playerAddr, txid, amount) {
      // Verify the TX exists and is to our address
      try {
        const tx = await client.getTransaction(txid);
        // Check it's confirmed (at least 1 confirmation)
        if (tx.confirmations < 1) {
          return { ok: false, error: 'TX not confirmed yet' };
        }
        // Verify amount
        const validOutput = tx.details?.find(d =>
          d.address === houseAddr && d.amount >= amount && d.category === 'receive'
        );
        if (!validOutput) {
          return { ok: false, error: 'TX does not pay to house address or wrong amount' };
        }
      } catch (e) {
        return { ok: false, error: 'Cannot verify TX: ' + e.message };
      }

      players.set(playerId, {
        addr: playerAddr,
        buyinTx: txid,
        chips: amount,
        status: ACTIVE,
        sitOutCountdown: 0,
        handsPlayed: 0,
        totalBuyIn: amount,
        totalCashOut: 0
      });

      return { ok: true, chips: amount };
    },

    /**
     * Quick buy-in for testing (no TX verification)
     */
    buyinDirect(playerId, playerAddr, amount) {
      players.set(playerId, {
        addr: playerAddr,
        buyinTx: null,
        chips: amount,
        status: ACTIVE,
        sitOutCountdown: 0,
        handsPlayed: 0,
        totalBuyIn: amount,
        totalCashOut: 0
      });
      return { ok: true, chips: amount };
    },

    /**
     * Player requests to leave — mark as sitting out
     */
    requestLeave(playerId) {
      const p = players.get(playerId);
      if (!p) return { ok: false, error: 'Not in session' };
      if (p.status === CASHING_OUT || p.status === CASHED_OUT) {
        return { ok: false, error: 'Already leaving' };
      }
      p.status = SITTING_OUT;
      p.sitOutCountdown = 1; // Cash out after 1 more hand completes
      return { ok: true, message: 'Will cash out after current hand' };
    },

    /**
     * Player disconnected
     */
    playerDisconnected(playerId) {
      const p = players.get(playerId);
      if (!p) return;
      if (p.status === ACTIVE) {
        p.status = DISCONNECTED;
        p.sitOutCountdown = 2; // Give 2 hands to reconnect
      }
    },

    /**
     * Player reconnected
     */
    playerReconnected(playerId) {
      const p = players.get(playerId);
      if (!p) return false;
      if (p.status === DISCONNECTED) {
        p.status = ACTIVE;
        p.sitOutCountdown = 0;
        return true;
      }
      return false;
    },

    /**
     * Get players who should be dealt into the next hand
     */
    getActivePlayers() {
      const active = [];
      for (const [id, p] of players) {
        if (p.status === ACTIVE && p.chips > 0) {
          active.push({ id, chips: p.chips, addr: p.addr });
        }
      }
      return active;
    },

    /**
     * Update chip balances after a hand completes.
     * Called by the poker engine with the final chip counts.
     */
    updateChips(chipResults) {
      for (const { id, chips } of chipResults) {
        const p = players.get(id);
        if (p) {
          p.chips = chips;
          p.handsPlayed++;
        }
      }
    },

    /**
     * Called after each hand — process sit-outs and cash-outs.
     * Returns array of players to cash out.
     */
    processEndOfHand() {
      const toCashOut = [];

      for (const [id, p] of players) {
        // Decrement sit-out countdown
        if (p.status === SITTING_OUT || p.status === DISCONNECTED) {
          p.sitOutCountdown--;
          if (p.sitOutCountdown <= 0) {
            p.status = CASHING_OUT;
            toCashOut.push({ id, addr: p.addr, amount: parseFloat(p.chips.toFixed(8)) });
          }
        }
        // Busted players auto cash out (0 chips)
        if (p.status === ACTIVE && p.chips <= 0) {
          p.status = CASHED_OUT;
          p.chips = 0;
        }
      }

      return toCashOut;
    },

    /**
     * Send payout TX for a player
     */
    async cashOut(playerId) {
      const p = players.get(playerId);
      if (!p || p.chips <= 0) {
        if (p) { p.status = CASHED_OUT; p.totalCashOut = 0; }
        return { ok: true, amount: 0 };
      }

      const amount = parseFloat(p.chips.toFixed(8));

      try {
        const opid = await client.sendCurrency(houseAddr, [{
          address: p.addr,
          amount: amount
        }]);
        const result = await client.waitForOperation(opid, 60000);
        p.status = CASHED_OUT;
        p.totalCashOut = amount;
        p.chips = 0;
        return { ok: true, txid: result.txid, amount };
      } catch (e) {
        return { ok: false, error: e.message, amount };
      }
    },

    /**
     * Close table — cash out all remaining players
     */
    async closeTable() {
      const results = [];
      for (const [id, p] of players) {
        if (p.status !== CASHED_OUT && p.chips > 0) {
          p.status = CASHING_OUT;
          const result = await this.cashOut(id);
          results.push({ id, ...result });
        }
      }
      return results;
    },

    /**
     * Get session summary
     */
    getSummary() {
      const summary = [];
      for (const [id, p] of players) {
        summary.push({
          id,
          addr: p.addr,
          status: p.status,
          chips: p.chips,
          buyIn: p.totalBuyIn,
          cashOut: p.totalCashOut,
          profit: p.totalCashOut - p.totalBuyIn,
          handsPlayed: p.handsPlayed
        });
      }
      return summary;
    },

    /**
     * Get player count by status
     */
    getStatus() {
      let active = 0, sittingOut = 0, disconnected = 0, total = 0;
      for (const [, p] of players) {
        if (p.status === ACTIVE) active++;
        if (p.status === SITTING_OUT) sittingOut++;
        if (p.status === DISCONNECTED) disconnected++;
        if (p.status !== CASHED_OUT) total++;
      }
      return { active, sittingOut, disconnected, total };
    },

    getPlayer(id) { return players.get(id); },
    getAllPlayers() { return players; }
  };
}
