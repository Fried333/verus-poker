#!/usr/bin/env node
/**
 * Cross-daemon mempool visibility test.
 *
 * Run on TWO machines simultaneously:
 *   Writer:   node test-mempool-cross.mjs --mode=write --id=pc-player
 *   Reader:   node test-mempool-cross.mjs --mode=read  --id=pc-player --nonce=<from writer>
 *
 * Or pipe the nonce automatically:
 *   ssh writer-host 'cd ~/poker && node test-mempool-cross.mjs --mode=write --id=pc-player' &
 *   sleep 2
 *   node test-mempool-cross.mjs --mode=read --id=pc-player --nonce=<paste>
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
const MODE = args.mode || 'write';
const ID = args.id || 'pc-player';
const NONCE = args.nonce;

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

async function write() {
  const client = createClient(findRPC());
  const fullName = ID.includes('.') ? ID : ID + '.CHIPS@';
  const idInfo = await client.getIdentity(fullName);
  const parent = idInfo.identity?.parent;

  const testKey = 'chips.vrsc::poker.sg777z.t_table_info';
  const vdxfId = (await client.getVdxfId(testKey)).vdxfid;

  const nonce = 'xchain-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const payload = { nonce, ts: Date.now(), src: 'writer' };
  const hex = Buffer.from(JSON.stringify(payload)).toString('hex');

  const params = { name: ID, contentmultimap: { [vdxfId]: hex } };
  if (parent) params.parent = parent;

  console.log('NONCE:', nonce);
  console.log('Submitting…');
  const t0 = Date.now();
  const txid = await client.call('updateidentity', [params]);
  const wms = Date.now() - t0;
  console.log('TXID:', txid, '(' + wms + 'ms)');
  console.log('VDXF:', vdxfId);
  console.log('TS:', t0);
  console.log('\nFor reader, run:');
  console.log('  node test-mempool-cross.mjs --mode=read --id=' + ID + ' --nonce=' + nonce);
}

async function read() {
  if (!NONCE) throw new Error('Need --nonce=<value>');
  const client = createClient(findRPC());
  const fullName = ID.includes('.') ? ID : ID + '.CHIPS@';
  const testKey = 'chips.vrsc::poker.sg777z.t_table_info';
  const vdxfId = (await client.getVdxfId(testKey)).vdxfid;

  console.log('Watching for nonce:', NONCE);
  console.log('Identity:', fullName);
  console.log('VDXF:', vdxfId);
  const t0 = Date.now();

  let mpFirstSeen = null;
  let getidcFirstSeen = null;
  let getidFirstSeen = null;
  let mpTxid = null;

  while (Date.now() - t0 < 180000) {
    const elapsed = Date.now() - t0;

    // Method A — scan mempool list, look at every TX, decode each, find our nonce
    if (!mpFirstSeen) {
      try {
        const mp = await client.call('getrawmempool', []);
        if (Array.isArray(mp) && mp.length > 0) {
          for (const tx of mp) {
            try {
              const rt = await client.call('getrawtransaction', [tx, 1]);
              for (const v of rt.vout || []) {
                const sp = v.scriptPubKey || {};
                const findCMM = (obj, depth = 0) => {
                  if (!obj || typeof obj !== 'object' || depth > 6) return null;
                  if (obj.contentmultimap) return obj.contentmultimap;
                  for (const k of Object.keys(obj)) {
                    const r = findCMM(obj[k], depth + 1);
                    if (r) return r;
                  }
                  return null;
                };
                const cmm = findCMM(sp);
                if (cmm && cmm[vdxfId]) {
                  const val = cmm[vdxfId];
                  const last = Array.isArray(val) ? val[val.length - 1] : val;
                  const hex = typeof last === 'string' ? last : (last && Object.values(last)[0]);
                  if (typeof hex === 'string') {
                    try {
                      const dec = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
                      if (dec.nonce === NONCE) {
                        mpFirstSeen = elapsed;
                        mpTxid = tx;
                        console.log('[' + elapsed + 'ms] METHOD A (mempool scan): FOUND in tx ' + tx.slice(0, 16));
                      }
                    } catch {}
                  }
                }
              }
            } catch {}
          }
        }
      } catch (e) {}
    }

    // Method B — getidentitycontent heightend=-1
    if (!getidcFirstSeen) {
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
              getidcFirstSeen = elapsed;
              console.log('[' + elapsed + 'ms] METHOD B (getidentitycontent -1): FOUND');
            }
          } catch {}
        }
      } catch {}
    }

    // Method C — getidentity (confirmed only)
    if (!getidFirstSeen) {
      try {
        const r = await client.getIdentity(fullName);
        const cmm = r?.identity?.contentmultimap;
        if (cmm && cmm[vdxfId]) {
          const val = cmm[vdxfId];
          const last = Array.isArray(val) ? val[val.length - 1] : val;
          const hex = typeof last === 'string' ? last : (last && Object.values(last)[0]);
          try {
            const dec = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
            if (dec.nonce === NONCE) {
              getidFirstSeen = elapsed;
              console.log('[' + elapsed + 'ms] METHOD C (getidentity): FOUND');
            }
          } catch {}
        }
      } catch {}
    }

    if (mpFirstSeen && getidcFirstSeen && getidFirstSeen) break;
    await WAIT(500);
  }

  console.log('\n=== SUMMARY ===');
  console.log('Method A (mempool scan):              ', mpFirstSeen !== null ? mpFirstSeen + 'ms' : 'NEVER');
  console.log('Method B (getidentitycontent -1):    ', getidcFirstSeen !== null ? getidcFirstSeen + 'ms' : 'NEVER');
  console.log('Method C (getidentity):              ', getidFirstSeen !== null ? getidFirstSeen + 'ms' : 'NEVER');
  if (mpFirstSeen && getidcFirstSeen) {
    console.log('Diff (B - A):', getidcFirstSeen - mpFirstSeen, 'ms');
  }
}

if (MODE === 'write') await write();
else await read();
