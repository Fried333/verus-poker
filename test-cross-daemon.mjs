/**
 * Cross-Daemon P2P Test
 * Dealer runs on REMOTE daemon (server), player runs on LOCAL daemon (this PC).
 * Both communicate ONLY through the CHIPS blockchain.
 * No browser, no poker-server.mjs — raw chain operations.
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  FOLD, CHECK, CALL, SHOWDOWN, SETTLED
} from './game.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

// LOCAL daemon RPC (player side — has pc-player key)
function findLocalRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
  const conf = readFileSync(p, 'utf8');
  const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
  return { host: '127.0.0.1', port: parseInt(get('rpcport')), user: get('rpcuser'), pass: get('rpcpassword') };
}

// REMOTE daemon RPC (dealer side — has poker-p1 and poker-table keys)
const REMOTE_RPC = {
  host: '46.225.132.28', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const LOCAL_RPC = findLocalRPC();
const TABLE = 'poker-table';
const DEALER_ID = 'poker-p1';
const PLAYER_ID = 'pc-player';

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
  console.log('║  Cross-Daemon P2P Test                           ║');
  console.log('║  Dealer: remote (46.225.132.28)                  ║');
  console.log('║  Player: local (this PC)                         ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Create P2P layers — each talks to its OWN daemon
  const dealerP2P = createP2PLayer(REMOTE_RPC, DEALER_ID, TABLE);
  const playerP2P = createP2PLayer(LOCAL_RPC, PLAYER_ID, TABLE);

  // Verify both daemons
  const dInfo = await dealerP2P.client.getInfo();
  const pInfo = await playerP2P.client.getInfo();
  console.log('Dealer daemon: block ' + dInfo.blocks);
  console.log('Player daemon: block ' + pInfo.blocks);
  console.log('Block diff: ' + Math.abs(dInfo.blocks - pInfo.blocks) + '\n');

  // ── STEP 1: Dealer opens table (writes to remote daemon) ──
  console.log('[' + ts() + '] STEP 1: Dealer opens table');
  const session = 'cross_' + Date.now().toString(36);
  await dealerP2P.write(TABLE, KEYS.TABLE_CONFIG, { dealer: DEALER_ID, smallBlind: 1, bigBlind: 2, session });
  console.log('[' + ts() + '] Table config written (session=' + session + ')');

  // ── STEP 2: Player reads table (from local daemon) ──
  console.log('\n[' + ts() + '] STEP 2: Player reads table config');
  let tc = null;
  for (let i = 0; i < 20; i++) {
    tc = await playerP2P.read(TABLE, KEYS.TABLE_CONFIG);
    if (tc && tc.session === session) break;
    console.log('[' + ts() + '] Waiting for config to propagate...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player sees: session=' + tc?.session + ' dealer=' + tc?.dealer);
  if (tc?.session !== session) { console.log('FAIL: config not propagated'); process.exit(1); }

  // ── STEP 3: Dealer shuffles (all local to remote daemon) ──
  console.log('\n[' + ts() + '] STEP 3: Shuffle + deal');
  const pd = [playerInit(52, DEALER_ID), playerInit(52, PLAYER_ID)];
  const dd = dealerShuffle(pd, 52);
  const cd = cashierShuffle(dd.blindedDecks, 2, 52, 2);
  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const idx = decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck);
      cards.push(idx % 52); cardPos++;
    }
    holeCards[[DEALER_ID, PLAYER_ID][i]] = cards;
  }

  // Write card reveals
  await dealerP2P.write(TABLE, KEYS.CARD_BV + '.' + DEALER_ID, { player: DEALER_ID, cards: holeCards[DEALER_ID].map(cardToString), hand: 1, session });
  await dealerP2P.write(TABLE, KEYS.CARD_BV + '.' + PLAYER_ID, { player: PLAYER_ID, cards: holeCards[PLAYER_ID].map(cardToString), hand: 1, session });
  console.log('[' + ts() + '] Dealer: ' + holeCards[DEALER_ID].map(cardToString).join(' '));
  console.log('[' + ts() + '] Player: ' + holeCards[PLAYER_ID].map(cardToString).join(' '));

  // ── STEP 4: Player reads cards (from local daemon) ──
  console.log('\n[' + ts() + '] STEP 4: Player reads cards');
  let myCards = null;
  for (let i = 0; i < 20; i++) {
    const cr = await playerP2P.read(TABLE, KEYS.CARD_BV + '.' + PLAYER_ID);
    if (cr && cr.session === session) { myCards = cr.cards; break; }
    console.log('[' + ts() + '] Waiting for cards to propagate...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player sees cards: ' + (myCards ? myCards.join(' ') : 'NONE'));
  if (!myCards) { console.log('FAIL: cards not propagated'); process.exit(1); }

  // ── STEP 5: Betting round ──
  console.log('\n[' + ts() + '] STEP 5: Betting');
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  addPlayer(game, DEALER_ID, 200); addPlayer(game, PLAYER_ID, 200);
  startHand(game); postBlinds(game);
  setHoleCards(game, 0, holeCards[DEALER_ID]); setHoleCards(game, 1, holeCards[PLAYER_ID]);

  // Dealer calls (preflop SB)
  playerAction(game, 0, 'call', 0);
  console.log('[' + ts() + '] Dealer: call');

  // Write turn to pc-player
  await dealerP2P.write(TABLE, KEYS.BETTING_STATE, { turn: PLAYER_ID, validActions: getValidActions(game), toCall: getToCall(game, 1), pot: game.pot, session });
  console.log('[' + ts() + '] Dealer wrote: turn=' + PLAYER_ID);

  // Player reads turn (from LOCAL daemon)
  let bs = null;
  for (let i = 0; i < 20; i++) {
    bs = await playerP2P.read(TABLE, KEYS.BETTING_STATE);
    if (bs && bs.session === session && bs.turn === PLAYER_ID) break;
    console.log('[' + ts() + '] Waiting for turn to propagate...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player sees: turn=' + bs?.turn);

  // Player writes action (to LOCAL daemon → propagates to remote)
  console.log('[' + ts() + '] Player writing: check');
  await playerP2P.write(PLAYER_ID, KEYS.PLAYER_ACTION, { action: 'check', amount: 0, session, timestamp: Date.now() });
  console.log('[' + ts() + '] Action written to local daemon');

  // Dealer reads action (from REMOTE daemon — must propagate from local)
  console.log('\n[' + ts() + '] STEP 6: Dealer reads player action');
  const baseline = await dealerP2P.read(PLAYER_ID, KEYS.PLAYER_ACTION);
  console.log('[' + ts() + '] Baseline: ' + JSON.stringify(baseline)?.substring(0, 60));

  // Poll for CHANGE (the action we just wrote)
  let action = null;
  for (let i = 0; i < 30; i++) {
    const a = await dealerP2P.read(PLAYER_ID, KEYS.PLAYER_ACTION);
    if (a && a.session === session && a.action === 'check') { action = a; break; }
    console.log('[' + ts() + '] Waiting for action to propagate from local→remote...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Dealer sees action: ' + (action ? action.action : 'TIMEOUT'));

  if (action) {
    playerAction(game, 1, action.action, 0);
    console.log('\n[' + ts() + '] ✓ Cross-daemon communication WORKS');
    console.log('[' + ts() + '] Player acted: ' + action.action);
    console.log('[' + ts() + '] Pot: ' + game.pot);
  } else {
    console.log('\n[' + ts() + '] ✗ FAILED: action did not propagate');
  }

  const total = ts();
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('  Total: ' + total);
  console.log('  Cross-daemon: ' + (action ? 'PASS' : 'FAIL'));
  console.log('╚══════════════════════════════════════════════════╝');
  process.exit(action ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
