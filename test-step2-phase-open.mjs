#!/usr/bin/env node
/**
 * Step 2 test: dealer phase opening + deposit detection.
 *
 * Validates that the dealer can:
 *   1. Compose a phase manifest from a roster
 *   2. Compute the multisig address deterministically
 *   3. Publish the manifest to the table identity
 *   4. Wait for player deposits
 *   5. Attribute each deposit back to the correct player
 *   6. Publish phase_confirmed when all deposits arrive
 *
 * This test simulates the dealer side only — the "players" are simulated
 * by sending CHIPS from explicit pay addresses to the multisig.
 *
 * We use the local cashier1 identity as the "table" since that's an identity
 * we control on this daemon. (The real production code would use a real
 * table identity like ptable2.CHIPS@ on the dealer's daemon.)
 *
 * Usage: node test-step2-phase-open.mjs
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
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

const TABLE_ID = 'cashier1'; // we use cashier1 as the test "table" since we own it
const DEALER_ID = 'cashier1';

const p2p = createP2PLayer(findRPC(), DEALER_ID, TABLE_ID);

// Minimal config for the dealer
const config = {
  smallBlind: 0.1,
  bigBlind: 0.2,
  buyin: 5,
  cashiers: [],
};

const dealer = createP2PDealer(p2p, config, () => {});

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function makePlayer(label, fundAmount = 6) {
  const addr = await p2p.client.call('getnewaddress', []);
  const pubkey = await p2p.getAddressPubkey(addr);
  // Pre-fund the player's address so they have UTXOs to spend
  await p2p.client.call('sendtoaddress', [addr, fundAmount]);
  return { id: label, addr, pubkey };
}

async function depositFromPlayer(player, msAddr, amount) {
  // Use createrawtransaction to spend specifically from the player's address
  // (so we can attribute the deposit back to them later)
  const utxos = await p2p.getAddressUtxos(player.addr);
  if (utxos.length === 0) throw new Error('player ' + player.id + ' has no UTXOs');

  const utxo = utxos[0];
  const fee = 0.0001;
  const change = Math.round((utxo.amount - amount - fee) * 1e8) / 1e8;
  if (change < 0) throw new Error('UTXO too small to fund deposit');

  const inputs = [{ txid: utxo.txid, vout: utxo.vout }];
  const outputs = { [msAddr]: amount };
  if (change > 0) outputs[player.addr] = change;

  const rawTx = await p2p.client.call('createrawtransaction', [inputs, outputs]);
  const signed = await p2p.client.call('signrawtransaction', [rawTx]);
  if (!signed.complete) throw new Error('failed to sign deposit');
  return await p2p.client.call('sendrawtransaction', [signed.hex]);
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 2: dealer phase opening + deposit detection');
  console.log('═'.repeat(70));

  const info = await p2p.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  const balance = await p2p.client.call('getbalance', []);
  console.log('Wallet balance: ' + balance + ' CHIPS\n');

  // Initialize a "session" (since openPhase needs gameId)
  // We can't call openTable() here because that writes to the table identity,
  // and we want to keep this test self-contained. Instead, manually set the
  // dealer's gameId via its internal state by calling openTable() — that's fine.
  console.log('--- Setup: open table session ---');
  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS');

  // Create 3 simulated players with their own addresses + pubkeys + funds
  console.log('\n--- Setup: create 3 simulated players ---');
  const A = await makePlayer('test_A');
  const B = await makePlayer('test_B');
  const C = await makePlayer('test_C');

  // Wait for funding TXs to land
  await p2p.waitForAddressUtxos(A.addr, 1, 60000);
  await p2p.waitForAddressUtxos(B.addr, 1, 60000);
  await p2p.waitForAddressUtxos(C.addr, 1, 60000);
  record('3 players funded with their own UTXOs', 'PASS', {
    note: 'A=' + A.addr.slice(0,8) + ' B=' + B.addr.slice(0,8) + ' C=' + C.addr.slice(0,8)
  });

  // ── Test 1: Dealer opens a phase ──
  console.log('\n--- Test 1: dealer.openPhase() ---');
  const roster = [
    { id: A.id, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: 2 },
    { id: B.id, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: 2 },
    { id: C.id, payAddr: C.addr, pubkey: C.pubkey, expectedDeposit: 2 },
  ];
  const threshold = 2;

  const t1 = Date.now();
  const phase = await dealer.openPhase(roster, threshold);
  record('1.1 phase opened', 'PASS', { ms: Date.now() - t1, note: phase.phase });
  record('1.2 multisig address present', phase.multisigAddr ? 'PASS' : 'FAIL', { note: phase.multisigAddr });
  record('1.3 redeemScript present', phase.redeemScript ? 'PASS' : 'FAIL');
  record('1.4 signers list has 3 entries', phase.signers.length === 3 ? 'PASS' : 'FAIL');
  record('1.5 threshold matches', phase.threshold === threshold ? 'PASS' : 'FAIL');

  // Verify the manifest was published to the table identity
  const manifestKey = 'chips.vrsc::poker.sg777z.t_phase_open.' + phase.phase;
  await WAIT(3000); // give it time to land
  const publishedManifest = await p2p.read(p2p.tableId, manifestKey);
  if (publishedManifest && publishedManifest.phase === phase.phase) {
    record('1.6 manifest readable from table identity', 'PASS', {
      note: 'phase=' + publishedManifest.phase
    });
  } else {
    record('1.6 manifest readable from table identity', 'FAIL', {
      note: 'got=' + JSON.stringify(publishedManifest)
    });
  }

  // ── Test 2: Players deposit, dealer detects ──
  console.log('\n--- Test 2: players deposit + dealer detects ---');

  // Trigger waitForPhaseDeposits in the background
  const waitPromise = dealer.waitForPhaseDeposits(120000);

  // Have each "player" deposit 2 CHIPS from their own address
  await WAIT(1000); // let the wait loop start
  const t2 = Date.now();
  const txA = await depositFromPlayer(A, phase.multisigAddr, 2);
  const txB = await depositFromPlayer(B, phase.multisigAddr, 2);
  const txC = await depositFromPlayer(C, phase.multisigAddr, 2);
  record('2.1 all 3 deposits broadcast', 'PASS', {
    ms: Date.now() - t2,
    note: txA.slice(0,8) + ', ' + txB.slice(0,8) + ', ' + txC.slice(0,8)
  });

  // Wait for the dealer to detect them
  const allConfirmed = await waitPromise;
  record('2.2 dealer detected all deposits', allConfirmed ? 'PASS' : 'FAIL');

  // Verify the dealer has confirmed the phase
  const current = dealer.getCurrentPhase();
  record('2.3 currentPhase.confirmed is true', current.confirmed ? 'PASS' : 'FAIL');
  record('2.4 currentPhase.totalBalance is 6', current.totalBalance === 6 ? 'PASS' : 'FAIL', {
    note: 'totalBalance=' + current.totalBalance
  });
  record('2.5 currentPhase.deposits has 3 entries', Object.keys(current.deposits).length === 3 ? 'PASS' : 'FAIL', {
    note: Object.keys(current.deposits).length + ' deposits'
  });

  // Verify each deposit was attributed to the correct player
  const attributedPlayers = new Set(Object.values(current.deposits).map(d => d.player));
  const expectedPlayers = new Set([A.id, B.id, C.id]);
  const allAttributed = [...expectedPlayers].every(p => attributedPlayers.has(p));
  record('2.6 each deposit attributed to correct player', allAttributed ? 'PASS' : 'FAIL', {
    note: 'attributed=' + [...attributedPlayers].join(',')
  });

  // ── Test 3: phase_confirmed published to chain ──
  console.log('\n--- Test 3: phase_confirmed record ---');
  await WAIT(3000);
  const confirmedKey = 'chips.vrsc::poker.sg777z.t_phase_confirmed.' + phase.phase;
  const publishedConfirmed = await p2p.read(p2p.tableId, confirmedKey);
  if (publishedConfirmed && publishedConfirmed.phase === phase.phase) {
    record('3.1 phase_confirmed readable from table identity', 'PASS');
    record('3.2 confirmed record has totalBalance=6',
      publishedConfirmed.totalBalance === 6 ? 'PASS' : 'FAIL',
      { note: 'got ' + publishedConfirmed.totalBalance });
  } else {
    record('3.1 phase_confirmed readable from table identity', 'FAIL');
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
