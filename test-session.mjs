/**
 * Session manager tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, ACTIVE, SITTING_OUT, CASHING_OUT, CASHED_OUT, DISCONNECTED } from './session.mjs';

function mockSession() {
  return createSession({}, 'house', 'RHouseAddr');
}

describe('Session Manager', () => {

  it('buy-in creates active player', () => {
    const s = mockSession();
    const r = s.buyinDirect('alice', 'RAliceAddr', 5.0);
    assert.ok(r.ok);
    assert.equal(r.chips, 5.0);
    assert.equal(s.getPlayer('alice').status, ACTIVE);
    assert.equal(s.getActivePlayers().length, 1);
  });

  it('multiple players can join', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.buyinDirect('charlie', 'RCharlie', 5.0);
    assert.equal(s.getActivePlayers().length, 3);
    assert.equal(s.getStatus().active, 3);
  });

  it('updateChips changes balances', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.updateChips([{ id: 'alice', chips: 7.0 }, { id: 'bob', chips: 3.0 }]);
    assert.equal(s.getPlayer('alice').chips, 7.0);
    assert.equal(s.getPlayer('bob').chips, 3.0);
  });

  it('request leave marks sitting out', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    const r = s.requestLeave('alice');
    assert.ok(r.ok);
    assert.equal(s.getPlayer('alice').status, SITTING_OUT);
    assert.equal(s.getActivePlayers().length, 0); // Not dealt next hand
  });

  it('sitting out player cashed out after 1 hand', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.requestLeave('alice');

    // Simulate end of hand
    const toCashOut = s.processEndOfHand();
    assert.equal(toCashOut.length, 1);
    assert.equal(toCashOut[0].id, 'alice');
    assert.equal(toCashOut[0].amount, 5.0);
    assert.equal(s.getPlayer('alice').status, CASHING_OUT);
  });

  it('disconnected player gets 2 hands to reconnect', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.playerDisconnected('alice');
    assert.equal(s.getPlayer('alice').status, DISCONNECTED);

    // First hand end — still has 1 hand left
    let toCashOut = s.processEndOfHand();
    assert.equal(toCashOut.length, 0);

    // Second hand end — now cash out
    toCashOut = s.processEndOfHand();
    assert.equal(toCashOut.length, 1);
    assert.equal(toCashOut[0].id, 'alice');
  });

  it('reconnect before timeout keeps player active', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.playerDisconnected('alice');

    s.processEndOfHand(); // 1 hand passes

    // Reconnect before second hand
    const reconnected = s.playerReconnected('alice');
    assert.ok(reconnected);
    assert.equal(s.getPlayer('alice').status, ACTIVE);

    // Should not cash out
    const toCashOut = s.processEndOfHand();
    assert.equal(toCashOut.length, 0);
  });

  it('busted player auto removed', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.updateChips([{ id: 'alice', chips: 0 }, { id: 'bob', chips: 10.0 }]);
    s.processEndOfHand();
    assert.equal(s.getPlayer('alice').status, CASHED_OUT);
    assert.equal(s.getActivePlayers().length, 1);
  });

  it('chips conserved through session', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.buyinDirect('charlie', 'RCharlie', 5.0);

    // Simulate 5 hands
    const scenarios = [
      [{ id: 'alice', chips: 7 }, { id: 'bob', chips: 4 }, { id: 'charlie', chips: 4 }],
      [{ id: 'alice', chips: 5 }, { id: 'bob', chips: 6 }, { id: 'charlie', chips: 4 }],
      [{ id: 'alice', chips: 3 }, { id: 'bob', chips: 8 }, { id: 'charlie', chips: 4 }],
      [{ id: 'alice', chips: 0 }, { id: 'bob', chips: 11 }, { id: 'charlie', chips: 4 }],
      [{ id: 'bob', chips: 9 }, { id: 'charlie', chips: 6 }],
    ];

    for (const chips of scenarios) {
      s.updateChips(chips);
      s.processEndOfHand();
      const total = [...s.getAllPlayers().values()].reduce((sum, p) => sum + p.chips, 0);
      assert.equal(total, 15, 'Chips not conserved');
    }
  });

  it('session summary shows profit/loss', () => {
    const s = mockSession();
    s.buyinDirect('alice', 'RAlice', 5.0);
    s.buyinDirect('bob', 'RBob', 5.0);
    s.updateChips([{ id: 'alice', chips: 8 }, { id: 'bob', chips: 2 }]);

    const summary = s.getSummary();
    assert.equal(summary.length, 2);
    assert.equal(summary[0].chips, 8);
    assert.equal(summary[1].chips, 2);
  });
});
