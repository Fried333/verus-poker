#!/usr/bin/env node
/**
 * Game Simulation Test — 50 actions alternating between .28 and .59
 * Simulates a real poker game: dealer writes state, player reads + responds
 *
 * .28 (ptable2) = dealer writes game state
 * .59 (pdealer2) = player writes actions
 *
 * Each action:
 *   1. Writer writes to their identity with unique key
 *   2. Other node polls getidentitycontent until seen
 *   3. Other node writes response
 *   4. Original node polls until response seen
 *
 * Usage: node test-game-sim.mjs
 * Run from .59 (has local RPC + can reach .28 writer)
 */
import { request as httpReq } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WRITER28_HOST = '46.225.132.28';
const WRITER28_PORT = 3001;
const ACTIONS = 50;
const WAIT = ms => new Promise(r => setTimeout(r, ms));

// .59 local CHIPS RPC
function findRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
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

// Poll getidentitycontent on local .59 daemon
async function pollLocal(identity, vdxfKey, matchFn, timeoutMs = 60000) {
  const keyId = (await rpc('getvdxfid', [vdxfKey])).vdxfid;
  const fullName = identity.includes('.') ? identity : identity + '.CHIPS@';
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await rpc('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[keyId]) {
        const val = cmm[keyId];
        const entries = Array.isArray(val) ? val : [val];
        const last = entries[entries.length - 1];
        const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
        if (hex) {
          const d = JSON.parse(Buffer.from(hex, 'hex').toString());
          if (matchFn(d)) return { data: d, ms: Date.now() - start };
        }
      }
    } catch {}
    await WAIT(300);
  }
  return null;
}

// Write locally from .59 to pdealer2
let lastLocalTx = null;
async function writeLocal(key, data) {
  // Wait for previous local TX
  if (lastLocalTx) {
    const start = Date.now();
    while (Date.now() - start < 30000) {
      try { await rpc('gettransaction', [lastLocalTx]); break; } catch {}
      await WAIT(500);
    }
  }

  const keyId = (await rpc('getvdxfid', [key])).vdxfid;
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const idInfo = await rpc('getidentity', ['pdealer2.CHIPS@']);
  const parent = idInfo?.identity?.parent;
  const params = { name: 'pdealer2', contentmultimap: { [keyId]: hex } };
  if (parent) params.parent = parent;

  // Retry up to 3 times
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txid = await rpc('updateidentity', [params]);
      lastLocalTx = txid;
      return txid;
    } catch (e) {
      if (attempt < 2) { await WAIT(2000 * (attempt + 1)); continue; }
      throw e;
    }
  }
}

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  GAME SIMULATION — ' + ACTIONS + ' actions');
  console.log('  .28 (ptable2) = dealer    .59 (pdealer2) = player');
  console.log('════════════════════════════════════════════════════════════════\n');

  // Check connectivity
  const localInfo = await rpc('getinfo');
  console.log('.59 local:  block=' + localInfo.blocks + ' conns=' + localInfo.connections);
  const ws = await httpGet(WRITER28_HOST, WRITER28_PORT, '/status');
  console.log('.28 writer: block=' + ws.block + ' conns=' + ws.connections);
  console.log();

  const gameId = 'game_' + Date.now().toString(36);
  const baseKey = 'chips.vrsc::poker.sg777z.t_betting_state';

  console.log('#'.padEnd(4) + 'Who'.padEnd(10) + 'Write(ms)'.padEnd(12) + 'Prop(ms)'.padEnd(12) + 'Total(ms)'.padEnd(12) + 'Status');
  console.log('─'.repeat(60));

  const results = [];
  let success = 0, fail = 0;

  for (let i = 0; i < ACTIONS; i++) {
    const isDealerTurn = (i % 2 === 0); // alternate dealer/player
    const actionKey = baseKey + '.' + gameId + '.a' + i;
    const actionData = { game: gameId, action: i, from: isDealerTurn ? 'dealer' : 'player', ts: Date.now() };
    const who = isDealerTurn ? 'dealer→' : 'player→';
    const writeId = isDealerTurn ? 'ptable2' : 'pdealer2';
    const readId = isDealerTurn ? 'ptable2' : 'pdealer2';

    const totalStart = Date.now();
    let writeMs = 0, propMs = 0, status = '✗';

    try {
      // WRITE
      const writeStart = Date.now();
      if (isDealerTurn) {
        // .28 writes to ptable2 via HTTP
        const wr = await httpPost(WRITER28_HOST, WRITER28_PORT, '/write', { key: actionKey, data: actionData });
        if (wr.error) throw new Error('Write fail: ' + wr.error.substring(0, 40));
        writeMs = Date.now() - writeStart;
      } else {
        // .59 writes to pdealer2 locally
        await writeLocal(actionKey, actionData);
        writeMs = Date.now() - writeStart;
      }

      // READ from the OTHER node
      const propStart = Date.now();
      if (isDealerTurn) {
        // .59 polls locally for dealer's write to ptable2
        const found = await pollLocal('ptable2', actionKey, d => d.game === gameId && d.action === i, 60000);
        if (!found) throw new Error('Prop timeout');
        propMs = found.ms;
      } else {
        // .28 polls for player's write to pdealer2 (via /read endpoint)
        // Poll .28's view of pdealer2
        const pollStart = Date.now();
        let found = false;
        while (Date.now() - pollStart < 60000) {
          const r = await httpPost(WRITER28_HOST, WRITER28_PORT, '/read', { identity: 'pdealer2', key: actionKey });
          if (r.data && r.data.game === gameId && r.data.action === i) { found = true; break; }
          await WAIT(300);
        }
        if (!found) throw new Error('Prop timeout (.28 read)');
        propMs = Date.now() - propStart;
      }

      status = '✓';
      success++;
    } catch (e) {
      status = '✗ ' + e.message.substring(0, 30);
      fail++;
    }

    const totalMs = Date.now() - totalStart;
    results.push({ i, who: isDealerTurn ? 'dealer' : 'player', writeMs, propMs, totalMs, ok: status === '✓' });
    console.log((i + '').padEnd(4) + who.padEnd(10) + (writeMs + '').padEnd(12) + (propMs + '').padEnd(12) + (totalMs + '').padEnd(12) + status);
  }

  // Summary
  const dealerResults = results.filter(r => r.who === 'dealer' && r.ok);
  const playerResults = results.filter(r => r.who === 'player' && r.ok);
  const allOk = results.filter(r => r.ok);

  const avg = arr => arr.length ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : 0;
  const med = arr => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const min = arr => arr.length ? Math.min(...arr) : 0;
  const max = arr => arr.length ? Math.max(...arr) : 0;

  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('════════════════════════════════════════════════════════════════');
  console.log('Total:   ' + success + '/' + ACTIONS + ' pass, ' + fail + ' fail');
  console.log();
  console.log('         Write(ms)                    Propagation(ms)              Total(ms)');
  console.log('         avg    med    min    max      avg    med    min    max      avg    med');
  console.log('─'.repeat(85));

  if (dealerResults.length) {
    const dw = dealerResults.map(r => r.writeMs), dp = dealerResults.map(r => r.propMs), dt = dealerResults.map(r => r.totalMs);
    console.log('Dealer:  ' + (avg(dw)+'').padEnd(7) + (med(dw)+'').padEnd(7) + (min(dw)+'').padEnd(7) + (max(dw)+'').padEnd(9) + (avg(dp)+'').padEnd(7) + (med(dp)+'').padEnd(7) + (min(dp)+'').padEnd(7) + (max(dp)+'').padEnd(9) + (avg(dt)+'').padEnd(7) + med(dt));
  }
  if (playerResults.length) {
    const pw = playerResults.map(r => r.writeMs), pp = playerResults.map(r => r.propMs), pt = playerResults.map(r => r.totalMs);
    console.log('Player:  ' + (avg(pw)+'').padEnd(7) + (med(pw)+'').padEnd(7) + (min(pw)+'').padEnd(7) + (max(pw)+'').padEnd(9) + (avg(pp)+'').padEnd(7) + (med(pp)+'').padEnd(7) + (min(pp)+'').padEnd(7) + (max(pp)+'').padEnd(9) + (avg(pt)+'').padEnd(7) + med(pt));
  }
  if (allOk.length) {
    const aw = allOk.map(r => r.writeMs), ap = allOk.map(r => r.propMs), at = allOk.map(r => r.totalMs);
    console.log('All:     ' + (avg(aw)+'').padEnd(7) + (med(aw)+'').padEnd(7) + (min(aw)+'').padEnd(7) + (max(aw)+'').padEnd(9) + (avg(ap)+'').padEnd(7) + (med(ap)+'').padEnd(7) + (min(ap)+'').padEnd(7) + (max(ap)+'').padEnd(9) + (avg(at)+'').padEnd(7) + med(at));
  }

  console.log('\nReliability: ' + (success / ACTIONS * 100).toFixed(1) + '%');
  if (allOk.length) {
    const totalTime = allOk.reduce((s, r) => s + r.totalMs, 0);
    console.log('Total game time: ' + (totalTime / 1000).toFixed(1) + 's for ' + allOk.length + ' actions');
    console.log('Avg per action: ' + (totalTime / allOk.length / 1000).toFixed(2) + 's');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
