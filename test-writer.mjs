#!/usr/bin/env node
/**
 * Test Writer — runs on .28 server, writes TXs on demand via HTTP
 * Writes to poker-table identity with unique test data.
 *
 * Usage: node test-writer.mjs [--port=3001]
 * API:
 *   POST /write   body: {key, data}  → writes to poker-table, returns {txid, ts}
 *   GET  /status                     → returns {block, mempool}
 *   POST /batch   body: {count, delay, prefix}  → writes N TXs with delay between each
 */
import { createServer } from 'http';
import { request } from 'http';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3001');

// Find RPC config
function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
    }
  }
  throw new Error('CHIPS config not found');
}

const RPC = findRPC();

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ jsonrpc: '1.0', id: 1, method, params });
    const auth = Buffer.from(RPC.user + ':' + RPC.pass).toString('base64');
    const req = request({ hostname: RPC.host, port: RPC.port, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Basic ' + auth }
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.error) reject(new Error(j.error.message));
          else resolve(j.result);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

async function resolveKey(keyName) {
  const r = await rpc('getvdxfid', [keyName]);
  return r.vdxfid;
}

const writeLog = []; // {ts, txid, key, data}
let cachedParent = null;
const lastTxPerIdentity = new Map(); // identity -> last txid

async function getParent() {
  if (cachedParent) return cachedParent;
  const idInfo = await rpc('getidentity', ['ptable2.CHIPS@']);
  cachedParent = idInfo?.identity?.parent;
  return cachedParent;
}

async function waitForTxSpendable(txid, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await rpc('gettransaction', [txid]);
      return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function writeToIdentity(idName, key, data) {
  const cleanName = idName.replace('.CHIPS@', '').replace('.CHIPS', '');
  const fullName = idName.includes('.') ? idName : idName + '.CHIPS@';

  // Wait for previous TX on this identity
  const prevTx = lastTxPerIdentity.get(cleanName);
  if (prevTx) await waitForTxSpendable(prevTx);

  const keyId = await resolveKey(key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const idInfo = await rpc('getidentity', [fullName]);
  const parent = idInfo?.identity?.parent;
  const params = { name: cleanName, contentmultimap: { [keyId]: hex } };
  if (parent) params.parent = parent;

  // Try up to 3 times with backoff
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const txid = await rpc('updateidentity', [params]);
      lastTxPerIdentity.set(cleanName, txid);
      return txid;
    } catch (e) {
      if (attempt < 2 && (e.message.includes('bad-txns') || e.message.includes('conflict') || e.message.includes('inputs-spent'))) {
        console.log('[RETRY ' + cleanName + '] attempt ' + (attempt + 1) + ', waiting...');
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
}

const server = createServer(async (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    try {
      if (req.url === '/status') {
        const info = await rpc('getinfo');
        const mp = await rpc('getrawmempool');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ block: info.blocks, mempool: mp.length, connections: info.connections }));
        return;
      }

      if (req.url === '/write' && req.method === 'POST') {
        const { key, data } = JSON.parse(body);
        const ts = Date.now();
        const txid = await writeToIdentity('ptable2', key, data);
        const entry = { ts, writeMs: Date.now() - ts, txid: txid?.substring(0, 16), key, data };
        writeLog.push(entry);
        console.log('[WRITE] ' + txid?.substring(0, 12) + ' (' + entry.writeMs + 'ms)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entry));
        return;
      }

      if (req.url === '/batch' && req.method === 'POST') {
        const { count, delay, prefix } = JSON.parse(body);
        const key = 'chips.vrsc::poker.sg777z.t_betting_state';
        const results = [];
        for (let i = 0; i < count; i++) {
          const uniqueKey = key + '.' + prefix + '.s' + i;
          const data = { test: prefix, seq: i, ts: Date.now() };
          const keyId = await resolveKey(uniqueKey);
          const hex = Buffer.from(JSON.stringify(data)).toString('hex');
          const ts = Date.now();
          try {
            const parent = await getParent();
            const params = { name: 'ptable2', contentmultimap: { [keyId]: hex } };
            if (parent) params.parent = parent;
            const txid = await rpc('updateidentity', [params]);
            const entry = { seq: i, ts, txid: txid?.substring(0, 16), key: uniqueKey };
            results.push(entry);
            writeLog.push(entry);
            console.log('[BATCH ' + i + '/' + count + '] ' + txid?.substring(0, 12) + ' @ ' + ts);
          } catch (e) {
            results.push({ seq: i, ts, error: e.message });
            console.log('[BATCH ' + i + '/' + count + '] ERROR: ' + e.message);
          }
          if (delay && i < count - 1) await new Promise(r => setTimeout(r, delay));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
        return;
      }

      // Write to any identity
      if (req.url === '/write-to' && req.method === 'POST') {
        const { identity, key, data } = JSON.parse(body);
        const idName = identity.replace('.CHIPS@', '').replace('.CHIPS', '');
        const ts = Date.now();
        const txid = await writeToIdentity(idName, key, data);
        const entry = { ts, writeMs: Date.now() - ts, txid: txid?.substring(0, 16), identity: idName, key, data };
        writeLog.push(entry);
        console.log('[WRITE-TO ' + idName + '] ' + txid?.substring(0, 12) + ' (' + entry.writeMs + 'ms)');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entry));
        return;
      }

      // Rapid fire writes (no UTXO wait)
      if (req.url === '/rapid' && req.method === 'POST') {
        const { count, prefix } = JSON.parse(body);
        const results = [];
        const parent = await getParent();
        for (let i = 0; i < count; i++) {
          const uniqueKey = 'chips.vrsc::poker.sg777z.t_betting_state.' + prefix + '.s' + i;
          const data = { test: prefix, seq: i, ts: Date.now() };
          const keyId = await resolveKey(uniqueKey);
          const hex = Buffer.from(JSON.stringify(data)).toString('hex');
          const ts = Date.now();
          try {
            const params = { name: 'ptable2', contentmultimap: { [keyId]: hex } };
            if (parent) params.parent = parent;
            const txid = await rpc('updateidentity', [params]);
            results.push({ seq: i, ts, txid: txid?.substring(0, 16), status: 'ok' });
            console.log('[RAPID ' + i + '] OK ' + txid?.substring(0, 12));
          } catch (e) {
            results.push({ seq: i, ts, status: 'error', error: e.message.substring(0, 80) });
            console.log('[RAPID ' + i + '] ERROR: ' + e.message.substring(0, 60));
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
        return;
      }

      // Read from any identity (so .59 can ask .28 to read too)
      if (req.url === '/read' && req.method === 'POST') {
        const { identity, key } = JSON.parse(body);
        const keyId = await resolveKey(key);
        const fullName = identity.includes('.') ? identity : identity + '.CHIPS@';
        const ts = Date.now();
        const r = await rpc('getidentitycontent', [fullName, 0, -1, false, 0, keyId]);
        const cmm = r?.identity?.contentmultimap;
        let data = null;
        if (cmm && cmm[keyId]) {
          const val = cmm[keyId];
          const entries = Array.isArray(val) ? val : [val];
          const last = entries[entries.length - 1];
          const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
          if (hex) try { data = JSON.parse(Buffer.from(hex, 'hex').toString()); } catch {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ts, readMs: Date.now() - ts, data }));
        return;
      }

      if (req.url === '/log') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(writeLog));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  const info = await rpc('getinfo');
  console.log('Test writer listening on :' + PORT);
  console.log('Block: ' + info.blocks + ' | Connections: ' + info.connections);
  console.log('Identity: ptable2.CHIPS');
});
