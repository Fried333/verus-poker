#!/usr/bin/env node
/**
 * Steps 5, 6, 7 test: cashout proposal + verification + signing + broadcast.
 *
 * Validates the full cashout flow:
 *   1. Dealer composes a cashout proposal with payouts based on simulated stacks
 *   2. Dealer publishes the proposal to the table identity
 *   3. Each player reads the proposal
 *   4. Each player runs FULL verification (roster, addresses, amounts, sum, tx)
 *   5. Each player signs and publishes their partial
 *   6. Dealer reads the partials, combines, broadcasts
 *   7. All players' pay addresses receive their payouts
 *
 * Also tests the verification rejecting bad cashouts (defensive check coverage).
 *
 * Usage: node test-step5-7-cashout.mjs
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
// We need REAL identities for partial signature publication. We have two
// local identities: cashier1 and pc-player. Use them as the two players in
// a 2-of-2 heads-up cashout test. The TABLE identity is cashier1 (where the
// dealer writes manifest/cashout records) — but the per-identity write mutex
// handles cashier1 acting in both roles.
const TABLE_ID = 'cashier1';
const PLAYER_A = 'cashier1';   // also the table identity
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
  // Get the primary R-address + pubkey for an existing local identity
  const idInfo = await p2pDealer.client.call('getidentity', [idName + '.CHIPS@']);
  const addr = idInfo.identity.primaryaddresses[0];
  const pubkey = await p2pDealer.getAddressPubkey(addr);
  // Pre-fund the address if needed
  const utxos = await p2pDealer.getAddressUtxos(addr);
  const balance = utxos.reduce((s, u) => s + u.amount, 0);
  if (balance < fundAmount) {
    await p2pDealer.client.call('sendtoaddress', [addr, fundAmount]);
  }
  return { id: idName, addr, pubkey };
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Steps 5-7: cashout proposal + verification + signing + broadcast');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  console.log('Wallet balance: ' + (await p2pDealer.client.call('getbalance', [])) + ' CHIPS\n');

  // ── Setup: open table, get real identity wallets, open phase, deposit ──
  console.log('--- Setup: 2-of-2 heads-up phase ---');
  await dealer.openTable();
  await WAIT(2000);

  const A = await getRealIdentityWallet(PLAYER_A);
  const B = await getRealIdentityWallet(PLAYER_B);
  await p2pDealer.waitForAddressUtxos(A.addr, 1, 60000);
  await p2pDealer.waitForAddressUtxos(B.addr, 1, 60000);
  record('player identity wallets ready', 'PASS', {
    note: 'A=' + A.addr.slice(0,8) + ' B=' + B.addr.slice(0,8)
  });

  const roster = [
    { id: PLAYER_A, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: 1 },
    { id: PLAYER_B, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: 1 },
  ];
  const phase = await dealer.openPhase(roster, 2);
  await WAIT(2000);

  // Players deposit
  const waitDeposits = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  const manifestForA = await playerA.readPhaseManifest(phase.phase);
  const manifestForB = await playerB.readPhaseManifest(phase.phase);
  await playerA.depositToPhase(manifestForA, A.addr);
  await playerB.depositToPhase(manifestForB, B.addr);
  const confirmed = await waitDeposits;
  record('phase setup complete (2 deposits, total 2 CHIPS)', confirmed ? 'PASS' : 'FAIL');

  // ── Test 1: dealer composes cashout proposal ──
  console.log('\n--- Test 1: dealer.composeCashout() ---');
  // Simulate: A won 0.5, B lost 0.5 (B absorbs fee)
  const finalStacks = {
    [PLAYER_A]: 1.5,
    [PLAYER_B]: 0.4999,  // -fee
  };
  // Sum: 1.5 + 0.4999 = 1.9999 + 0.0001 fee = 2.0
  const t1 = Date.now();
  const cashout = await dealer.composeCashout(finalStacks);
  record('1.1 composeCashout returns proposal', cashout && cashout.type === 'cashout' ? 'PASS' : 'FAIL', {
    ms: Date.now() - t1
  });
  record('1.2 cashout has 2 payouts', cashout.payouts.length === 2 ? 'PASS' : 'FAIL');
  record('1.3 cashout has unsignedTxHex', !!cashout.unsignedTxHex ? 'PASS' : 'FAIL');
  record('1.4 cashout multisigBalance is 2', cashout.multisigBalance === 2 ? 'PASS' : 'FAIL');

  await WAIT(3000);

  // ── Test 2: each player reads + verifies the cashout ──
  console.log('\n--- Test 2: players read and verify cashout ---');

  const cashoutForA = await playerA.readCashoutProposal(phase.phase);
  const verifyA = await playerA.verifyCashoutProposal(cashoutForA, manifestForA, A.addr, finalStacks);
  record('2.1 A verifies cashout', verifyA.ok ? 'PASS' : 'FAIL', { note: verifyA.reason || 'verified' });

  const cashoutForB = await playerB.readCashoutProposal(phase.phase);
  const verifyB = await playerB.verifyCashoutProposal(cashoutForB, manifestForB, B.addr, finalStacks);
  record('2.2 B verifies cashout', verifyB.ok ? 'PASS' : 'FAIL', { note: verifyB.reason || 'verified' });

  // ── Test 3: defensive checks reject bad cashouts ──
  console.log('\n--- Test 3: defensive checks ---');

  // 3.1: bad amount for one player
  const badCashout = { ...cashoutForA, payouts: cashoutForA.payouts.map(p => ({ ...p })) };
  badCashout.payouts.find(p => p.id === PLAYER_B).amount = 0.3;
  const verifyBad1 = await playerA.verifyCashoutProposal(badCashout, manifestForA, A.addr, finalStacks);
  record('3.1 reject wrong amount', !verifyBad1.ok ? 'PASS' : 'FAIL', { note: verifyBad1.reason });

  // 3.2: outsider in payouts
  const outsiderCashout = { ...cashoutForA, payouts: [...cashoutForA.payouts, { id: 'outsider.CHIPS@', payAddr: 'RXxxx', amount: 0.1 }] };
  const verifyBad2 = await playerA.verifyCashoutProposal(outsiderCashout, manifestForA, A.addr, finalStacks);
  record('3.2 reject outsider in payouts', !verifyBad2.ok ? 'PASS' : 'FAIL', { note: verifyBad2.reason });

  // 3.3: dropped signer
  const droppedCashout = { ...cashoutForA, payouts: cashoutForA.payouts.filter(p => p.id !== PLAYER_B) };
  const verifyBad3 = await playerA.verifyCashoutProposal(droppedCashout, manifestForA, A.addr, finalStacks);
  record('3.3 reject dropped signer', !verifyBad3.ok ? 'PASS' : 'FAIL', { note: verifyBad3.reason });

  // 3.4: wrong payAddr for a player
  const badAddrCashout = { ...cashoutForA, payouts: cashoutForA.payouts.map(p => ({ ...p })) };
  badAddrCashout.payouts.find(p => p.id === PLAYER_B).payAddr = 'RWrongBAddrxxxxxxxxxxxxxxxxxxxxxxxx';
  const verifyBad4 = await playerA.verifyCashoutProposal(badAddrCashout, manifestForA, A.addr, finalStacks);
  record('3.4 reject wrong payAddr', !verifyBad4.ok ? 'PASS' : 'FAIL', { note: verifyBad4.reason });

  // ── Test 4: players sign + publish their partials ──
  console.log('\n--- Test 4: players sign and publish partials ---');
  const t4 = Date.now();
  const sigA = await playerA.signAndPublishCashout(cashoutForA);
  const sigB = await playerB.signAndPublishCashout(cashoutForB);
  record('4.1 both players signed and published', 'PASS', { ms: Date.now() - t4 });
  record('4.2 sigs have hex', sigA.signedHex && sigB.signedHex ? 'PASS' : 'FAIL');

  // ── Test 5: dealer reads partials ──
  console.log('\n--- Test 5: dealer collects partials ---');
  await WAIT(3000);
  const partials = await dealer.readCashoutPartials(phase.phase);
  record('5.1 dealer reads 2 partials', Object.keys(partials).length === 2 ? 'PASS' : 'FAIL', {
    note: 'got ' + Object.keys(partials).length
  });

  // ── Test 6: dealer finalizes (combine + broadcast) ──
  console.log('\n--- Test 6: dealer finalizes cashout ---');
  const t6 = Date.now();
  const final = await dealer.finalizeCashout(60000);
  record('6.1 finalizeCashout succeeds', final.ok ? 'PASS' : 'FAIL', {
    ms: Date.now() - t6,
    note: final.txid ? final.txid.slice(0, 16) : final.reason
  });

  // ── Test 7: each player's pay address received their payout ──
  console.log('\n--- Test 7: verify payouts received (waits for index update) ---');

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

  const aGot = await waitForTxAtAddr(A.addr, final.txid, 1.5);
  record('7.1 A received 1.5', aGot === 1.5 ? 'PASS' : 'FAIL', { note: 'got ' + aGot });

  const bGot = await waitForTxAtAddr(B.addr, final.txid, 0.4999);
  record('7.2 B received 0.4999', bGot === 0.4999 ? 'PASS' : 'FAIL', { note: 'got ' + bGot });

  // ── Test 8: cashout_settled record published ──
  console.log('\n--- Test 8: cashout_settled record ---');
  const settled = await playerA.readCashoutSettled(phase.phase);
  record('8.1 settled record published', settled && settled.type === 'cashout_settled' ? 'PASS' : 'FAIL', {
    note: settled ? settled.settlementTxId.slice(0, 16) : 'null'
  });

  // ── Test 9: lobby scan for pending cashouts ──
  console.log('\n--- Test 9: lobby scan ---');
  const pendingForA = await playerA.scanPendingCashouts([{ table: TABLE_ID, phase: phase.phase }]);
  record('9.1 A has no pending (already settled)', pendingForA.length === 0 ? 'PASS' : 'FAIL', {
    note: pendingForA.length + ' pending'
  });

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
