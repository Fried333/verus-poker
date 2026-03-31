/**
 * Poker Engine — orchestrates a full hand of poker
 * Ties together: crypto protocol, game state machine, and chain I/O.
 * Protocol-agnostic: accepts a crypto backend (sg777 or SRA).
 * Chain-agnostic: accepts an I/O backend (Verus RPC, WebSocket, or mock).
 */

import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getGameState,
  getValidActions, getToCall,
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, SHUFFLING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED
} from './game.mjs';

import { evaluateHand } from './hand-eval.mjs';

/**
 * Crypto backend interface:
 * {
 *   initDeck(numCards) → { playerData, dealerData, blinderData, encryptedDeck }
 *   revealCard(position, deck, keys) → cardIndex (0-51)
 * }
 *
 * IO backend interface:
 * {
 *   broadcast(event, data) → void           // Send to all players
 *   sendTo(playerId, event, data) → void     // Send to one player
 *   waitForAction(playerId, validActions, timeout) → { action, amount }
 *   onPlayerJoin(callback) → void
 *   log(msg) → void
 * }
 */

/**
 * Create a poker engine instance
 */
export function createEngine(config, io) {
  const game = createGame(config);
  let deck = null;
  let cardPositions = {
    // Maps card purpose to deck position
    hole: {},      // hole[seat] = [pos1, pos2]
    flop: [],      // [pos1, pos2, pos3]
    turn: null,
    river: null,
    nextPos: 0
  };

  const engine = {
    game,

    /**
     * Add a player to the table
     */
    addPlayer(id, chips) {
      addPlayer(game, id, chips);
      io.broadcast('player_joined', { id, chips, seat: game.players.length - 1 });
      io.log(`${id} joined with ${chips} chips (seat ${game.players.length - 1})`);
      return game.players.length - 1;
    },

    /**
     * Run a complete hand
     */
    async playHand(cryptoBackend) {
      io.log('=== New Hand ===');

      // Start hand — don't remove busted players, just skip them in startHand
      const activePlayers = game.players.filter(p => p.chips > 0);
      if (activePlayers.length < 2) {
        io.log('Not enough players with chips to continue');
        return game;
      }
      game.dealerSeat = game.dealerSeat % game.players.length;
      // Skip to a dealer seat that has chips
      while (game.players[game.dealerSeat].chips <= 0) {
        game.dealerSeat = (game.dealerSeat + 1) % game.players.length;
      }

      startHand(game);
      io.broadcast('hand_start', { dealer: game.dealerSeat });

      // Shuffle and encrypt deck
      io.log('Shuffling deck...');
      const numCards = Math.max(game.players.length * 2 + 5 + 3, 14); // hole cards + community + burn
      deck = await cryptoBackend.initDeck(numCards);
      io.broadcast('deck_ready', {});

      // Post blinds
      postBlinds(game);
      io.broadcast('blinds_posted', {
        smallBlind: { seat: getSBSeat(game), amount: game.smallBlind },
        bigBlind: { seat: getBBSeat(game), amount: game.bigBlind },
        pot: game.pot
      });

      // Reset card positions
      cardPositions = { hole: {}, flop: [], turn: null, river: null, nextPos: 0 };

      // Deal hole cards
      await dealHoleCards(game, deck, cryptoBackend, io, cardPositions);

      // Betting rounds
      const phases = [
        { name: PREFLOP, cards: 0 },
        { name: FLOP, cards: 3 },
        { name: TURN, cards: 1 },
        { name: RIVER, cards: 1 },
      ];

      // Main game loop — keep going until showdown or settled
      while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
        // Deal community cards if entering a new street
        if (game.phase === FLOP && game.board.length === 0) {
          const communityCards = [];
          for (let i = 0; i < 3; i++) {
            communityCards.push(await cryptoBackend.revealCard(cardPositions.nextPos++, deck));
          }
          dealBoard(game, communityCards);
          cardPositions.flop = communityCards;
          io.broadcast('community_cards', { phase: FLOP, cards: communityCards, board: game.board });
        } else if (game.phase === TURN && game.board.length === 3) {
          const card = await cryptoBackend.revealCard(cardPositions.nextPos++, deck);
          dealBoard(game, [card]);
          cardPositions.turn = card;
          io.broadcast('community_cards', { phase: TURN, cards: [card], board: game.board });
        } else if (game.phase === RIVER && game.board.length === 4) {
          const card = await cryptoBackend.revealCard(cardPositions.nextPos++, deck);
          dealBoard(game, [card]);
          cardPositions.river = card;
          io.broadcast('community_cards', { phase: RIVER, cards: [card], board: game.board });
        }

        // Run one betting action
        if (game.currentTurn >= 0) {
          await runOneAction(game, io);
        } else {
          // No one can act — go to showdown
          game.phase = SHOWDOWN;
          game.currentTurn = -1;
          break;
        }
      }

      // Showdown / Settlement
      if (game.phase === SHOWDOWN) {
        const nonFolded = game.players.filter(p => !p.folded);

        // Deal remaining community cards only if multiple players need showdown
        if (nonFolded.length > 1) {
          while (game.board.length < 5) {
            const needed = game.board.length === 0 ? 3 : 1;
            const cards = [];
            for (let i = 0; i < needed; i++) {
              cards.push(await cryptoBackend.revealCard(cardPositions.nextPos++, deck));
            }
            dealBoard(game, cards);
            const phase = game.board.length === 3 ? 'flop' : game.board.length === 4 ? 'turn' : 'river';
            io.broadcast('community_cards', { phase, cards, board: game.board });
            if (io.broadcastState) io.broadcastState();
            await new Promise(r => setTimeout(r, 500));
          }
        }

        // Always settle — handles both fold-win and showdown
        const payouts = settleHand(game, evaluateHand);
        applyPayouts(game, payouts);

        // Build showdown info
        const showdownInfo = {};
        const handNames = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];
        for (const p of game.players) {
          if (!p.folded && p.holeCards.length > 0) {
            if (game.board.length >= 3) {
              const score = evaluateHand([...p.holeCards, ...game.board]);
              const rank = Math.floor(score / 1e10);
              showdownInfo[p.seat] = {
                id: p.id, cards: p.holeCards, score,
                handName: handNames[rank] || 'Unknown',
                won: payouts[p.seat] > 0, payout: payouts[p.seat] || 0
              };
            } else {
              // Won by fold — no board to evaluate
              showdownInfo[p.seat] = {
                id: p.id, cards: p.holeCards,
                handName: 'Winner (all folded)',
                won: payouts[p.seat] > 0, payout: payouts[p.seat] || 0
              };
            }
          }
        }

        io.broadcast('showdown', { hands: showdownInfo, board: game.board, payouts, pot: game.pot });
        if (io.broadcastState) io.broadcastState();

        io.log('=== Hand Complete ===');
        for (const p of game.players) {
          io.log(`  ${p.id}: ${p.chips} chips ${payouts[p.seat] > 0 ? `(+${payouts[p.seat]})` : ''}`);
        }
      }

      // Advance dealer for next hand
      game.dealerSeat = (game.dealerSeat + 1) % game.players.length;

      return game;
    },

    /**
     * Get game state visible to a specific player
     */
    getState(forSeat) {
      return getGameState(game, forSeat);
    }
  };

  return engine;
}

// ============================================================
// Internal helpers
// ============================================================

async function dealHoleCards(game, deck, crypto, io, positions) {
  for (const p of game.players) {
    const cards = [];
    for (let i = 0; i < 2; i++) {
      const pos = positions.nextPos++;
      const card = await crypto.revealCard(pos, deck);
      cards.push(card);
    }
    setHoleCards(game, p.seat, cards);
    positions.hole[p.seat] = cards;

    // Only send hole cards to the player who owns them
    io.sendTo(p.id, 'hole_cards', { cards });
    io.broadcast('cards_dealt', { seat: p.seat }); // Others just know cards were dealt
  }
}

async function runOneAction(game, io) {
  const seat = game.currentTurn;
  if (seat < 0) return;

  const p = game.players[seat];
  const validActions = getValidActions(game);
  const toCall = getToCall(game, seat);

  // Broadcast full state so all players see updated board, pot, and active player
  if (io.broadcastState) io.broadcastState();

  io.broadcast('turn', {
    seat,
    player: p.id,
    validActions,
    toCall,
    pot: game.pot,
    minRaise: game.minRaise
  });

  const response = await io.waitForAction(p.id, validActions, 15000);

  if (!response) {
    const action = validActions.includes(CHECK) ? CHECK : FOLD;
    playerAction(game, seat, action);
    io.broadcast('action', { seat, player: p.id, action, amount: 0, timeout: true });
    io.log(`${p.id} timed out: ${action}`);
  } else {
    const { action, amount } = response;
    if (!validActions.includes(action)) {
      playerAction(game, seat, FOLD);
      io.broadcast('action', { seat, player: p.id, action: FOLD, amount: 0, invalid: true });
      io.log(`${p.id} invalid action ${action}: fold`);
    } else {
      const chipsBefore = p.chips;
      playerAction(game, seat, action, amount || 0);
      const actualAmount = chipsBefore - p.chips; // How much they actually put in
      io.broadcast('action', {
        seat, player: p.id, action, amount: actualAmount,
        chips: p.chips, pot: game.pot
      });
      io.log(`${p.id}: ${action} ${actualAmount} (pot: ${game.pot})`);
    }
  }
}

function getSBSeat(game) {
  const n = game.players.length;
  return n === 2 ? game.dealerSeat : (game.dealerSeat + 1) % n;
}

function getBBSeat(game) {
  const n = game.players.length;
  return n === 2 ? (game.dealerSeat + 1) % n : (game.dealerSeat + 2) % n;
}

// ============================================================
// Mock backends for testing
// ============================================================

/**
 * Mock crypto backend — just returns sequential card indices
 */
export function createMockCrypto() {
  let cards = [];
  return {
    async initDeck(n) {
      cards = Array.from({ length: n }, (_, i) => i);
      // Shuffle for randomness
      for (let i = cards.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cards[i], cards[j]] = [cards[j], cards[i]];
      }
      return cards;
    },
    async revealCard(pos) {
      return cards[pos];
    }
  };
}

/**
 * Mock IO backend — logs to console, uses pre-scripted actions
 */
export function createMockIO(scriptedActions = []) {
  let actionIndex = 0;
  const log = [];
  const messages = [];

  return {
    broadcast(event, data) {
      messages.push({ type: 'broadcast', event, data });
    },
    sendTo(playerId, event, data) {
      messages.push({ type: 'sendTo', playerId, event, data });
    },
    async waitForAction(playerId, validActions, timeout) {
      if (actionIndex < scriptedActions.length) {
        const action = scriptedActions[actionIndex++];
        return action;
      }
      // Default: check if possible, else call, else fold
      if (validActions.includes(CHECK)) return { action: CHECK };
      if (validActions.includes(CALL)) return { action: CALL };
      return { action: FOLD };
    },
    log(msg) {
      log.push(msg);
    },
    getLog() { return log; },
    getMessages() { return messages; }
  };
}
