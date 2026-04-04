#!/usr/bin/env node
/**
 * Auto-player — headless bot that joins and auto-plays poker.
 * Uses player-backend.mjs, no browser needed.
 *
 * Usage: node auto-player.mjs --id=pplayer2 --table=ptable2
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const MY_ID = args.id || 'pplayer2';
const TABLE_ID = args.table || 'ptable2';
const RPC_HOST = args.host || '127.0.0.1';
const RPC_PORT = parseInt(args.rpcport || '22778');

function findRPC() {
  // Try local config first
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
    join(process.env.HOME, '.komodo/CHIPS/CHIPS.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword')) {
        return { host: RPC_HOST, port: parseInt(get('rpcport') || RPC_PORT), user: get('rpcuser'), pass: get('rpcpassword') };
      }
    }
  }
  throw new Error('CHIPS daemon config not found');
}

async function main() {
  console.log('[AUTO] Starting auto-player: ' + MY_ID);
  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, MY_ID, TABLE_ID);
  const backend = createPlayerBackend(p2p, MY_ID, TABLE_ID);

  let hands = 0, actions = 0;

  backend.onStateChange(s => {
    // Minimal logging
  });

  backend.onNeedAction((state, respond) => {
    // Auto-play: check > call > fold
    const va = state.validActions;
    let action;
    if (va.includes('check')) action = { action: 'check', amount: 0 };
    else if (va.includes('call')) action = { action: 'call', amount: state.toCall };
    else action = { action: 'fold', amount: 0 };

    console.log('[AUTO ' + MY_ID + '] ' + action.action + (action.amount ? ' ' + action.amount : '') + ' (hand #' + state.handCount + ')');
    actions++;
    respond(action);
  });

  backend.onLog(entry => {
    if (entry.includes('Settlement') || entry.includes('New hand')) {
      console.log('[AUTO ' + MY_ID + '] ' + entry);
      if (entry.includes('Settlement')) hands++;
    }
  });

  console.log('[AUTO] Playing as ' + MY_ID + ', auto check/call...');
  await backend.start();
}

main().catch(e => { console.error('[AUTO] FATAL:', e.message); process.exit(1); });
