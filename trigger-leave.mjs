#!/usr/bin/env node
/**
 * Trigger a leave by writing leaving:true to a player's JOIN_REQUEST.
 * Equivalent to calling leaveTable() on the player backend.
 *
 * Usage: node trigger-leave.mjs --id=pc-player --table=ptable2
 */
import { createP2PLayer } from './p2p-layer.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
  const [k, v] = a.substring(2).split('='); return [k, v || true];
}));
const MY_ID = args.id || 'pc-player';
const TABLE_ID = args.table || 'ptable2';

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

const KEY_JOIN_REQUEST = 'chips.vrsc::poker.sg777z.p_join_request';
const KEY_TABLE_CONFIG = 'chips.vrsc::poker.sg777z.t_table_info';

const p2p = createP2PLayer(findRPC(), MY_ID, TABLE_ID);

const tc = await p2p.read(TABLE_ID, KEY_TABLE_CONFIG);
const session = tc?.session;
if (!session) { console.error('No session in table_config'); process.exit(1); }

const idInfo = await p2p.client.call('getidentity', [MY_ID + (MY_ID.endsWith('@') ? '' : '.CHIPS@')]);
const payAddr = idInfo?.identity?.primaryaddresses?.[0];

const leaveData = {
  table: TABLE_ID, player: MY_ID, session,
  ready: false, leaving: true, payAddr, timestamp: Date.now()
};
console.log('Writing leave marker for', MY_ID, 'session=', session);
await p2p.write(MY_ID, KEY_JOIN_REQUEST, leaveData);
console.log('Leave marker written. Dealer should detect and rotate phase shortly.');
