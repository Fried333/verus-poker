/**
 * Cross-Daemon Player Side — runs on LOCAL PC
 * Reads game state from poker-table, writes actions to pc-player
 *
 * Usage: node test-cross-player.mjs
 * Run on LOCAL PC (separate from dealer)
 */

import { createClient } from './verus-rpc.mjs';
import { readFileSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

function findRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
  const conf = readFileSync(p, 'utf8');
  const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
  return { host: '127.0.0.1', port: parseInt(get('rpcport')), user: get('rpcuser'), pass: get('rpcpassword') };
}

const c = createClient(findRPC());
const TABLE = 'poker-table';
const PLAYER = 'pc-player';

const vdxfCache = new Map();
async function vk(key) { if (vdxfCache.has(key)) return vdxfCache.get(key); const r = await c.getVdxfId(key); vdxfCache.set(key, r.vdxfid); return r.vdxfid; }

async function read(identity, key) {
  const vid = await vk(key);
  // Use getidentitycontent with mempool (-1) — returns array of all entries, take LAST (newest)
  const r = await c.call('getidentitycontent', [identity + '.CHIPS@', 0, -1]);
  const cmm = r?.identity?.contentmultimap;
  if (!cmm || !cmm[vid]) return null;
  const val = cmm[vid];
  // IMPORTANT: take LAST element (newest), not first (oldest)
  const last = Array.isArray(val) ? val[val.length - 1] : val;
  const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
  if (!hex) return null;
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
}

async function writeAction(key, data) {
  const id = await c.getIdentity(PLAYER + '.CHIPS@');
  const vid = await vk(key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const tx = await c.call('updateidentity', [{ name: PLAYER, parent: id.identity.parent, contentmultimap: { [vid]: hex } }]);
  console.log('[' + ts() + '] WRITE action tx=' + tx.substring(0, 12));
  return tx;
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  PLAYER SIDE (run on local PC)        ║');
  console.log('╚═══════════════════════════════════════╝');

  const info = await c.getInfo();
  console.log('Block: ' + info.blocks + '\n');

  // Step 1: Read table config → get LATEST session
  // First read the current (possibly old) session, then wait for a new one
  console.log('Reading current table state...');
  const oldTc = await read(TABLE, 'chips.vrsc::poker.sg777z.t_table_info');
  const oldSession = oldTc?.session || null;
  console.log('Current session on chain: ' + (oldSession || 'none'));
  console.log('Waiting for NEW session from dealer...');

  let session = null;
  for (let i = 0; i < 30; i++) {
    const tc = await read(TABLE, 'chips.vrsc::poker.sg777z.t_table_info');
    if (tc && tc.session && tc.session !== oldSession) {
      session = tc.session;
      console.log('[' + ts() + '] New session: ' + session + ' Dealer: ' + tc.dealer);
      break;
    }
    if (i % 5 === 0) console.log('[' + ts() + '] waiting for dealer to open table...');
    await WAIT(2000);
  }
  if (!session) { console.log('FAIL: no session'); process.exit(1); }

  // Step 2: Write join
  console.log('[' + ts() + '] Writing join...');
  await writeAction('chips.vrsc::poker.sg777z.p_join_request', { table: TABLE, player: PLAYER, session, ready: true, timestamp: Date.now() });

  // Step 3: Wait for cards
  console.log('\nWaiting for cards...');
  let myCards = null;
  for (let i = 0; i < 60; i++) {
    const cr = await read(TABLE, 'chips.vrsc::poker.sg777z.card_bv.' + PLAYER);
    if (cr && cr.session === session) { myCards = cr.cards; break; }
    if (i % 10 === 0) console.log('[' + ts() + '] waiting...');
    await WAIT(1500);
  }
  if (!myCards) { console.log('FAIL: no cards after 90s'); process.exit(1); }
  console.log('[' + ts() + '] My cards: ' + myCards.join(' '));

  // Step 4: Game loop — poll for turn, act, repeat
  let lastBS = null;
  let lastBC = null;
  let lastST = null;
  let actionCount = 0;

  console.log('\nPlaying...');
  while (true) {
    // Check betting state
    const bs = await read(TABLE, 'chips.vrsc::poker.sg777z.t_betting_state');
    if (bs && bs.session === session && JSON.stringify(bs) !== JSON.stringify(lastBS)) {
      lastBS = bs;
      if (bs.turn === PLAYER && bs.validActions) {
        // My turn — auto-play
        const act = bs.validActions.includes('check') ? 'check' : bs.validActions.includes('call') ? 'call' : 'fold';
        console.log('[' + ts() + '] My turn! pot=' + bs.pot + ' → ' + act);
        await writeAction('chips.vrsc::poker.sg777z.p_betting_action', { action: act, amount: 0, session, timestamp: Date.now() });
        actionCount++;
      } else if (bs.action) {
        console.log('[' + ts() + '] Dealer: ' + bs.action);
      }
    }

    // Check board cards
    const bc = await read(TABLE, 'chips.vrsc::poker.sg777z.t_board_cards');
    if (bc && bc.session === session && JSON.stringify(bc) !== JSON.stringify(lastBC)) {
      lastBC = bc;
      console.log('[' + ts() + '] Board (' + bc.phase + '): ' + bc.board.join(' '));
    }

    // Check settlement
    const st = await read(TABLE, 'chips.vrsc::poker.sg777z.t_settlement_info');
    if (st && st.session === session && JSON.stringify(st) !== JSON.stringify(lastST)) {
      lastST = st;
      console.log('[' + ts() + '] Settlement: verified=' + st.verified);
      st.results?.forEach(r => console.log('  ' + r.id + ': ' + r.chips));
      console.log('\nDONE | Time: ' + ts() + ' | Actions: ' + actionCount);
      process.exit(0);
    }

    await WAIT(1500);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
