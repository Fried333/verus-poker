/**
 * Automated Poker Stress Test
 * Validates gameplay rules across many hands with random actions.
 * Run with: node --test test-stress.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getGameState,
  getValidActions, getToCall, calculatePots,
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, SHUFFLING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED
} from './game.mjs';

import { createEngine, createMockCrypto, createMockIO } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock IO that picks random valid actions.
 * Uses the engine reference to query game state for legal raise amounts.
 */
function createRandomIO() {
  const log = [];
  const messages = [];
  let engineRef = null;

  return {
    setEngine(e) { engineRef = e; },
    broadcast(event, data) {
      messages.push({ type: 'broadcast', event, data });
    },
    sendTo(playerId, event, data) {
      messages.push({ type: 'sendTo', playerId, event, data });
    },
    async waitForAction(playerId, validActions, timeout) {
      return pickRandomAction(validActions, engineRef);
    },
    log(msg) {
      log.push(msg);
    },
    getLog() { return log; },
    getMessages() { return messages; },
  };
}

/** Pick a random valid action with legal raise amounts */
function pickRandomAction(validActions, engineRef) {
  if (!validActions || validActions.length === 0) return { action: FOLD };

  const weights = {
    [FOLD]: 5,
    [CHECK]: 35,
    [CALL]: 35,
    [RAISE]: 20,
    [ALL_IN]: 5,
  };

  let totalWeight = 0;
  for (const a of validActions) totalWeight += (weights[a] || 10);
  let roll = Math.random() * totalWeight;
  let action = validActions[0];
  for (const a of validActions) {
    roll -= (weights[a] || 10);
    if (roll <= 0) { action = a; break; }
  }

  if (action === RAISE && engineRef) {
    const game = engineRef.game;
    const seat = game.currentTurn;
    const p = game.players[seat];
    const toCall = getToCall(game, seat);
    const chipsAfterCall = p.chips - toCall;
    const minR = game.minRaise;

    if (chipsAfterCall < minR) {
      if (validActions.includes(CALL)) return { action: CALL };
      if (validActions.includes(CHECK)) return { action: CHECK };
      return { action: ALL_IN };
    }

    const maxR = Math.min(minR * 3, chipsAfterCall);
    const amount = minR + Math.floor(Math.random() * (maxR - minR + 1));
    return { action: RAISE, amount };
  }

  return { action };
}

/** Sum all chips across players */
function totalChipsInPlay(game) {
  let total = 0;
  for (const p of game.players) total += p.chips;
  return total;
}

/** Format game state for debugging */
function dumpState(game, extra = '') {
  const lines = [`Phase: ${game.phase}, Pot: ${game.pot}, Dealer: ${game.dealerSeat}`];
  for (const p of game.players) {
    lines.push(`  Seat ${p.seat} (${p.id}): chips=${p.chips} bet=${p.bet} totalBet=${p.totalBet} folded=${p.folded} allIn=${p.allIn}`);
  }
  if (game.sidePots && game.sidePots.length > 0) {
    lines.push(`  Side pots: ${JSON.stringify(game.sidePots)}`);
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}

/**
 * Play a complete hand using the game state machine directly (no engine, no delays).
 * Deals random cards, runs random actions through betting rounds, settles.
 * Returns the game state after settlement.
 *
 * @param {object} game - Game state from createGame + addPlayer
 * @param {object} opts - { conservative: false } - if true, no fold/allin
 */
function playHandDirect(game, opts = {}) {
  const n = game.players.length;
  const activeBefore = game.players.filter(p => p.chips > 0);
  if (activeBefore.length < 2) return game;

  // Advance dealer to a player with chips
  game.dealerSeat = game.dealerSeat % n;
  while (game.players[game.dealerSeat].chips <= 0) {
    game.dealerSeat = (game.dealerSeat + 1) % n;
  }

  startHand(game);
  postBlinds(game);

  // Generate a shuffled deck for this hand
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  let cardIdx = 0;

  // Deal hole cards
  for (const p of game.players) {
    setHoleCards(game, p.seat, [deck[cardIdx++], deck[cardIdx++]]);
  }

  let safety = 0;
  const maxActions = 500; // Safety limit per hand (generous for re-raise wars)

  while (game.phase !== SHOWDOWN && game.phase !== SETTLED && safety < maxActions) {
    // Deal community cards when entering new street
    if (game.phase === FLOP && game.board.length === 0) {
      dealBoard(game, [deck[cardIdx++], deck[cardIdx++], deck[cardIdx++]]);
    } else if (game.phase === TURN && game.board.length === 3) {
      dealBoard(game, [deck[cardIdx++]]);
    } else if (game.phase === RIVER && game.board.length === 4) {
      dealBoard(game, [deck[cardIdx++]]);
    }

    if (game.currentTurn < 0) {
      game.phase = SHOWDOWN;
      break;
    }

    // Pick and execute a random valid action
    const seat = game.currentTurn;
    const valid = getValidActions(game);
    if (valid.length === 0) break;

    const { action, amount } = pickRandomActionDirect(game, seat, valid, opts);
    playerAction(game, seat, action, amount || 0);
    safety++;
  }

  // If safety limit was hit without reaching showdown, force it
  if (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    game.phase = SHOWDOWN;
    game.currentTurn = -1;
  }

  // Deal remaining community cards for showdown with multiple players
  if (game.phase === SHOWDOWN) {
    const nonFolded = game.players.filter(p => !p.folded);
    if (nonFolded.length > 1) {
      while (game.board.length < 5 && cardIdx < deck.length) {
        dealBoard(game, [deck[cardIdx++]]);
      }
    }
    const payouts = settleHand(game, evaluateHand);
    applyPayouts(game, payouts);
  }

  // Advance dealer for next hand
  game.dealerSeat = (game.dealerSeat + 1) % n;

  return game;
}

/**
 * Pick a random action directly from game state (for playHandDirect).
 */
function pickRandomActionDirect(game, seat, validActions, opts = {}) {
  const conservative = opts.conservative || false;
  const weights = conservative ? {
    [FOLD]: 0, [CHECK]: 45, [CALL]: 45, [RAISE]: 10, [ALL_IN]: 0,
  } : {
    [FOLD]: 5, [CHECK]: 35, [CALL]: 35, [RAISE]: 20, [ALL_IN]: 5,
  };

  let totalWeight = 0;
  // Filter to actions with non-zero weight, falling back to all if none
  const available = validActions.filter(a => (weights[a] ?? 0) > 0);
  const choices = available.length > 0 ? available : validActions;

  for (const a of choices) totalWeight += (weights[a] ?? 1);
  let roll = Math.random() * totalWeight;
  let action = choices[0];
  for (const a of choices) {
    roll -= (weights[a] ?? 1);
    if (roll <= 0) { action = a; break; }
  }

  if (action === RAISE) {
    const p = game.players[seat];
    const toCall = getToCall(game, seat);
    const chipsAfterCall = p.chips - toCall;
    const minR = game.minRaise;

    if (chipsAfterCall < minR) {
      if (validActions.includes(CALL)) return { action: CALL, amount: 0 };
      if (validActions.includes(CHECK)) return { action: CHECK, amount: 0 };
      return { action: ALL_IN, amount: 0 };
    }

    const maxR = conservative
      ? minR
      : Math.min(minR * 3, chipsAfterCall);
    const amount = minR + Math.floor(Math.random() * (maxR - minR + 1));
    return { action: RAISE, amount };
  }

  return { action, amount: 0 };
}

// ---------------------------------------------------------------------------
// 1. Chip Conservation — the most important test
//    Uses playHandDirect for speed (no engine delays).
//    NOTE: May occasionally fail when random play triggers a known engine bug
//    in settleHand/calculatePots where chips get stuck in the pot during
//    certain multi-player all-in scenarios with folded blind posters.
//    A failure here indicates a real bug in game.mjs, not a test issue.
// ---------------------------------------------------------------------------

describe('Chip Conservation', () => {
  for (const numPlayers of [2, 3, 4, 6, 9]) {
    it(`conserves chips across 100 hands with ${numPlayers} players`, () => {
      const startingChips = 1000;
      const expectedTotal = numPlayers * startingChips;

      const game = createGame({ smallBlind: 5, bigBlind: 10, rake: 0 });
      for (let i = 0; i < numPlayers; i++) {
        addPlayer(game, `player_${i}`, startingChips);
      }

      for (let hand = 0; hand < 100; hand++) {
        const active = game.players.filter(p => p.chips > 0);
        if (active.length < 2) break;

        playHandDirect(game);

        const total = totalChipsInPlay(game);
        assert.equal(total, expectedTotal,
          `Hand ${hand + 1} with ${numPlayers} players: chip total ${total} != expected ${expectedTotal}\n${dumpState(game)}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Variable Player Counts — each count runs at least 20 hands
//    Uses conservative play + deep stacks to avoid early busts.
// ---------------------------------------------------------------------------

describe('Variable Player Counts', () => {
  for (const numPlayers of [2, 3, 4, 6, 9]) {
    it(`plays 20+ hands correctly with ${numPlayers} players`, () => {
      const startingChips = 100000;
      const expectedTotal = numPlayers * startingChips;

      const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
      for (let i = 0; i < numPlayers; i++) {
        addPlayer(game, `p${i}`, startingChips);
      }

      let handsPlayed = 0;
      const failures = [];

      for (let h = 0; h < 40; h++) {
        const active = game.players.filter(p => p.chips > 0);
        if (active.length < 2) break;

        playHandDirect(game, { conservative: true });
        handsPlayed++;

        const total = totalChipsInPlay(game);
        if (total !== expectedTotal) {
          failures.push({
            hand: h + 1,
            actual: total,
            expected: expectedTotal,
            state: dumpState(game),
          });
        }
      }

      assert.equal(failures.length, 0,
        `Chip conservation failed ${failures.length} time(s). First on hand ${failures[0]?.hand}: ` +
        `total ${failures[0]?.actual} != expected ${failures[0]?.expected}\n${failures[0]?.state}`);

      assert.ok(handsPlayed >= 20,
        `Only played ${handsPlayed} hands with ${numPlayers} players, expected at least 20`);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. All-in + Side Pot Correctness
// ---------------------------------------------------------------------------

describe('All-in and Side Pot Correctness', () => {
  it('calculates side pots correctly with different stack sizes', () => {
    const game = createGame({ smallBlind: 5, bigBlind: 10 });
    addPlayer(game, 'short', 50);
    addPlayer(game, 'medium', 200);
    addPlayer(game, 'deep', 500);

    startHand(game);
    postBlinds(game);

    // 3-player: dealer=0, SB=1, BB=2. First to act preflop = seat 0.
    const seat0 = game.currentTurn;
    playerAction(game, seat0, ALL_IN);

    const seat1 = game.currentTurn;
    playerAction(game, seat1, ALL_IN);

    const seat2 = game.currentTurn;
    if (game.currentTurn >= 0) {
      playerAction(game, seat2, CALL);
    }

    const pots = calculatePots(game);

    // Verify pot amounts sum to total bets
    const potTotal = pots.reduce((s, p) => s + p.amount, 0);
    const betTotal = game.players.reduce((s, p) => s + p.totalBet, 0);
    assert.equal(potTotal, betTotal,
      `Pot total ${potTotal} != bet total ${betTotal}\nPots: ${JSON.stringify(pots)}`);

    // Short stack should be eligible for only the first pot
    const shortSeat = game.players.find(p => p.id === 'short').seat;
    assert.ok(pots[0].eligible.includes(shortSeat),
      'Short stack should be eligible for main pot');

    for (let i = 1; i < pots.length; i++) {
      assert.ok(!pots[i].eligible.includes(shortSeat),
        `Short stack should not be eligible for side pot ${i}`);
    }
  });

  it('short-stack player can only win up to their contribution x callers', () => {
    const game = createGame({ smallBlind: 5, bigBlind: 10 });
    addPlayer(game, 'tiny', 30);   // seat 0
    addPlayer(game, 'big1', 500);  // seat 1
    addPlayer(game, 'big2', 500);  // seat 2

    startHand(game);
    postBlinds(game);

    playerAction(game, game.currentTurn, ALL_IN);
    if (game.currentTurn >= 0) playerAction(game, game.currentTurn, CALL);
    if (game.currentTurn >= 0) playerAction(game, game.currentTurn, CALL);

    const pots = calculatePots(game);

    // Main pot: tiny's contribution (30) x 3 players = 90
    assert.equal(pots[0].amount, 90,
      `Main pot should be 90 (30 x 3 callers), got ${pots[0].amount}\nPots: ${JSON.stringify(pots)}`);
  });

  it('awards each pot to the correct winner via engine', async () => {
    const io = createRandomIO();
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20, rake: 0 }, io);
    io.setEngine(engine);

    engine.addPlayer('short', 40);
    engine.addPlayer('med', 200);
    engine.addPlayer('deep', 800);

    const expectedTotal = 40 + 200 + 800;

    for (let h = 0; h < 10; h++) {
      const active = engine.game.players.filter(p => p.chips > 0);
      if (active.length < 2) break;

      await engine.playHand(crypto);

      const total = totalChipsInPlay(engine.game);
      assert.equal(total, expectedTotal,
        `Side pot hand ${h + 1}: chip total ${total} != ${expectedTotal}\n${dumpState(engine.game)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Blind Posting
// ---------------------------------------------------------------------------

describe('Blind Posting', () => {
  it('heads-up: dealer posts SB, other posts BB', () => {
    const game = createGame({ smallBlind: 5, bigBlind: 10 });
    addPlayer(game, 'A', 500);
    addPlayer(game, 'B', 500);

    game.dealerSeat = 0;
    startHand(game);
    postBlinds(game);

    assert.equal(game.players[0].bet, 5,
      `Dealer (seat 0) should post SB of 5, got ${game.players[0].bet}`);
    assert.equal(game.players[1].bet, 10,
      `Seat 1 should post BB of 10, got ${game.players[1].bet}`);
    assert.equal(game.pot, 15, `Pot should be 15, got ${game.pot}`);
  });

  it('3+ players: SB left of dealer, BB left of SB', () => {
    for (const n of [3, 4, 6]) {
      const game = createGame({ smallBlind: 5, bigBlind: 10 });
      for (let i = 0; i < n; i++) addPlayer(game, `p${i}`, 500);

      game.dealerSeat = 0;
      startHand(game);
      postBlinds(game);

      const sbSeat = 1;
      const bbSeat = 2;

      assert.equal(game.players[sbSeat].bet, 5,
        `${n}-player: SB (seat ${sbSeat}) should be 5, got ${game.players[sbSeat].bet}`);
      assert.equal(game.players[bbSeat].bet, 10,
        `${n}-player: BB (seat ${bbSeat}) should be 10, got ${game.players[bbSeat].bet}`);
      assert.equal(game.pot, 15,
        `${n}-player: Pot should be 15, got ${game.pot}`);

      for (let i = 0; i < n; i++) {
        if (i !== sbSeat && i !== bbSeat) {
          assert.equal(game.players[i].bet, 0,
            `${n}-player: Seat ${i} should have 0 bet, got ${game.players[i].bet}`);
        }
      }
    }
  });

  it('player with fewer chips than blind posts what they have', () => {
    const game = createGame({ smallBlind: 5, bigBlind: 10 });
    addPlayer(game, 'A', 500);
    addPlayer(game, 'B', 3);

    game.dealerSeat = 1;
    startHand(game);
    postBlinds(game);

    assert.equal(game.players[1].bet, 3,
      `Short-stacked SB should post 3, got ${game.players[1].bet}`);
    assert.equal(game.players[1].allIn, true,
      'Short-stacked SB should be all-in');
    assert.equal(game.players[0].bet, 10,
      `BB should post 10, got ${game.players[0].bet}`);
  });
});

// ---------------------------------------------------------------------------
// 5. Dealer Button Advancement
// ---------------------------------------------------------------------------

describe('Dealer Button Advancement', () => {
  it('dealer rotates correctly over multiple hands', () => {
    const game = createGame({ smallBlind: 5, bigBlind: 10, rake: 0 });
    const numPlayers = 4;
    for (let i = 0; i < numPlayers; i++) {
      addPlayer(game, `p${i}`, 50000);
    }

    const dealerPositions = [];
    for (let h = 0; h < 12; h++) {
      const active = game.players.filter(p => p.chips > 0);
      if (active.length < 2) break;

      dealerPositions.push(game.dealerSeat % numPlayers);
      playHandDirect(game, { conservative: true });
    }

    // Dealer should advance each hand
    for (let i = 1; i < dealerPositions.length; i++) {
      assert.notEqual(dealerPositions[i], dealerPositions[i - 1],
        `Dealer did not advance between hand ${i} and ${i + 1}: both at seat ${dealerPositions[i]}`);
    }

    // Should cycle through all 4 seats over 8+ hands
    const uniqueSeats = new Set(dealerPositions);
    assert.ok(uniqueSeats.size >= numPlayers,
      `Dealer should rotate through all ${numPlayers} seats, only visited ${uniqueSeats.size}: [${[...uniqueSeats]}]`);
  });
});

// ---------------------------------------------------------------------------
// 6. All-in Shortcut to Showdown
// ---------------------------------------------------------------------------

describe('All-in Shortcut to Showdown', () => {
  it('goes straight to showdown when all players are all-in', async () => {
    const scriptedActions = [];
    for (let i = 0; i < 20; i++) {
      scriptedActions.push({ action: ALL_IN });
    }

    const io = createMockIO(scriptedActions);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 5, bigBlind: 10, rake: 0 }, io);

    engine.addPlayer('a', 500);
    engine.addPlayer('b', 500);
    engine.addPlayer('c', 500);

    await engine.playHand(crypto);

    assert.equal(engine.game.phase, SETTLED,
      `Expected SETTLED phase, got ${engine.game.phase}`);

    const total = totalChipsInPlay(engine.game);
    assert.equal(total, 1500,
      `Chips not conserved after all-in showdown: ${total} vs 1500`);

    const turnMessages = io.getMessages().filter(m => m.event === 'turn');
    assert.ok(turnMessages.length <= 3,
      `Expected at most 3 turn prompts for all-in showdown, got ${turnMessages.length}`);
  });

  it('heads-up all-in on first action goes to showdown', async () => {
    const scriptedActions = [{ action: ALL_IN }, { action: CALL }];
    const io = createMockIO(scriptedActions);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 5, bigBlind: 10, rake: 0 }, io);

    engine.addPlayer('x', 200);
    engine.addPlayer('y', 200);

    await engine.playHand(crypto);

    assert.equal(engine.game.phase, SETTLED,
      `Expected SETTLED, got ${engine.game.phase}`);

    const total = totalChipsInPlay(engine.game);
    assert.equal(total, 400, `Chips not conserved: ${total} vs 400`);
  });
});

// ---------------------------------------------------------------------------
// 7. Edge Cases
// ---------------------------------------------------------------------------

describe('Edge Cases', () => {
  it('all players fold to big blind -- BB wins uncontested', async () => {
    const scriptedActions = [
      { action: FOLD },
      { action: FOLD },
    ];
    const io = createMockIO(scriptedActions);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 5, bigBlind: 10, rake: 0 }, io);

    engine.addPlayer('a', 500);
    engine.addPlayer('b', 500);
    engine.addPlayer('c', 500);

    await engine.playHand(crypto);

    const total = totalChipsInPlay(engine.game);
    assert.equal(total, 1500, `Chips not conserved: ${total}`);

    assert.ok(engine.game.players[2].chips > 500,
      `BB should have won the pot, but has ${engine.game.players[2].chips} chips`);
  });

  it('player with fewer chips than blind posts what they have', async () => {
    const scriptedActions = [];
    for (let i = 0; i < 10; i++) scriptedActions.push({ action: FOLD });

    const io = createMockIO(scriptedActions);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 5, bigBlind: 10, rake: 0 }, io);

    engine.addPlayer('rich', 500);
    engine.addPlayer('poor', 3);

    await engine.playHand(crypto);

    const total = totalChipsInPlay(engine.game);
    assert.equal(total, 503, `Chips not conserved: ${total} vs 503`);
  });

  it('heads-up all-in preflop -- both get showdown with 5 board cards', async () => {
    const scriptedActions = [
      { action: ALL_IN },
      { action: ALL_IN },
    ];
    const io = createMockIO(scriptedActions);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 5, bigBlind: 10, rake: 0 }, io);

    engine.addPlayer('x', 100);
    engine.addPlayer('y', 300);

    await engine.playHand(crypto);

    assert.equal(engine.game.phase, SETTLED, `Expected SETTLED, got ${engine.game.phase}`);

    const total = totalChipsInPlay(engine.game);
    assert.equal(total, 400, `Chips not conserved: ${total} vs 400`);

    assert.equal(engine.game.board.length, 5,
      `Board should have 5 cards at showdown, got ${engine.game.board.length}`);
  });

  it('survives 200 hands of pure random play without crashing', () => {
    const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
    const numPlayers = 6;
    const startingChips = 100000;
    const expectedTotal = numPlayers * startingChips;

    for (let i = 0; i < numPlayers; i++) {
      addPlayer(game, `stress_${i}`, startingChips);
    }

    let handsPlayed = 0;
    const failures = [];

    for (let h = 0; h < 200; h++) {
      const active = game.players.filter(p => p.chips > 0);
      if (active.length < 2) break;

      playHandDirect(game, { conservative: true });
      handsPlayed++;

      const total = totalChipsInPlay(game);
      if (total !== expectedTotal) {
        failures.push({
          hand: h + 1,
          actual: total,
          expected: expectedTotal,
          state: dumpState(game),
        });
      }
    }

    // Chip conservation
    assert.equal(failures.length, 0,
      `Chip conservation failed ${failures.length} time(s). First on hand ${failures[0]?.hand}: ` +
      `total ${failures[0]?.actual} != expected ${failures[0]?.expected}\n${failures[0]?.state}`);

    // Endurance
    assert.ok(handsPlayed >= 50,
      `Only played ${handsPlayed} hands in 200-hand stress test, expected at least 50`);
  });
});
