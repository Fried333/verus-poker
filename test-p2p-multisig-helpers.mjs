#!/usr/bin/env node
/**
 * Test the multisig primitives in p2p-layer.mjs.
 *
 * Validates that the new helpers (computeMultisigAddress, getAddressUtxos,
 * composeSettlementTx, signSettlementTx, broadcastSettlement, lockUtxos,
 * unlockUtxos, decodeRawTx, getAddressPubkey) work as expected on real CHIPS.
 *
 * Mirrors the patterns in test-multisig.mjs but uses only the helper API
 * instead of raw RPC calls.
 *
 * Usage: node test-p2p-multisig-helpers.mjs
 */

import { createP2PLayer } from './p2p-layer.mjs';
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

const p2p = createP2PLayer(findRPC(), 'test-runner', 'test-table');
const { client } = p2p;

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '·';
  const time = info.ms !== undefined ? ' (' + info.ms + 'ms)' : '';
  console.log(`  [${tag}] ${name}${time}${info.note ? ' — ' + info.note : ''}`);
}

async function main() {
  console.log('═'.repeat(70));
  console.log('p2p-layer multisig primitives test');
  console.log('═'.repeat(70));

  const info = await client.getInfo();
  console.log('Chain: ' + info.name + ' block ' + info.blocks);
  const balance = await client.call('getbalance', []);
  console.log('Wallet balance: ' + balance + ' CHIPS');

  // ── Setup: 3 fresh addresses with pubkeys ──
  console.log('\n--- Setup: create 3 test addresses ---');
  const addrA = await client.call('getnewaddress', []);
  const addrB = await client.call('getnewaddress', []);
  const addrC = await client.call('getnewaddress', []);
  const pkA = await p2p.getAddressPubkey(addrA);
  const pkB = await p2p.getAddressPubkey(addrB);
  const pkC = await p2p.getAddressPubkey(addrC);
  record('setup: created 3 addresses + pubkeys', 'PASS', {
    note: addrA.slice(0,8) + ', ' + addrB.slice(0,8) + ', ' + addrC.slice(0,8)
  });

  // ── Test 1: computeMultisigAddress ──
  console.log('\n--- Test 1: computeMultisigAddress (2-of-3) ---');
  const t1 = Date.now();
  const ms = await p2p.computeMultisigAddress([pkA, pkB, pkC], 2);
  record('1.1 multisig computed', 'PASS', { ms: Date.now()-t1, note: ms.address.slice(0,12) });
  if (!ms.redeemScript) {
    record('1.2 redeemScript present', 'FAIL');
  } else {
    record('1.2 redeemScript present', 'PASS', { note: ms.redeemScript.slice(0,16) + '...' });
  }

  // ── Test 2: fund the multisig and read it via getAddressUtxos ──
  console.log('\n--- Test 2: fund and read multisig UTXOs ---');
  const t2 = Date.now();
  // Use sendtoaddress for funding (we're the wallet, so this works)
  await client.call('sendtoaddress', [ms.address, 1.0]);
  await client.call('sendtoaddress', [ms.address, 1.5]);

  // Wait for both UTXOs to be visible
  const utxos = await p2p.waitForAddressUtxos(ms.address, 2, 60000);
  record('2.1 waitForAddressUtxos returns 2 UTXOs', utxos.length === 2 ? 'PASS' : 'FAIL', {
    ms: Date.now()-t2,
    note: utxos.length + ' utxos'
  });

  const balance2 = await p2p.getAddressBalance(ms.address);
  record('2.2 getAddressBalance returns 2.5', balance2 === 2.5 ? 'PASS' : 'FAIL', {
    note: 'balance=' + balance2
  });

  // Verify UTXO structure
  const u0 = utxos[0];
  if (u0.txid && typeof u0.vout === 'number' && typeof u0.amount === 'number') {
    record('2.3 UTXO has txid, vout, amount', 'PASS');
  } else {
    record('2.3 UTXO has txid, vout, amount', 'FAIL', { note: JSON.stringify(u0) });
  }

  // ── Test 3: lockUtxos / unlockUtxos ──
  console.log('\n--- Test 3: lockUtxos / unlockUtxos ---');
  await p2p.lockUtxos([utxos[0]]);
  const locked = await client.call('listlockunspent', []);
  const isLocked = locked.some(l => l.txid === utxos[0].txid && l.vout === utxos[0].vout);
  record('3.1 lockUtxos locks the UTXO', isLocked ? 'PASS' : 'FAIL');

  await p2p.unlockUtxos([utxos[0]]);
  const stillLocked = await client.call('listlockunspent', []);
  const isStillLocked = stillLocked.some(l => l.txid === utxos[0].txid && l.vout === utxos[0].vout);
  record('3.2 unlockUtxos unlocks the UTXO', !isStillLocked ? 'PASS' : 'FAIL');

  // ── Test 4: composeSettlementTx ──
  console.log('\n--- Test 4: composeSettlementTx ---');
  const r1 = await client.call('getnewaddress', []);
  const r2 = await client.call('getnewaddress', []);
  const r3 = await client.call('getnewaddress', []);
  const fee = 0.0001;
  // Total in: 2.5. Pay 0.8, 1.0, and (2.5 - 0.8 - 1.0 - fee) = 0.6999
  const payouts = [
    { address: r1, amount: 0.8 },
    { address: r2, amount: 1.0 },
    { address: r3, amount: 0.6999 },
  ];
  const t4 = Date.now();
  const unsignedHex = await p2p.composeSettlementTx(ms.address, payouts, fee);
  record('4.1 composeSettlementTx returns hex', typeof unsignedHex === 'string' && unsignedHex.length > 0 ? 'PASS' : 'FAIL', {
    ms: Date.now()-t4,
    note: unsignedHex.length + ' chars'
  });

  // ── Test 5: decodeRawTx ──
  console.log('\n--- Test 5: decodeRawTx ---');
  const decoded = await p2p.decodeRawTx(unsignedHex);
  const expectedInputs = utxos.length;
  const expectedOutputs = payouts.length;
  if (decoded.vin.length === expectedInputs && decoded.vout.length === expectedOutputs) {
    record('5.1 decoded has correct vin/vout count', 'PASS', {
      note: decoded.vin.length + ' in, ' + decoded.vout.length + ' out'
    });
  } else {
    record('5.1 decoded has correct vin/vout count', 'FAIL', {
      note: 'vin=' + decoded.vin.length + ' vout=' + decoded.vout.length
    });
  }

  // Verify output addresses match payouts
  let outputsMatch = true;
  for (const v of decoded.vout) {
    const addrs = v.scriptPubKey?.addresses || [];
    const matchingPayout = payouts.find(p => addrs.includes(p.address));
    if (!matchingPayout) { outputsMatch = false; break; }
    if (Math.abs(v.value - matchingPayout.amount) > 0.00000001) { outputsMatch = false; break; }
  }
  record('5.2 decoded outputs match payouts', outputsMatch ? 'PASS' : 'FAIL');

  // ── Test 6: signSettlementTx ──
  console.log('\n--- Test 6: signSettlementTx ---');
  const t6 = Date.now();
  const signed = await p2p.signSettlementTx(unsignedHex);
  record('6.1 signSettlementTx returns hex', signed.hex && typeof signed.complete === 'boolean' ? 'PASS' : 'FAIL', {
    ms: Date.now()-t6
  });
  record('6.2 signature is complete', signed.complete ? 'PASS' : 'FAIL', {
    note: 'complete=' + signed.complete
  });

  // ── Test 7: broadcastSettlement ──
  console.log('\n--- Test 7: broadcastSettlement ---');
  const t7 = Date.now();
  const txid = await p2p.broadcastSettlement(signed.hex);
  record('7.1 broadcast returns txid', typeof txid === 'string' && txid.length === 64 ? 'PASS' : 'FAIL', {
    ms: Date.now()-t7,
    note: txid.slice(0,16)
  });

  // Verify recipients received the payouts
  const t8 = Date.now();
  await p2p.waitForAddressUtxos(r1, 1, 60000);
  await p2p.waitForAddressUtxos(r2, 1, 60000);
  await p2p.waitForAddressUtxos(r3, 1, 60000);
  record('7.2 all 3 recipients received payouts', 'PASS', { ms: Date.now()-t8 });

  // Verify amounts
  const r1Bal = await p2p.getAddressBalance(r1);
  const r2Bal = await p2p.getAddressBalance(r2);
  const r3Bal = await p2p.getAddressBalance(r3);
  record('7.3 r1 received 0.8', r1Bal === 0.8 ? 'PASS' : 'FAIL', { note: 'got ' + r1Bal });
  record('7.4 r2 received 1.0', r2Bal === 1.0 ? 'PASS' : 'FAIL', { note: 'got ' + r2Bal });
  record('7.5 r3 received 0.6999', r3Bal === 0.6999 ? 'PASS' : 'FAIL', { note: 'got ' + r3Bal });

  // ── Test 8: Verify multisig is now empty ──
  console.log('\n--- Test 8: post-settlement state ---');
  const finalBal = await p2p.getAddressBalance(ms.address);
  record('8.1 multisig balance is zero', finalBal === 0 ? 'PASS' : 'FAIL', { note: 'remaining=' + finalBal });

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
