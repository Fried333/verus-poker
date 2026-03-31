import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  getValidActions, getToCall, dealBoard, setHoleCards,
  settleHand, applyPayouts, calculatePots, getGameState,
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED, SHUFFLING
} from './game.mjs';

import { evaluateHand, stringToCard } from './hand-eval.mjs';
const cards = (...strs) => strs.map(stringToCard);

function setupHeadsUp(chips1 = 1000, chips2 = 1000) {
  const game = createGame({ smallBlind: 10, bigBlind: 20 });
  addPlayer(game, 'alice', chips1);
  addPlayer(game, 'bob', chips2);
  startHand(game);
  postBlinds(game);
  return game;
}

function setup3Player() {
  const game = createGame({ smallBlind: 10, bigBlind: 20 });
  addPlayer(game, 'alice', 1000);
  addPlayer(game, 'bob', 1000);
  addPlayer(game, 'charlie', 1000);
  startHand(game);
  postBlinds(game);
  return game;
}

describe('Game Setup', () => {

  it('create game and add players', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 1000);
    addPlayer(game, 'bob', 500);
    assert.equal(game.players.length, 2);
    assert.equal(game.phase, WAITING);
  });

  it('cannot add player during game', () => {
    const game = setupHeadsUp();
    assert.throws(() => addPlayer(game, 'charlie', 500), /already started/);
  });

  it('cannot start with 1 player', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 1000);
    assert.throws(() => startHand(game), /at least 2/);
  });
});

describe('Blinds', () => {

  it('heads-up blinds posted correctly', () => {
    const game = setupHeadsUp();
    assert.equal(game.phase, PREFLOP);
    // Dealer (seat 0) posts SB, seat 1 posts BB
    assert.equal(game.players[0].chips, 990); // SB posted
    assert.equal(game.players[1].chips, 980); // BB posted
    assert.equal(game.pot, 30);
  });

  it('3-player blinds posted correctly', () => {
    const game = setup3Player();
    // Dealer=0, SB=1, BB=2
    assert.equal(game.players[0].chips, 1000); // Dealer
    assert.equal(game.players[1].chips, 990);  // SB
    assert.equal(game.players[2].chips, 980);  // BB
    assert.equal(game.pot, 30);
  });

  it('short stack posts partial blind', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 1000);
    addPlayer(game, 'bob', 5); // Only 5 chips
    startHand(game);
    postBlinds(game);
    assert.equal(game.players[1].chips, 0);
    assert.equal(game.players[1].allIn, true);
  });
});

describe('Betting Actions', () => {

  it('fold removes player from hand', () => {
    const game = setupHeadsUp();
    // Seat 0 (SB) acts first heads-up preflop
    playerAction(game, 0, FOLD);
    assert.equal(game.players[0].folded, true);
    assert.equal(game.phase, SHOWDOWN); // Only 1 player left
  });

  it('call matches the bet', () => {
    const game = setupHeadsUp();
    const toCall = getToCall(game, 0);
    assert.equal(toCall, 10); // SB needs 10 more to match BB
    playerAction(game, 0, CALL);
    assert.equal(game.players[0].bet, 20);
    assert.equal(game.players[0].chips, 980);
  });

  it('check when no bet to call', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, CALL); // SB calls
    // BB can check (already posted BB, no raise)
    assert.equal(getToCall(game, 1), 0);
    playerAction(game, 1, CHECK);
    assert.equal(game.phase, FLOP); // Advances to flop
  });

  it('cannot check when there is a bet', () => {
    const game = setupHeadsUp();
    // SB has 10 to call
    assert.throws(() => playerAction(game, 0, CHECK), /Cannot check/);
  });

  it('raise increases the bet', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, RAISE, 30); // Raise 30 on top of the 10 call
    assert.equal(game.players[0].bet, 50); // 10 SB already + 10 call + 30 raise
    assert.equal(game.pot, 70); // 10 SB + 20 BB + 40 more from raise
  });

  it('cannot act out of turn', () => {
    const game = setupHeadsUp();
    assert.throws(() => playerAction(game, 1, CHECK), /Not your turn/);
  });

  it('all-in pushes all chips', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, ALL_IN);
    assert.equal(game.players[0].chips, 0);
    assert.equal(game.players[0].allIn, true);
    assert.equal(game.players[0].bet, 1000);
  });

  it('negative bet amount rejected', () => {
    const game = setupHeadsUp();
    assert.throws(() => playerAction(game, 0, RAISE, -50));
  });
});

describe('Betting Rounds', () => {

  it('preflop → flop after all act', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, CALL);  // SB calls
    playerAction(game, 1, CHECK); // BB checks
    assert.equal(game.phase, FLOP);
  });

  it('flop → turn → river → showdown', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, CALL);  // Preflop
    playerAction(game, 1, CHECK);
    assert.equal(game.phase, FLOP);

    playerAction(game, 1, CHECK); // Flop (post-flop: left of dealer acts first)
    playerAction(game, 0, CHECK);
    assert.equal(game.phase, TURN);

    playerAction(game, 1, CHECK); // Turn
    playerAction(game, 0, CHECK);
    assert.equal(game.phase, RIVER);

    playerAction(game, 1, CHECK); // River
    playerAction(game, 0, CHECK);
    assert.equal(game.phase, SHOWDOWN);
  });

  it('raise resets action around the table', () => {
    const game = setup3Player();
    // Preflop: UTG (seat 0) acts first in 3-player
    playerAction(game, 0, CALL);  // UTG calls
    playerAction(game, 1, RAISE, 20); // SB raises
    // BB and UTG need to act again
    assert.equal(game.currentTurn, 2); // BB's turn
    playerAction(game, 2, CALL);  // BB calls
    assert.equal(game.currentTurn, 0); // UTG's turn again
    playerAction(game, 0, CALL);  // UTG calls the raise
    assert.equal(game.phase, FLOP); // Now everyone has acted
  });
});

describe('Side Pots', () => {

  it('all-in creates side pot', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 100);  // Short stack
    addPlayer(game, 'bob', 1000);
    startHand(game);
    postBlinds(game);

    playerAction(game, 0, ALL_IN); // Alice all-in for 100
    playerAction(game, 1, CALL);   // Bob calls

    const pots = calculatePots(game);
    assert.equal(pots.length, 1); // Only 1 pot since Bob just called
    assert.equal(pots[0].amount, 200);
    assert.deepEqual(pots[0].eligible, [0, 1]);
  });

  it('3-way with different stack sizes creates multiple pots', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 50);
    addPlayer(game, 'bob', 200);
    addPlayer(game, 'charlie', 1000);
    startHand(game);
    postBlinds(game);

    // UTG (alice) goes all-in for 50
    playerAction(game, 0, ALL_IN);
    // SB (bob) goes all-in for 200
    playerAction(game, 1, ALL_IN);
    // BB (charlie) calls
    playerAction(game, 2, CALL);

    const pots = calculatePots(game);
    // Main pot: 50 * 3 = 150 (all 3 eligible)
    // Side pot: (200-50) * 2 = 300 (bob + charlie eligible)
    assert.equal(pots.length, 2);
    assert.equal(pots[0].amount, 150);
    assert.deepEqual(pots[0].eligible, [0, 1, 2]);
    assert.equal(pots[1].amount, 300);
    assert.deepEqual(pots[1].eligible, [1, 2]);
  });
});

describe('Settlement', () => {

  it('last player standing wins', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, FOLD);
    const payouts = settleHand(game, evaluateHand);
    assert.equal(payouts[1], 30); // Bob wins the pot
    assert.equal(payouts[0], 0);
  });

  it('best hand wins at showdown', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, CALL);
    playerAction(game, 1, CHECK);

    // Set cards
    setHoleCards(game, 0, cards('Ah', 'Kh'));  // Alice: AK suited
    setHoleCards(game, 1, cards('2c', '7d'));   // Bob: 27 offsuit

    // Check through to showdown
    for (let round = 0; round < 3; round++) {
      playerAction(game, 1, CHECK);
      playerAction(game, 0, CHECK);
    }

    dealBoard(game, cards('Ac', 'Ks', '3d', '8h', 'Jc'));
    assert.equal(game.phase, SHOWDOWN);

    const payouts = settleHand(game, evaluateHand);
    assert.equal(payouts[0], 40); // Alice wins with two pair
    assert.equal(payouts[1], 0);

    applyPayouts(game, payouts);
    assert.equal(game.players[0].chips, 1020); // 980 + 40
    assert.equal(game.players[1].chips, 980);  // Lost 20
  });

  it('split pot on tie', () => {
    const game = setupHeadsUp();
    playerAction(game, 0, CALL);
    playerAction(game, 1, CHECK);

    // Both have same hand strength (board plays)
    setHoleCards(game, 0, cards('2c', '3d'));
    setHoleCards(game, 1, cards('2d', '3c'));
    dealBoard(game, cards('Ah', 'Kh', 'Qh', 'Jh', 'Th')); // Royal board

    for (let round = 0; round < 3; round++) {
      playerAction(game, 1, CHECK);
      playerAction(game, 0, CHECK);
    }

    const payouts = settleHand(game, evaluateHand);
    assert.equal(payouts[0], 20); // Split pot
    assert.equal(payouts[1], 20);
  });

  it('rake deducted from winnings', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20, rake: 5 }); // 5% rake
    addPlayer(game, 'alice', 1000);
    addPlayer(game, 'bob', 1000);
    startHand(game);
    postBlinds(game);
    playerAction(game, 0, FOLD);

    const payouts = settleHand(game, evaluateHand);
    // Pot is 30, 5% rake = 1.5, rounded down = 1
    assert.ok(payouts[1] < 30);
    assert.ok(payouts[1] >= 28); // Rake shouldn't be huge
  });
});

describe('Game State View', () => {

  it('hides opponent hole cards', () => {
    const game = setupHeadsUp();
    setHoleCards(game, 0, cards('Ah', 'Kh'));
    setHoleCards(game, 1, cards('2c', '7d'));

    const aliceView = getGameState(game, 0);
    assert.deepEqual(aliceView.players[0].holeCards, cards('Ah', 'Kh'));
    assert.deepEqual(aliceView.players[1].holeCards, ['??', '??']);

    const bobView = getGameState(game, 1);
    assert.deepEqual(bobView.players[0].holeCards, ['??', '??']);
    assert.deepEqual(bobView.players[1].holeCards, cards('2c', '7d'));
  });

  it('shows valid actions only to current player', () => {
    const game = setupHeadsUp();
    const aliceView = getGameState(game, 0);
    const bobView = getGameState(game, 1);
    assert.ok(aliceView.validActions.length > 0);
    assert.equal(bobView.validActions.length, 0);
  });
});

describe('Full Hand Simulation', () => {

  it('complete hand: deal, bet, showdown, settle', () => {
    const game = createGame({ smallBlind: 10, bigBlind: 20 });
    addPlayer(game, 'alice', 1000);
    addPlayer(game, 'bob', 1000);
    startHand(game);
    postBlinds(game);

    // Preflop
    setHoleCards(game, 0, cards('Ah', 'Kh'));
    setHoleCards(game, 1, cards('Qd', 'Js'));
    playerAction(game, 0, RAISE, 40);
    playerAction(game, 1, CALL);

    // Flop
    assert.equal(game.phase, FLOP);
    dealBoard(game, cards('Th', '9h', '2c'));
    playerAction(game, 1, CHECK);
    playerAction(game, 0, RAISE, 60);
    playerAction(game, 1, CALL);

    // Turn
    assert.equal(game.phase, TURN);
    dealBoard(game, cards('8h'));
    playerAction(game, 1, CHECK);
    playerAction(game, 0, RAISE, 100);
    playerAction(game, 1, FOLD);

    // Alice wins — Bob folded
    assert.equal(game.phase, SHOWDOWN);
    const payouts = settleHand(game, evaluateHand);
    assert.ok(payouts[0] > 0);
    assert.equal(payouts[1], 0);

    applyPayouts(game, payouts);
    assert.ok(game.players[0].chips > 1000);
    assert.ok(game.players[1].chips < 1000);
    assert.equal(game.players[0].chips + game.players[1].chips, 2000);
  });
});
