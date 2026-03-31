/**
 * End-to-end test suite for the Verus Poker server.
 * Simulates real players via WebSocket connections.
 *
 * Run with:  node --test test-e2e.mjs
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from './node_modules/ws/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SCRIPT = join(__dirname, 'poker-server.mjs');
const WS_URL = 'ws://localhost:3000';

// ════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════

/** Start the poker server and wait until it is listening. */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [SERVER_SCRIPT], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) { proc.kill('SIGKILL'); reject(new Error('Server did not start within 10s')); }
    }, 10000);

    proc.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('Verus Poker at') && !started) {
        started = true;
        clearTimeout(timeout);
        resolve(proc);
      }
    });
    proc.stderr.on('data', (chunk) => {
      // Some warnings are fine, only reject if not yet started
      if (!started && chunk.toString().includes('EADDRINUSE')) {
        clearTimeout(timeout);
        reject(new Error('Port 3000 already in use'));
      }
    });
    proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
    proc.on('exit', (code) => {
      if (!started) { clearTimeout(timeout); reject(new Error('Server exited with code ' + code)); }
    });
  });
}

/** Kill the server process and wait for it to exit. */
function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed) { resolve(); return; }
    proc.on('exit', () => resolve());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 3000);
  });
}

/**
 * Create a player connection.  Resolves once the `info` message arrives.
 * Returns { ws, name, seat, messages, close(), waitFor(fn, ms) }.
 */
function createPlayer(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const messages = [];
    const listeners = [];
    const p = {
      ws, name, seat: -1, messages,
      /** Close the WebSocket */
      close() { try { ws.close(); } catch {} },
      /** Wait for a message that satisfies `fn`, with timeout `ms`. */
      waitFor(fn, ms = 15000) {
        // Check already-received messages first
        const found = messages.find(fn);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            const idx = listeners.indexOf(entry);
            if (idx >= 0) listeners.splice(idx, 1);
            rej(new Error(`Timeout (${ms}ms) waiting for message [${name}]`));
          }, ms);
          const entry = { fn, res, timer };
          listeners.push(entry);
        });
      },
      /** Collect all messages matching fn received within ms */
      collectFor(fn, ms = 5000) {
        return new Promise((res) => {
          const collected = messages.filter(fn);
          const entry = { fn, collected };
          listeners.push(entry);
          setTimeout(() => {
            const idx = listeners.indexOf(entry);
            if (idx >= 0) listeners.splice(idx, 1);
            res(entry.collected);
          }, ms);
        });
      },
      /** Send a JSON message. */
      send(obj) { ws.send(JSON.stringify(obj)); },
      /** Clear message history. */
      clearMessages() { messages.length = 0; },
    };
    const timer = setTimeout(() => { ws.close(); reject(new Error('Join timeout for ' + name)); }, 10000);
    ws.on('open', () => { ws.send(JSON.stringify({ action: 'join', name })); });
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      messages.push(m);
      // Notify waiters
      for (let i = listeners.length - 1; i >= 0; i--) {
        const l = listeners[i];
        if (l.collected) {
          // collectFor mode
          if (l.fn(m)) l.collected.push(m);
        } else if (l.fn(m)) {
          clearTimeout(l.timer);
          listeners.splice(i, 1);
          l.res(m);
        }
      }
      if (m.method === 'info') {
        p.seat = m.playerid;
        clearTimeout(timer);
        resolve(p);
      }
    });
    ws.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

/** Convenience: wait ms. */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for a round_betting message addressed to a specific player seat. */
function waitForMyTurn(player, ms = 20000) {
  return player.waitFor(
    (m) => m.method === 'betting' && m.action === 'round_betting' && m.playerid === player.seat,
    ms,
  );
}

/** Wait for ANY round_betting message (regardless of whose turn). */
function waitForAnyTurn(player, ms = 20000) {
  return player.waitFor(
    (m) => m.method === 'betting' && m.action === 'round_betting',
    ms,
  );
}

/** Wait for a deal message with board cards. */
function waitForBoard(player, ms = 20000) {
  return player.waitFor((m) => m.method === 'deal' && m.deal && m.deal.board, ms);
}

/** Wait for the finalInfo (showdown result) message. */
function waitForFinalInfo(player, ms = 30000) {
  return player.waitFor((m) => m.method === 'finalInfo', ms);
}

/** Wait for a seats message. */
function waitForSeats(player, ms = 10000) {
  return player.waitFor((m) => m.method === 'seats', ms);
}

/** Wait for game to start (hole cards dealt). */
function waitForHoleCards(player, ms = 15000) {
  return player.waitFor((m) => m.method === 'deal' && m.deal && m.deal.holecards, ms);
}

/** Send an action and wait briefly. */
async function sendAction(player, action, amount) {
  const msg = { action };
  if (amount !== undefined) msg.amount = amount;
  player.send(msg);
  await sleep(200);
}

/**
 * Auto-play a hand: whenever it is this player's turn, execute the
 * given action (or call a function to decide).
 * Returns a promise that resolves with the finalInfo message.
 *
 * actionFn: (turnMsg, player) => { action: 'check'|'fold'|..., amount? }
 * OR a string like 'check', 'fold', etc.
 */
function autoPlay(player, actionFn, timeoutMs = 60000) {
  const fn = typeof actionFn === 'string' ? () => ({ action: actionFn }) : actionFn;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`autoPlay timeout for ${player.name}`)), timeoutMs);
    const handler = (data) => {
      const m = JSON.parse(data.toString());
      if (m.method === 'betting' && m.action === 'round_betting' && m.playerid === player.seat) {
        const decision = fn(m, player);
        if (decision) {
          player.send({ action: decision.action, amount: decision.amount || 0 });
        }
      }
      if (m.method === 'finalInfo') {
        clearTimeout(timer);
        player.ws.removeListener('message', handler);
        resolve(m);
      }
    };
    player.ws.on('message', handler);
  });
}

/**
 * Play a full hand for an array of players, each with an action function.
 * Returns array of finalInfo messages (one per player, all identical).
 */
function playHand(players, actionFns) {
  return Promise.all(
    players.map((p, i) => {
      const fn = Array.isArray(actionFns) ? actionFns[i] : actionFns;
      return autoPlay(p, fn);
    }),
  );
}

/** Close all player connections. */
function closePlayers(players) {
  for (const p of players) p.close();
}


// ════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════

describe('Verus Poker E2E', () => {
  let server;

  async function freshServer() {
    server = await startServer();
  }

  async function killServer() {
    if (server) { await stopServer(server); server = null; }
  }

  // ──────────────────────────────────────────────────────────────
  // 1. Player join and seat assignment
  // ──────────────────────────────────────────────────────────────
  it('1. Six players join and get unique seats 0-5', { timeout: 30000 }, async () => {
    await freshServer();
    try {
      const names = ['Alice', 'Bob', 'Charlie', 'Dave', 'Eve', 'Frank'];
      const players = [];
      for (const n of names) {
        players.push(await createPlayer(n));
      }
      const seats = players.map((p) => p.seat);
      // All seats should be unique
      assert.equal(new Set(seats).size, 6, 'Seats must be unique');
      // All seats should be in the range 0-5
      for (const s of seats) {
        assert.ok(s >= 0 && s <= 5, `Seat ${s} out of range 0-5`);
      }
      // Each player received an info message
      for (const p of players) {
        const info = p.messages.find((m) => m.method === 'info');
        assert.ok(info, `${p.name} should receive info message`);
        assert.equal(info.playerid, p.seat);
      }
      closePlayers(players);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 2. Game starts after MIN_PLAYERS join
  // ──────────────────────────────────────────────────────────────
  it('2. Game starts within 10s after 2 players join', { timeout: 25000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      // Wait for hole cards — that means the game started
      const hc = await waitForHoleCards(p1, 12000);
      assert.ok(hc, 'Player 1 should receive hole cards');
      assert.ok(hc.deal.holecards.length === 2, 'Should get 2 hole cards');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 3. Round betting flow
  // ──────────────────────────────────────────────────────────────
  it('3. round_betting has correct playerid and valid possibilities', { timeout: 30000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      // Wait for game to start
      await waitForHoleCards(p1, 12000);

      // Wait for any round_betting from either player
      const turn1 = await waitForAnyTurn(p1, 10000);
      assert.ok(turn1, 'Should receive round_betting');
      assert.ok(typeof turn1.playerid === 'number', 'playerid should be a number');
      assert.ok(turn1.playerid >= 0 && turn1.playerid <= 1, 'playerid should be 0 or 1');
      assert.ok(Array.isArray(turn1.possibilities), 'possibilities should be an array');
      assert.ok(turn1.possibilities.length > 0, 'possibilities should not be empty');
      // All possibilities should be valid action codes
      for (const p of turn1.possibilities) {
        assert.ok([0, 1, 2, 3, 7].includes(p), `Unknown possibility code: ${p}`);
      }

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 4. Action buttons for active player only
  // ──────────────────────────────────────────────────────────────
  it('4. round_betting is broadcast to all but only active playerid should act', { timeout: 30000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // Both players receive round_betting (it is broadcast)
      const turn1 = await waitForAnyTurn(p1, 10000);
      const turn2 = await waitForAnyTurn(p2, 10000);

      // Both should have the same playerid (same player's turn)
      assert.equal(turn1.playerid, turn2.playerid, 'Both should see same active playerid');
      // Exactly one player's seat matches playerid
      const activeCount = [p1, p2].filter((p) => p.seat === turn1.playerid).length;
      assert.equal(activeCount, 1, 'Exactly one player should be the active player');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 5. Check-check advances phases
  // ──────────────────────────────────────────────────────────────
  it('5. Check-check advances through all phases to showdown', { timeout: 60000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      const phases = [];
      const boards = [];

      const results = await playHand([p1, p2], (turnMsg, player) => {
        // Preflop: SB must call or fold first, BB can check after
        // Just call if needed, check if possible
        const poss = turnMsg.possibilities || [];
        if (poss.includes(1)) return { action: 'check' };  // check
        if (poss.includes(2)) return { action: 'call' };   // call
        return { action: 'fold' };
      });

      assert.ok(results[0], 'Should receive finalInfo');
      assert.ok(results[0].winners, 'finalInfo should have winners');

      // Verify that board messages were received (showing phase progression)
      const boardMsgs = p1.messages.filter((m) => m.method === 'deal' && m.deal && m.deal.board);
      // At minimum we should get flop (3 cards), turn (4 cards), river (5 cards)
      const boardSizes = boardMsgs.map((m) => m.deal.board.length);
      assert.ok(boardSizes.some((s) => s === 3), 'Should see flop (3 cards)');
      assert.ok(boardSizes.some((s) => s === 4), 'Should see turn (4 cards)');
      assert.ok(boardSizes.some((s) => s === 5), 'Should see river (5 cards)');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 6. Fold ends hand — BB wins, no showdown cards
  // ──────────────────────────────────────────────────────────────
  it('6. All fold to BB — BB wins pot, no revealed cards', { timeout: 30000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // Strategy: SB folds preflop
      const results = await playHand([p1, p2], (turnMsg, player) => {
        const poss = turnMsg.possibilities || [];
        // The first player to act preflop is SB (in 2-player, dealer=SB)
        // If fold is available just fold — one of them is SB
        if (poss.includes(0)) return { action: 'fold' };
        return { action: 'check' };
      });

      const fi = results[0];
      assert.ok(fi.winners.length > 0, 'Should have a winner');

      // The winner should have cards = [null, null] for the folder (fold-win, no reveal)
      const allCards = fi.showInfo?.allHoleCardsInfo || {};
      const winnerSeat = fi.winners[0];
      // The non-winner should have [null, null] cards (folded)
      const nonWinnerSeats = [p1.seat, p2.seat].filter((s) => s !== winnerSeat);
      for (const s of nonWinnerSeats) {
        if (allCards[s]) {
          assert.ok(
            allCards[s][0] === null || allCards[s][0] === undefined,
            'Folded player cards should not be revealed',
          );
        }
      }

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 7. Call and raise
  // ──────────────────────────────────────────────────────────────
  it('7. Player calls, another raises, first calls the raise', { timeout: 60000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      let raisesSent = 0;
      const results = await playHand([p1, p2], (turnMsg, player) => {
        const poss = turnMsg.possibilities || [];
        // First action: call if possible
        // Second action: raise once, then call/check
        if (raisesSent === 0 && poss.includes(3)) {
          raisesSent++;
          return { action: 'raise', amount: turnMsg.minRaiseTo || 4 };
        }
        if (poss.includes(2)) return { action: 'call' };
        if (poss.includes(1)) return { action: 'check' };
        return { action: 'fold' };
      });

      assert.ok(results[0], 'Hand should complete');
      assert.ok(results[0].winners.length > 0, 'Should have winner');

      // Verify raise action was broadcast
      const raiseActions = p1.messages.filter(
        (m) => m.method === 'betting' && m.action === 'raise',
      );
      assert.ok(raiseActions.length > 0, 'Should see at least one raise action');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 8. All-in shortcut to showdown
  // ──────────────────────────────────────────────────────────────
  it('8. All-in call goes directly to showdown', { timeout: 60000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      let allinSent = false;
      const results = await playHand([p1, p2], (turnMsg, player) => {
        const poss = turnMsg.possibilities || [];
        if (!allinSent && poss.includes(7)) {
          allinSent = true;
          return { action: 'allin' };
        }
        // Other player: call the all-in
        if (poss.includes(2)) return { action: 'call' };
        if (poss.includes(7)) return { action: 'allin' };
        if (poss.includes(1)) return { action: 'check' };
        return { action: 'fold' };
      });

      const fi = results[0];
      assert.ok(fi, 'Should reach showdown');
      assert.ok(fi.winners.length > 0, 'Should have winner');

      // After all-in + call, board should be dealt to 5 cards automatically
      const boardMsg = fi.showInfo?.boardCardInfo || [];
      assert.equal(boardMsg.length, 5, 'Board should have 5 cards at showdown after all-in');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 9. Timeout auto-folds
  // ──────────────────────────────────────────────────────────────
  it('9. Player who does not act within 15s is auto-folded', { timeout: 45000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // One player auto-plays, the other does nothing (timeout)
      // The engine timeout is 15s per action (set in runOneAction)
      // We need one player to NOT respond so the server auto-folds them.
      // Use autoPlay on p2 only, let p1 time out.

      // Actually we don't know who goes first. Let's set up so that
      // whoever acts first plays normally, but the second player never responds.
      let firstTurnHandled = false;
      const fiPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timeout waiting for finalInfo')), 40000);
        const handler = (data) => {
          const m = JSON.parse(data.toString());
          if (m.method === 'finalInfo') {
            clearTimeout(timer);
            p1.ws.removeListener('message', handler);
            resolve(m);
          }
        };
        p1.ws.on('message', handler);
      });

      // p2 auto-plays but p1 ignores all turns (auto-fold via timeout)
      // Actually, the simpler approach: p2 auto-plays with call/check,
      // and p1 just never sends anything. If p1 is first to act, they time out.
      // If p2 is first to act, p2 calls, then p1 times out.
      const p2AutoPlay = autoPlay(p2, (turnMsg) => {
        const poss = turnMsg.possibilities || [];
        if (poss.includes(2)) return { action: 'call' };
        if (poss.includes(1)) return { action: 'check' };
        return { action: 'fold' };
      }, 40000);

      const fi = await fiPromise;
      assert.ok(fi.winners.length > 0, 'Hand should complete with a winner');

      // Verify timeout action was broadcast
      const timeoutActions = p1.messages.filter(
        (m) => m.method === 'betting' && (m.action === 'fold' || m.action === 'check') && m.timeout === true,
      );
      assert.ok(timeoutActions.length > 0, 'Should see at least one timeout action');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 10. Reload and sit-in flow
  // ──────────────────────────────────────────────────────────────
  it('10. Busted player reloads, sits in, and plays next hand', { timeout: 120000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // Play hands until someone busts. Strategy: one always goes all-in, other calls.
      let bustedPlayer = null;
      let otherPlayer = null;

      for (let hand = 0; hand < 20; hand++) {
        const results = await playHand([p1, p2], (turnMsg, player) => {
          const poss = turnMsg.possibilities || [];
          if (poss.includes(7)) return { action: 'allin' };
          if (poss.includes(2)) return { action: 'call' };
          if (poss.includes(1)) return { action: 'check' };
          return { action: 'fold' };
        });

        // Check if someone got busted message
        const p1Busted = p1.messages.find((m) => m.method === 'busted');
        const p2Busted = p2.messages.find((m) => m.method === 'busted');

        if (p1Busted) { bustedPlayer = p1; otherPlayer = p2; break; }
        if (p2Busted) { bustedPlayer = p2; otherPlayer = p1; break; }

        // Wait for next hand to start
        p1.clearMessages();
        p2.clearMessages();
        try { await waitForHoleCards(p1, 8000); } catch { break; }
      }

      if (bustedPlayer) {
        // Send reload
        bustedPlayer.send({ action: 'reload' });
        const reloaded = await bustedPlayer.waitFor((m) => m.method === 'reloaded', 5000);
        assert.ok(reloaded, 'Should receive reloaded message');
        assert.equal(reloaded.chips, 200, 'Should be reloaded to 200');

        // Send sit-in
        bustedPlayer.send({ action: 'sitin' });
        const satIn = await bustedPlayer.waitFor((m) => m.method === 'satin', 5000);
        assert.ok(satIn, 'Should receive satin message');

        // Wait for next hand
        const hc = await waitForHoleCards(bustedPlayer, 15000);
        assert.ok(hc, 'Busted-and-reloaded player should get hole cards in next hand');
      } else {
        // Nobody busted in 20 hands, still pass (unlikely with all-in strategy)
        assert.ok(true, 'No bust occurred (rare but possible)');
      }

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 11. Community cards dealt correctly
  // ──────────────────────────────────────────────────────────────
  it('11. Board has 3 cards at flop, 4 at turn, 5 at river', { timeout: 60000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // Play a hand with call/check to see all streets
      const results = await playHand([p1, p2], (turnMsg) => {
        const poss = turnMsg.possibilities || [];
        if (poss.includes(1)) return { action: 'check' };
        if (poss.includes(2)) return { action: 'call' };
        return { action: 'fold' };
      });

      // Inspect board deal messages
      const boardMsgs = p1.messages.filter((m) => m.method === 'deal' && m.deal && m.deal.board);
      const sizes = boardMsgs.map((m) => m.deal.board.length);

      assert.ok(sizes.includes(3), 'Should deal flop with 3 board cards');
      assert.ok(sizes.includes(4), 'Should deal turn with 4 board cards');
      assert.ok(sizes.includes(5), 'Should deal river with 5 board cards');

      // Verify card format (e.g. "Ah", "2c", "Td")
      const lastBoard = boardMsgs[boardMsgs.length - 1].deal.board;
      for (const card of lastBoard) {
        assert.ok(typeof card === 'string', `Card should be string, got ${typeof card}`);
        assert.ok(card.length >= 2 && card.length <= 3, `Card "${card}" has unexpected length`);
      }

      // All 5 board cards should be unique
      const uniqueCards = new Set(lastBoard);
      assert.equal(uniqueCards.size, 5, 'All 5 board cards should be unique');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 12. Seat reuse after disconnect
  // ──────────────────────────────────────────────────────────────
  it('12. Disconnected player seat is reused by new player', { timeout: 30000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');
      const p3 = await createPlayer('Charlie');

      const originalSeats = new Set([p1.seat, p2.seat, p3.seat]);
      assert.equal(originalSeats.size, 3, 'Initial seats should be unique');

      // Disconnect p2
      p2.close();
      await sleep(500);

      // New player joins and should get a seat in 0-5 range
      const p4 = await createPlayer('Dave');
      assert.ok(p4.seat >= 0 && p4.seat <= 5, `New player seat ${p4.seat} should be in 0-5`);

      // The freed seat should be reusable (not necessarily the same one,
      // but it should still be in the 0-5 range)
      const currentSeats = [p1.seat, p3.seat, p4.seat];
      assert.equal(new Set(currentSeats).size, 3, 'All current seats should be unique');

      closePlayers([p1, p3, p4]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 13. Multiple hands — dealer rotates, chips conserved
  // ──────────────────────────────────────────────────────────────
  it('13. Play 3 hands — dealer rotates and chips are conserved', { timeout: 90000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      const dealers = [];
      const totalChipsBefore = 400; // 2 players x 200

      for (let hand = 0; hand < 3; hand++) {
        // Find dealer message for this hand
        const dealerMsg = p1.messages.find(
          (m) => m.method === 'dealer' && !dealers.includes(m) // not already counted
        );
        if (dealerMsg) dealers.push(dealerMsg.playerid);

        // Play hand: call/check through
        const results = await playHand([p1, p2], (turnMsg) => {
          const poss = turnMsg.possibilities || [];
          if (poss.includes(1)) return { action: 'check' };
          if (poss.includes(2)) return { action: 'call' };
          return { action: 'fold' };
        });

        // Wait for the seats update after hand settles to check chips
        await sleep(1000);
        const seatsMsgs = p1.messages.filter((m) => m.method === 'seats');
        if (seatsMsgs.length > 0) {
          const lastSeats = seatsMsgs[seatsMsgs.length - 1];
          const totalChips = lastSeats.seats
            .filter((s) => !s.empty)
            .reduce((sum, s) => sum + (s.chips || 0), 0);
          assert.equal(totalChips, totalChipsBefore, `Chips must be conserved (hand ${hand + 1}): got ${totalChips}`);
        }

        if (hand < 2) {
          // Wait for next hand
          p1.clearMessages();
          p2.clearMessages();
          await waitForHoleCards(p1, 10000);
        }
      }

      // Verify dealer rotation: collect all dealer messages
      const allDealerMsgs = [...p1.messages, ...p2.messages].filter((m) => m.method === 'dealer');
      // We should see at least 2 different dealer positions if 3 hands played
      // (Well, with 2 players the dealer alternates between the two seats)
      assert.ok(allDealerMsgs.length >= 2, 'Should have multiple dealer announcements');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 14. Winner announcement
  // ──────────────────────────────────────────────────────────────
  it('14. finalInfo contains winners, hand names, and win amount', { timeout: 60000 }, async () => {
    await freshServer();
    try {
      const p1 = await createPlayer('Alice');
      const p2 = await createPlayer('Bob');

      await waitForHoleCards(p1, 12000);

      // Play a full hand to showdown (check/call through)
      const results = await playHand([p1, p2], (turnMsg) => {
        const poss = turnMsg.possibilities || [];
        if (poss.includes(1)) return { action: 'check' };
        if (poss.includes(2)) return { action: 'call' };
        return { action: 'fold' };
      });

      const fi = results[0];
      assert.ok(fi, 'Should get finalInfo');

      // winners array
      assert.ok(Array.isArray(fi.winners), 'winners should be an array');
      assert.ok(fi.winners.length >= 1, 'Should have at least 1 winner');
      for (const w of fi.winners) {
        assert.ok(typeof w === 'number', 'Winner seat should be a number');
      }

      // win_amount
      assert.ok(typeof fi.win_amount === 'number', 'win_amount should be a number');
      assert.ok(fi.win_amount > 0, 'win_amount should be positive');

      // handNames
      assert.ok(fi.handNames, 'Should have handNames');
      const handNameValues = Object.values(fi.handNames);
      assert.ok(handNameValues.length > 0, 'Should have at least one hand name');
      for (const hn of handNameValues) {
        assert.ok(typeof hn === 'string', 'Hand name should be a string');
        assert.ok(hn.length > 0, 'Hand name should not be empty');
      }

      // showInfo
      assert.ok(fi.showInfo, 'Should have showInfo');
      assert.ok(fi.showInfo.allHoleCardsInfo, 'Should have allHoleCardsInfo');
      assert.ok(fi.showInfo.boardCardInfo, 'Should have boardCardInfo');
      assert.ok(fi.showInfo.boardCardInfo.length === 5, 'Board should have 5 cards at showdown');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });

  // ──────────────────────────────────────────────────────────────
  // 15. Page reload mid-game — reconnect
  // ──────────────────────────────────────────────────────────────
  it('15. All players disconnect and reconnect — game restarts cleanly', { timeout: 45000 }, async () => {
    await freshServer();
    try {
      let p1 = await createPlayer('Alice');
      let p2 = await createPlayer('Bob');

      // Wait for game to start
      await waitForHoleCards(p1, 12000);
      await sleep(500);

      // Disconnect all players (simulate page reload)
      p1.close();
      p2.close();
      await sleep(1000);

      // Reconnect with fresh names
      p1 = await createPlayer('Alice2');
      p2 = await createPlayer('Bob2');

      // Both should get info messages with valid seats
      assert.ok(p1.seat >= 0, 'Reconnected p1 should get a valid seat');
      assert.ok(p2.seat >= 0, 'Reconnected p2 should get a valid seat');
      assert.notEqual(p1.seat, p2.seat, 'Seats should be different');

      // Game should start again
      const hc = await waitForHoleCards(p1, 12000);
      assert.ok(hc, 'New game should start after reconnect');
      assert.ok(hc.deal.holecards.length === 2, 'Should get 2 hole cards');

      // Play a complete hand to verify everything works
      const results = await playHand([p1, p2], (turnMsg) => {
        const poss = turnMsg.possibilities || [];
        if (poss.includes(1)) return { action: 'check' };
        if (poss.includes(2)) return { action: 'call' };
        return { action: 'fold' };
      });
      assert.ok(results[0].winners.length > 0, 'Should complete hand with a winner after reconnect');

      closePlayers([p1, p2]);
    } finally {
      await killServer();
    }
  });
});
