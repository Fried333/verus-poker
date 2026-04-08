#!/usr/bin/env node
/**
 * Step 10c: AUTO flow integration test
 *
 * The closest thing to a real game without actually running the GUI:
 * the dealer goes through its lifecycle and the players run a polling
 * loop that auto-detects cashout proposals and auto-signs them. This
 * mimics what the production player-backend polling loop would do.
 *
 * Flow:
 *   1. Players sitIn() (writes join_request with payAddr/pubkey)
 *   2. Dealer detects, builds roster from join_requests
 *   3. Dealer opens phase
 *   4. Players' polling loop detects phase_open, deposits
 *   5. Dealer waits for confirmed
 *   6. (Simulated hand outcomes)
 *   7. Dealer composes cashout
 *   8. Players' polling loop detects cashout, auto-signs
 *   9. Dealer finalizes
 *  10. Verify payouts
 *  11. Repeat for phase 2
 *
 * Usage: node test-step10c-auto-flow.mjs
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

// Player polling loop: keeps running in the background and auto-handles
// pending cashouts on tracked phases
async function startPlayerPoller(player, label, trackedPhases, stopFlag) {
  while (!stopFlag.stop) {
    try {
      const signed = await player.autoRespondToCashouts(Array.from(trackedPhases));
      if (signed.length > 0) {
        console.log('  [poller-' + label + '] auto-signed cashouts for: ' + signed.join(', '));
      }
    } catch (e) {
      console.log('  [poller-' + label + '] error: ' + e.message);
    }
    await WAIT(2000);
  }
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 10c: AUTO flow integration test (player auto-signing)');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks + '\n');

  // ── Setup ──
  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS');

  // ── Step 1: players sitIn (writes join_request with payAddr) ──
  console.log('\n--- Step 1: players sit in ---');
  await playerA.sitIn(0);
  await playerB.sitIn(1);
  await WAIT(5000);
  record('1.1 both players sat in', 'PASS');

  // Read join requests
  const joinA = await p2pDealer.read(PLAYER_A, KEYS.JOIN_REQUEST);
  const joinB = await p2pDealer.read(PLAYER_B, KEYS.JOIN_REQUEST);
  if (!joinA?.payAddr || !joinB?.payAddr) {
    console.log('FATAL: join requests missing payAddr');
    process.exit(1);
  }
  record('1.2 join requests have payAddr/pubkey', 'PASS');

  // ── Set up player polling loops ──
  const stopFlag = { stop: false };
  const trackedPhasesA = new Set();
  const trackedPhasesB = new Set();
  const pollerA = startPlayerPoller(playerA, 'A', trackedPhasesA, stopFlag);
  const pollerB = startPlayerPoller(playerB, 'B', trackedPhasesB, stopFlag);

  // ── PHASE 1 ──
  console.log('\n--- Phase 1 ---');
  const t1 = Date.now();
  const roster1 = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 1.0 },
    { id: PLAYER_B, payAddr: joinB.payAddr, pubkey: joinB.pubkey, expectedDeposit: 1.0 },
  ];
  const phase1 = await dealer.openPhase(roster1, 2);
  trackedPhasesA.add(phase1.phase);
  trackedPhasesB.add(phase1.phase);
  dealer.addPlayer(PLAYER_A, 1.0);
  dealer.addPlayer(PLAYER_B, 1.0);
  record('Phase 1 opened', 'PASS', { note: phase1.phase });

  // Players need to deposit. The dealer waits for deposits.
  // For now, the deposit isn't auto-triggered by the polling loop — we
  // explicitly call depositToPhase. (Production code would auto-deposit
  // on detecting the phase manifest, but for this test we keep the deposit
  // step explicit.)
  await WAIT(3000);
  const manifestA1 = await playerA.readPhaseManifest(phase1.phase);
  const manifestB1 = await playerB.readPhaseManifest(phase1.phase);
  const waitDeposits1 = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA1, joinA.payAddr);
  await playerB.depositToPhase(manifestB1, joinB.payAddr);
  const conf1 = await waitDeposits1;
  record('Phase 1 deposits confirmed', conf1 ? 'PASS' : 'FAIL');

  // Simulate hands
  const dp = dealer.getPlayers();
  dp.find(p => p.id === PLAYER_A).chips = 1.4;
  dp.find(p => p.id === PLAYER_B).chips = 0.6;
  console.log('  [simulated hands: A=1.4, B=0.6]');

  // Dealer composes cashout
  const cashout1 = await dealer.composeCashoutFromPlayers();
  await WAIT(2000);
  record('Phase 1 cashout proposed', 'PASS', {
    note: cashout1.payouts.map(p => p.id + '=' + p.amount).join(', ')
  });

  // The player pollers should auto-sign within a few seconds
  // (we sleep to let them process)
  console.log('  waiting for player pollers to auto-sign...');
  await WAIT(8000);

  // Check that both players auto-signed
  const partialsCount1 = Object.keys(await dealer.readCashoutPartials(phase1.phase)).length;
  record('Phase 1 partials collected (auto)', partialsCount1 >= 2 ? 'PASS' : 'FAIL', {
    note: partialsCount1 + '/2 partials'
  });

  // Dealer finalizes
  const final1 = await dealer.finalizeCashout(60000);
  record('Phase 1 finalized', final1.ok ? 'PASS' : 'FAIL', { note: final1.txid?.slice(0, 16) });

  // Verify payouts
  const a1 = cashout1.payouts.find(p => p.id === PLAYER_A).amount;
  const b1 = cashout1.payouts.find(p => p.id === PLAYER_B).amount;
  const ag1 = await waitForTxAtAddr(joinA.payAddr, final1.txid, a1);
  const bg1 = await waitForTxAtAddr(joinB.payAddr, final1.txid, b1);
  record('Phase 1 A received', ag1 === a1 ? 'PASS' : 'FAIL', { note: 'got ' + ag1 + ' / ' + a1 });
  record('Phase 1 B received', bg1 === b1 ? 'PASS' : 'FAIL', { note: 'got ' + bg1 + ' / ' + b1 });

  console.log('  Phase 1 complete in ' + (Date.now() - t1) + 'ms');

  // ── PHASE 2 ──
  console.log('\n--- Phase 2 ---');
  const t2 = Date.now();
  // Reset chips for new phase
  dp.find(p => p.id === PLAYER_A).chips = 1.0;
  dp.find(p => p.id === PLAYER_B).chips = 1.0;

  const roster2 = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 1.0 },
    { id: PLAYER_B, payAddr: joinB.payAddr, pubkey: joinB.pubkey, expectedDeposit: 1.0 },
  ];
  const phase2 = await dealer.openPhase(roster2, 2);
  trackedPhasesA.add(phase2.phase);
  trackedPhasesB.add(phase2.phase);
  record('Phase 2 opened', 'PASS', { note: phase2.phase });

  await WAIT(3000);
  const manifestA2 = await playerA.readPhaseManifest(phase2.phase);
  const manifestB2 = await playerB.readPhaseManifest(phase2.phase);
  const waitDeposits2 = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA2, joinA.payAddr);
  await playerB.depositToPhase(manifestB2, joinB.payAddr);
  const conf2 = await waitDeposits2;
  record('Phase 2 deposits confirmed', conf2 ? 'PASS' : 'FAIL');

  // Simulate: B wins this time
  dp.find(p => p.id === PLAYER_A).chips = 0.6;
  dp.find(p => p.id === PLAYER_B).chips = 1.4;
  console.log('  [simulated hands: A=0.6, B=1.4]');

  const cashout2 = await dealer.composeCashoutFromPlayers();
  await WAIT(2000);
  record('Phase 2 cashout proposed', 'PASS', {
    note: cashout2.payouts.map(p => p.id + '=' + p.amount).join(', ')
  });

  console.log('  waiting for player pollers to auto-sign...');
  await WAIT(8000);

  const partialsCount2 = Object.keys(await dealer.readCashoutPartials(phase2.phase)).length;
  record('Phase 2 partials collected (auto)', partialsCount2 >= 2 ? 'PASS' : 'FAIL', {
    note: partialsCount2 + '/2 partials'
  });

  const final2 = await dealer.finalizeCashout(60000);
  record('Phase 2 finalized', final2.ok ? 'PASS' : 'FAIL', { note: final2.txid?.slice(0, 16) });

  const a2 = cashout2.payouts.find(p => p.id === PLAYER_A).amount;
  const b2 = cashout2.payouts.find(p => p.id === PLAYER_B).amount;
  const ag2 = await waitForTxAtAddr(joinA.payAddr, final2.txid, a2);
  const bg2 = await waitForTxAtAddr(joinB.payAddr, final2.txid, b2);
  record('Phase 2 A received', ag2 === a2 ? 'PASS' : 'FAIL', { note: 'got ' + ag2 + ' / ' + a2 });
  record('Phase 2 B received', bg2 === b2 ? 'PASS' : 'FAIL', { note: 'got ' + bg2 + ' / ' + b2 });

  console.log('  Phase 2 complete in ' + (Date.now() - t2) + 'ms');

  // Stop pollers
  stopFlag.stop = true;
  await pollerA;
  await pollerB;

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
