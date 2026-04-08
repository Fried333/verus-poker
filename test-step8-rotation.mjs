#!/usr/bin/env node
/**
 * Step 8 test: phase rotation
 *
 * Validates the rotation flow:
 *   1. Open phase 1 with 2 players
 *   2. Players deposit
 *   3. (Simulate some hands by computing different stacks)
 *   4. Trigger rotation: settle phase 1, open phase 2 with same roster
 *   5. Players verify the new manifest, deposit again (using their fresh
 *      settlement UTXOs)
 *   6. Phase 2 confirmed
 *   7. Settle phase 2 cleanly
 *
 * This validates the complete settle -> rotate -> deposit -> settle cycle.
 *
 * Usage: node test-step8-rotation.mjs
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
const dealer = createP2PDealer(p2pDealer, { smallBlind: 0.1, bigBlind: 0.2, buyin: 5, cashiers: [] }, () => {});

const playerA = createPlayerBackend(createP2PLayer(rpc, PLAYER_A, TABLE_ID), PLAYER_A, TABLE_ID, {});
const playerB = createPlayerBackend(createP2PLayer(rpc, PLAYER_B, TABLE_ID), PLAYER_B, TABLE_ID, {});

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function getRealIdentityWallet(idName, fundAmount = 4) {
  const idInfo = await p2pDealer.client.call('getidentity', [idName + '.CHIPS@']);
  const addr = idInfo.identity.primaryaddresses[0];
  const pubkey = await p2pDealer.getAddressPubkey(addr);
  const utxos = await p2pDealer.getAddressUtxos(addr);
  const balance = utxos.reduce((s, u) => s + u.amount, 0);
  if (balance < fundAmount) {
    await p2pDealer.client.call('sendtoaddress', [addr, fundAmount]);
  }
  return { id: idName, addr, pubkey };
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

async function runPhaseLifecycle(label, A, B, depositAmount, finalStacks) {
  console.log('\n--- ' + label + ' ---');
  const t0 = Date.now();

  const roster = [
    { id: PLAYER_A, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: depositAmount },
    { id: PLAYER_B, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: depositAmount },
  ];

  const phase = await dealer.openPhase(roster, 2);
  await WAIT(2000);

  // Each player reads + verifies
  const manifestA = await playerA.readPhaseManifest(phase.phase);
  const manifestB = await playerB.readPhaseManifest(phase.phase);

  // Deposits
  const waitDeposits = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA, A.addr);
  await playerB.depositToPhase(manifestB, B.addr);
  const confirmed = await waitDeposits;

  if (!confirmed) {
    record(label + ' phase setup', 'FAIL');
    return { error: 'phase setup failed' };
  }

  // Compose cashout with the final stacks
  const cashout = await dealer.composeCashout(finalStacks);
  await WAIT(2000);

  // Players sign + publish
  const cashoutForA = await playerA.readCashoutProposal(phase.phase);
  const cashoutForB = await playerB.readCashoutProposal(phase.phase);
  const verifyA = await playerA.verifyCashoutProposal(cashoutForA, manifestA, A.addr, finalStacks);
  const verifyB = await playerB.verifyCashoutProposal(cashoutForB, manifestB, B.addr, finalStacks);
  if (!verifyA.ok || !verifyB.ok) {
    record(label + ' cashout verification', 'FAIL', { note: 'A=' + verifyA.reason + ' B=' + verifyB.reason });
    return { error: 'verification failed' };
  }
  await playerA.signAndPublishCashout(cashoutForA);
  await playerB.signAndPublishCashout(cashoutForB);

  // Dealer finalizes
  const final = await dealer.finalizeCashout(60000);
  if (!final.ok) {
    record(label + ' finalize', 'FAIL', { note: final.reason });
    return { error: 'finalize failed' };
  }

  // Wait for both to receive
  const aGot = await waitForTxAtAddr(A.addr, final.txid, finalStacks[PLAYER_A]);
  const bGot = await waitForTxAtAddr(B.addr, final.txid, finalStacks[PLAYER_B]);

  const elapsed = Date.now() - t0;
  if (aGot === finalStacks[PLAYER_A] && bGot === finalStacks[PLAYER_B]) {
    record(label + ' complete cycle', 'PASS', {
      ms: elapsed,
      note: 'A=' + aGot + ' B=' + bGot
    });
    return { txid: final.txid, phase: phase.phase };
  } else {
    record(label + ' payouts', 'FAIL', {
      note: 'A=' + aGot + ' (expected ' + finalStacks[PLAYER_A] + ') B=' + bGot + ' (expected ' + finalStacks[PLAYER_B] + ')'
    });
    return { error: 'payouts incorrect' };
  }
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 8: phase rotation (multiple sequential phases)');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);

  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS');

  const A = await getRealIdentityWallet(PLAYER_A);
  const B = await getRealIdentityWallet(PLAYER_B);
  await p2pDealer.waitForAddressUtxos(A.addr, 1, 60000);
  await p2pDealer.waitForAddressUtxos(B.addr, 1, 60000);
  record('player wallets ready', 'PASS');

  // Phase 1: deposit 1 each, A wins 0.5
  const r1 = await runPhaseLifecycle(
    'Phase 1 (1 CHIPS deposit each)',
    A, B,
    1.0,
    { [PLAYER_A]: 1.5, [PLAYER_B]: 0.4999 }
  );
  if (r1.error) {
    console.log('aborting due to phase 1 failure');
    process.exit(1);
  }

  // Phase 2: same players continue, now deposit 0.8 each, B wins 0.3
  const r2 = await runPhaseLifecycle(
    'Phase 2 (rotation, 0.8 CHIPS deposit each)',
    A, B,
    0.8,
    { [PLAYER_A]: 0.5, [PLAYER_B]: 1.0999 }
  );
  if (r2.error) {
    console.log('aborting due to phase 2 failure');
    process.exit(1);
  }

  // Phase 3: keep going, deposit 0.5 each, A wins 0.2
  const r3 = await runPhaseLifecycle(
    'Phase 3 (rotation, 0.5 CHIPS deposit each)',
    A, B,
    0.5,
    { [PLAYER_A]: 0.7, [PLAYER_B]: 0.2999 }
  );
  if (r3.error) {
    console.log('aborting due to phase 3 failure');
    process.exit(1);
  }

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
