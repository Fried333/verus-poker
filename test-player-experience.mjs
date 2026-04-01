/**
 * Player Experience Test — simulates what a real player sees
 * Measures every step from the player's perspective.
 */
import { createP2PLayer } from './p2p-layer.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

function findRPC() {
  const paths = [
    join(process.env.HOME || '', '.komodo/CHIPS/CHIPS.conf'),
    join(process.env.HOME || '', '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = key => (conf.match(new RegExp('^' + key + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword'))
        return { host: get('rpchost') || '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
    }
  }
  throw new Error('CHIPS conf not found');
}

const RPC = findRPC();
const TABLE = 'poker-table';
const PLAYER = 'pc-player';
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Player Experience Test — timing every step       ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  const p2p = createP2PLayer(RPC, PLAYER, TABLE);
  const info = await p2p.client.getInfo();
  console.log('Chain: block ' + info.blocks + '\n');

  // Step 1: Read table config → get session
  console.log('STEP 1: Read table config');
  let t = Date.now();
  const tc = await p2p.read(TABLE, KEYS.TABLE_CONFIG);
  console.log('  ' + ts() + ' Read: ' + (Date.now() - t) + 'ms');
  console.log('  Session: ' + (tc?.session || 'NONE'));
  console.log('  Dealer: ' + (tc?.dealer || '?'));
  const session = tc?.session;
  if (!session) { console.log('  FAIL: no session'); process.exit(1); }

  // Step 1b: Write join signal (triggers dealer to start)
  console.log('\nSTEP 1b: Write join signal');
  t = Date.now();
  await p2p.write(PLAYER, 'chips.vrsc::poker.sg777z.p_join_request', {
    table: TABLE, player: PLAYER, ready: true, session, timestamp: Date.now()
  });
  console.log('  ' + ts() + ' Join written (' + (Date.now() - t) + 'ms)');
  console.log('  Waiting for dealer to start hand...');

  // Step 2: Poll for cards (already dealt or waiting)
  console.log('\nSTEP 2: Poll for hole cards');
  let cards = null;
  for (let i = 0; i < 90; i++) {
    t = Date.now();
    const cr = await p2p.read(TABLE, KEYS.CARD_BV + '.' + PLAYER);
    const readTime = Date.now() - t;
    if (cr && cr.session === session) {
      cards = cr.cards;
      console.log('  ' + ts() + ' Cards: ' + cards.join(' ') + ' (read: ' + readTime + 'ms)');
      break;
    }
    if (i % 10 === 0) console.log('  ' + ts() + ' Waiting for shuffle... (read: ' + readTime + 'ms)');
    await WAIT(1000);
  }
  if (!cards) { console.log('  FAIL: no cards after 90s'); process.exit(1); }

  // Step 3: Poll for my turn
  console.log('\nSTEP 3: Poll for my turn');
  let myTurn = null;
  for (let i = 0; i < 30; i++) {
    t = Date.now();
    const bs = await p2p.read(TABLE, KEYS.BETTING_STATE);
    const readTime = Date.now() - t;
    if (bs && bs.session === session && bs.turn === PLAYER) {
      myTurn = bs;
      console.log('  ' + ts() + ' My turn! pot=' + bs.pot + ' toCall=' + bs.toCall + ' (read: ' + readTime + 'ms)');
      break;
    }
    if (bs && bs.session === session) {
      console.log('  ' + ts() + ' Turn: ' + bs.turn + ' (not me) (read: ' + readTime + 'ms)');
    } else {
      if (i % 5 === 0) console.log('  ' + ts() + ' Waiting... (read: ' + readTime + 'ms)');
    }
    await WAIT(1000);
  }

  // Step 4: Write action
  if (myTurn) {
    console.log('\nSTEP 4: Write action (check)');
    t = Date.now();
    await p2p.write(PLAYER, KEYS.PLAYER_ACTION, { action: 'check', amount: 0, player: PLAYER, session, timestamp: Date.now() });
    console.log('  ' + ts() + ' Action written (' + (Date.now() - t) + 'ms)');
  }

  // Step 5: Poll for board cards
  console.log('\nSTEP 5: Poll for board cards');
  for (let i = 0; i < 20; i++) {
    t = Date.now();
    const bc = await p2p.read(TABLE, KEYS.BOARD_CARDS);
    const readTime = Date.now() - t;
    if (bc && bc.session === session) {
      console.log('  ' + ts() + ' Board: ' + bc.board.join(' ') + ' (' + bc.phase + ') (read: ' + readTime + 'ms)');
      break;
    }
    if (i % 5 === 0) console.log('  ' + ts() + ' Waiting... (read: ' + readTime + 'ms)');
    await WAIT(1000);
  }

  // Step 6: Poll for settlement
  console.log('\nSTEP 6: Poll for settlement');
  for (let i = 0; i < 30; i++) {
    t = Date.now();
    const st = await p2p.read(TABLE, KEYS.SETTLEMENT);
    const readTime = Date.now() - t;
    if (st && st.session === session) {
      console.log('  ' + ts() + ' Settlement: verified=' + st.verified + ' (read: ' + readTime + 'ms)');
      if (st.results) st.results.forEach(r => console.log('    ' + r.id + ': ' + r.chips));
      break;
    }
    if (i % 5 === 0) console.log('  ' + ts() + ' Waiting... (read: ' + readTime + 'ms)');
    await WAIT(1000);
  }

  console.log('\n  Total time: ' + ts());
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
