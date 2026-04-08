#!/usr/bin/env node
/**
 * Step 3 test: player phase deposit flow + verification.
 *
 * Validates that the player backend can:
 *   1. Read the phase manifest from the table identity
 *   2. Verify the manifest matches their pay address
 *   3. Reject a manifest that doesn't match
 *   4. Deposit the expected amount using explicit input selection (no wallet
 *      pool contamination)
 *   5. Wait for phase_confirmed
 *
 * The dealer is run end-to-end as in step 2, so this validates the full
 * dealer + player flow up through phase open + deposit confirmation.
 *
 * Usage: node test-step3-player-deposit.mjs
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

// We use cashier1 as the test "table" since we own it on local
const TABLE_ID = 'cashier1';

// Players for this test — synthetic IDs since we're testing the chain mechanics
const PLAYER_A = 'test_player_a';
const PLAYER_B = 'test_player_b';
const PLAYER_C = 'test_player_c';

// p2p layer for the dealer (myId = cashier1, since the dealer process owns the table identity)
const p2pDealer = createP2PLayer(rpc, 'cashier1', TABLE_ID);

const dealer = createP2PDealer(p2pDealer, {
  smallBlind: 0.1, bigBlind: 0.2, buyin: 5, cashiers: [],
}, () => {});

// p2p layers for each player (myId = the player's id)
// Note: in a real deployment each player runs on their own daemon. For this
// test we use the same local daemon but with different myId values.
const p2pA = createP2PLayer(rpc, PLAYER_A, TABLE_ID);
const p2pB = createP2PLayer(rpc, PLAYER_B, TABLE_ID);
const p2pC = createP2PLayer(rpc, PLAYER_C, TABLE_ID);

const playerA = createPlayerBackend(p2pA, PLAYER_A, TABLE_ID, {});
const playerB = createPlayerBackend(p2pB, PLAYER_B, TABLE_ID, {});
const playerC = createPlayerBackend(p2pC, PLAYER_C, TABLE_ID, {});

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function makePlayerWallet(label, fundAmount = 6) {
  const addr = await p2pDealer.client.call('getnewaddress', []);
  const pubkey = await p2pDealer.getAddressPubkey(addr);
  await p2pDealer.client.call('sendtoaddress', [addr, fundAmount]);
  return { id: label, addr, pubkey };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 3: player phase deposit flow');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  const balance = await p2pDealer.client.call('getbalance', []);
  console.log('Wallet balance: ' + balance + ' CHIPS\n');

  // ── Setup: open table session and create funded player wallets ──
  console.log('--- Setup ---');
  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS');

  const A = await makePlayerWallet(PLAYER_A);
  const B = await makePlayerWallet(PLAYER_B);
  const C = await makePlayerWallet(PLAYER_C);
  await p2pDealer.waitForAddressUtxos(A.addr, 1, 60000);
  await p2pDealer.waitForAddressUtxos(B.addr, 1, 60000);
  await p2pDealer.waitForAddressUtxos(C.addr, 1, 60000);
  record('3 player wallets funded', 'PASS', {
    note: 'A=' + A.addr.slice(0,8) + ' B=' + B.addr.slice(0,8) + ' C=' + C.addr.slice(0,8)
  });

  // ── Test 1: Dealer opens a phase, players read the manifest ──
  console.log('\n--- Test 1: dealer opens phase, players read manifest ---');
  const roster = [
    { id: PLAYER_A, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: 1.5 },
    { id: PLAYER_B, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: 1.5 },
    { id: PLAYER_C, payAddr: C.addr, pubkey: C.pubkey, expectedDeposit: 1.5 },
  ];
  const phase = await dealer.openPhase(roster, 2);
  await WAIT(3000);
  record('1.1 dealer opened phase', 'PASS', { note: phase.phase });

  // Each player reads the manifest from their own backend
  const manifestA = await playerA.readPhaseManifest(phase.phase);
  const manifestB = await playerB.readPhaseManifest(phase.phase);
  const manifestC = await playerC.readPhaseManifest(phase.phase);
  record('1.2 player A reads manifest', manifestA && manifestA.phase === phase.phase ? 'PASS' : 'FAIL');
  record('1.3 player B reads manifest', manifestB && manifestB.phase === phase.phase ? 'PASS' : 'FAIL');
  record('1.4 player C reads manifest', manifestC && manifestC.phase === phase.phase ? 'PASS' : 'FAIL');

  // ── Test 2: Manifest verification (positive case) ──
  console.log('\n--- Test 2: manifest verification ---');
  const verifyA = playerA.verifyPhaseManifest(manifestA, A.addr);
  record('2.1 A verifies manifest with correct payAddr', verifyA.ok ? 'PASS' : 'FAIL', {
    note: verifyA.reason || 'verified'
  });

  const verifyB = playerB.verifyPhaseManifest(manifestB, B.addr);
  record('2.2 B verifies manifest with correct payAddr', verifyB.ok ? 'PASS' : 'FAIL', {
    note: verifyB.reason || 'verified'
  });

  // ── Test 3: Manifest verification (negative cases) ──
  console.log('\n--- Test 3: manifest verification rejects bad input ---');

  // 3.1: wrong payAddr
  const verifyBadAddr = playerA.verifyPhaseManifest(manifestA, 'RWrongAddrXxxxxxxxxxxxxxxxxxxxxxxx');
  record('3.1 reject wrong payAddr', !verifyBadAddr.ok ? 'PASS' : 'FAIL', {
    note: verifyBadAddr.reason
  });

  // 3.2: not in signers (use a non-existent player to verify)
  const verifyNotInList = createPlayerBackend(
    createP2PLayer(rpc, 'nonexistent_player', TABLE_ID),
    'nonexistent_player', TABLE_ID, {}
  ).verifyPhaseManifest(manifestA, A.addr);
  record('3.2 reject when myId not in signers', !verifyNotInList.ok ? 'PASS' : 'FAIL', {
    note: verifyNotInList.reason
  });

  // 3.3: malformed manifest
  const verifyMalformed = playerA.verifyPhaseManifest({ type: 'wrong' }, A.addr);
  record('3.3 reject malformed manifest', !verifyMalformed.ok ? 'PASS' : 'FAIL');

  // ── Test 4: Players deposit, dealer detects, phase confirmed ──
  console.log('\n--- Test 4: players deposit + dealer confirms ---');

  // Start the dealer's wait in background
  const waitPromise = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000); // let the wait loop start

  const t4 = Date.now();
  const txA = await playerA.depositToPhase(manifestA, A.addr);
  const txB = await playerB.depositToPhase(manifestB, B.addr);
  const txC = await playerC.depositToPhase(manifestC, C.addr);
  record('4.1 all 3 players deposited via depositToPhase', 'PASS', {
    ms: Date.now() - t4,
    note: txA.slice(0, 8) + ', ' + txB.slice(0, 8) + ', ' + txC.slice(0, 8)
  });

  // Dealer should detect them
  const allConfirmed = await waitPromise;
  record('4.2 dealer confirmed phase', allConfirmed ? 'PASS' : 'FAIL');

  // ── Test 5: Players read phase_confirmed ──
  console.log('\n--- Test 5: players read phase_confirmed ---');
  await WAIT(3000);
  const confirmedA = await playerA.readPhaseConfirmed(phase.phase);
  const confirmedB = await playerB.readPhaseConfirmed(phase.phase);
  record('5.1 A reads phase_confirmed', confirmedA && confirmedA.totalBalance === 4.5 ? 'PASS' : 'FAIL', {
    note: confirmedA ? 'totalBalance=' + confirmedA.totalBalance : 'null'
  });
  record('5.2 B reads phase_confirmed', confirmedB && confirmedB.totalBalance === 4.5 ? 'PASS' : 'FAIL');

  // ── Test 6: waitForPhaseConfirmed (already-published case) ──
  console.log('\n--- Test 6: waitForPhaseConfirmed ---');
  const t6 = Date.now();
  const waited = await playerC.waitForPhaseConfirmed(phase.phase, 10000);
  record('6.1 waitForPhaseConfirmed returns confirmed record', waited && waited.totalBalance === 4.5 ? 'PASS' : 'FAIL', {
    ms: Date.now() - t6
  });

  // ── Test 7: Verify the multisig actually has 4.5 CHIPS on chain ──
  console.log('\n--- Test 7: verify multisig balance on chain ---');
  const msBalance = await p2pDealer.getAddressBalance(manifestA.multisigAddr);
  record('7.1 multisig balance is 4.5', msBalance === 4.5 ? 'PASS' : 'FAIL', { note: 'got ' + msBalance });

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
