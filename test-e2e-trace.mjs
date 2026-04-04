#!/usr/bin/env node
/**
 * End-to-End Trace — full poker hand flow with timing from BOTH nodes
 *
 * Runs on .59, controls .28 via test-writer HTTP API
 * Logs every write and read with timestamps from both perspectives
 *
 * Simulates exactly what the poker dealer + player do:
 *   - Dealer (on .28): batch writes to ptable2 using /write endpoint
 *   - Player (on .59): reads from local daemon, writes to pdealer2 locally
 *   - Both sides poll and log when they see each other's data
 */
import { request as httpReq } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const WRITER28 = { host: '46.225.132.28', port: 3001 };
const T0 = Date.now();
const ts = () => ((Date.now() - T0) / 1000).toFixed(2);
const WAIT = ms => new Promise(r => setTimeout(r, ms));

// .59 local RPC
const conf = readFileSync(join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'), 'utf8');
const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
const RPC = { host: '127.0.0.1', port: parseInt(get('rpcport')), user: get('rpcuser'), pass: get('rpcpassword') };

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(RPC.user + ':' + RPC.pass).toString('base64');
    const req = httpReq({ hostname: RPC.host, port: RPC.port, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function httpPost(path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = httpReq({ hostname: WRITER28.host, port: WRITER28.port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}

const keyCache = new Map();
async function getKeyId(key) {
  if (keyCache.has(key)) return keyCache.get(key);
  const r = await rpc('getvdxfid', [key]);
  keyCache.set(key, r.vdxfid);
  return r.vdxfid;
}

// Read from .59 local daemon
async function readLocal(identity, key, matchFn) {
  const keyId = await getKeyId(key);
  const fullName = identity.includes('.') ? identity : identity + '.CHIPS@';
  const r = await rpc('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
  const cmm = r?.identity?.contentmultimap;
  if (!cmm || !cmm[keyId]) return null;
  const val = cmm[keyId];
  const entries = Array.isArray(val) ? val : [val];
  const last = entries[entries.length - 1];
  const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
  if (!hex) return null;
  try { const d = JSON.parse(Buffer.from(hex, 'hex').toString()); return matchFn(d) ? d : null; } catch { return null; }
}

// Read from .28 via /read endpoint
async function read28(identity, key, matchFn) {
  const r = await httpPost('/read', { identity, key });
  return r.data && matchFn(r.data) ? r.data : null;
}

// Poll with logging
async function pollWithLog(label, readFn, timeoutMs = 60000) {
  const start = Date.now();
  let polls = 0;
  while (Date.now() - start < timeoutMs) {
    polls++;
    const d = await readFn();
    if (d) {
      const ms = Date.now() - start;
      console.log('  ' + ts() + ' [' + label + '] FOUND after ' + ms + 'ms (' + polls + ' polls)');
      return { data: d, ms, polls };
    }
    await WAIT(300);
  }
  console.log('  ' + ts() + ' [' + label + '] TIMEOUT after ' + timeoutMs + 'ms (' + polls + ' polls)');
  return null;
}

// Write to pdealer2 from .59 locally
let lastLocalTx = null;
async function writeLocal59(key, data) {
  if (lastLocalTx) {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      try { await rpc('gettransaction', [lastLocalTx]); break; } catch {} await WAIT(500);
    }
  }
  const keyId = await getKeyId(key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const idInfo = await rpc('getidentity', ['pdealer2.CHIPS@']);
  const parent = idInfo?.identity?.parent;
  const params = { name: 'pdealer2', contentmultimap: { [keyId]: hex } };
  if (parent) params.parent = parent;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txid = await rpc('updateidentity', [params]);
      lastLocalTx = txid;
      return txid;
    } catch (e) {
      if (attempt < 2) { console.log('  ' + ts() + ' [.59 RETRY] ' + e.message.substring(0, 40)); await WAIT(2000); continue; }
      throw e;
    }
  }
}

const BASE = 'chips.vrsc::poker.sg777z';

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  E2E TRACE — Full poker hand flow with timing');
  console.log('════════════════════════════════════════════════════════════════\n');

  const handId = 'trace_' + Date.now().toString(36);
  console.log('Hand ID: ' + handId);
  console.log();

  // ── STEP 1: Dealer batch write (init + cards + BS s0) ──
  console.log(ts() + ' === STEP 1: Dealer init batch ===');
  const initKey = BASE + '.t_betting_state.' + handId + '.s0';
  const w1Start = Date.now();
  const w1 = await httpPost('/write', { key: initKey, data: { hand: handId, phase: 'preflop', pot: 3, seq: 0 } });
  console.log('  ' + ts() + ' [.28 WRITE] init s0: ' + (w1.error ? 'FAIL ' + w1.error.substring(0, 40) : (Date.now() - w1Start) + 'ms tx=' + w1.txid));
  if (w1.error) { console.log('ABORTING'); process.exit(1); }

  // Both sides poll
  const p1_59 = pollWithLog('.59 reads s0', () => readLocal('ptable2', initKey, d => d.hand === handId));
  const p1_28 = pollWithLog('.28 reads s0', () => read28('ptable2', initKey, d => d.hand === handId));
  await Promise.all([p1_59, p1_28]);

  // ── STEP 2: Dealer writes BS s1 (player's turn) ──
  console.log('\n' + ts() + ' === STEP 2: Dealer writes BS s1 ===');
  const s1Key = BASE + '.t_betting_state.' + handId + '.s1';
  const w2Start = Date.now();
  const w2 = await httpPost('/write', { key: s1Key, data: { hand: handId, phase: 'preflop', turn: 'player', toCall: 1, pot: 3, seq: 1 } });
  console.log('  ' + ts() + ' [.28 WRITE] s1: ' + (w2.error ? 'FAIL ' + w2.error.substring(0, 40) : (Date.now() - w2Start) + 'ms tx=' + w2.txid));
  if (w2.error) { console.log('ABORTING'); process.exit(1); }

  const p2_59 = pollWithLog('.59 reads s1', () => readLocal('ptable2', s1Key, d => d.hand === handId && d.seq === 1));
  const p2_28 = pollWithLog('.28 reads s1', () => read28('ptable2', s1Key, d => d.hand === handId && d.seq === 1));
  await Promise.all([p2_59, p2_28]);

  // ── STEP 3: Player writes action ──
  console.log('\n' + ts() + ' === STEP 3: Player writes action (call) ===');
  const actKey = BASE + '.p_betting_action.' + handId + '.a1';
  const w3Start = Date.now();
  const tx3 = await writeLocal59(actKey, { hand: handId, action: 'call', amount: 1, seq: 1 });
  console.log('  ' + ts() + ' [.59 WRITE] action: ' + (Date.now() - w3Start) + 'ms tx=' + tx3?.substring(0, 16));

  const p3_28 = pollWithLog('.28 reads action', () => read28('pdealer2', actKey, d => d.hand === handId && d.seq === 1));
  const p3_59 = pollWithLog('.59 reads action', () => readLocal('pdealer2', actKey, d => d.hand === handId && d.seq === 1));
  await Promise.all([p3_28, p3_59]);

  // ── STEP 4: Dealer writes board + BS s2 (flop) ──
  console.log('\n' + ts() + ' === STEP 4: Dealer writes flop + BS s2 ===');
  const s2Key = BASE + '.t_betting_state.' + handId + '.s2';
  const w4Start = Date.now();
  const w4 = await httpPost('/write', { key: s2Key, data: { hand: handId, phase: 'flop', turn: 'player', board: ['Qh', '5d', '3c'], pot: 4, seq: 2 } });
  console.log('  ' + ts() + ' [.28 WRITE] s2: ' + (w4.error ? 'FAIL ' + w4.error.substring(0, 40) : (Date.now() - w4Start) + 'ms tx=' + w4.txid));
  if (w4.error) { console.log('s2 WRITE FAILED — this is the problem point'); process.exit(1); }

  const p4_59 = pollWithLog('.59 reads s2', () => readLocal('ptable2', s2Key, d => d.hand === handId && d.seq === 2));
  const p4_28 = pollWithLog('.28 reads s2', () => read28('ptable2', s2Key, d => d.hand === handId && d.seq === 2));
  await Promise.all([p4_59, p4_28]);

  // ── STEP 5: Player writes action 2 ──
  console.log('\n' + ts() + ' === STEP 5: Player writes action (check) ===');
  const act2Key = BASE + '.p_betting_action.' + handId + '.a2';
  const w5Start = Date.now();
  const tx5 = await writeLocal59(act2Key, { hand: handId, action: 'check', amount: 0, seq: 2 });
  console.log('  ' + ts() + ' [.59 WRITE] action2: ' + (Date.now() - w5Start) + 'ms tx=' + tx5?.substring(0, 16));

  const p5_28 = pollWithLog('.28 reads action2', () => read28('pdealer2', act2Key, d => d.hand === handId && d.seq === 2));
  const p5_59 = pollWithLog('.59 reads action2', () => readLocal('pdealer2', act2Key, d => d.hand === handId && d.seq === 2));
  await Promise.all([p5_28, p5_59]);

  // ── STEP 6: Dealer writes turn + BS s3 ──
  console.log('\n' + ts() + ' === STEP 6: Dealer writes turn + BS s3 ===');
  const s3Key = BASE + '.t_betting_state.' + handId + '.s3';
  const w6Start = Date.now();
  const w6 = await httpPost('/write', { key: s3Key, data: { hand: handId, phase: 'turn', turn: 'player', board: ['Qh', '5d', '3c', 'Jh'], pot: 4, seq: 3 } });
  console.log('  ' + ts() + ' [.28 WRITE] s3: ' + (w6.error ? 'FAIL ' + w6.error.substring(0, 40) : (Date.now() - w6Start) + 'ms tx=' + w6.txid));

  if (!w6.error) {
    const p6_59 = pollWithLog('.59 reads s3', () => readLocal('ptable2', s3Key, d => d.hand === handId && d.seq === 3));
    await p6_59;
  }

  // ── STEP 7: Player writes action 3 ──
  console.log('\n' + ts() + ' === STEP 7: Player writes action (bet) ===');
  const act3Key = BASE + '.p_betting_action.' + handId + '.a3';
  const w7Start = Date.now();
  const tx7 = await writeLocal59(act3Key, { hand: handId, action: 'bet', amount: 2, seq: 3 });
  console.log('  ' + ts() + ' [.59 WRITE] action3: ' + (Date.now() - w7Start) + 'ms tx=' + tx7?.substring(0, 16));

  const p7_28 = pollWithLog('.28 reads action3', () => read28('pdealer2', act3Key, d => d.hand === handId && d.seq === 3));
  await p7_28;

  // ── STEP 8: Dealer writes river + BS s4 ──
  console.log('\n' + ts() + ' === STEP 8: Dealer writes river + BS s4 ===');
  const s4Key = BASE + '.t_betting_state.' + handId + '.s4';
  const w8Start = Date.now();
  const w8 = await httpPost('/write', { key: s4Key, data: { hand: handId, phase: 'river', turn: 'player', pot: 8, seq: 4 } });
  console.log('  ' + ts() + ' [.28 WRITE] s4: ' + (w8.error ? 'FAIL ' + w8.error.substring(0, 40) : (Date.now() - w8Start) + 'ms tx=' + w8.txid));

  if (!w8.error) {
    const p8_59 = pollWithLog('.59 reads s4', () => readLocal('ptable2', s4Key, d => d.hand === handId && d.seq === 4));
    await p8_59;
  }

  // ── STEP 9: Settlement ──
  console.log('\n' + ts() + ' === STEP 9: Dealer writes settlement ===');
  const settleKey = BASE + '.t_settlement_info.' + handId;
  const w9Start = Date.now();
  const w9 = await httpPost('/write', { key: settleKey, data: { hand: handId, verified: true, winner: 'player' } });
  console.log('  ' + ts() + ' [.28 WRITE] settle: ' + (w9.error ? 'FAIL' : (Date.now() - w9Start) + 'ms tx=' + w9.txid));

  if (!w9.error) {
    const p9_59 = pollWithLog('.59 reads settle', () => readLocal('ptable2', settleKey, d => d.hand === handId));
    await p9_59;
  }

  console.log('\n' + ts() + ' === DONE ===');
}

main().catch(e => { console.error(e); process.exit(1); });
