/**
 * Full automated game test — plays multiple hands, verifies correctness
 * node test-full-game.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, createMockCrypto, createMockIO } from './poker-engine.mjs';
import { evaluateHand, cardToString, stringToCard } from './hand-eval.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED
} from './game.mjs';

function chips(players) {
  return players.map(p => p.chips);
}
function total(players) {
  return players.reduce((s, p) => s + p.chips, 0);
}

describe('Full Game Simulation', () => {

  it('4 players: chips are conserved across 10 hands', async () => {
    const io = createMockIO();
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);
    engine.addPlayer('Charlie', 200);
    engine.addPlayer('Dave', 200);

    const startTotal = total(engine.game.players);
    assert.equal(startTotal, 800);

    for (let i = 0; i < 10; i++) {
      await engine.playHand(createMockCrypto());
      const t = total(engine.game.players);
      assert.equal(t, 800, `Hand ${i + 1}: chips not conserved (${t} != 800)`);
    }
    console.log('  10 hands played, chips conserved: ' + chips(engine.game.players).join(', '));
  });

  it('4 players: dealer button rotates', async () => {
    const io = createMockIO();
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);
    engine.addPlayer('Charlie', 200);
    engine.addPlayer('Dave', 200);

    const dealers = [];
    for (let i = 0; i < 4; i++) {
      dealers.push(engine.game.dealerSeat);
      await engine.playHand(createMockCrypto());
    }
    console.log('  Dealer positions: ' + dealers.join(', '));
    // All 4 seats should have been dealer
    assert.equal(new Set(dealers).size, 4);
  });

  it('fold gives pot to remaining player', async () => {
    // Script: everyone folds to BB
    const actions = [
      { action: FOLD }, // UTG folds
      { action: FOLD }, // Dealer/SB folds
      { action: FOLD }, // next folds
    ];
    const io = createMockIO(actions);
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);
    engine.addPlayer('Charlie', 200);
    engine.addPlayer('Dave', 200);

    await engine.playHand(createMockCrypto());
    const t = total(engine.game.players);
    assert.equal(t, 800);
    // One player should have gained the blinds
    const maxChips = Math.max(...chips(engine.game.players));
    assert.ok(maxChips > 200, 'Winner should have more than starting chips');
    console.log('  After fold: ' + chips(engine.game.players).join(', '));
  });

  it('all-in showdown deals community cards and picks winner', async () => {
    // Everyone goes all-in preflop
    const actions = [
      { action: ALL_IN }, // UTG
      { action: ALL_IN }, // next
      { action: ALL_IN }, // next
      { action: ALL_IN }, // last
    ];
    const io = createMockIO(actions);
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);
    engine.addPlayer('Charlie', 200);
    engine.addPlayer('Dave', 200);

    await engine.playHand(createMockCrypto());

    // Board should have 5 cards
    assert.equal(engine.game.board.length, 5, 'Board should have 5 community cards');
    // All cards should be valid (0-51)
    for (const c of engine.game.board) {
      assert.ok(c >= 0 && c < 52, 'Invalid board card: ' + c);
    }
    // Chips conserved
    assert.equal(total(engine.game.players), 800);
    // At least one player should have chips (the winner)
    assert.ok(Math.max(...chips(engine.game.players)) > 0, 'Someone should have won');
    console.log('  All-in result: ' + chips(engine.game.players).join(', '));
    console.log('  Board: ' + engine.game.board.map(cardToString).join(' '));
  });

  it('raise and re-raise works correctly', async () => {
    const actions = [
      { action: RAISE, amount: 10 }, // UTG raises
      { action: CALL },              // next calls
      { action: RAISE, amount: 20 }, // next re-raises
      { action: FOLD },              // next folds
      { action: CALL },              // UTG calls
      { action: CALL },              // caller calls
      // Then check through
    ];
    const io = createMockIO(actions);
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);
    engine.addPlayer('Charlie', 200);
    engine.addPlayer('Dave', 200);

    await engine.playHand(createMockCrypto());
    assert.equal(total(engine.game.players), 800);
    console.log('  Raise/re-raise result: ' + chips(engine.game.players).join(', '));
  });

  it('side pots work with different stack sizes', async () => {
    const actions = [
      { action: ALL_IN }, // short stack all-in
      { action: ALL_IN }, // medium all-in
      { action: ALL_IN }, // big stack all-in
      { action: ALL_IN }, // biggest all-in
    ];
    const io = createMockIO(actions);
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 50);   // short
    engine.addPlayer('Bob', 100);    // medium
    engine.addPlayer('Charlie', 200); // big
    engine.addPlayer('Dave', 300);   // biggest

    await engine.playHand(createMockCrypto());
    const t = total(engine.game.players);
    assert.equal(t, 650, 'Total chips should be 650');
    console.log('  Side pots result: ' + chips(engine.game.players).join(', '));
  });

  it('hand evaluation is correct in showdown', async () => {
    // Run 50 all-in hands and verify the best hand always wins
    let correctWins = 0;
    const totalHands = 50;

    for (let h = 0; h < totalHands; h++) {
      const actions = [
        { action: ALL_IN },
        { action: ALL_IN },
      ];
      const io = createMockIO(actions);
      const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
      engine.addPlayer('Alice', 200);
      engine.addPlayer('Bob', 200);

      await engine.playHand(createMockCrypto());

      const g = engine.game;
      if (g.board.length === 5) {
        const scores = g.players.map(p => {
          if (p.holeCards.length === 2) {
            return evaluateHand([...p.holeCards, ...g.board]);
          }
          return -1;
        });

        const winner = g.players.findIndex(p => p.chips > 200);
        if (winner >= 0 && scores[winner] >= scores[1 - winner]) {
          correctWins++;
        } else if (scores[0] === scores[1]) {
          // Tie — both should have 200
          correctWins++;
        }
      } else {
        correctWins++; // Someone folded, no showdown needed
      }
    }

    console.log(`  Correct wins: ${correctWins}/${totalHands}`);
    assert.equal(correctWins, totalHands, 'Best hand should always win');
  });

  it('game survives 100 hands without crashing', async () => {
    const io = createMockIO();
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 500);
    engine.addPlayer('Bob', 500);
    engine.addPlayer('Charlie', 500);
    engine.addPlayer('Dave', 500);

    for (let i = 0; i < 100; i++) {
      await engine.playHand(createMockCrypto());
      const t = total(engine.game.players);
      assert.equal(t, 2000, `Hand ${i + 1}: chips = ${t}`);
      // If someone busted, give them chips back for continued testing
      for (const p of engine.game.players) {
        if (p.chips <= 0) p.chips = 100;
      }
    }
    console.log('  100 hands completed. Final: ' + chips(engine.game.players).join(', '));
  });

  it('messages are correct format for pangea GUI', async () => {
    const io = createMockIO();
    const engine = createEngine({ smallBlind: 1, bigBlind: 2 }, io);
    engine.addPlayer('Alice', 200);
    engine.addPlayer('Bob', 200);

    await engine.playHand(createMockCrypto());

    const msgs = io.getMessages();
    const events = msgs.map(m => m.event);

    // Should have key events
    assert.ok(events.includes('hand_start'), 'Missing hand_start');
    assert.ok(events.includes('blinds_posted'), 'Missing blinds_posted');
    assert.ok(events.includes('cards_dealt'), 'Missing cards_dealt');
    assert.ok(events.includes('turn'), 'Missing turn');
    assert.ok(events.includes('action'), 'Missing action');

    // Hole cards should be sent privately
    const holeMsgs = msgs.filter(m => m.event === 'hole_cards');
    assert.equal(holeMsgs.length, 2);
    assert.equal(holeMsgs[0].type, 'sendTo');
    assert.equal(holeMsgs[1].type, 'sendTo');
    assert.notEqual(holeMsgs[0].playerId, holeMsgs[1].playerId);

    // Each hole card message should have 2 valid cards
    for (const hm of holeMsgs) {
      assert.equal(hm.data.cards.length, 2);
      for (const c of hm.data.cards) {
        assert.ok(c >= 0 && c < 52, 'Invalid hole card: ' + c);
      }
    }

    console.log('  Message count: ' + msgs.length + ' events across hand');
  });
});
