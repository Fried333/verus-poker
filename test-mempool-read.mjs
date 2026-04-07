#!/usr/bin/env node
/**
 * Mempool-aware read experiment.
 *
 * Goal: write an identity update, then attempt to read it back BEFORE it
 * gets mined into a block. We try several techniques and report which work.
 *
 * Usage: node test-mempool-read.mjs --id=cashier1
 *
 * The identity must be controlled by the local wallet.
 */

import { createClient, VDXF_KEYS } from './verus-rpc.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const ID = args.id || 'cashier1';
const VERBOSE = args.v || args.verbose;

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

const WAIT = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const rpc = findRPC();
  const client = createClient(rpc);

  console.log('=== Mempool Read Experiment ===');
  console.log('Identity:', ID);

  const info = await client.getInfo();
  const tipBefore = info.blocks;
  console.log('Tip block:', tipBefore);

  // Use a unique test key with a unique payload so we can identify our TX
  const testKey = 'chips.vrsc::poker.sg777z.t_table_info';
  const vdxfRes = await client.getVdxfId(testKey);
  const vdxfId = vdxfRes.vdxfid;
  console.log('VDXF key id:', vdxfId);

  const nonce = 'mempool-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const payload = { nonce, ts: Date.now(), test: 'mempool-reconstruction' };
  const hexPayload = Buffer.from(JSON.stringify(payload)).toString('hex');
  console.log('Payload nonce:', nonce);
  console.log('Hex payload:', hexPayload);

  // Get parent
  const fullName = ID.includes('.') ? ID : ID + '.CHIPS@';
  const idInfo = await client.getIdentity(fullName);
  const parent = idInfo.identity?.parent;

  // Write the update
  const updateParams = { name: ID, contentmultimap: { [vdxfId]: hexPayload } };
  if (parent) updateParams.parent = parent;

  console.log('\n--- Submitting updateidentity ---');
  const t0 = Date.now();
  const txid = await client.call('updateidentity', [updateParams]);
  console.log('TXID:', txid, '(' + (Date.now() - t0) + 'ms)');

  // ============================================================
  // METHOD 1: Poll getrawmempool for our TXID
  // ============================================================
  console.log('\n--- Method 1: getrawmempool poll ---');
  let mempoolFoundAt = null;
  for (let i = 0; i < 60; i++) {
    const mp = await client.call('getrawmempool', []);
    if (Array.isArray(mp) && mp.includes(txid)) {
      mempoolFoundAt = Date.now() - t0;
      console.log('TX in mempool after', mempoolFoundAt, 'ms (poll #' + (i + 1) + ')');
      break;
    }
    await WAIT(200);
  }
  if (mempoolFoundAt === null) {
    console.log('NOT FOUND in mempool after 12s — already mined? Checking…');
    try {
      const tx = await client.call('getrawtransaction', [txid, 1]);
      if (tx.confirmations > 0) {
        console.log('Already confirmed in block', tx.blockhash, '(skipped mempool stage)');
      }
    } catch (e) { console.log('  not found at all:', e.message); }
  }

  // ============================================================
  // METHOD 2: getrawtransaction <txid> 1 — decoded JSON
  // ============================================================
  console.log('\n--- Method 2: getrawtransaction (decoded) ---');
  const rawTx = await client.call('getrawtransaction', [txid, 1]);
  console.log('confirmations:', rawTx.confirmations);
  console.log('vout count:', rawTx.vout.length);

  let identityVout = null;
  for (let i = 0; i < rawTx.vout.length; i++) {
    const v = rawTx.vout[i];
    if (VERBOSE) console.log('  vout[' + i + ']:', JSON.stringify(v.scriptPubKey).slice(0, 200));
    // Look for identity-update outputs
    const sp = v.scriptPubKey;
    if (sp.type === 'cryptocondition' || sp.identityprimary || sp.type === 'identityprimary') {
      identityVout = { idx: i, script: sp };
    }
    // Some Verus daemons embed under .reservetransfer or .identity
    if (sp.identity || sp.identityreservation || sp.identityupdate) {
      identityVout = { idx: i, script: sp };
    }
  }

  if (identityVout) {
    console.log('Found identity vout at index', identityVout.idx);
    console.log('Script keys:', Object.keys(identityVout.script));
    // Try to find contentmultimap
    const findCMM = (obj, depth = 0) => {
      if (!obj || typeof obj !== 'object' || depth > 6) return null;
      if (obj.contentmultimap) return obj.contentmultimap;
      for (const k of Object.keys(obj)) {
        const r = findCMM(obj[k], depth + 1);
        if (r) return r;
      }
      return null;
    };
    const cmm = findCMM(identityVout.script);
    if (cmm) {
      console.log('FOUND contentmultimap!');
      const cmmKeys = Object.keys(cmm);
      console.log('  CMM keys:', cmmKeys);
      if (cmm[vdxfId]) {
        console.log('  Our key present!');
        const val = cmm[vdxfId];
        // Value can be array, string, or object
        const extract = v => {
          if (typeof v === 'string') return v;
          if (Array.isArray(v)) return extract(v[v.length - 1]);
          if (v && typeof v === 'object') {
            // Common shape: { serializedhex: '...' } or { messagedata: ... }
            return v.serializedhex || v.messagedata || v.message || Object.values(v)[0];
          }
          return null;
        };
        const hex = extract(val);
        console.log('  Raw value:', JSON.stringify(val).slice(0, 200));
        console.log('  Extracted hex:', typeof hex === 'string' ? hex.slice(0, 80) : hex);
        if (typeof hex === 'string') {
          try {
            const decoded = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
            console.log('  DECODED PAYLOAD:', decoded);
            if (decoded.nonce === nonce) {
              console.log('  ✓ MATCH — round-trip via raw mempool TX successful!');
            } else {
              console.log('  ✗ Nonce mismatch (got latest cmm but not our TX\'s data)');
            }
          } catch (e) { console.log('  decode failed:', e.message); }
        }
      } else {
        console.log('  Our vdxfId not in this CMM. Keys present:', cmmKeys);
      }
    } else {
      console.log('No contentmultimap found in script. Full script:');
      console.log(JSON.stringify(identityVout.script, null, 2).slice(0, 2000));
    }
  } else {
    console.log('No identity output found. All vout types:');
    rawTx.vout.forEach((v, i) => console.log('  [' + i + ']', v.scriptPubKey.type, Object.keys(v.scriptPubKey).join(',')));
  }

  // ============================================================
  // METHOD 3: getidentitycontent with heightend=-1 (existing path)
  // ============================================================
  console.log('\n--- Method 3: getidentitycontent (heightend=-1) ---');
  let getidcontentFoundAt = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await client.call('getidentitycontent', [fullName, 0, -1, false, 0, vdxfId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[vdxfId]) {
        const val = cmm[vdxfId];
        const last = Array.isArray(val) ? val[val.length - 1] : val;
        const hex = typeof last === 'string' ? last : (last && Object.values(last)[0]);
        try {
          const dec = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
          if (dec.nonce === nonce) {
            getidcontentFoundAt = Date.now() - t0;
            console.log('FOUND via getidentitycontent at', getidcontentFoundAt, 'ms');
            break;
          }
        } catch {}
      }
    } catch (e) { if (i === 0) console.log('error:', e.message); }
    await WAIT(500);
  }
  if (getidcontentFoundAt === null) {
    console.log('NOT found via getidentitycontent in 30s — confirmed-only after all');
  }

  // ============================================================
  // METHOD 4: getidentity (no content args)
  // ============================================================
  console.log('\n--- Method 4: getidentity (latest) ---');
  let getidFoundAt = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await client.getIdentity(fullName);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[vdxfId]) {
        const val = cmm[vdxfId];
        const last = Array.isArray(val) ? val[val.length - 1] : val;
        const hex = typeof last === 'string' ? last : (last && Object.values(last)[0]);
        try {
          const dec = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
          if (dec.nonce === nonce) {
            getidFoundAt = Date.now() - t0;
            console.log('FOUND via getidentity at', getidFoundAt, 'ms');
            break;
          }
        } catch {}
      }
    } catch (e) {}
    await WAIT(500);
  }
  if (getidFoundAt === null) {
    console.log('NOT found via getidentity in 30s');
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  console.log('TXID:                       ', txid);
  console.log('In mempool after:           ', mempoolFoundAt !== null ? mempoolFoundAt + 'ms' : 'NEVER');
  console.log('getrawtransaction has data: ', rawTx ? 'yes (confirmations=' + rawTx.confirmations + ')' : 'no');
  console.log('getidentitycontent picked up:', getidcontentFoundAt !== null ? getidcontentFoundAt + 'ms' : 'NEVER');
  console.log('getidentity picked up:      ', getidFoundAt !== null ? getidFoundAt + 'ms' : 'NEVER');

  const tipAfter = (await client.getInfo()).blocks;
  console.log('Blocks during test:         ', tipAfter - tipBefore);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
