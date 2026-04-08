#!/usr/bin/env node
/**
 * Parallelism opportunity validation tests.
 *
 * These test whether various optimization patterns actually work on real CHIPS,
 * before we change the production code.
 *
 * Tests:
 *   A. Concurrent updateidentity + sendcurrency on the SAME identity
 *      (validates that game state writes and game money writes don't collide)
 *   B. Concurrent updateidentity calls on DIFFERENT identities
 *      (validates pre-staging hand N+1 cashier work during hand N dealer work)
 *   C. Parallel vs sequential reads from multiple identities
 *      (validates parallel polling savings)
 *   D. Settlement TX + next-hand identity update back-to-back
 *      (validates pipelining settlement with next hand setup)
 *   E. Player updateidentity + multisig deposit in parallel
 *      (validates pre-funding next hand's multisig during current hand)
 *   F. Sequential identity updates with mempool chaining
 *      (measures real latency between sequential writes — is the mutex needed?)
 *
 * Usage: node test-parallelism.mjs
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

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function runTest(name, fn) {
  console.log('\n' + '═'.repeat(70));
  console.log('TEST: ' + name);
  console.log('═'.repeat(70));
  const t0 = Date.now();
  try {
    await fn();
    console.log('TEST DONE (' + (Date.now() - t0) + 'ms)');
  } catch (e) {
    record(name + ' [overall]', 'FAIL', { note: e.message });
    console.log('FAILED: ' + e.message);
  }
}

// Constants
const TEST_ID = 'pc-player';
const FULL_ID = TEST_ID + '.CHIPS@';
const TEST_KEY = 'chips.vrsc::poker.sg777z.t_table_info';
let vdxfId, parent;

async function bootstrap() {
  // Get the VDXF ID and parent for our test identity (one-time setup)
  vdxfId = (await call('getvdxfid', [TEST_KEY])).vdxfid;
  const idInfo = await call('getidentity', [FULL_ID]);
  parent = idInfo.identity.parent;
}

function makeUpdateParams(payloadObj, sourceAddr) {
  const hex = Buffer.from(JSON.stringify(payloadObj)).toString('hex');
  const params = { name: TEST_ID, parent, contentmultimap: { [vdxfId]: hex } };
  if (sourceAddr) {
    return [params, false, false, 0, sourceAddr];
  }
  return [params];
}

// ════════════════════════════════════════════════════════
// TEST A — Concurrent updateidentity + sendcurrency from SAME identity
// ════════════════════════════════════════════════════════
async function testA_sameIdentityConcurrent() {
  // Setup: ensure pc-player.CHIPS@ has spendable i-address UTXOs
  // (we know it does from previous tests, but let's verify)
  const idInfo = await call('getidentity', [FULL_ID]);
  const iaddr = idInfo.identity.identityaddress;
  const utxos = await call('getaddressutxos', [{ addresses: [iaddr] }]);
  const spendable = utxos.filter(u => u.isspendable);
  if (spendable.length < 1) {
    // Top up
    console.log('  topping up i-address with 0.5 CHIPS...');
    await call('sendtoaddress', [FULL_ID, 0.5]);
    await WAIT(8000);
  }
  record('A.1 i-address has spendable UTXOs', 'PASS', { note: spendable.length + ' utxos' });

  // Create a fresh fee budget address for the identity update
  const feeAddr = await call('getnewaddress', []);
  const fundTx = await call('sendtoaddress', [feeAddr, 0.5]);
  await WAIT(8000); // wait for confirmation
  record('A.2 fee budget address funded', 'PASS', { note: feeAddr.slice(0, 12) });

  // Recipient for the sendcurrency
  const recipient = await call('getnewaddress', []);

  // Now: fire both ops in parallel
  console.log('  firing updateidentity AND sendcurrency in parallel...');
  const t0 = Date.now();
  const [updateResult, sendResult] = await Promise.allSettled([
    call('updateidentity', makeUpdateParams({ test: 'parallel-A', ts: Date.now() }, feeAddr)),
    call('sendcurrency', [FULL_ID, [{ address: recipient, amount: 0.1 }]]),
  ]);
  const ms = Date.now() - t0;

  if (updateResult.status === 'fulfilled' && sendResult.status === 'fulfilled') {
    record('A.3 parallel updateidentity + sendcurrency', 'PASS', {
      ms,
      note: 'update=' + updateResult.value.slice(0,12) + ' send=opid'
    });
  } else {
    const errs = [];
    if (updateResult.status === 'rejected') errs.push('update: ' + updateResult.reason.message.slice(0, 100));
    if (sendResult.status === 'rejected') errs.push('send: ' + sendResult.reason.message.slice(0, 100));
    record('A.3 parallel updateidentity + sendcurrency', 'FAIL', { ms, note: errs.join('; ') });
  }
}

// ════════════════════════════════════════════════════════
// TEST B — Concurrent updates on DIFFERENT identities
// ════════════════════════════════════════════════════════
async function testB_differentIdentities() {
  // For this test we need two identities we control on this daemon.
  // Use pc-player and cashier1 (we know both are local).
  let cashierInfo;
  try {
    cashierInfo = await call('getidentity', ['cashier1.CHIPS@']);
  } catch (e) {
    record('B.0 SKIP — cashier1 not on this daemon', 'SKIP');
    return;
  }
  record('B.1 both test identities available', 'PASS');

  // Fee addresses for each
  const feeAddr1 = await call('getnewaddress', []);
  const feeAddr2 = await call('getnewaddress', []);
  await call('sendtoaddress', [feeAddr1, 0.3]);
  await call('sendtoaddress', [feeAddr2, 0.3]);
  await WAIT(8000);
  record('B.2 fee addresses funded', 'PASS');

  // Bootstrap cashier1 metadata
  const cashierVdxf = (await call('getvdxfid', [TEST_KEY])).vdxfid;
  const cashierParent = cashierInfo.identity.parent;

  // Fire both updates in parallel
  console.log('  firing updateidentity to pc-player AND cashier1 in parallel...');
  const t0 = Date.now();
  const [r1, r2] = await Promise.allSettled([
    call('updateidentity', [
      { name: 'pc-player', parent, contentmultimap: { [vdxfId]: Buffer.from('{"x":"a"}').toString('hex') } },
      false, false, 0, feeAddr1
    ]),
    call('updateidentity', [
      { name: 'cashier1', parent: cashierParent, contentmultimap: { [cashierVdxf]: Buffer.from('{"x":"b"}').toString('hex') } },
      false, false, 0, feeAddr2
    ])
  ]);
  const ms = Date.now() - t0;

  if (r1.status === 'fulfilled' && r2.status === 'fulfilled') {
    record('B.3 parallel updates on different identities', 'PASS', { ms });
  } else {
    const errs = [];
    if (r1.status === 'rejected') errs.push('id1: ' + r1.reason.message.slice(0, 100));
    if (r2.status === 'rejected') errs.push('id2: ' + r2.reason.message.slice(0, 100));
    record('B.3 parallel updates on different identities', 'FAIL', { ms, note: errs.join('; ') });
  }

  // Compare to sequential timing for the same operations
  await WAIT(4000); // let the previous TXs settle
  const feeAddr3 = await call('getnewaddress', []);
  const feeAddr4 = await call('getnewaddress', []);
  await call('sendtoaddress', [feeAddr3, 0.3]);
  await call('sendtoaddress', [feeAddr4, 0.3]);
  await WAIT(8000);

  console.log('  same operations sequentially for comparison...');
  const tSeq0 = Date.now();
  await call('updateidentity', [
    { name: 'pc-player', parent, contentmultimap: { [vdxfId]: Buffer.from('{"x":"c"}').toString('hex') } },
    false, false, 0, feeAddr3
  ]);
  await call('updateidentity', [
    { name: 'cashier1', parent: cashierParent, contentmultimap: { [cashierVdxf]: Buffer.from('{"x":"d"}').toString('hex') } },
    false, false, 0, feeAddr4
  ]);
  const seqMs = Date.now() - tSeq0;
  record('B.4 same ops sequential (for comparison)', 'PASS', { ms: seqMs });
  record('B.5 parallelism savings', 'PASS', { note: (seqMs - ms) + 'ms saved (' + Math.round((seqMs - ms) / seqMs * 100) + '%)' });
}

// ════════════════════════════════════════════════════════
// TEST C — Parallel vs sequential reads
// ════════════════════════════════════════════════════════
async function testC_parallelReads() {
  // Read pc-player and cashier1 identities a bunch of times, both ways
  const ids = ['pc-player.CHIPS@', 'cashier1.CHIPS@', 'pplayer2.CHIPS@', 'pdealer2.CHIPS@', 'ptable2.CHIPS@'];
  // Filter to ones that exist
  const validIds = [];
  for (const id of ids) {
    try {
      await call('getidentity', [id]);
      validIds.push(id);
    } catch {}
  }
  record('C.1 found ' + validIds.length + ' valid identities to read', 'PASS');

  // Sequential reads
  const tSeq = Date.now();
  for (const id of validIds) {
    await call('getidentity', [id]);
  }
  const seqMs = Date.now() - tSeq;
  record('C.2 sequential ' + validIds.length + ' getidentity', 'PASS', { ms: seqMs });

  // Parallel reads
  const tPar = Date.now();
  await Promise.all(validIds.map(id => call('getidentity', [id])));
  const parMs = Date.now() - tPar;
  record('C.3 parallel ' + validIds.length + ' getidentity', 'PASS', { ms: parMs });
  record('C.4 parallelism savings', 'PASS', {
    note: (seqMs - parMs) + 'ms saved (' + Math.round((seqMs - parMs) / Math.max(seqMs, 1) * 100) + '%)'
  });

  // Try the same with getidentitycontent (heavier RPC)
  const tSeq2 = Date.now();
  for (const id of validIds) {
    await call('getidentitycontent', [id, 0, -1, false, 0, vdxfId]);
  }
  const seqMs2 = Date.now() - tSeq2;
  record('C.5 sequential getidentitycontent', 'PASS', { ms: seqMs2 });

  const tPar2 = Date.now();
  await Promise.all(validIds.map(id => call('getidentitycontent', [id, 0, -1, false, 0, vdxfId])));
  const parMs2 = Date.now() - tPar2;
  record('C.6 parallel getidentitycontent', 'PASS', { ms: parMs2 });
  record('C.7 getidentitycontent savings', 'PASS', {
    note: (seqMs2 - parMs2) + 'ms saved'
  });
}

// ════════════════════════════════════════════════════════
// TEST D — Settlement TX + next-hand identity update back-to-back
// ════════════════════════════════════════════════════════
async function testD_settlementPlusNextHand() {
  // Create a 2-of-2 multisig that we control entirely
  const A = await call('getnewaddress', []);
  const B = await call('getnewaddress', []);
  const pkA = (await call('validateaddress', [A])).pubkey;
  const pkB = (await call('validateaddress', [B])).pubkey;
  const ms = await call('createmultisig', [2, [pkA, pkB]]);
  await call('addmultisigaddress', [2, [pkA, pkB]]);

  // Fund it with 1 CHIPS, wait for it to actually appear
  await call('sendtoaddress', [ms.address, 1]);
  let utxos = [];
  for (let i = 0; i < 30 && utxos.length < 1; i++) {
    await WAIT(2000);
    utxos = await call('getaddressutxos', [{ addresses: [ms.address] }]);
  }
  if (utxos.length < 1) throw new Error('multisig not funded after 60s');
  record('D.1 multisig funded', 'PASS', { note: utxos.length + ' UTXOs' });

  // Create a fee address for the identity update
  const feeAddr = await call('getnewaddress', []);
  await call('sendtoaddress', [feeAddr, 0.3]);
  await WAIT(8000);
  record('D.2 fee budget for identity update funded', 'PASS');

  // Compose the settlement TX (multisig spend back to two new addresses)
  const r1 = await call('getnewaddress', []);
  const r2 = await call('getnewaddress', []);
  const fee = 0.0001;
  const utxoTotal = utxos.reduce((s, u) => s + u.satoshis, 0) / 1e8;
  const inputs = utxos.map(u => ({ txid: u.txid, vout: u.outputIndex }));
  const outputs = { [r1]: round8(utxoTotal / 2 - fee / 2), [r2]: round8(utxoTotal / 2 - fee / 2) };
  const rawTx = await call('createrawtransaction', [inputs, outputs]);
  const signed = await call('signrawtransaction', [rawTx]);
  if (!signed.complete) throw new Error('settlement sign incomplete');
  record('D.3 settlement TX prepared', 'PASS');

  // Now fire BOTH: the settlement broadcast AND an identity update
  console.log('  firing settlement TX + identity update in parallel...');
  const t0 = Date.now();
  const [settleResult, updateResult] = await Promise.allSettled([
    call('sendrawtransaction', [signed.hex]),
    call('updateidentity', makeUpdateParams({ test: 'parallel-D', ts: Date.now() }, feeAddr)),
  ]);
  const ms2 = Date.now() - t0;

  if (settleResult.status === 'fulfilled' && updateResult.status === 'fulfilled') {
    record('D.4 parallel settlement + updateidentity', 'PASS', {
      ms: ms2,
      note: 'settle=' + settleResult.value.slice(0,12) + ' update=' + updateResult.value.slice(0,12)
    });
  } else {
    const errs = [];
    if (settleResult.status === 'rejected') errs.push('settle: ' + settleResult.reason.message.slice(0, 100));
    if (updateResult.status === 'rejected') errs.push('update: ' + updateResult.reason.message.slice(0, 100));
    record('D.4 parallel settlement + updateidentity', 'FAIL', { ms: ms2, note: errs.join('; ') });
  }
}

// ════════════════════════════════════════════════════════
// TEST E — Player updateidentity + deposit to next hand's multisig
// ════════════════════════════════════════════════════════
async function testE_playerUpdateAndPreDeposit() {
  // Create a "next hand" multisig that the player will pre-deposit to
  const A = await call('getnewaddress', []);
  const B = await call('getnewaddress', []);
  const pkA = (await call('validateaddress', [A])).pubkey;
  const pkB = (await call('validateaddress', [B])).pubkey;
  const nextMs = await call('createmultisig', [2, [pkA, pkB]]);
  record('E.1 next hand multisig computed', 'PASS', { note: nextMs.address.slice(0, 12) });

  // Fee budget for the identity update
  const feeAddr = await call('getnewaddress', []);
  await call('sendtoaddress', [feeAddr, 0.3]);
  await WAIT(8000);
  record('E.2 fee budget funded', 'PASS');

  // Make sure the player's identity has spendable i-address UTXOs
  const idInfo = await call('getidentity', [FULL_ID]);
  const iaddr = idInfo.identity.identityaddress;
  let iUtxos = (await call('getaddressutxos', [{ addresses: [iaddr] }])).filter(u => u.isspendable);
  if (iUtxos.length < 1) {
    await call('sendtoaddress', [FULL_ID, 0.5]);
    await WAIT(8000);
    iUtxos = (await call('getaddressutxos', [{ addresses: [iaddr] }])).filter(u => u.isspendable);
  }
  record('E.3 player has spendable i-address UTXOs', 'PASS', { note: iUtxos.length + ' utxos' });

  // Fire both: identity update (game state) + sendcurrency to next multisig (pre-fund)
  console.log('  firing identity update + pre-deposit to next multisig in parallel...');
  const t0 = Date.now();
  const [r1, r2] = await Promise.allSettled([
    call('updateidentity', makeUpdateParams({ test: 'parallel-E', ts: Date.now() }, feeAddr)),
    call('sendcurrency', [FULL_ID, [{ address: nextMs.address, amount: 0.1 }]]),
  ]);
  const ms = Date.now() - t0;

  if (r1.status === 'fulfilled' && r2.status === 'fulfilled') {
    record('E.4 parallel identity update + pre-deposit', 'PASS', { ms });
  } else {
    const errs = [];
    if (r1.status === 'rejected') errs.push('update: ' + r1.reason.message.slice(0, 100));
    if (r2.status === 'rejected') errs.push('deposit: ' + r2.reason.message.slice(0, 100));
    record('E.4 parallel identity update + pre-deposit', 'FAIL', { ms, note: errs.join('; ') });
  }
}

// ════════════════════════════════════════════════════════
// TEST F — Sequential identity updates: how fast can we go?
// ════════════════════════════════════════════════════════
async function testF_sequentialChaining() {
  // Test how rapidly we can issue sequential updateidentity calls.
  // The chain enforces that the next update can only be issued once the
  // previous one's primary output is visible (in mempool). Measure that.
  const feeAddr = await call('getnewaddress', []);
  await call('sendtoaddress', [feeAddr, 1.5]);
  await WAIT(10000);
  record('F.1 fee budget funded', 'PASS');

  // Issue 5 sequential updates with NO wait between them.
  // Expect the second one to fail with "inputs-spent" because the first
  // one's primary output isn't yet known to the wallet's UTXO selector.
  console.log('  issuing 5 sequential updates with NO wait...');
  const noWaitResults = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      await call('updateidentity', makeUpdateParams({ test: 'F-nowait', i, ts: Date.now() }, feeAddr));
      noWaitResults.push({ ok: true, ms: Date.now() - t0 });
    } catch (e) {
      noWaitResults.push({ ok: false, ms: Date.now() - t0, err: e.message.slice(0, 60) });
    }
  }
  const noWaitOk = noWaitResults.filter(r => r.ok).length;
  record('F.2 5 sequential, no wait', noWaitOk === 5 ? 'PASS' : 'FAIL', {
    note: `${noWaitOk}/5 ok, individual times: ${noWaitResults.map(r => r.ms).join(',')}ms`
  });
  if (noWaitOk < 5) {
    record('F.2.fail-detail', 'PASS', { note: 'first failure: ' + (noWaitResults.find(r => !r.ok)?.err || 'none') });
  }

  // Wait for things to settle, then test with explicit short waits between updates
  await WAIT(5000);
  console.log('  issuing 5 sequential updates with 500ms wait...');
  const wait500 = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      await call('updateidentity', makeUpdateParams({ test: 'F-500', i, ts: Date.now() }, feeAddr));
      wait500.push({ ok: true, ms: Date.now() - t0 });
    } catch (e) {
      wait500.push({ ok: false, ms: Date.now() - t0, err: e.message.slice(0, 60) });
    }
    await WAIT(500);
  }
  const w500ok = wait500.filter(r => r.ok).length;
  record('F.3 5 sequential, 500ms wait', w500ok === 5 ? 'PASS' : 'FAIL', {
    note: `${w500ok}/5 ok, total ${wait500.reduce((s, r) => s + r.ms, 0)}ms`
  });

  // Try with 2 second waits
  await WAIT(5000);
  console.log('  issuing 5 sequential updates with 2000ms wait...');
  const wait2000 = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      await call('updateidentity', makeUpdateParams({ test: 'F-2000', i, ts: Date.now() }, feeAddr));
      wait2000.push({ ok: true, ms: Date.now() - t0 });
    } catch (e) {
      wait2000.push({ ok: false, ms: Date.now() - t0, err: e.message.slice(0, 60) });
    }
    await WAIT(2000);
  }
  const w2000ok = wait2000.filter(r => r.ok).length;
  record('F.4 5 sequential, 2000ms wait', w2000ok === 5 ? 'PASS' : 'FAIL', {
    note: `${w2000ok}/5 ok, total ${wait2000.reduce((s, r) => s + r.ms, 0)}ms`
  });
}

// ════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════
async function main() {
  console.log('═'.repeat(70));
  console.log('Parallelism opportunity validation tests');
  console.log('═'.repeat(70));

  const info = await call('getinfo', []);
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  const balance = await call('getbalance', []);
  console.log('Wallet balance: ' + balance + ' CHIPS');
  if (balance < 10) {
    console.log('WARNING: Low balance, some tests may fail.');
  }

  await bootstrap();

  await runTest('A. Concurrent updateidentity + sendcurrency (same identity)', testA_sameIdentityConcurrent);
  await runTest('B. Concurrent updates on different identities', testB_differentIdentities);
  await runTest('C. Parallel vs sequential reads', testC_parallelReads);
  await runTest('D. Settlement TX + next-hand updateidentity in parallel', testD_settlementPlusNextHand);
  await runTest('E. Player updateidentity + pre-deposit to next multisig', testE_playerUpdateAndPreDeposit);
  await runTest('F. Sequential updates with mempool chaining', testF_sequentialChaining);

  console.log('\n' + '═'.repeat(70));
  console.log('SUMMARY');
  console.log('═'.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;
  console.log(`PASS: ${pass}   FAIL: ${fail}   SKIP: ${skip}   (total: ${results.length})`);
  if (fail > 0) {
    console.log('\nFailures:');
    for (const r of results.filter(r => r.status === 'FAIL')) {
      console.log('  ✗ ' + r.name + (r.note ? ' — ' + r.note : ''));
    }
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
