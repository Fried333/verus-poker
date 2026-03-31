/**
 * Game Coordinator — ties together:
 * - Protocol (shuffle/blind/reveal/verify)
 * - Game engine (betting/pot/hand eval)
 * - Verus RPC (identity updates, settlement)
 * - Session management (buy-in/cash-out)
 *
 * This is the main orchestrator that runs a poker table.
 */

import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { createSession, ACTIVE } from './session.mjs';
import { createClient, VDXF_KEYS } from './verus-rpc.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

/**
 * Create a game coordinator
 */
export function createGameCoordinator(config) {
  const {
    rpcConfig,
    tableId,           // Table VerusID name
    dealerId,          // Dealer VerusID name
    cashierId,         // Cashier VerusID name
    dealerAddr,        // Dealer t-address
    smallBlind = 0.01,
    bigBlind = 0.02,
    numCards = 14,      // 14 for 2 players, 52 for full table
    sssThreshold = 2,   // M-of-N for SSS
  } = config;

  const client = createClient(rpcConfig);
  let handCount = 0;
  let gameLog = [];     // Full game log for verification

  return {
    /**
     * Run a complete hand with all protocol phases
     */
    async playFullHand(playerConfigs) {
      handCount++;
      const numPlayers = playerConfigs.length;
      const handLog = { hand: handCount, phases: [] };

      console.log('\n=== Hand ' + handCount + ' ===');

      // ────────────────────────────────────────
      // PHASE 1: Player Deck Initialization
      // ────────────────────────────────────────
      console.log('[Phase 1] Player deck initialization...');
      const playerData = [];
      for (let i = 0; i < numPlayers; i++) {
        const pd = playerInit(numCards, playerConfigs[i].id);
        playerData.push(pd);

        // In production: write to player's VerusID
        // await writeToIdentity(playerConfigs[i].id, 'poker.deck.player', {
        //   publicKey: pd.publicKey.toString(16),
        //   initialDeck: pd.initialDeck.map(p => p.toString(16)),
        //   blindedDeck: pd.blindedDeck.map(p => p.toString(16)),
        //   commitment: pd.commitment
        // });
      }
      handLog.phases.push({ phase: 'player_init', players: numPlayers, cards: numCards });

      // ────────────────────────────────────────
      // PHASE 2: Dealer Shuffle and Blind
      // ────────────────────────────────────────
      console.log('[Phase 2] Dealer shuffle and blind (with e_i factors)...');
      const dealerData = dealerShuffle(playerData, numCards);
      handLog.phases.push({
        phase: 'dealer_shuffle',
        commitment: dealerData.dealerCommitment,
        e_count: dealerData.E.length
      });

      // In production: write to table VerusID
      // await writeToIdentity(tableId, 'poker.deck.dealer', { ... });

      // ────────────────────────────────────────
      // PHASE 3: Cashier Shuffle and Blind + SSS
      // ────────────────────────────────────────
      console.log('[Phase 3] Cashier shuffle, blind, and SSS distribution...');
      const cashierData = cashierShuffle(
        dealerData.blindedDecks, numPlayers, numCards, sssThreshold
      );
      handLog.phases.push({
        phase: 'cashier_shuffle',
        commitment: cashierData.cashierCommitment,
        sss_threshold: sssThreshold
      });

      // In production: write to each player's VerusID (encrypted SSS shares)
      // await writeToIdentity(cashierId, 'poker.deck.cashier', { ... });

      // ────────────────────────────────────────
      // PHASE 4: Deal Hole Cards
      // ────────────────────────────────────────
      console.log('[Phase 4] Dealing hole cards...');
      const holeCards = {};
      let cardPos = 0;

      for (let i = 0; i < numPlayers; i++) {
        const cards = [];
        for (let c = 0; c < 2; c++) {
          // Trace through all three permutations to find original card
          const cashierPos = cashierData.sigma_Cashier[cardPos];
          const dealerPos = dealerData.sigma_Dealer[cashierPos];
          const playerPos = playerData[i].permutation[dealerPos];

          cards.push(playerPos);
          cardPos++;
        }
        holeCards[playerConfigs[i].id] = cards;
        console.log('  ' + playerConfigs[i].id + ': ' +
          cards.map(c => cardToString(c % 52)).join(' '));
      }

      // ────────────────────────────────────────
      // PHASE 5: Betting + Community Cards
      // ────────────────────────────────────────
      console.log('[Phase 5] Playing hand...');

      // Create game engine for this hand
      const actions = [];
      const io = createHandIO(playerConfigs, holeCards, actions);
      const engine = createEngine({ smallBlind, bigBlind, rake: 0 }, io);

      for (const pc of playerConfigs) {
        engine.addPlayer(pc.id, pc.chips);
      }

      // Set hole cards on the engine
      for (let i = 0; i < numPlayers; i++) {
        const cards = holeCards[playerConfigs[i].id];
        // Map to 0-51 range
        engine.game.players[i].holeCards = cards.map(c => c % 52);
      }

      // Create a crypto adapter that uses the dealt cards
      const cryptoAdapter = createProtocolCrypto(
        playerData, dealerData, cashierData, numCards, numPlayers
      );

      await engine.playHand(cryptoAdapter);

      handLog.phases.push({
        phase: 'betting_complete',
        actions: actions.length,
        pot: engine.game.pot,
        board: engine.game.board.map(cardToString)
      });

      // ────────────────────────────────────────
      // PHASE 6: Post-Game Verification
      // ────────────────────────────────────────
      console.log('[Phase 6] Post-game verification...');
      const verification = verifyGame(playerData, dealerData, cashierData, numCards);
      console.log('  Verification: ' + (verification.valid ? 'PASSED' : 'FAILED'));
      if (!verification.valid) {
        for (const e of verification.errors) console.log('    ERROR: ' + e);
      }
      handLog.phases.push({
        phase: 'verification',
        valid: verification.valid,
        errors: verification.errors
      });

      // ────────────────────────────────────────
      // PHASE 7: Settlement
      // ────────────────────────────────────────
      console.log('[Phase 7] Settlement...');
      const results = engine.game.players.map(p => ({
        id: p.id,
        chips: p.chips,
        holeCards: p.holeCards.map(cardToString),
        folded: p.folded
      }));

      // Calculate rake
      const winner = engine.game.players.find(p => p.chips > playerConfigs.find(pc => pc.id === p.id).chips);
      if (winner) {
        const winAmount = winner.chips - playerConfigs.find(pc => pc.id === winner.id).chips;
        console.log('  Winner: ' + winner.id + ' (won ' + winAmount.toFixed(4) + ')');
      }

      handLog.phases.push({ phase: 'settlement', results });
      handLog.verification = verification.valid;
      gameLog.push(handLog);

      return {
        results,
        verification,
        handLog
      };
    },

    /**
     * Get the full game log for audit
     */
    getGameLog() { return gameLog; },

    /**
     * Get hand count
     */
    getHandCount() { return handCount; }
  };
}

/**
 * Create IO adapter for the poker engine during a hand
 */
function createHandIO(playerConfigs, holeCards, actionsLog, bigBlind = 0.02) {
  return {
    broadcast(event, data) {
      if (event === 'action') {
        actionsLog.push({ player: data.player, action: data.action, amount: data.amount });
        console.log('    ' + data.player + ': ' + data.action +
          (data.amount ? ' ' + data.amount : ''));
      }
      if (event === 'community_cards') {
        console.log('    Board: ' + (data.board || []).map(c =>
          typeof c === 'number' ? cardToString(c) : c).join(' '));
      }
      if (event === 'showdown') {
        console.log('    *** SHOWDOWN ***');
        for (const [, info] of Object.entries(data.hands || {})) {
          const cards = (info.cards || []).map(c =>
            typeof c === 'number' ? cardToString(c) : c).join(' ');
          console.log('    ' + info.id + ': ' + cards + ' (' + info.handName + ')' +
            (info.won ? ' WINS ' + info.payout : ''));
        }
      }
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        console.log('    ' + playerId + ' dealt: ' +
          data.cards.map(c => typeof c === 'number' ? cardToString(c) : c).join(' '));
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      // Auto-play bot for testing — always respects minRaise
      const r = Math.random();
      // Get minRaise from engine if available
      const minR = bigBlind * 2; // Safe default
      if (validActions.includes('check')) {
        return r < 0.65 ? { action: 'check' } :
               r < 0.85 ? { action: 'raise', amount: minR } :
               { action: 'fold' };
      }
      if (validActions.includes('call')) {
        return r < 0.5 ? { action: 'call' } :
               r < 0.7 ? { action: 'raise', amount: minR } :
               { action: 'fold' };
      }
      return { action: 'fold' };
    },
    broadcastState() {},
    log(msg) {
      if (msg.includes('Hand Complete')) console.log('    ' + msg);
    }
  };
}

/**
 * Create a crypto adapter that returns cards from the protocol's dealt positions
 */
function createProtocolCrypto(playerData, dealerData, cashierData, numCards, numPlayers) {
  let posCounter = 0;

  return {
    async initDeck(n) {
      posCounter = 0;
      // Deck is already shuffled/encrypted by the protocol
      return { numCards: n };
    },

    async revealCard(position) {
      // Trace through permutations to find the original card
      const p = position % numCards;
      const playerIdx = Math.floor(posCounter / numCards) % numPlayers;

      // Map from final position through all three permutations
      const cashierPos = cashierData.sigma_Cashier[p];
      const dealerPos = dealerData.sigma_Dealer[cashierPos];

      // For simplicity, use player 0's permutation for community cards
      // In production, community cards are revealed publicly
      const pi = playerIdx < numPlayers ? playerIdx : 0;
      const originalCard = playerData[pi].permutation[dealerPos];

      posCounter++;
      return originalCard % 52; // Map to 0-51 range
    }
  };
}

// ────────────────────────────────────────
// Standalone test
// ────────────────────────────────────────
if (process.argv[1] && process.argv[1].includes('game-coordinator')) {
  (async () => {
    const coord = createGameCoordinator({
      rpcConfig: {},
      tableId: 'test-table',
      dealerId: 'test-dealer',
      cashierId: 'test-cashier',
      dealerAddr: 'RTestAddr',
      numCards: 14,
      sssThreshold: 2
    });

    const players = [
      { id: 'Alice', chips: 5.0 },
      { id: 'Bob', chips: 5.0 }
    ];

    console.log('Playing 3 hands...\n');

    for (let i = 0; i < 3; i++) {
      const result = await coord.playFullHand(players);
      // Update chips for next hand
      for (const p of players) {
        const r = result.results.find(r => r.id === p.id);
        if (r) p.chips = r.chips;
      }
    }

    console.log('\n=== Session Summary ===');
    for (const p of players) {
      console.log('  ' + p.id + ': ' + p.chips.toFixed(4) + ' chips');
    }
    console.log('  Total: ' + players.reduce((s, p) => s + p.chips, 0).toFixed(4));
    console.log('  Hands: ' + coord.getHandCount());
    console.log('  All verified: ' + coord.getGameLog().every(h => h.verification));
  })();
}
