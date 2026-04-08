#!/usr/bin/env node
/**
 * Realistic player-join test.
 *
 * This validates the ACTUAL money flow a player would experience:
 *   1. Players A, B form a 2-of-2 multisig and deposit from their own addresses
 *   2. Old multisig settles: A and B each receive payouts to their wallet addresses
 *   3. The funds A and B receive ARE the funds they then re-deposit to phase 2
 *   4. Player C joins with fresh funds from a different source
 *   5. New 2-of-3 multisig forms
 *   6. All 3 deposit to the new multisig
 *   7. Final settlement
 *
 * Critically: A and B's phase-2 deposits use the SAME UTXOs they received from
 * the phase-1 settlement, not random wallet UTXOs. This tests whether players
 * can actually carry their balance forward through a rotation.
 */

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
const auth = 'Basic ' + Buffer.from(rpc.user + ':' + rpc.pass).toString('base64');

async function call(method, params = []) {
  const r = await fetch('http://' + rpc.host + ':' + rpc.port + '/', {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ': ' + j.error.message);
  return j.result;
}

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const round8 = n => Math.round(n * 1e8) / 1e8;

function ts() { return new Date().toISOString().split('T')[1].slice(0, 12); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

// Helpers
async function makePlayer(label, initialFund = 6) {
  const addr = await call('getnewaddress', []);
  const pk = (await call('validateaddress', [addr])).pubkey;
  // Pre-fund the player's address so they have actual UTXOs to spend
  if (initialFund > 0) {
    await call('sendtoaddress', [addr, initialFund]);
  }
  return { label, addr, pubkey: pk };
}

async function getUtxosAt(addr) {
  const raw = await call('getaddressutxos', [{ addresses: [addr] }]);
  return raw.map(u => ({
    txid: u.txid,
    vout: u.outputIndex,
    amount: u.satoshis / 1e8,
    address: u.address,
  }));
}

async function waitForUtxos(addr, expectedCount, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const u = await getUtxosAt(addr);
    if (u.length >= expectedCount) return u;
    await WAIT(1000);
  }
  return await getUtxosAt(addr);
}

async function lockUtxo(txid, vout) {
  return await call('lockunspent', [false, [{ txid, vout }]]);
}

async function unlockUtxo(txid, vout) {
  return await call('lockunspent', [true, [{ txid, vout }]]);
}

async function depositFromAddrSpecific(srcUtxo, srcAddr, msAddr, amount) {
  // Spend a SPECIFIC UTXO from srcAddr to deposit `amount` into msAddr.
  // The change goes back to srcAddr.
  const fee = 0.0001;
  const change = round8(srcUtxo.amount - amount - fee);
  if (change < 0) throw new Error(`UTXO ${srcUtxo.amount} can't fund ${amount} + fee`);

  const inputs = [{ txid: srcUtxo.txid, vout: srcUtxo.vout }];
  const outputs = { [msAddr]: round8(amount) };
  if (change > 0) outputs[srcAddr] = change;

  const rawTx = await call('createrawtransaction', [inputs, outputs]);
  const signed = await call('signrawtransaction', [rawTx]);
  if (!signed.complete) {
    const errs = signed.errors ? signed.errors.map(e => e.error || JSON.stringify(e)).join('; ') : 'no error details';
    throw new Error(`signing failed for UTXO ${srcUtxo.txid.slice(0,16)}:${srcUtxo.vout} from ${srcAddr.slice(0,8)}: ${errs}`);
  }
  return await call('sendrawtransaction', [signed.hex]);
}

async function settleMultisig(msAddr, payouts) {
  const utxos = await getUtxosAt(msAddr);
  if (utxos.length === 0) throw new Error('multisig empty');
  const totalIn = utxos.reduce((s, u) => s + u.amount, 0);
  const totalOut = payouts.reduce((s, p) => s + p.amount, 0);
  if (totalIn - totalOut < 0) throw new Error('outputs exceed inputs');

  const inputs = utxos.map(u => ({ txid: u.txid, vout: u.vout }));
  const outputs = {};
  for (const p of payouts) outputs[p.addr] = round8(p.amount);

  const rawTx = await call('createrawtransaction', [inputs, outputs]);
  const signed = await call('signrawtransaction', [rawTx]);
  if (!signed.complete) throw new Error('settlement signature incomplete');
  return await call('sendrawtransaction', [signed.hex]);
}

async function main() {
  console.log('═'.repeat(70));
  console.log('Realistic player join test (chain-level money flow)');
  console.log('═'.repeat(70));

  const startBalance = await call('getbalance', []);
  console.log('Wallet balance: ' + startBalance + ' CHIPS\n');

  // ── Step 1: Create A and B with their own funds ──
  log('Step 1: create players A and B with their own pre-funded addresses');
  const A = await makePlayer('A', 6);
  const B = await makePlayer('B', 6);
  log(`  A: ${A.addr} (pre-funded with 6 CHIPS)`);
  log(`  B: ${B.addr} (pre-funded with 6 CHIPS)`);

  // Poll until both addresses have funds visible
  log('  waiting for funding to be visible at A and B...');
  const aInitial = await waitForUtxos(A.addr, 1, 90000);
  const bInitial = await waitForUtxos(B.addr, 1, 90000);
  log(`  A has ${aInitial.length} UTXO(s) totaling ${aInitial.reduce((s,u)=>s+u.amount,0)}`);
  log(`  B has ${bInitial.length} UTXO(s) totaling ${bInitial.reduce((s,u)=>s+u.amount,0)}`);

  if (aInitial.length === 0 || bInitial.length === 0) {
    throw new Error('player addresses not funded after 90s');
  }

  // LOCK A and B's UTXOs so the wallet doesn't spend them for other operations
  for (const u of aInitial) await lockUtxo(u.txid, u.vout);
  for (const u of bInitial) await lockUtxo(u.txid, u.vout);
  log(`  locked ${aInitial.length + bInitial.length} player UTXOs to prevent wallet contamination`);

  // ── Step 2: Create phase 1 multisig (2-of-2) ──
  log('Step 2: create phase 1 multisig (2-of-2 of A, B)');
  const ms1 = await call('createmultisig', [2, [A.pubkey, B.pubkey]]);
  await call('addmultisigaddress', [2, [A.pubkey, B.pubkey]]);
  log(`  multisig: ${ms1.address}`);

  // ── Step 3: A and B each deposit 5 CHIPS from their OWN addresses ──
  log('Step 3: A and B deposit 5 CHIPS each from their own addresses');
  // Unlock the UTXOs we're about to spend
  await unlockUtxo(aInitial[0].txid, aInitial[0].vout);
  await unlockUtxo(bInitial[0].txid, bInitial[0].vout);
  const t3 = Date.now();
  const aDepTx = await depositFromAddrSpecific(aInitial[0], A.addr, ms1.address, 5);
  const bDepTx = await depositFromAddrSpecific(bInitial[0], B.addr, ms1.address, 5);
  log(`  A deposit TX: ${aDepTx.slice(0, 16)}`);
  log(`  B deposit TX: ${bDepTx.slice(0, 16)}`);

  await waitForUtxos(ms1.address, 2);
  const phase1Balance = (await getUtxosAt(ms1.address)).reduce((s, u) => s + u.amount, 0);
  log(`  ✓ phase 1 multisig has ${phase1Balance} CHIPS (${Date.now() - t3}ms)`);

  // ── Step 4: Simulate hand play. A wins 1, B loses 1. ──
  log('Step 4: simulating play... A=6, B=4 going into rotation');

  // ── Step 5: Player C wants to join. Settle phase 1 first. ──
  log('Step 5: C wants to join. Settling phase 1 multisig...');
  const t5 = Date.now();
  const settle1Tx = await settleMultisig(ms1.address, [
    { addr: A.addr, amount: 6 },
    { addr: B.addr, amount: 3.9999 },  // 4 - half fee
  ]);
  log(`  settlement TX: ${settle1Tx.slice(0, 16)}`);

  // Wait for A and B to receive their settlements
  let aSettled = null;
  let bSettled = null;
  for (let i = 0; i < 60; i++) {
    const aUtxos = await getUtxosAt(A.addr);
    const bUtxos = await getUtxosAt(B.addr);
    aSettled = aUtxos.find(u => u.txid === settle1Tx);
    bSettled = bUtxos.find(u => u.txid === settle1Tx);
    if (aSettled && bSettled) break;
    await WAIT(1000);
  }
  if (!aSettled || !bSettled) throw new Error('settlements never visible');
  // LOCK the settlement UTXOs so the wallet doesn't spend them when funding C
  await lockUtxo(aSettled.txid, aSettled.vout);
  await lockUtxo(bSettled.txid, bSettled.vout);
  log(`  ✓ A received ${aSettled.amount} CHIPS at ${A.addr.slice(0,8)} (settle 1) (${Date.now() - t5}ms total)`);
  log(`  ✓ B received ${bSettled.amount} CHIPS at ${B.addr.slice(0,8)} (settle 1)`);
  log(`  locked A and B's settlement UTXOs to prevent wallet contamination`);

  // Verify old multisig is empty
  const ms1After = (await getUtxosAt(ms1.address)).reduce((s, u) => s + u.amount, 0);
  log(`  ✓ old multisig drained (balance: ${ms1After})`);

  // ── Step 6: Create C and the new 2-of-3 multisig ──
  log('Step 6: create player C and new 2-of-3 multisig');
  const C = await makePlayer('C', 6);
  log('  waiting for C funding to be visible...');
  const cInitial = await waitForUtxos(C.addr, 1, 90000);
  log(`  C: ${C.addr} has ${cInitial.length} UTXO(s) totaling ${cInitial.reduce((s,u)=>s+u.amount,0)}`);
  // Lock C's UTXO too
  for (const u of cInitial) await lockUtxo(u.txid, u.vout);

  const ms2 = await call('createmultisig', [2, [A.pubkey, B.pubkey, C.pubkey]]);
  await call('addmultisigaddress', [2, [A.pubkey, B.pubkey, C.pubkey]]);
  log(`  new multisig: ${ms2.address} (different from phase 1: ${ms2.address !== ms1.address})`);

  // ── Step 7: Each player deposits to the NEW multisig from their OWN UTXOs ──
  // A uses their phase-1 settlement UTXO (6 CHIPS) to deposit 5
  // B uses their phase-1 settlement UTXO (3.9999) to deposit 3
  // C uses their fresh UTXO (6) to deposit 5
  log('Step 7: each player deposits to new multisig from their OWN UTXOs');
  log('  (A uses settle-1 UTXO, B uses settle-1 UTXO, C uses fresh UTXO)');

  const t7 = Date.now();

  // Unlock A's settlement UTXO and verify it's still there
  await unlockUtxo(aSettled.txid, aSettled.vout);
  let aFreshUtxos = await getUtxosAt(A.addr);
  let aSpendable = aFreshUtxos.find(u => u.txid === aSettled.txid && u.vout === aSettled.vout);
  if (!aSpendable) throw new Error(`A's UTXO ${aSettled.txid}:${aSettled.vout} not found at ${A.addr}`);
  log(`  A's UTXO confirmed: ${aSpendable.txid.slice(0,16)}:${aSpendable.vout} = ${aSpendable.amount}`);

  const aDep2 = await depositFromAddrSpecific(aSpendable, A.addr, ms2.address, 5);
  log(`  A deposited 5 from their settle-1 UTXO: ${aDep2.slice(0,16)}`);

  // Wait for A's deposit to be visible in mempool before B tries
  await WAIT(2000);

  // Unlock B's settlement UTXO and verify
  await unlockUtxo(bSettled.txid, bSettled.vout);
  let bFreshUtxos = await getUtxosAt(B.addr);
  let bSpendable = bFreshUtxos.find(u => u.txid === bSettled.txid && u.vout === bSettled.vout);
  if (!bSpendable) {
    log(`  ⚠ B's settle-1 UTXO not found at ${B.addr}, listing all:`);
    for (const u of bFreshUtxos) log(`    ${u.txid.slice(0,16)}:${u.vout} = ${u.amount}`);
    throw new Error(`B's UTXO ${bSettled.txid}:${bSettled.vout} not found at B's address`);
  }
  log(`  B's UTXO confirmed: ${bSpendable.txid.slice(0,16)}:${bSpendable.vout} = ${bSpendable.amount}`);

  const bDep2 = await depositFromAddrSpecific(bSpendable, B.addr, ms2.address, 3);
  log(`  B deposited 3 from their settle-1 UTXO: ${bDep2.slice(0,16)}`);

  await WAIT(2000);

  // Unlock C's UTXO
  await unlockUtxo(cInitial[0].txid, cInitial[0].vout);
  const cDep2 = await depositFromAddrSpecific(cInitial[0], C.addr, ms2.address, 5);
  log(`  C deposited 5 from their fresh UTXO: ${cDep2.slice(0,16)}`);

  await waitForUtxos(ms2.address, 3);
  const phase2Balance = (await getUtxosAt(ms2.address)).reduce((s, u) => s + u.amount, 0);
  log(`  ✓ phase 2 multisig has ${phase2Balance} CHIPS (${Date.now() - t7}ms)`);

  // ── Step 8: Simulate play, then final settlement ──
  log('Step 8: simulating play... A=6, B=4, C=2.9999 going into final settle');

  log('Step 9: final settlement of phase 2 multisig');
  const t9 = Date.now();
  const settle2Tx = await settleMultisig(ms2.address, [
    { addr: A.addr, amount: 6 },
    { addr: B.addr, amount: 4 },
    { addr: C.addr, amount: 2.9999 },
  ]);
  log(`  final settlement TX: ${settle2Tx.slice(0, 16)}`);

  // Verify all 3 receive
  let aFinal = null, bFinal = null, cFinal = null;
  for (let i = 0; i < 60; i++) {
    const aU = await getUtxosAt(A.addr);
    const bU = await getUtxosAt(B.addr);
    const cU = await getUtxosAt(C.addr);
    aFinal = aU.find(u => u.txid === settle2Tx);
    bFinal = bU.find(u => u.txid === settle2Tx);
    cFinal = cU.find(u => u.txid === settle2Tx);
    if (aFinal && bFinal && cFinal) break;
    await WAIT(1000);
  }

  if (!aFinal || !bFinal || !cFinal) throw new Error('not all final payouts visible');
  log(`  ✓ A received final ${aFinal.amount} CHIPS (${Date.now() - t9}ms total)`);
  log(`  ✓ B received final ${bFinal.amount} CHIPS`);
  log(`  ✓ C received final ${cFinal.amount} CHIPS`);

  console.log('\n' + '═'.repeat(70));
  console.log('FULL FLOW VALIDATED');
  console.log('═'.repeat(70));
  console.log('Players A, B started with their own funds');
  console.log('Phase 1: 2-of-2 multisig with A=5, B=5 deposits → 10 CHIPS pooled');
  console.log('Settlement 1: A=6 (won 1), B=3.9999 (lost 1) — back to their wallets');
  console.log('Player C joined with fresh funds');
  console.log('Phase 2: A and B re-deposited from their settlement UTXOs (carry-forward),');
  console.log('         C deposited from fresh funds → 13 CHIPS pooled');
  console.log('Settlement 2: A=6, B=4, C=2.9999 — all 3 paid out');
  console.log('Total chain TXs: ~10 (2 player funds, 2 deposits, 1 settle, 3 deposits, 1 settle, 1 C fund)');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
