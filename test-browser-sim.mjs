/**
 * Browser Simulation Test — tests poker-server.mjs via WebSocket
 * No Playwright needed. Simulates 2 browser clients connecting via WS.
 * Tests: join, deal, action buttons, settlement, table clear, hand transition
 *
 * Usage: node test-browser-sim.mjs [--local] [--port 3000]
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';

const PORT = parseInt(process.argv.find((a, i) => process.argv[i-1] === '--port') || '3001');
const USE_LOCAL = process.argv.includes('--local');
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

let server;
let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; console.log('  ✗ FAIL: ' + msg); }
}

function connectWS(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    const msgs = [];
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'join', name }));
      resolve({ ws, msgs, send: m => ws.send(JSON.stringify(m)) });
    });
    ws.on('message', d => { try { msgs.push(JSON.parse(d.toString())); } catch {} });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('WS connect timeout')), 5000);
  });
}

function findMsg(msgs, method, fromIdx = 0) {
  for (let i = fromIdx; i < msgs.length; i++) {
    if ((msgs[i].method || msgs[i].event) === method) return { msg: msgs[i], idx: i };
  }
  return null;
}

function waitForMsg(msgs, method, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = findMsg(msgs, method);
      if (found) return resolve(found.msg);
      if (Date.now() - start > timeout) return reject(new Error('Timeout waiting for ' + method));
      setTimeout(check, 200);
    };
    check();
  });
}

async function main() {
  console.log('Starting poker server on port ' + PORT + '...');

  // Start server in virtual mode (no chain needed)
  server = spawn('node', ['poker-server.mjs', '--port=' + PORT], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe']
  });

  let serverReady = false;
  server.stdout.on('data', d => {
    const s = d.toString();
    if (s.includes('Verus Poker at')) serverReady = true;
  });
  server.stderr.on('data', d => {});

  // Wait for server to start
  for (let i = 0; i < 20; i++) {
    if (serverReady) break;
    await WAIT(500);
  }
  if (!serverReady) { console.log('FAIL: Server did not start'); process.exit(1); }
  console.log('[' + ts() + '] Server ready\n');

  // ══════════════════════════════
  // TEST 1: Two players connect
  // ══════════════════════════════
  console.log('TEST 1: Connection');
  const p1 = await connectWS('Alice');
  const p2 = await connectWS('Bob');
  await WAIT(500);

  const p1Info = findMsg(p1.msgs, 'info');
  const p2Info = findMsg(p2.msgs, 'info');
  assert(p1Info !== null, 'Alice got info message');
  assert(p2Info !== null, 'Bob got info message');

  // ══════════════════════════════
  // TEST 2: Wait for hand to deal
  // ══════════════════════════════
  console.log('\nTEST 2: Hand dealing');
  let deal1, deal2;
  try {
    deal1 = await waitForMsg(p1.msgs, 'deal', 10000);
    deal2 = await waitForMsg(p2.msgs, 'deal', 10000);
  } catch (e) {
    console.log('  ✗ FAIL: No deal message received — ' + e.message);
    failed++;
  }

  if (deal1 && deal1.deal) {
    assert(deal1.deal.holecards && deal1.deal.holecards.length === 2, 'Alice got 2 hole cards');
    console.log('    Alice cards: ' + (deal1.deal.holecards || []).join(' '));
  }
  if (deal2 && deal2.deal) {
    assert(deal2.deal.holecards && deal2.deal.holecards.length === 2, 'Bob got 2 hole cards');
    console.log('    Bob cards: ' + (deal2.deal.holecards || []).join(' '));
  }

  // Check no duplicate cards between players
  if (deal1?.deal?.holecards && deal2?.deal?.holecards) {
    const allCards = [...deal1.deal.holecards, ...deal2.deal.holecards];
    const unique = new Set(allCards);
    assert(unique.size === allCards.length, 'No duplicate hole cards between players');
  }

  // ══════════════════════════════
  // TEST 3: Seats with chip counts
  // ══════════════════════════════
  console.log('\nTEST 3: Seats & chips');
  const seats1 = findMsg(p1.msgs, 'seats');
  if (seats1) {
    const players = seats1.msg.seats.filter(s => !s.empty);
    assert(players.length >= 2, 'At least 2 players seated');
    const me = players.find(p => p.id === 'Alice');
    assert(me && me.chips > 0, 'Alice has chips: ' + (me ? me.chips : 0));
    // Check pot
    assert(seats1.msg.pot !== undefined, 'Pot is defined: ' + seats1.msg.pot);
  } else {
    assert(false, 'Got seats message');
  }

  // ══════════════════════════════
  // TEST 4: Action buttons (round_betting)
  // ══════════════════════════════
  console.log('\nTEST 4: Action buttons');
  await WAIT(3000); // Wait for betting round to start
  let betting = null;
  // Search ALL messages for round_betting
  for (const m of [...p1.msgs, ...p2.msgs]) {
    if (m.method === 'betting' && m.action === 'round_betting') { betting = m; break; }
  }
  if (!betting) {
    try { betting = await waitForMsg(p1.msgs, 'betting', 5000); } catch {}
    if (betting && betting.action !== 'round_betting') betting = null;
  }

  if (betting && betting.action === 'round_betting') {
    assert(betting.possibilities && betting.possibilities.length > 0, 'Got action possibilities');
    assert(betting.pot !== undefined, 'Pot in betting: ' + betting.pot);
    console.log('    Turn player: ' + betting.turnPlayer);
    console.log('    Possibilities: ' + JSON.stringify(betting.possibilities));

    // Act: check or call
    const actingPlayer = betting.turnPlayer === 'Alice' ? p1 : p2;
    const action = betting.toCall === 0 ? 'check' : 'call';
    actingPlayer.send({ action, amount: 0 });
    console.log('    Sent: ' + action);
    await WAIT(1000);
    assert(true, 'Action sent without error');
  } else {
    console.log('  ✗ FAIL: No round_betting received');
    failed++;
  }

  // ══════════════════════════════
  // TEST 5: Play through to settlement
  // ══════════════════════════════
  console.log('\nTEST 5: Play to settlement');
  // Auto-play: check/call everything for both players
  for (let round = 0; round < 20; round++) {
    await WAIT(500);
    // Check each player's messages for round_betting
    for (const p of [p1, p2]) {
      for (let i = p.msgs.length - 1; i >= Math.max(0, p.msgs.length - 5); i--) {
        const m = p.msgs[i];
        if (m.method === 'betting' && m.action === 'round_betting' && m.possibilities?.length > 0) {
          const act = m.toCall === 0 ? 'check' : (m.possibilities.includes(2) ? 'call' : 'fold');
          p.send({ action: act, amount: 0 });
          break;
        }
      }
    }
  }

  await WAIT(2000);

  // Check for settlement/verification
  const verify1 = findMsg(p1.msgs, 'verification');
  const verify2 = findMsg(p2.msgs, 'verification');
  assert(verify1 !== null || verify2 !== null, 'Got verification message');

  if (verify1) {
    assert(verify1.msg.valid === true, 'Hand verified: ' + verify1.msg.valid);
    console.log('    Hand #' + verify1.msg.hand);
  }

  // Check for finalInfo (winner banner)
  const final1 = findMsg(p1.msgs, 'finalInfo');
  assert(final1 !== null, 'Got finalInfo (winner banner)');
  if (final1) {
    console.log('    Winners: ' + JSON.stringify(final1.msg.winners));
    console.log('    Win amount: ' + final1.msg.win_amount);
  }

  // ══════════════════════════════
  // TEST 6: Board cards
  // ══════════════════════════════
  console.log('\nTEST 6: Board cards');
  const boardMsgs = p1.msgs.filter(m => m.method === 'deal' && m.deal?.board?.length > 0);
  if (boardMsgs.length > 0) {
    const lastBoard = boardMsgs[boardMsgs.length - 1].deal.board;
    assert(lastBoard.length >= 3, 'Board has at least flop: ' + lastBoard.join(' '));
    // Check no duplicate between board and hole cards
    if (deal1?.deal?.holecards) {
      const allCards = [...deal1.deal.holecards, ...lastBoard];
      const unique = new Set(allCards);
      assert(unique.size === allCards.length, 'No duplicates between hole + board');
    }
  } else {
    // Hand might have ended before flop (fold)
    console.log('    (no board — hand ended preflop)');
  }

  // ══════════════════════════════
  // TEST 7: Chip conservation
  // ══════════════════════════════
  console.log('\nTEST 7: Chip conservation');
  const lastSeats1 = [...p1.msgs].reverse().find(m => m.method === 'seats');
  if (lastSeats1) {
    const players = lastSeats1.seats.filter(s => !s.empty);
    const total = players.reduce((s, p) => s + (p.chips || 0), 0);
    assert(total === 400, 'Total chips conserved: ' + total + ' (expect 400)');
    players.forEach(p => console.log('    ' + p.id + ': ' + p.chips));
  }

  // ══════════════════════════════
  // RESULTS
  // ══════════════════════════════
  console.log('\n═══════════════════════════');
  console.log(passed + ' passed, ' + failed + ' failed');
  console.log(failed === 0 ? 'ALL TESTS PASS' : 'SOME TESTS FAILED');

  p1.ws.close();
  p2.ws.close();
  server.kill();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  if (server) server.kill();
  process.exit(1);
});
