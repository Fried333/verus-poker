#!/usr/bin/env node
/**
 * Test: knock-based player discovery
 *
 * Validates that:
 *   1. A player calling knockTable() sends a tiny tx from their identity
 *      to the table identity's pay address
 *   2. The dealer's discoverIdsFromKnocks() logic walks the incoming UTXO
 *      back to the source address and resolves it to the player's identity
 *      via getidentitieswithaddress
 *   3. The resolved identity name matches the player's ID
 *
 * Usage: node test-knock-discovery.mjs
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
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

const TABLE_ID = 'cashier1';
const PLAYER_ID = 'pc-player';
const WAIT = ms => new Promise(r => setTimeout(r, ms));

const results = [];
function record(name, status, info = {}) {
  results.push({ name, status, ...info });
  const tag = status === 'PASS' ? '\u2713' : status === 'FAIL' ? '\u2717' : '\u00b7';
  console.log(`  [${tag}] ${name}${info.note ? ' \u2014 ' + info.note : ''}`);
}

async function main() {
  console.log('='.repeat(70));
  console.log('Test: knock-based player discovery');
  console.log('='.repeat(70));

  const rpc = findRPC();
  const dealerP2P = createP2PLayer(rpc, TABLE_ID, TABLE_ID);
  const playerP2P = createP2PLayer(rpc, PLAYER_ID, TABLE_ID);
  const player = createPlayerBackend(playerP2P, PLAYER_ID, TABLE_ID, {});
  // Set state.session so the knock-once-per-session guard works
  player.state.session = 'test-' + Date.now();

  const info = await dealerP2P.client.call('getinfo', []);
  console.log('Chain: ' + info.name + ' block ' + info.blocks + '\n');

  // 1. Resolve table pay address (the discovery target)
  const tableIdInfo = await dealerP2P.client.call('getidentity', [TABLE_ID + '.CHIPS@']);
  const tableAddr = tableIdInfo?.identity?.primaryaddresses?.[0];
  if (!tableAddr) {
    console.log('FATAL: table identity has no primary address');
    process.exit(1);
  }
  console.log('Table pay address: ' + tableAddr);

  // 2. Snapshot UTXOs at the table address BEFORE the knock
  const beforeUtxos = await dealerP2P.client.call('getaddressutxos', [{ addresses: [tableAddr] }]);
  const beforeTxids = new Set((beforeUtxos || []).map(u => u.txid));
  console.log('Pre-knock UTXOs at table addr: ' + beforeTxids.size);

  // 3. Player calls knockTable
  console.log('\n--- Player knocking ---');
  await player.knockTable();
  record('knockTable() returned without error', 'PASS');

  // 4. Wait for the knock UTXO to appear at the table address (check both mempool + confirmed)
  console.log('Waiting for knock UTXO to land at table addr (max 240s)...');
  let knockUtxo = null;
  const start = Date.now();
  while (Date.now() - start < 240000) {
    // Check confirmed UTXOs
    const utxos = await dealerP2P.client.call('getaddressutxos', [{ addresses: [tableAddr] }]);
    const fresh = (utxos || []).filter(u => !beforeTxids.has(u.txid));
    if (fresh.length > 0) {
      knockUtxo = fresh[0];
      console.log('  found in confirmed UTXOs');
      break;
    }
    // Check mempool
    try {
      const mp = await dealerP2P.client.call('getaddressmempool', [{ addresses: [tableAddr] }]);
      if (Array.isArray(mp) && mp.length > 0) {
        // mempool entries with positive value (incoming) that aren't pre-existing
        const incoming = mp.filter(m => m.satoshis > 0 && !beforeTxids.has(m.txid));
        if (incoming.length > 0) {
          knockUtxo = { txid: incoming[0].txid, satoshis: incoming[0].satoshis };
          console.log('  found in mempool');
          break;
        }
      }
    } catch {}
    if ((Date.now() - start) % 20000 < 2100) {
      console.log('  still waiting... (' + Math.round((Date.now() - start) / 1000) + 's)');
    }
    await WAIT(2000);
  }
  if (!knockUtxo) {
    record('knock UTXO appeared at table addr', 'FAIL', { note: 'timeout' });
    process.exit(1);
  }
  record('knock UTXO appeared at table addr', 'PASS', { note: knockUtxo.txid.slice(0, 16) + ' amt=' + knockUtxo.satoshis / 1e8 });

  // 5. Walk vin[0] back to find the source address
  const tx = await dealerP2P.client.call('getrawtransaction', [knockUtxo.txid, 1]);
  if (!tx?.vin || tx.vin.length === 0) {
    record('knock tx has inputs', 'FAIL');
    process.exit(1);
  }
  const prevTxid = tx.vin[0].txid;
  const prevVout = tx.vin[0].vout;
  const prev = await dealerP2P.client.call('getrawtransaction', [prevTxid, 1]);
  const senderAddrs = prev.vout[prevVout]?.scriptPubKey?.addresses || [];
  const sender = senderAddrs[0];
  if (!sender) {
    record('extracted sender address from input', 'FAIL');
    process.exit(1);
  }
  record('extracted sender address from input', 'PASS', { note: sender });

  // 6. Sender should be an i-address (we knocked from i-addr)
  if (!sender.startsWith('i')) {
    record('sender is an i-address', 'FAIL', { note: sender });
    process.exit(1);
  }
  record('sender is an i-address', 'PASS', { note: sender });

  // 7. Resolve i-address → identity name via getidentity (no -idindex needed)
  let idName = null;
  try {
    const idInfo = await dealerP2P.client.call('getidentity', [sender]);
    idName = idInfo?.identity?.name || null;
  } catch (e) {
    record('getidentity(i-addr)', 'FAIL', { note: e.message });
    process.exit(1);
  }
  if (!idName) {
    record('resolved i-addr to identity', 'FAIL');
    process.exit(1);
  }
  record('resolved i-addr to identity name', 'PASS', { note: idName });

  // 7. Verify it matches our player
  const expected = PLAYER_ID;
  if (idName === expected) {
    record('discovered identity matches player ID', 'PASS');
  } else {
    record('discovered identity matches player ID', 'FAIL', { note: 'got ' + idName + ' expected ' + expected });
  }

  console.log('\n' + '='.repeat(70));
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  console.log(`PASS: ${pass}   FAIL: ${fail}   (total: ${results.length})`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e.message); if (e.stack) console.error(e.stack); process.exit(1); });
