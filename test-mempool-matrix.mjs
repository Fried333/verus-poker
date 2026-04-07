#!/usr/bin/env node
/**
 * Two-mode helper for matrix mempool propagation testing.
 *
 *   --mode=write --id=<identity>          → writes a nonce, prints TXID + nonce
 *   --mode=read  --id=<identity> --nonce=<n> --t0=<unix-ms>
 *                                          → polls until nonce visible, prints latency
 *
 * Latency reported is (now - t0) where t0 is the writer's submission time so we
 * measure end-to-end propagation including the writer's own RPC submission.
 */

import { createClient } from './verus-rpc.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const MODE = args.mode || 'read';
const ID = args.id;
const NONCE = args.nonce;
const T0 = args.t0 ? parseInt(args.t0) : Date.now();
const TIMEOUT = args.timeout ? parseInt(args.timeout) : 60000;

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
  const client = createClient(findRPC());
  const fullName = ID.includes('.') ? ID : ID + '.CHIPS@';
  const testKey = 'chips.vrsc::poker.sg777z.t_table_info';
  const vdxfId = (await client.getVdxfId(testKey)).vdxfid;

  if (MODE === 'write') {
    const idInfo = await client.getIdentity(fullName);
    const parent = idInfo.identity?.parent;
    const nonce = 'mtx-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const payload = { nonce, ts: Date.now() };
    const hex = Buffer.from(JSON.stringify(payload)).toString('hex');
    const params = { name: ID, contentmultimap: { [vdxfId]: hex } };
    if (parent) params.parent = parent;
    const t0 = Date.now();
    const txid = await client.call('updateidentity', [params]);
    const submitMs = Date.now() - t0;
    // Output (parsed by orchestrator)
    console.log('NONCE=' + nonce);
    console.log('TXID=' + txid);
    console.log('T0=' + t0);
    console.log('SUBMIT_MS=' + submitMs);
    return;
  }

  // READ MODE
  if (!NONCE) throw new Error('Need --nonce');
  const start = Date.now();
  while (Date.now() - T0 < TIMEOUT) {
    try {
      const r = await client.call('getidentitycontent', [fullName, 0, -1, false, 0, vdxfId]);
      const cmm = r?.identity?.contentmultimap;
      if (cmm && cmm[vdxfId]) {
        const val = cmm[vdxfId];
        const last = Array.isArray(val) ? val[val.length - 1] : val;
        const hex = typeof last === 'string' ? last : (last && Object.values(last)[0]);
        try {
          const dec = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
          if (dec.nonce === NONCE) {
            const e2e = Date.now() - T0;
            const localOnly = Date.now() - start;
            console.log('FOUND e2e=' + e2e + 'ms localpoll=' + localOnly + 'ms');
            return;
          }
        } catch {}
      }
    } catch {}
    await WAIT(250);
  }
  console.log('TIMEOUT after ' + (Date.now() - T0) + 'ms');
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });
