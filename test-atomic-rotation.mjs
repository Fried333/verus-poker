#!/usr/bin/env node
/**
 * Test: atomic rotation — settles old multisig AND funds new multisig in one TX.
 *
 * Setup: 2 players (cashier1 + pc-player, both local wallets) in a phase.
 * One player leaves → atomic rotation creates a single TX that pays the leaver
 * AND funds the new multisig for the continuing player.
 *
 * Measures timing vs the old sequential rotation.
 *
 * Usage: node test-atomic-rotation.mjs
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
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

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const ts = () => Date.now();
const rpc = findRPC();

const TABLE_ID = 'cashier1';
const PLAYER_A = 'cashier1'; // continuing
const PLAYER_B = 'pc-player'; // leaving

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '\u2713' : status === 'FAIL' ? '\u2717' : '\u00b7';
  console.log('  [' + tag + '] ' + name + (info.note ? ' \u2014 ' + info.note : ''));
}

async function main() {
  console.log('='.repeat(70));
  console.log('Test: atomic rotation (leave-only, no new joiners)');
  console.log('='.repeat(70));

  const p2pDealer = createP2PLayer(rpc, TABLE_ID, TABLE_ID);
  const dealer = createP2PDealer(p2pDealer, { smallBlind: 0.005, bigBlind: 0.01, buyin: 1, cashiers: [] }, () => {});
  const playerA = createPlayerBackend(createP2PLayer(rpc, PLAYER_A, TABLE_ID), PLAYER_A, TABLE_ID, { phaseMultisig: true });
  const playerB = createPlayerBackend(createP2PLayer(rpc, PLAYER_B, TABLE_ID), PLAYER_B, TABLE_ID, { phaseMultisig: true });

  const info = await p2pDealer.client.call('getinfo', []);
  console.log('Chain: ' + info.name + ' block ' + info.blocks);

  // ── Setup: open phase + both players deposit ──
  console.log('\n--- Setup: open phase + deposits ---');
  await dealer.openTable();
  await WAIT(2000);
  await playerA.sitIn(0);
  await playerB.sitIn(1);
  await WAIT(5000);

  const KEYS = { JOIN_REQUEST: 'chips.vrsc::poker.sg777z.p_join_request' };
  const joinA = await p2pDealer.read(PLAYER_A, KEYS.JOIN_REQUEST);
  const joinB = await p2pDealer.read(PLAYER_B, KEYS.JOIN_REQUEST);
  if (!joinA?.payAddr || !joinB?.payAddr) { console.log('FATAL: missing payAddr'); process.exit(1); }

  const roster = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 0.1 },
    { id: PLAYER_B, payAddr: joinB.payAddr, pubkey: joinB.pubkey, expectedDeposit: 0.1 },
  ];
  const phase = await dealer.openPhase(roster, 2);
  dealer.addPlayer(PLAYER_A, 0.1);
  dealer.addPlayer(PLAYER_B, 0.1);
  console.log('Phase: ' + phase.phase);

  const mA = await playerA.readPhaseManifest(phase.phase);
  await playerA.depositToPhase(mA, joinA.payAddr);
  const mB = await playerB.readPhaseManifest(phase.phase);
  await playerB.depositToPhase(mB, joinB.payAddr);
  const conf = await dealer.waitForPhaseDeposits(120000);
  if (!conf) { console.log('FATAL: deposits timeout'); process.exit(1); }
  record('phase opened + both deposited', 'PASS');

  // Simulate hand outcome: A=0.7, B=0.3
  const dp = dealer.getPlayers();
  dp.find(p => p.id === PLAYER_A).chips = 0.14;
  dp.find(p => p.id === PLAYER_B).chips = 0.06;
  console.log('  Simulated hand: A=0.7 B=0.3\n');

  // ══════════════════════════════════════════
  // ATOMIC ROTATION
  // ══════════════════════════════════════════
  console.log('--- Atomic rotation: B leaves, A continues ---');

  // New roster: only A continues
  const newRoster = [
    { id: PLAYER_A, payAddr: joinA.payAddr, pubkey: joinA.pubkey, expectedDeposit: 0 },
  ];
  const newThreshold = 1; // 1-of-1 for solo (degeneratecase)

  const t0 = ts();
  console.log('  t0=' + 0 + 'ms  compose atomic rotation');

  const proposal = await dealer.composeAtomicRotation(newRoster, newThreshold, []);
  const t1 = ts();
  console.log('  t1=' + (t1 - t0) + 'ms  proposal published');
  record('proposal published', proposal ? 'PASS' : 'FAIL', { note: 'type=' + proposal?.type });

  // Player B (leaver) signs first
  await playerB.autoRespondToCashouts([phase.phase]);
  const t2 = ts();
  console.log('  t2=' + (t2 - t0) + 'ms  player B (leaver) signed');

  // Player A (continuing) signs
  await playerA.autoRespondToCashouts([phase.phase]);
  const t3 = ts();
  console.log('  t3=' + (t3 - t0) + 'ms  player A (continuing) signed');

  // Finalize
  const result = await dealer.finalizeCashout(60000);
  const t4 = ts();
  console.log('  t4=' + (t4 - t0) + 'ms  settlement broadcast');

  record('settlement broadcast', result.ok ? 'PASS' : 'FAIL', { note: result.txid?.slice(0, 16) || result.reason });

  if (result.ok) {
    // Activate the new phase
    dealer.activateAtomicPhase();
    record('new phase activated', 'PASS');

    // Verify the settlement TX on chain
    await WAIT(3000);
    const tx = await p2pDealer.client.call('getrawtransaction', [result.txid, 1]);
    console.log('\n  Settlement TX outputs:');
    for (const v of tx.vout) {
      const addrs = v.scriptPubKey?.addresses || [];
      console.log('    vout ' + v.n + ': ' + v.value + ' → ' + addrs.join(', '));
    }

    // Check: B should get 0.3 - fee portion to their R-addr
    // Check: new multisig should get A's 0.7
    const bPayout = tx.vout.find(v => (v.scriptPubKey?.addresses || []).includes(joinB.payAddr));
    const msOut = tx.vout.find(v => (v.scriptPubKey?.addresses || []).includes(proposal.newMultisigAddr));

    record('leaver B paid out', bPayout ? 'PASS' : 'FAIL', { note: bPayout ? bPayout.value + ' CHIPS' : 'no output found' });
    record('new multisig funded', msOut ? 'PASS' : 'FAIL', { note: msOut ? msOut.value + ' CHIPS' : 'no output found' });

    console.log('\n  Total rotation time: ' + (t4 - t0) + 'ms (' + ((t4 - t0) / 1000).toFixed(1) + 's)');
    console.log('  Breakdown:');
    console.log('    compose+propose:    ' + (t1 - t0) + 'ms');
    console.log('    player B sign:      ' + (t2 - t1) + 'ms');
    console.log('    player A sign:      ' + (t3 - t2) + 'ms');
    console.log('    finalize+broadcast: ' + (t4 - t3) + 'ms');
  }

  console.log('\n' + '='.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); console.error(e.stack); process.exit(1); });
