/**
 * P2P Player — player-side logic for on-chain poker
 * Polls the table VerusID for game state, reacts to dealer instructions.
 * Writes actions to own VerusID.
 */

import { playerInit } from './protocol.mjs';
import { cardToString } from './hand-eval.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

export function createP2PPlayer(p2p, localNotify) {
  let myHand = null; // Current hand's player data
  let state = 'idle'; // idle, joining, waiting, shuffle, playing, showdown
  let currentHand = 0;
  let holeCards = [];
  let actionResolver = null; // Resolve function for pending action

  return {
    /**
     * Join the table — write join request to own ID
     */
    async joinTable() {
      console.log('[PLAYER] Joining table ' + p2p.tableId + '...');
      state = 'joining';

      // Read table config
      const tableConfig = await p2p.readTable();
      if (!tableConfig) {
        console.log('[PLAYER] No table config found at ' + p2p.tableId);
        return false;
      }
      console.log('[PLAYER] Table: ' + tableConfig.smallBlind + '/' + tableConfig.bigBlind + ' blinds');

      // Write join request
      await p2p.writeJoin('virtual');
      state = 'waiting';
      localNotify('joined', { table: p2p.tableId, config: tableConfig });
      return true;
    },

    /**
     * Main game loop — poll table state and react
     */
    async run() {
      console.log('[PLAYER] Starting game loop...');
      let lastState = null;

      while (true) {
        const gameState = await p2p.pollGameState(lastState, 5000);
        if (!gameState) continue;
        lastState = gameState;

        console.log('[PLAYER] State: ' + gameState.phase + ' hand=' + (gameState.hand || ''));

        switch (gameState.phase) {
          case 'shuffle':
            if (gameState.hand !== currentHand) {
              currentHand = gameState.hand;
              await this.handleShuffle(gameState);
            }
            break;

          case 'betting':
            if (gameState.turn === p2p.myId) {
              await this.handleMyTurn(gameState);
            } else {
              localNotify('waiting_turn', { turn: gameState.turn });
            }
            break;

          case 'settled':
            if (gameState.hand === currentHand) {
              this.handleSettlement(gameState);
              currentHand = 0; // Reset for next hand
              holeCards = [];
            }
            break;

          case 'waiting':
            localNotify('waiting', { players: gameState.players });
            break;
        }
      }
    },

    /**
     * Handle shuffle phase — generate and submit our deck
     */
    async handleShuffle(gameState) {
      console.log('[PLAYER] Shuffle for hand ' + gameState.hand);
      state = 'shuffle';

      // Stage I: Generate our deck
      myHand = playerInit(52, p2p.myId);
      await p2p.writePlayerDeck({
        playerId: p2p.myId,
        publicKey: myHand.publicKey,
        blindedDeck: myHand.blindedDeck,
        commitment: myHand.commitment,
        hand: gameState.hand
      });
      console.log('[PLAYER] Deck submitted');

      // Wait for our hole cards
      console.log('[PLAYER] Waiting for hole cards...');
      const reveal = await p2p.pollCardReveal(p2p.myId, null, 60000);
      if (reveal && reveal.hand === gameState.hand) {
        holeCards = reveal.cards;
        console.log('[PLAYER] Hole cards: ' + holeCards.join(' '));
        localNotify('hole_cards', { cards: holeCards });
      }

      state = 'playing';
    },

    /**
     * Handle our turn — show buttons, wait for local input, submit to chain
     */
    async handleMyTurn(gameState) {
      console.log('[PLAYER] My turn! Valid: ' + (gameState.validActions || []).join(', '));
      state = 'my_turn';

      localNotify('my_turn', {
        validActions: gameState.validActions,
        pot: gameState.pot,
        toCall: gameState.toCall
      });

      // Wait for action from local UI
      const action = await new Promise(resolve => {
        actionResolver = resolve;
        // Timeout — auto fold/check
        setTimeout(() => {
          if (actionResolver === resolve) {
            const fallback = (gameState.validActions || []).includes('check') ? 'check' : 'fold';
            console.log('[PLAYER] Timeout — ' + fallback);
            resolve({ action: fallback, amount: 0 });
          }
        }, 15000);
      });
      actionResolver = null;

      // Write action to our VerusID
      console.log('[PLAYER] Action: ' + action.action + (action.amount ? ' ' + action.amount : ''));
      await p2p.writeAction({
        action: action.action,
        amount: action.amount || 0,
        hand: currentHand,
        timestamp: Date.now()
      });

      state = 'playing';
    },

    /**
     * Handle settlement
     */
    handleSettlement(gameState) {
      console.log('[PLAYER] Hand settled. Verified: ' + gameState.verification);
      const me = (gameState.results || []).find(r => r.id === p2p.myId);
      if (me) console.log('[PLAYER] My chips: ' + me.chips);
      localNotify('settlement', {
        verified: gameState.verification,
        results: gameState.results,
        myChips: me ? me.chips : 0
      });
      state = 'waiting';
    },

    /**
     * Submit action from local UI (called by WebSocket handler)
     */
    submitAction(action, amount) {
      if (actionResolver) {
        actionResolver({ action, amount: amount || 0 });
      }
    },

    getState() { return state; },
    getHoleCards() { return holeCards; },
    getHandNum() { return currentHand; }
  };
}
