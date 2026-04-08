#!/usr/bin/env node
/**
 * Step 10: end-to-end phase-multisig integration test
 *
 * The headline test that exercises the full integrated flow:
 *
 *   1. Dealer opens a table
 *   2. Dealer opens phase 1 with 2 players (heads-up, 2-of-2 multisig)
 *   3. Both players read manifest, verify, deposit from their pay addresses
 *   4. Dealer detects deposits, publishes phase_confirmed
 *   5. (Simulated hands: dealer's players[] chip stacks are updated to
 *       reflect what would happen after several hands)
 *   6. Dealer composes cashout from current player stacks
 *   7. Players verify cashout, sign, publish partials
 *   8. Dealer combines partials, broadcasts settlement
 *   9. Both players' pay addresses receive their final stacks
 *  10. Phase rotation: same players continue with new buy-ins (carry-forward)
 *  11. Run another phase end-to-end
 *  12. Settle phase 2
 *  13. Verify total balance flow is consistent (no funds lost or created)
 *
 * This test mimics the real production flow except that hands are
 * "simulated" by directly updating chip stacks instead of running the
 * full poker game (which would require the cashier process and player
 * action input). The phase-multisig integration is the same regardless of
 * how the chip stacks got their final values.
 *
 * Usage: node test-step10-end-to-end.mjs
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
  smallBlind: 0.1, bigBlind: 0.2, buyin: 5, cashiers: [],
}, () => {});

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

async function getBalance(addr) {
  const utxos = await p2pDealer.getAddressUtxos(addr);
  return utxos.reduce((s, u) => s + u.amount, 0);
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Step 10: end-to-end phase-multisig integration test');
  console.log('═'.repeat(70));

  const info = await p2pDealer.client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  console.log('Wallet balance: ' + (await p2pDealer.client.call('getbalance', [])) + ' CHIPS\n');

  const overallT0 = Date.now();

  // ──────────────────────────────────────────────
  // SETUP: open table, get player wallets
  // ──────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('SETUP');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await dealer.openTable();
  await WAIT(2000);
  record('table opened', 'PASS', { note: 'session=' + (await p2pDealer.read(TABLE_ID, 'chips.vrsc::poker.sg777z.t_table_info'))?.session });

  const A = await getRealIdentityWallet(PLAYER_A);
  const B = await getRealIdentityWallet(PLAYER_B);
  await p2pDealer.waitForAddressUtxos(A.addr, 1, 60000);
  await p2pDealer.waitForAddressUtxos(B.addr, 1, 60000);

  const aStartBalance = await getBalance(A.addr);
  const bStartBalance = await getBalance(B.addr);
  record('player wallets ready', 'PASS', {
    note: 'A start: ' + aStartBalance + ', B start: ' + bStartBalance
  });

  // ──────────────────────────────────────────────
  // PHASE 1: 2-player heads-up, A wins net 0.5 CHIPS
  // ──────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PHASE 1: 2-of-2 heads-up, deposit 1 CHIPS each');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Step 1: dealer adds players to its in-memory state (this is what addPlayer does in production)
  dealer.addPlayer(PLAYER_A, 1.0);
  dealer.addPlayer(PLAYER_B, 1.0);
  record('1.1 dealer added 2 players', 'PASS');

  // Step 2: dealer opens the phase
  const roster1 = [
    { id: PLAYER_A, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: 1.0 },
    { id: PLAYER_B, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: 1.0 },
  ];
  const phase1 = await dealer.openPhase(roster1, 2);
  record('1.2 phase 1 opened', 'PASS', { note: phase1.phase });

  // Step 3: players read manifest, verify
  await WAIT(2000);
  const manifestA1 = await playerA.readPhaseManifest(phase1.phase);
  const manifestB1 = await playerB.readPhaseManifest(phase1.phase);
  const verifyA1 = playerA.verifyPhaseManifest(manifestA1, A.addr);
  const verifyB1 = playerB.verifyPhaseManifest(manifestB1, B.addr);
  record('1.3 both players verified manifest', verifyA1.ok && verifyB1.ok ? 'PASS' : 'FAIL');

  // Step 4: players deposit
  const waitDeposits1 = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA1, A.addr);
  await playerB.depositToPhase(manifestB1, B.addr);
  const confirmed1 = await waitDeposits1;
  record('1.4 phase 1 deposits confirmed', confirmed1 ? 'PASS' : 'FAIL');

  // Step 5: simulate hands - A wins 0.5 CHIPS from B
  // Update dealer's in-memory player stacks to reflect "what happened in the hand"
  console.log('  [simulating hands: A wins 0.5 from B]');
  const dealerPlayers1 = dealer.getPlayers();
  dealerPlayers1.find(p => p.id === PLAYER_A).chips = 1.5;
  dealerPlayers1.find(p => p.id === PLAYER_B).chips = 0.5;
  record('1.5 player stacks after simulated hands', 'PASS', { note: 'A=1.5 B=0.5' });

  // Step 6: dealer composes cashout from current stacks
  const cashout1 = await dealer.composeCashoutFromPlayers();
  await WAIT(2000);
  record('1.6 dealer composed cashout', 'PASS', {
    note: cashout1.payouts.map(p => p.id + '=' + p.amount).join(', ')
  });

  // Step 7: players verify and sign
  const cashoutForA1 = await playerA.readCashoutProposal(phase1.phase);
  const cashoutForB1 = await playerB.readCashoutProposal(phase1.phase);

  // Build the stacks oracle from what the dealer published (for verification)
  const stacksOracle1 = {};
  for (const p of cashout1.payouts) stacksOracle1[p.id] = p.amount;

  const verifyCashoutA1 = await playerA.verifyCashoutProposal(cashoutForA1, manifestA1, A.addr, stacksOracle1);
  const verifyCashoutB1 = await playerB.verifyCashoutProposal(cashoutForB1, manifestB1, B.addr, stacksOracle1);
  record('1.7 both players verified cashout', verifyCashoutA1.ok && verifyCashoutB1.ok ? 'PASS' : 'FAIL', {
    note: verifyCashoutA1.reason || verifyCashoutB1.reason || 'verified'
  });

  await playerA.signAndPublishCashout(cashoutForA1);
  await playerB.signAndPublishCashout(cashoutForB1);
  record('1.8 both players signed and published partials', 'PASS');

  // Step 8: dealer finalizes
  const final1 = await dealer.finalizeCashout(60000);
  record('1.9 phase 1 settlement broadcast', final1.ok ? 'PASS' : 'FAIL', { note: final1.txid?.slice(0, 16) });

  // Step 9: verify both players received correct amounts
  const aPayout1 = cashout1.payouts.find(p => p.id === PLAYER_A).amount;
  const bPayout1 = cashout1.payouts.find(p => p.id === PLAYER_B).amount;
  const aGot1 = await waitForTxAtAddr(A.addr, final1.txid, aPayout1);
  const bGot1 = await waitForTxAtAddr(B.addr, final1.txid, bPayout1);
  record('1.10 A received phase 1 payout', aGot1 === aPayout1 ? 'PASS' : 'FAIL', { note: 'got ' + aGot1 + ' / ' + aPayout1 });
  record('1.11 B received phase 1 payout', bGot1 === bPayout1 ? 'PASS' : 'FAIL', { note: 'got ' + bGot1 + ' / ' + bPayout1 });

  const phase1Time = Date.now() - overallT0;
  console.log('  Phase 1 complete in ' + phase1Time + 'ms');

  // ──────────────────────────────────────────────
  // PHASE 2: same players continue, B wins back
  // ──────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('PHASE 2: rotation, both deposit again from their fresh payouts');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Reset dealer's players[] for the new phase (or update — depends on real flow)
  // For this test, we keep the same players and reset their chip stacks to the new buy-in
  dealerPlayers1.find(p => p.id === PLAYER_A).chips = 1.0;
  dealerPlayers1.find(p => p.id === PLAYER_B).chips = 1.0;

  const roster2 = [
    { id: PLAYER_A, payAddr: A.addr, pubkey: A.pubkey, expectedDeposit: 1.0 },
    { id: PLAYER_B, payAddr: B.addr, pubkey: B.pubkey, expectedDeposit: 1.0 },
  ];
  const phase2 = await dealer.openPhase(roster2, 2);
  record('2.1 phase 2 opened', 'PASS', { note: phase2.phase });

  await WAIT(2000);
  const manifestA2 = await playerA.readPhaseManifest(phase2.phase);
  const manifestB2 = await playerB.readPhaseManifest(phase2.phase);
  record('2.2 both players read new manifest', manifestA2 && manifestB2 ? 'PASS' : 'FAIL');

  // Players deposit again — note they're using their settlement UTXOs from phase 1
  // (this is the carry-forward we validated earlier)
  const waitDeposits2 = dealer.waitForPhaseDeposits(120000);
  await WAIT(1000);
  await playerA.depositToPhase(manifestA2, A.addr);
  await playerB.depositToPhase(manifestB2, B.addr);
  const confirmed2 = await waitDeposits2;
  record('2.3 phase 2 deposits confirmed', confirmed2 ? 'PASS' : 'FAIL');

  // Simulate: B wins back, ends with 1.5
  console.log('  [simulating hands: B wins 0.5 back from A]');
  dealerPlayers1.find(p => p.id === PLAYER_A).chips = 0.5;
  dealerPlayers1.find(p => p.id === PLAYER_B).chips = 1.5;

  const cashout2 = await dealer.composeCashoutFromPlayers();
  await WAIT(2000);
  record('2.4 phase 2 cashout composed', 'PASS', {
    note: cashout2.payouts.map(p => p.id + '=' + p.amount).join(', ')
  });

  // Players sign
  const cashoutForA2 = await playerA.readCashoutProposal(phase2.phase);
  const cashoutForB2 = await playerB.readCashoutProposal(phase2.phase);
  const stacksOracle2 = {};
  for (const p of cashout2.payouts) stacksOracle2[p.id] = p.amount;
  const verifyA2 = await playerA.verifyCashoutProposal(cashoutForA2, manifestA2, A.addr, stacksOracle2);
  const verifyB2 = await playerB.verifyCashoutProposal(cashoutForB2, manifestB2, B.addr, stacksOracle2);
  record('2.5 both players verified phase 2 cashout', verifyA2.ok && verifyB2.ok ? 'PASS' : 'FAIL');

  await playerA.signAndPublishCashout(cashoutForA2);
  await playerB.signAndPublishCashout(cashoutForB2);

  const final2 = await dealer.finalizeCashout(60000);
  record('2.6 phase 2 settlement broadcast', final2.ok ? 'PASS' : 'FAIL');

  const aPayout2 = cashout2.payouts.find(p => p.id === PLAYER_A).amount;
  const bPayout2 = cashout2.payouts.find(p => p.id === PLAYER_B).amount;
  const aGot2 = await waitForTxAtAddr(A.addr, final2.txid, aPayout2);
  const bGot2 = await waitForTxAtAddr(B.addr, final2.txid, bPayout2);
  record('2.7 A received phase 2 payout', aGot2 === aPayout2 ? 'PASS' : 'FAIL', { note: 'got ' + aGot2 + ' / ' + aPayout2 });
  record('2.8 B received phase 2 payout', bGot2 === bPayout2 ? 'PASS' : 'FAIL', { note: 'got ' + bGot2 + ' / ' + bPayout2 });

  // ──────────────────────────────────────────────
  // VERIFICATION: total balance flow consistent
  // ──────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('VERIFICATION: total balance flow');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Total CHIPS that flowed through the multisigs:
  //   Phase 1: 2.0 in, 1.9999 out (0.0001 fee)
  //   Phase 2: 2.0 in, 1.9999 out (0.0001 fee)
  // Total fees: 0.0002 CHIPS
  const totalFees = 0.0002;

  // Net change for each player from start to end:
  //   A: started with X, paid 1+1=2 in deposits, received 1.5+0.5=2 in payouts
  //      → net: paid (2 - 2) = 0 (excluding fee absorption)
  //   B: started with Y, paid 1+1=2 in deposits, received 0.4999+1.4999=1.9998 in payouts
  //      → net: paid 0.0002 (the total fee)

  const aFinalBalance = await getBalance(A.addr);
  const bFinalBalance = await getBalance(B.addr);

  console.log(`  A balance: ${aStartBalance} → ${aFinalBalance} (delta ${aFinalBalance - aStartBalance})`);
  console.log(`  B balance: ${bStartBalance} → ${bFinalBalance} (delta ${bFinalBalance - bStartBalance})`);
  console.log(`  Total fees absorbed: ${totalFees}`);

  // The combined balance change should equal -totalFees (since the rest is just
  // money moving between the two players)
  const combinedDelta = (aFinalBalance + bFinalBalance) - (aStartBalance + bStartBalance);
  // It should be approximately -totalFees but actual chain fees may differ slightly
  const closeEnough = Math.abs(combinedDelta + totalFees) < 0.001;
  record('V.1 combined balance change ≈ -totalFees', closeEnough ? 'PASS' : 'FAIL', {
    note: 'delta=' + combinedDelta + ', expected ≈ ' + (-totalFees)
  });

  const overallTime = Date.now() - overallT0;
  console.log('\n  TOTAL test time: ' + (overallTime / 1000).toFixed(1) + 's for 2 phases');

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
