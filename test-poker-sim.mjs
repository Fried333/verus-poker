#!/usr/bin/env node
/**
 * Poker Hand Simulation — 100 hands with random actions
 * Exact write pattern matching real poker dealer + player
 *
 * .28 (ptable2) = dealer    .59 (pdealer2) = player
 * Run from .59
 */
import { request as httpReq } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';

const WRITER28 = { host: '46.225.132.28', port: 3001 };
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '100');
const WAIT = ms => new Promise(r => setTimeout(r, ms));

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

function httpGet(path) {
  return new Promise((resolve, reject) => {
    const req = httpReq({ hostname: WRITER28.host, port: WRITER28.port, path }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }); req.on('error', reject); req.end();
  });
}

const keyCache = new Map();
async function getKeyId(key) { if (keyCache.has(key)) return keyCache.get(key); const r = await rpc('getvdxfid', [key]); keyCache.set(key, r.vdxfid); return r.vdxfid; }

async function pollLocal(identity, key, matchFn, timeoutMs = 60000) {
  const keyId = await getKeyId(key);
  const fullName = identity.includes('.') ? identity : identity + '.CHIPS@';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await rpc('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[keyId]) {
        const val = cmm[keyId]; const entries = Array.isArray(val) ? val : [val]; const last = entries[entries.length - 1];
        const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
        if (hex) { const d = JSON.parse(Buffer.from(hex, 'hex').toString()); if (matchFn(d)) return { ms: Date.now() - start }; }
      }
    } catch {}
    await WAIT(300);
  }
  return null;
}

async function poll28(identity, key, matchFn, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await httpPost('/read', { identity, key });
      if (r.data && matchFn(r.data)) return { ms: Date.now() - start };
    } catch {}
    await WAIT(300);
  }
  return null;
}

let lastLocalTx = null;
async function writeLocal(key, data) {
  if (lastLocalTx) { const s = Date.now(); while (Date.now() - s < 30000) { try { await rpc('gettransaction', [lastLocalTx]); break; } catch {} await WAIT(500); } }
  const keyId = await getKeyId(key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const idInfo = await rpc('getidentity', ['pdealer2.CHIPS@']);
  const parent = idInfo?.identity?.parent;
  const params = { name: 'pdealer2', contentmultimap: { [keyId]: hex } };
  if (parent) params.parent = parent;
  for (let a = 0; a < 3; a++) { try { const txid = await rpc('updateidentity', [params]); lastLocalTx = txid; return txid; } catch (e) { if (a < 2) { await WAIT(2000); continue; } throw e; } }
}

const BASE = 'chips.vrsc::poker.sg777z';
const STREETS = ['preflop', 'flop', 'turn', 'river'];
const ACTIONS = ['fold', 'check', 'call', 'raise', 'allin'];

function pickAction() {
  const r = Math.random();
  if (r < 0.15) return 'fold';
  if (r < 0.50) return 'check';
  if (r < 0.75) return 'call';
  if (r < 0.92) return 'raise';
  return 'allin';
}

const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
const med = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

async function playHand(h) {
  const handId = 'h_' + Date.now().toString(36) + '_' + h;
  const handStart = Date.now();
  const timings = [];
  let seq = 0;

  // Dealer writes init batch (s0)
  const initKey = BASE + '.t_betting_state.' + handId + '.s0';
  let t = Date.now();
  const w0 = await httpPost('/write', { key: initKey, data: { hand: handId, phase: 'preflop', pot: 3, seq: 0 } });
  if (w0.error) throw new Error('init: ' + w0.error.substring(0, 30));
  const w0ms = Date.now() - t;
  const p0 = await pollLocal('ptable2', initKey, d => d.hand === handId);
  if (!p0) throw new Error('init timeout');
  timings.push({ step: 'init', write: w0ms, prop: p0.ms, who: 'D' });

  // Dealer writes s1 (player turn preflop)
  seq = 1;
  const s1Key = BASE + '.t_betting_state.' + handId + '.s1';
  t = Date.now();
  const w1 = await httpPost('/write', { key: s1Key, data: { hand: handId, phase: 'preflop', turn: 'player', pot: 3, seq: 1 } });
  if (w1.error) throw new Error('s1: ' + w1.error.substring(0, 30));
  const w1ms = Date.now() - t;
  const p1 = await pollLocal('ptable2', s1Key, d => d.hand === handId && d.seq === 1);
  if (!p1) throw new Error('s1 timeout');
  timings.push({ step: 's1', write: w1ms, prop: p1.ms, who: 'D' });

  // Play streets
  for (let street = 0; street < 4; street++) {
    const action = pickAction();

    // Player writes action
    const actKey = BASE + '.p_betting_action.' + handId + '.a' + seq;
    t = Date.now();
    await writeLocal(actKey, { hand: handId, action, seq });
    const wAms = Date.now() - t;
    const pA = await poll28('pdealer2', actKey, d => d.hand === handId && d.seq === seq);
    if (!pA) throw new Error('act' + seq + ' timeout');
    timings.push({ step: action[0] + seq, write: wAms, prop: pA.ms, who: 'P' });

    if (action === 'fold') break;
    if (street >= 3) break; // river done

    // Dealer writes next street BS
    seq++;
    const nextPhase = STREETS[street + 1];
    const bsKey = BASE + '.t_betting_state.' + handId + '.s' + seq;
    t = Date.now();
    const wB = await httpPost('/write', { key: bsKey, data: { hand: handId, phase: nextPhase, turn: 'player', pot: 4 + street * 2, seq } });
    if (wB.error) throw new Error('s' + seq + ': ' + wB.error.substring(0, 30));
    const wBms = Date.now() - t;
    const pB = await pollLocal('ptable2', bsKey, d => d.hand === handId && d.seq === seq);
    if (!pB) throw new Error('s' + seq + ' timeout');
    timings.push({ step: 's' + seq, write: wBms, prop: pB.ms, who: 'D' });
  }

  // Dealer writes settlement
  const settleKey = BASE + '.t_settlement_info.' + handId;
  t = Date.now();
  const wS = await httpPost('/write', { key: settleKey, data: { hand: handId, verified: true } });
  if (wS.error) throw new Error('settle: ' + wS.error.substring(0, 30));
  const wSms = Date.now() - t;
  const pS = await pollLocal('ptable2', settleKey, d => d.hand === handId);
  if (!pS) throw new Error('settle timeout');
  timings.push({ step: 'set', write: wSms, prop: pS.ms, who: 'D' });

  return { handId, handTime: Date.now() - handStart, timings, steps: timings.length };
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  POKER SIM — ' + HANDS + ' hands, random actions');
  console.log('  .28 (ptable2) = dealer    .59 (pdealer2) = player');
  console.log('════════════════════════════════════════════════════════════════\n');

  const li = await rpc('getinfo');
  console.log('.59: block=' + li.blocks + ' conns=' + li.connections);
  const ws = await httpGet('/status');
  console.log('.28: block=' + ws.block + ' conns=' + ws.connections);
  console.log();

  console.log('#'.padEnd(5) + 'Time'.padEnd(8) + 'Steps'.padEnd(7) + 'Timeline');
  console.log('─'.repeat(80));

  const results = [];
  let pass = 0, fail = 0;

  for (let h = 0; h < HANDS; h++) {
    try {
      const r = await playHand(h);
      pass++;
      results.push(r);
      const timeline = r.timings.map(t => t.step + '(' + t.write + '+' + t.prop + ')').join(' ');
      console.log((h + 1 + '').padEnd(5) + ((r.handTime / 1000).toFixed(1) + 's').padEnd(8) + (r.steps + '').padEnd(7) + timeline);
    } catch (e) {
      fail++;
      console.log((h + 1 + '').padEnd(5) + 'FAIL    ' + e.message);
      results.push({ handTime: 0, timings: [], steps: 0 });
    }
  }

  const ok = results.filter(r => r.handTime > 0);
  const allTimings = ok.flatMap(r => r.timings);
  const dTimings = allTimings.filter(t => t.who === 'D');
  const pTimings = allTimings.filter(t => t.who === 'P');
  const handTimes = ok.map(r => r.handTime);
  const folds = allTimings.filter(t => t.step.startsWith('f')).length;
  const streets = { 3: 0, 5: 0, 7: 0, 9: 0 }; // steps per hand = fold-early vs showdown
  ok.forEach(r => { const k = r.steps; streets[k] = (streets[k] || 0) + 1; });

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY — ' + pass + '/' + HANDS + ' pass, ' + fail + ' fail');
  console.log('════════════════════════════════════════════════════════════════');
  if (handTimes.length) {
    console.log('Hand time:    avg=' + (avg(handTimes)/1000).toFixed(1) + 's  med=' + (med(handTimes)/1000).toFixed(1) + 's  min=' + (Math.min(...handTimes)/1000).toFixed(1) + 's  max=' + (Math.max(...handTimes)/1000).toFixed(1) + 's');
    console.log('Dealer write: avg=' + avg(dTimings.map(t=>t.write)) + 'ms  med=' + med(dTimings.map(t=>t.write)) + 'ms');
    console.log('Dealer prop:  avg=' + avg(dTimings.map(t=>t.prop)) + 'ms  med=' + med(dTimings.map(t=>t.prop)) + 'ms');
    console.log('Player write: avg=' + avg(pTimings.map(t=>t.write)) + 'ms  med=' + med(pTimings.map(t=>t.write)) + 'ms');
    console.log('Player prop:  avg=' + avg(pTimings.map(t=>t.prop)) + 'ms  med=' + med(pTimings.map(t=>t.prop)) + 'ms');
    console.log('Folds: ' + folds + '/' + pass + ' (' + (folds/pass*100).toFixed(0) + '%)');
    console.log('Steps/hand dist: ' + Object.entries(streets).filter(([,v])=>v>0).map(([k,v])=>k+'steps='+v).join(' '));
  }
  console.log('Reliability: ' + (pass/HANDS*100).toFixed(1) + '%');
}

main().catch(e => { console.error(e); process.exit(1); });
