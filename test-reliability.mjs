#!/usr/bin/env node
/**
 * Reliability Test — runs on .59, writes via .28 writer, reads locally
 * Tests: sequential writes, rapid writes, round trips, read consistency, recovery
 *
 * Usage: node test-reliability.mjs
 * Prereq: test-writer.mjs running on .28:3001
 */
import { request as httpReq } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WRITER_HOST = '46.225.132.28';
const WRITER_PORT = 3001;
const WAIT = ms => new Promise(r => setTimeout(r, ms));

// Local CHIPS RPC
function findRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
  if (!existsSync(p)) throw new Error('CHIPS config not found');
  const conf = readFileSync(p, 'utf8');
  const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
  return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
}

const RPC = findRPC();

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(RPC.user + ':' + RPC.pass).toString('base64');
    const req = httpReq({ hostname: RPC.host, port: RPC.port, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { const j = JSON.parse(d); if (j.error) reject(new Error(j.error.message)); else resolve(j.result); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function httpPost(host, port, path, data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(data);
    const req = httpReq({ hostname: host, port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.write(payload); req.end();
  });
}

function httpGet(host, port, path) {
  return new Promise((resolve, reject) => {
    const req = httpReq({ hostname: host, port, path }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

// Read via local getidentitycontent (mempool enabled)
async function readLocal(identity, vdxfKey, matchFn) {
  const keyId = (await rpc('getvdxfid', [vdxfKey])).vdxfid;
  const fullName = identity.includes('.') ? identity : identity + '.CHIPS@';
  const r = await rpc('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
  const cmm = r?.identity?.contentmultimap;
  if (!cmm || !cmm[keyId]) return null;
  const val = cmm[keyId];
  const entries = Array.isArray(val) ? val : [val];
  const last = entries[entries.length - 1];
  const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
  if (!hex) return null;
  try {
    const d = JSON.parse(Buffer.from(hex, 'hex').toString());
    return matchFn ? (matchFn(d) ? d : null) : d;
  } catch { return null; }
}

// Poll until matchFn returns true
async function pollLocal(identity, vdxfKey, matchFn, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const d = await readLocal(identity, vdxfKey, matchFn);
    if (d) return { data: d, ms: Date.now() - start };
    await WAIT(300);
  }
  return null;
}

const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
const med = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  RELIABILITY TEST');
  console.log('════════════════════════════════════════════════════════════════\n');

  const localInfo = await rpc('getinfo');
  console.log('Local (.59): block=' + localInfo.blocks + ' conns=' + localInfo.connections);
  const ws = await httpGet(WRITER_HOST, WRITER_PORT, '/status');
  console.log('.28 writer:  block=' + ws.block + ' conns=' + ws.connections + ' mempool=' + ws.mempool);
  console.log();

  // ═══════════════════════════════════════════
  // TEST 1: Sequential Writes
  // ═══════════════════════════════════════════
  const COUNT1 = 100;
  console.log('═══ TEST 1: Sequential Writes (' + COUNT1 + 'x) ═══');
  console.log('#'.padEnd(4) + 'Write(ms)'.padEnd(12) + 'Prop(ms)'.padEnd(12) + 'Total(ms)'.padEnd(12) + 'Status');
  console.log('─'.repeat(52));

  const t1_writes = [], t1_props = [], t1_totals = [];
  let t1_success = 0;

  for (let i = 0; i < COUNT1; i++) {
    const prefix = 'seq_' + Date.now().toString(36);
    const uniqueKey = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix + '.s0';
    const testData = { test: prefix, seq: i, ts: Date.now() };

    const writeStart = Date.now();
    let wr;
    try {
      wr = await httpPost(WRITER_HOST, WRITER_PORT, '/write', { key: uniqueKey, data: testData });
    } catch (e) { console.log((i + '').padEnd(4) + 'WRITE ERROR: ' + e.message); continue; }

    if (wr.error) { console.log((i + '').padEnd(4) + 'WRITE FAIL: ' + wr.error.substring(0, 50)); continue; }
    const writeMs = Date.now() - writeStart;

    // Poll locally
    const pollResult = await pollLocal('ptable2', uniqueKey, d => d.test === prefix, 30000);
    if (pollResult) {
      t1_writes.push(writeMs);
      t1_props.push(pollResult.ms);
      t1_totals.push(writeMs + pollResult.ms);
      t1_success++;
      console.log((i + '').padEnd(4) + (writeMs + '').padEnd(12) + (pollResult.ms + '').padEnd(12) + ((writeMs + pollResult.ms) + '').padEnd(12) + '✓');
    } else {
      t1_writes.push(writeMs);
      console.log((i + '').padEnd(4) + (writeMs + '').padEnd(12) + 'TIMEOUT'.padEnd(12) + '-'.padEnd(12) + '✗');
    }
  }

  console.log('─'.repeat(52));
  console.log('Success: ' + t1_success + '/' + COUNT1);
  console.log('Write:  avg=' + avg(t1_writes) + 'ms  med=' + med(t1_writes) + 'ms');
  console.log('Prop:   avg=' + avg(t1_props) + 'ms  med=' + med(t1_props) + 'ms');
  console.log('Total:  avg=' + avg(t1_totals) + 'ms  med=' + med(t1_totals) + 'ms');
  console.log();

  // ═══════════════════════════════════════════
  // TEST 2: Rapid Writes (no UTXO wait)
  // ═══════════════════════════════════════════
  console.log('═══ TEST 2: Rapid Writes (5x no wait) ═══');
  const prefix2 = 'rapid_' + Date.now().toString(36);
  let rapidResult;
  try {
    rapidResult = await httpPost(WRITER_HOST, WRITER_PORT, '/rapid', { count: 5, prefix: prefix2 });
  } catch (e) { console.log('RAPID ERROR: ' + e.message); rapidResult = { results: [] }; }

  let t2_ok = 0, t2_err = 0;
  for (const r of rapidResult.results || []) {
    console.log('  s' + r.seq + ': ' + r.status + (r.txid ? ' tx=' + r.txid : '') + (r.error ? ' ' + r.error.substring(0, 50) : ''));
    if (r.status === 'ok') t2_ok++; else t2_err++;
  }
  console.log('Succeeded: ' + t2_ok + '/5, Errors: ' + t2_err);

  // Check which ones .59 can see
  await WAIT(5000);
  let t2_seen = 0;
  for (let i = 0; i < 5; i++) {
    const k = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix2 + '.s' + i;
    const d = await readLocal('ptable2', k, d => d.test === prefix2 && d.seq === i);
    if (d) t2_seen++;
  }
  console.log('Visible on .59: ' + t2_seen + '/5');
  console.log();

  // ═══════════════════════════════════════════
  // TEST 3: Round Trip (dealer writes, player reads + writes back)
  // ═══════════════════════════════════════════
  const COUNT3 = 10;
  console.log('═══ TEST 3: Round Trip (' + COUNT3 + 'x) ═══');
  console.log('#'.padEnd(4) + 'D→P(ms)'.padEnd(12) + 'P→D(ms)'.padEnd(12) + 'Total(ms)'.padEnd(12) + 'Status');
  console.log('─'.repeat(52));

  const t3_d2p = [], t3_p2d = [], t3_totals = [];
  let t3_success = 0;

  for (let i = 0; i < COUNT3; i++) {
    const prefix = 'rt_' + Date.now().toString(36) + '_' + i;
    const dealerKey = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix + '.dealer';
    const playerKey = 'chips.vrsc::poker.sg777z.p_betting_action.' + prefix + '.player';

    // Step 1: .28 writes to ptable2 (dealer -> player)
    const d2pStart = Date.now();
    let wr;
    try {
      wr = await httpPost(WRITER_HOST, WRITER_PORT, '/write', { key: dealerKey, data: { test: prefix, from: 'dealer', seq: i } });
    } catch (e) { console.log((i + '').padEnd(4) + 'D WRITE ERROR'); continue; }
    if (wr.error) { console.log((i + '').padEnd(4) + 'D WRITE FAIL'); continue; }

    // Step 2: .59 polls for dealer's write
    const dealerPoll = await pollLocal('ptable2', dealerKey, d => d.test === prefix, 30000);
    if (!dealerPoll) { console.log((i + '').padEnd(4) + 'D→P TIMEOUT'); continue; }
    const d2pMs = Date.now() - d2pStart;

    // Step 3: .59 tells .28 to write to pplayer2 (player -> dealer)
    const p2dStart = Date.now();
    let wr2;
    try {
      wr2 = await httpPost(WRITER_HOST, WRITER_PORT, '/write-to', {
        identity: 'pplayer2', key: playerKey, data: { test: prefix, from: 'player', seq: i }
      });
    } catch (e) { console.log((i + '').padEnd(4) + (d2pMs + '').padEnd(12) + 'P WRITE ERROR'); continue; }
    if (wr2.error) { console.log((i + '').padEnd(4) + (d2pMs + '').padEnd(12) + 'P WRITE FAIL: ' + wr2.error.substring(0, 30)); continue; }

    // Step 4: .28 reads player's action (ask .28 to read via /read endpoint)
    const readResult = await httpPost(WRITER_HOST, WRITER_PORT, '/read', { identity: 'pplayer2', key: playerKey });
    // Also poll from .59 to confirm
    const playerPoll = await pollLocal('pplayer2', playerKey, d => d.test === prefix, 30000);
    const p2dMs = Date.now() - p2dStart;

    if (playerPoll) {
      t3_d2p.push(d2pMs);
      t3_p2d.push(p2dMs);
      t3_totals.push(d2pMs + p2dMs);
      t3_success++;
      console.log((i + '').padEnd(4) + (d2pMs + '').padEnd(12) + (p2dMs + '').padEnd(12) + ((d2pMs + p2dMs) + '').padEnd(12) + '✓');
    } else {
      console.log((i + '').padEnd(4) + (d2pMs + '').padEnd(12) + 'P→D TIMEOUT'.padEnd(12));
    }
  }

  console.log('─'.repeat(52));
  console.log('Success: ' + t3_success + '/' + COUNT3);
  if (t3_d2p.length) console.log('D→P:   avg=' + avg(t3_d2p) + 'ms  med=' + med(t3_d2p) + 'ms');
  if (t3_p2d.length) console.log('P→D:   avg=' + avg(t3_p2d) + 'ms  med=' + med(t3_p2d) + 'ms');
  if (t3_totals.length) console.log('Total: avg=' + avg(t3_totals) + 'ms  med=' + med(t3_totals) + 'ms');
  console.log();

  // ═══════════════════════════════════════════
  // TEST 4: Read Consistency
  // ═══════════════════════════════════════════
  console.log('═══ TEST 4: Read Consistency ═══');
  // Write one value, then read it 20 times rapidly
  const prefix4 = 'consist_' + Date.now().toString(36);
  const key4 = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix4 + '.s0';
  const wr4 = await httpPost(WRITER_HOST, WRITER_PORT, '/write', { key: key4, data: { test: prefix4, value: 42 } });
  if (wr4.error) { console.log('Write failed, skipping'); }
  else {
    // Wait for propagation
    await pollLocal('ptable2', key4, d => d.test === prefix4, 30000);
    // Now read 20 times
    let consistent = 0, stale = 0, failed = 0;
    for (let i = 0; i < 20; i++) {
      const d = await readLocal('ptable2', key4, d => d.test === prefix4);
      if (d && d.value === 42) consistent++;
      else if (d) stale++;
      else failed++;
    }
    console.log('Reads: ' + consistent + '/20 consistent, ' + stale + ' stale, ' + failed + ' failed');
  }
  console.log();

  // ═══════════════════════════════════════════
  // TEST 5: Recovery After Error
  // ═══════════════════════════════════════════
  console.log('═══ TEST 5: Recovery After Error ═══');
  // Write, then rapid (will cause conflicts), then write again
  const prefix5a = 'recov_a_' + Date.now().toString(36);
  const key5a = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix5a + '.s0';
  const wr5a = await httpPost(WRITER_HOST, WRITER_PORT, '/write', { key: key5a, data: { test: prefix5a, phase: 'before' } });
  console.log('Write before: ' + (wr5a.error ? 'FAIL' : 'OK tx=' + wr5a.txid));

  // Rapid writes to cause conflicts
  const prefix5r = 'recov_r_' + Date.now().toString(36);
  const rapid5 = await httpPost(WRITER_HOST, WRITER_PORT, '/rapid', { count: 3, prefix: prefix5r });
  const rapid5ok = (rapid5.results || []).filter(r => r.status === 'ok').length;
  console.log('Rapid (conflict test): ' + rapid5ok + '/3 succeeded');

  // Wait a bit for UTXO to settle
  await WAIT(5000);

  // Try writing again
  const prefix5b = 'recov_b_' + Date.now().toString(36);
  const key5b = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix5b + '.s0';
  const wr5b = await httpPost(WRITER_HOST, WRITER_PORT, '/write', { key: key5b, data: { test: prefix5b, phase: 'after' } });
  console.log('Write after:  ' + (wr5b.error ? 'FAIL — ' + wr5b.error.substring(0, 50) : 'OK tx=' + wr5b.txid));

  // Check both writes visible on .59
  const see5a = await pollLocal('ptable2', key5a, d => d.test === prefix5a, 30000);
  const see5b = await pollLocal('ptable2', key5b, d => d.test === prefix5b, 30000);
  console.log('Pre-conflict write visible:  ' + (see5a ? '✓' : '✗'));
  console.log('Post-conflict write visible: ' + (see5b ? '✓' : '✗'));

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('Test 1 (Sequential):  ' + t1_success + '/' + COUNT1 + ' pass, avg total=' + avg(t1_totals) + 'ms');
  console.log('Test 2 (Rapid):       ' + t2_ok + '/5 writes, ' + t2_seen + '/5 visible');
  console.log('Test 3 (Round Trip):  ' + t3_success + '/' + COUNT3 + ' pass, avg=' + avg(t3_totals) + 'ms');
  console.log('Test 5 (Recovery):    ' + (see5a ? '✓' : '✗') + ' pre, ' + (see5b ? '✓' : '✗') + ' post');
}

main().catch(e => { console.error(e); process.exit(1); });
