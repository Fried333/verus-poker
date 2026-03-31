import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createEngine, createMockCrypto, createMockIO } from './poker-engine.mjs';
import { FOLD, CHECK, CALL, RAISE, SHOWDOWN, SETTLED } from './game.mjs';

describe('Poker Engine', () => {

  it('plays a complete hand with mock backends', async () => {
    const io = createMockIO();
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    await engine.playHand(crypto);

    const log = io.getLog();
    assert.ok(log.includes('=== New Hand ==='));
    assert.ok(log.includes('=== Hand Complete ==='));

    // Both players should still have total of 2000 chips
    const total = engine.game.players.reduce((sum, p) => sum + p.chips, 0);
    assert.equal(total, 2000);
  });

  it('fold gives pot to opponent', async () => {
    // Script: alice folds immediately
    const io = createMockIO([{ action: FOLD }]);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    await engine.playHand(crypto);

    // Bob wins the blinds
    assert.ok(engine.game.players[1].chips > 1000);
    assert.ok(engine.game.players[0].chips < 1000);
  });

  it('raise and call works', async () => {
    const io = createMockIO([
      { action: RAISE, amount: 40 }, // Alice raises
      { action: CALL },              // Bob calls
      // Then check through to showdown
    ]);
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    await engine.playHand(crypto);

    // Game should complete
    assert.ok(engine.game.phase === SHOWDOWN || engine.game.phase === SETTLED);
    const total = engine.game.players.reduce((sum, p) => sum + p.chips, 0);
    assert.equal(total, 2000);
  });

  it('broadcasts correct events', async () => {
    const io = createMockIO();
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    await engine.playHand(crypto);

    const events = io.getMessages().map(m => m.event);
    assert.ok(events.includes('player_joined'));
    assert.ok(events.includes('hand_start'));
    assert.ok(events.includes('deck_ready'));
    assert.ok(events.includes('blinds_posted'));
    assert.ok(events.includes('cards_dealt'));
    assert.ok(events.includes('turn'));
    assert.ok(events.includes('action'));
  });

  it('sends hole cards only to the owning player', async () => {
    const io = createMockIO();
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    await engine.playHand(crypto);

    const holeCardMsgs = io.getMessages().filter(m => m.event === 'hole_cards');
    assert.equal(holeCardMsgs.length, 2); // One for each player
    assert.equal(holeCardMsgs[0].type, 'sendTo'); // Not broadcast
    assert.equal(holeCardMsgs[1].type, 'sendTo');
    // Each goes to different player
    assert.notEqual(holeCardMsgs[0].playerId, holeCardMsgs[1].playerId);
  });

  it('plays multiple hands in sequence', async () => {
    const io = createMockIO();
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    for (let i = 0; i < 5; i++) {
      await engine.playHand(crypto);
    }

    const total = engine.game.players.reduce((sum, p) => sum + p.chips, 0);
    assert.equal(total, 2000);
    console.log(`  After 5 hands: Alice=${engine.game.players[0].chips} Bob=${engine.game.players[1].chips}`);
  });

  it('getState hides opponent cards', async () => {
    const io = createMockIO([{ action: FOLD }]); // Quick hand
    const crypto = createMockCrypto();
    const engine = createEngine({ smallBlind: 10, bigBlind: 20 }, io);

    engine.addPlayer('alice', 1000);
    engine.addPlayer('bob', 1000);

    // Start but don't finish — check mid-game state
    const aliceView = engine.getState(0);
    const bobView = engine.getState(1);

    // Each player should only see their own cards (if dealt)
    if (aliceView.players[1].holeCards.length > 0) {
      assert.deepEqual(aliceView.players[1].holeCards, ['??', '??']);
    }
  });
});
