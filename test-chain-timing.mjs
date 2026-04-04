#!/usr/bin/env node
/**
 * Chain Timing Test — 20 writes from .28, observed from local + .59
 * Tests getidentity and getidentitycontent (with and without key filter)
 * Records exact timing for each read method on each write.
 *
 * Usage: node test-chain-timing.mjs [--count=20] [--delay=5000]
 * Prereq: node test-writer.mjs running on .28:3001
 */
import { request as httpReq } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const COUNT = parseInt(process.argv.find(a => a.startsWith('--count='))?.split('=')[1] || '20');
const DELAY = parseInt(process.argv.find(a => a.startsWith('--delay='))?.split('=')[1] || '5000');

const WRITER_HOST = '46.225.132.28';
const WRITER_PORT = 3001;
const S59 = { host: '89.125.50.59', port: 22778, user: 'user3204884389', pass: 'pass0eb576315b2469542ae02d3232eda16948e23c621e790ce16cbd685e2e5062b855' };

const WAIT = ms => new Promise(r => setTimeout(r, ms));

function findLocalRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
  const conf = readFileSync(p, 'utf8');
  const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
  return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
}

function rpc(cfg, method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(cfg.user + ':' + cfg.pass).toString('base64');
    const req = httpReq({ hostname: cfg.host, port: cfg.port, method: 'POST',
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
    const req = httpReq({ hostname: host, port, path, method: 'GET' }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.end();
  });
}

// Check if data matches using getidentity
async function checkGI(cfg, identity, keyId, matchVal) {
  try {
    const r = await rpc(cfg, 'getidentity', [identity]);
    const cmm = r?.identity?.contentmultimap;
    if (!cmm || !cmm[keyId]) return false;
    const val = cmm[keyId];
    const last = Array.isArray(val) ? val[val.length - 1] : val;
    const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
    if (!hex) return false;
    const d = JSON.parse(Buffer.from(hex, 'hex').toString());
    return d.test === matchVal;
  } catch { return false; }
}

// Check using getidentitycontent WITH key filter
async function checkGIC_filtered(cfg, identity, keyId, matchVal) {
  try {
    const r = await rpc(cfg, 'getidentitycontent', [identity, 0, -1, false, 0, keyId]);
    const cmm = r?.identity?.contentmultimap;
    if (!cmm || !cmm[keyId]) return false;
    const val = cmm[keyId];
    const entries = Array.isArray(val) ? val : [val];
    const last = entries[entries.length - 1];
    const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
    if (!hex) return false;
    const d = JSON.parse(Buffer.from(hex, 'hex').toString());
    return d.test === matchVal;
  } catch { return false; }
}

// Check using getidentitycontent WITHOUT key filter
async function checkGIC_unfiltered(cfg, identity, keyId, matchVal) {
  try {
    const r = await rpc(cfg, 'getidentitycontent', [identity, 0, -1]);
    const cmm = r?.identity?.contentmultimap;
    if (!cmm || !cmm[keyId]) return false;
    const val = cmm[keyId];
    const entries = Array.isArray(val) ? val : [val];
    const last = entries[entries.length - 1];
    const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
    if (!hex) return false;
    const d = JSON.parse(Buffer.from(hex, 'hex').toString());
    return d.test === matchVal;
  } catch { return false; }
}

let LOCAL = null;
try { LOCAL = findLocalRPC(); } catch {}
const IDENTITY = 'ptable2.CHIPS@';

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  CHAIN TIMING TEST — ' + COUNT + ' writes, ' + (DELAY / 1000) + 's apart');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Check connectivity
  let localOk = false;
  if (LOCAL) {
    try { const li = await rpc(LOCAL, 'getinfo'); console.log('Local:  block=' + li.blocks + ' conns=' + li.connections); localOk = true; }
    catch { console.log('Local:  NOT RUNNING'); }
  } else { console.log('Local:  NO CONFIG'); }

  let writerOk = false;
  try {
    const ws = await httpGet(WRITER_HOST, WRITER_PORT, '/status');
    console.log('.28:    block=' + ws.block + ' conns=' + ws.connections + ' mempool=' + ws.mempool);
    writerOk = true;
  } catch { console.log('.28:    test-writer NOT RUNNING'); process.exit(1); }

  let s59Ok = false;
  try {
    const s = await rpc(S59, 'getinfo');
    console.log('.59:    block=' + s.blocks + ' conns=' + s.connections);
    s59Ok = true;
  } catch { console.log('.59:    UNREACHABLE'); }

  if (!localOk && !s59Ok) { console.log('No observer nodes available'); process.exit(1); }

  console.log('\n' + 'TX'.padEnd(4) + 'Write'.padEnd(8) +
    (localOk ? 'Local_GI'.padEnd(12) + 'Local_GIC_f'.padEnd(14) + 'Local_GIC_u'.padEnd(14) : '') +
    (s59Ok ? '.59_GI'.padEnd(12) + '.59_GIC_f'.padEnd(14) + '.59_GIC_u'.padEnd(14) : '') +
    'Method');
  console.log('─'.repeat(8 + (localOk ? 40 : 0) + (s59Ok ? 40 : 0)));

  const results = [];

  for (let i = 0; i < COUNT; i++) {
    const testId = 'timing_' + Date.now().toString(36) + '_' + i;
    const uniqueKey = 'chips.vrsc::poker.sg777z.t_betting_state.' + testId + '.s0';

    // Resolve VDXF key ID
    const keyId = (await rpc(LOCAL, 'getvdxfid', [uniqueKey])).vdxfid;

    // Write from .28
    const writeT = Date.now();
    let writeOk = false;
    try {
      const wr = await httpPost(WRITER_HOST, WRITER_PORT, '/write', {
        key: uniqueKey, data: { test: testId, seq: i, ts: Date.now() }
      });
      writeOk = !wr.error;
      if (wr.error) { console.log((i + '').padEnd(4) + 'WRITE FAIL: ' + wr.error); continue; }
    } catch (e) { console.log((i + '').padEnd(4) + 'WRITE FAIL: ' + e.message); continue; }
    const writeMs = Date.now() - writeT;

    // Poll all methods in parallel until found (max 120s)
    const found = { local_gi: -1, local_gic_f: -1, local_gic_u: -1, s59_gi: -1, s59_gic_f: -1, s59_gic_u: -1 };
    let firstMethod = '';
    const pollStart = Date.now();

    for (let tick = 0; tick < 240; tick++) {
      const allFound = Object.values(found).every(v => v >= 0);
      if (allFound) break;

      const checks = [];
      if (localOk && found.local_gi < 0) checks.push(checkGI(LOCAL, IDENTITY, keyId, testId).then(ok => { if (ok) { found.local_gi = Date.now() - pollStart; if (!firstMethod) firstMethod = 'local_gi'; } }));
      if (localOk && found.local_gic_f < 0) checks.push(checkGIC_filtered(LOCAL, IDENTITY, keyId, testId).then(ok => { if (ok) { found.local_gic_f = Date.now() - pollStart; if (!firstMethod) firstMethod = 'local_gic_f'; } }));
      if (localOk && found.local_gic_u < 0) checks.push(checkGIC_unfiltered(LOCAL, IDENTITY, keyId, testId).then(ok => { if (ok) { found.local_gic_u = Date.now() - pollStart; if (!firstMethod) firstMethod = 'local_gic_u'; } }));
      if (s59Ok && found.s59_gi < 0) checks.push(checkGI(S59, IDENTITY, keyId, testId).then(ok => { if (ok) { found.s59_gi = Date.now() - pollStart; if (!firstMethod) firstMethod = '.59_gi'; } }));
      if (s59Ok && found.s59_gic_f < 0) checks.push(checkGIC_filtered(S59, IDENTITY, keyId, testId).then(ok => { if (ok) { found.s59_gic_f = Date.now() - pollStart; if (!firstMethod) firstMethod = '.59_gic_f'; } }));
      if (s59Ok && found.s59_gic_u < 0) checks.push(checkGIC_unfiltered(S59, IDENTITY, keyId, testId).then(ok => { if (ok) { found.s59_gic_u = Date.now() - pollStart; if (!firstMethod) firstMethod = '.59_gic_u'; } }));

      await Promise.all(checks);
      if (!Object.values(found).every(v => v >= 0)) await WAIT(500);
    }

    const fmt = ms => ms >= 0 ? (ms / 1000).toFixed(1) + 's' : 'MISS';
    let line = (i + '').padEnd(4) + (writeMs / 1000).toFixed(1).padEnd(8);
    if (localOk) line += fmt(found.local_gi).padEnd(12) + fmt(found.local_gic_f).padEnd(14) + fmt(found.local_gic_u).padEnd(14);
    if (s59Ok) line += fmt(found.s59_gi).padEnd(12) + fmt(found.s59_gic_f).padEnd(14) + fmt(found.s59_gic_u).padEnd(14);
    line += firstMethod;
    console.log(line);

    results.push({ i, writeMs, ...found, firstMethod });

    if (i < COUNT - 1) await WAIT(DELAY);
  }

  // Summary
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');
  const ok = results.filter(r => r.local_gi >= 0 || r.local_gic_f >= 0);
  console.log('Writes: ' + results.length + ' | Seen locally: ' + ok.length + '/' + results.length);

  const avg = arr => arr.length ? (arr.reduce((s, v) => s + v, 0) / arr.length / 1000).toFixed(1) + 's' : 'N/A';
  const med = arr => { if (!arr.length) return 'N/A'; const s = [...arr].sort((a, b) => a - b); return (s[Math.floor(s.length / 2)] / 1000).toFixed(1) + 's'; };

  for (const method of ['local_gi', 'local_gic_f', 'local_gic_u', 's59_gi', 's59_gic_f', 's59_gic_u']) {
    const times = results.map(r => r[method]).filter(t => t >= 0);
    if (times.length === 0) continue;
    const misses = results.length - times.length;
    console.log(method.padEnd(16) + 'avg=' + avg(times).padEnd(8) + 'med=' + med(times).padEnd(8) +
      'min=' + (Math.min(...times) / 1000).toFixed(1) + 's'.padEnd(6) +
      'max=' + (Math.max(...times) / 1000).toFixed(1) + 's' +
      (misses ? '  MISSED=' + misses : ''));
  }

  const firstMethods = {};
  for (const r of results) { firstMethods[r.firstMethod] = (firstMethods[r.firstMethod] || 0) + 1; }
  console.log('\nFastest method: ' + Object.entries(firstMethods).map(([k, v]) => k + '=' + v).join('  '));
}

main().catch(e => { console.error(e); process.exit(1); });
