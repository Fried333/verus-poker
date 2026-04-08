#!/usr/bin/env node
/**
 * Step 10b: REAL flow integration test
 *
 * Unlike test-step10-end-to-end.mjs which bypasses the player-backend's join
 * flow and calls phase functions directly, this test goes through the actual
 * player-backend.sitIn() method (which writes the join request) and the
 * dealer reads those join requests to construct the phase roster.
 *
 * This validates that the wiring through the EXISTING code paths works:
 *   1. Players call sitIn() → writes join_request with payAddr + pubkey
 *   2. Dealer reads each player's join_request, builds the phase roster
 *      from the payAddr/pubkey provided
 *   3. Dealer calls openPhase()
 *   4. Players read manifest, deposit (via depositToPhase)
 *   5. Hand outcomes simulated
 *   6. Cashout composed and signed and broadcast
 *
 * Usage: node test-step10b-real-flow.mjs
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
    join(process.env.HOME, '.komodo/CHIPS/CHIPS.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword')) {
        return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
      }
    }
  }
  throw new Error('CHIPS daemon config not found');
}

const rpc = findRPC();
const TABLE_ID = 'cashier1';
const PLAYER_A = 'cashier1';
const PLAYER_B = 'pc-player';

const p2pDealer = createP2PLayer(rpc, 'cashier1', TABLE_ID);
const dealer = createP2PDealer(p2pDealer, {
  smallBlind: 0.1, bigBlind: 0.2, buyin: 1, cashiers: [],
}, () => {});

const playerA = createPlayerBackend(createP2PLayer(rpc, PLAYER_A, TABLE_ID), PLAYER_A, TABLE_ID, {});
const playerB = createPlayerBackend(createP2PLayer(rpc, PLAYER_B, TABLE_ID), PLAYER_B, TABLE_ID, {});

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const KEYS = { JOIN_REQUEST: 'chips.vrsc::poker.sg777z.p_join_request' };

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function waitForTxAtAddr(addr, txid, expectedAmount, maxMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const utxos = await p2pDealer.getAddressUtxos(addr);
    const got = utxos.filter(u => u.txid === txid).reduce((s, u) => s + u.amount, 0);
    if (Math.abs(got - expectedAmount) < 0.00000001) return got;
    await WAIT(2000);
  }
  return null;
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 10b: REAL flow through sitIn() + phase multisig');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks + '\n');

  // ── Setup: open table ──
  console.log('--- Setup ---');
  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS');

  // ── Step 1: each player calls sitIn() — writes join_request to chain ──
  console.log('\n--- Step 1: players sitIn() (writes join_request with payAddr) ---');
  const t1 = Date.now();
  await playerA.sitIn(0);
  await playerB.sitIn(1);
  await WAIT(5000);  // give writes time to propagate
  record('1.1 both players called sitIn', 'PASS', { ms: Date.now() - t1 });

  // ── Step 2: dealer reads join requests and verifies payAddr is present ──
  console.log('\n--- Step 2: dealer reads join requests ---');
  const joinA = await p2pDealer.read(PLAYER_A, KEYS.JOIN_REQUEST);
  const joinB = await p2pDealer.read(PLAYER_B, KEYS.JOIN_REQUEST);
  record('2.1 A join_request present', joinA ? 'PASS' : 'FAIL');
  record('2.2 B join_request present', joinB ? 'PASS' : 'FAIL');
  record('2.3 A join_request has payAddr', joinA?.payAddr ? 'PASS' : 'FAIL', { note: joinA?.payAddr });
  record('2.4 B join_request has payAddr', joinB?.payAddr ? 'PASS' : 'FAIL', { note: joinB?.payAddr });
  record('2.5 A join_request has pubkey', joinA?.pubkey ? 'PASS' : 'FAIL');
  record('2.6 B join_request has pubkey', joinB?.pubkey ? 'PASS' : 'FAIL');

  // ── Step 3: dealer constructs phase roster from join requests ──
  console.log('\n--- Step 3: dealer builds phase roster from join requests ---');
  const roster = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 1.0 },
    { id: PLAYER_B, payAddr: joinB.payAddr, pubkey: joinB.pubkey, expectedDeposit: 1.0 },
  ];
  const phase = await dealer.openPhase(roster, 2);
  record('3.1 phase opened from join requests', 'PASS', { note: phase.phase });

  // Add players to dealer's in-memory state
  dealer.addPlayer(PLAYER_A, 1.0);
  dealer.addPlayer(PLAYER_B, 1.0);

  // ── Step 4: players read the manifest and deposit ──
  console.log('\n--- Step 4: players read manifest, deposit ---');
  await WAIT(2000);
  const manifestA = await playerA.readPhaseManifest(phase.phase);
  const manifestB = await playerB.readPhaseManifest(phase.phase);
  record('4.1 both players read manifest', manifestA && manifestB ? 'PASS' : 'FAIL');

  // Players verify
  const verifyA = playerA.verifyPhaseManifest(manifestA, joinA.payAddr);
  const verifyB = playerB.verifyPhaseManifest(manifestB, joinB.payAddr);
  record('4.2 both players verified manifest', verifyA.ok && verifyB.ok ? 'PASS' : 'FAIL', {
    note: verifyA.reason || verifyB.reason || 'verified'
  });

  // Deposit
  const waitDeposits = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA, joinA.payAddr);
  await playerB.depositToPhase(manifestB, joinB.payAddr);
  const confirmed = await waitDeposits;
  record('4.3 phase deposits confirmed', confirmed ? 'PASS' : 'FAIL');

  // ── Step 5: simulate hand outcomes via dealer.players[] ──
  console.log('\n--- Step 5: simulate hand outcomes ---');
  // A wins 0.3, B loses 0.3
  const dp = dealer.getPlayers();
  dp.find(p => p.id === PLAYER_A).chips = 1.3;
  dp.find(p => p.id === PLAYER_B).chips = 0.7;
  record('5.1 player stacks updated (A=1.3, B=0.7)', 'PASS');

  // ── Step 6: dealer composes cashout from current players[] ──
  console.log('\n--- Step 6: dealer composes cashout from players[] ---');
  const cashout = await dealer.composeCashoutFromPlayers();
  await WAIT(2000);
  record('6.1 cashout composed', 'PASS', {
    note: cashout.payouts.map(p => p.id + '=' + p.amount).join(', ')
  });

  // ── Step 7: players verify and sign ──
  console.log('\n--- Step 7: players verify and sign ---');
  const cashoutForA = await playerA.readCashoutProposal(phase.phase);
  const cashoutForB = await playerB.readCashoutProposal(phase.phase);
  const stacksOracle = {};
  for (const p of cashout.payouts) stacksOracle[p.id] = p.amount;

  const verifyA2 = await playerA.verifyCashoutProposal(cashoutForA, manifestA, joinA.payAddr, stacksOracle);
  const verifyB2 = await playerB.verifyCashoutProposal(cashoutForB, manifestB, joinB.payAddr, stacksOracle);
  record('7.1 A verified cashout', verifyA2.ok ? 'PASS' : 'FAIL', { note: verifyA2.reason });
  record('7.2 B verified cashout', verifyB2.ok ? 'PASS' : 'FAIL', { note: verifyB2.reason });

  await playerA.signAndPublishCashout(cashoutForA);
  await playerB.signAndPublishCashout(cashoutForB);
  record('7.3 both players signed and published', 'PASS');

  // ── Step 8: dealer finalizes ──
  console.log('\n--- Step 8: dealer finalizes settlement ---');
  const final = await dealer.finalizeCashout(60000);
  record('8.1 settlement broadcast', final.ok ? 'PASS' : 'FAIL', { note: final.txid?.slice(0, 16) });

  // ── Step 9: verify payouts received ──
  console.log('\n--- Step 9: verify payouts received ---');
  const aPayout = cashout.payouts.find(p => p.id === PLAYER_A).amount;
  const bPayout = cashout.payouts.find(p => p.id === PLAYER_B).amount;
  const aGot = await waitForTxAtAddr(joinA.payAddr, final.txid, aPayout);
  const bGot = await waitForTxAtAddr(joinB.payAddr, final.txid, bPayout);
  record('9.1 A received payout', aGot === aPayout ? 'PASS' : 'FAIL', { note: 'got ' + aGot });
  record('9.2 B received payout', bGot === bPayout ? 'PASS' : 'FAIL', { note: 'got ' + bGot });

  // Summary
  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`PASS: ${pass}   FAIL: ${fail}   (total: ${results.length})`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log('  ✗ ' + r.name + (r.note ? ' — ' + r.note : ''));
    }
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); if (e.stack) console.error(e.stack); process.exit(1); });
