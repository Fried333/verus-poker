/**
 * Cross-Daemon Dealer Side — runs on SERVER
 * Writes shuffle data, card reveals, betting states to poker-table
 * Polls pc-player for actions
 *
 * Usage: node test-cross-dealer.mjs
 * Run on the SERVER (46.225.132.28)
 */

import { createClient } from './verus-rpc.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

const RPC = {
  host: '127.0.0.1', port: 22778,
  user: 'user918810440',
  pass: 'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'
};

const c = createClient(RPC);
const TABLE = 'poker-table';
const DEALER = 'poker-p1';
const PLAYER = 'pc-player';
const WRITE_GAP = 1200;

const vdxfCache = new Map();
async function vk(key) { if (vdxfCache.has(key)) return vdxfCache.get(key); const r = await c.getVdxfId(key); vdxfCache.set(key, r.vdxfid); return r.vdxfid; }

let lastWrite = 0;
async function write(key, data) {
  const gap = Date.now() - lastWrite;
  if (gap < WRITE_GAP) await WAIT(WRITE_GAP - gap);
  const id = await c.getIdentity(TABLE + '.CHIPS@');
  const vid = await vk(key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const tx = await c.call('updateidentity', [{ name: TABLE, parent: id.identity.parent, contentmultimap: { [vid]: hex } }]);
  lastWrite = Date.now();
  console.log('[' + ts() + '] WRITE ' + key.split('.').pop() + ' tx=' + tx.substring(0, 12));
  return tx;
}

async function readPlayer(key) {
  const vid = await vk(key);
  // getidentity returns CURRENT state (latest confirmed + mempool)
  const id = await c.getIdentity(PLAYER + '.CHIPS@');
  const cmm = id?.identity?.contentmultimap;
  if (!cmm || !cmm[vid]) return null;
  const val = cmm[vid];
  // IMPORTANT: take LAST element (newest), not first (oldest)
  const last = Array.isArray(val) ? val[val.length - 1] : val;
  const hex = typeof last === 'string' ? last : (typeof last === 'object' ? Object.values(last)[0] : null);
  if (!hex) return null;
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
}

async function main() {
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  DEALER SIDE (run on server)           ║');
  console.log('╚═══════════════════════════════════════╝');

  const info = await c.getInfo();
  console.log('Block: ' + info.blocks + '\n');

  const session = 'xh_' + Date.now().toString(36);
  console.log('Session: ' + session);

  // Step 1: Write table config
  await write('chips.vrsc::poker.sg777z.t_table_info', { dealer: DEALER, session, smallBlind: 1, bigBlind: 2 });

  // Step 2: Wait for player join
  console.log('\nWaiting for player join (up to 3 min)...');
  let joined = false;
  for (let i = 0; i < 90; i++) {
    const jr = await readPlayer('chips.vrsc::poker.sg777z.p_join_request');
    if (jr && jr.session === session) { joined = true; break; }
    if (i % 10 === 0) console.log('[' + ts() + '] polling for join...');
    await WAIT(2000);
  }
  if (!joined) { console.log('FAIL: player never joined after 3 min'); process.exit(1); }
  console.log('[' + ts() + '] Player joined!');

  // Step 3: Shuffle
  console.log('\nShuffling...');
  const pd = [playerInit(52, DEALER), playerInit(52, PLAYER)];
  const dd = dealerShuffle(pd, 52);
  const cd = cashierShuffle(dd.blindedDecks, 2, 52, 2);
  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let j = 0; j < 2; j++) { cards.push(decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck) % 52); cardPos++; }
    holeCards[[DEALER, PLAYER][i]] = cards;
  }
  console.log(DEALER + ': ' + holeCards[DEALER].map(cardToString).join(' '));
  console.log(PLAYER + ': ' + holeCards[PLAYER].map(cardToString).join(' '));

  // Step 4: Write card reveals
  await write('chips.vrsc::poker.sg777z.card_bv.' + PLAYER, { player: PLAYER, cards: holeCards[PLAYER].map(cardToString), hand: 1, session });
  await write('chips.vrsc::poker.sg777z.card_bv.' + DEALER, { player: DEALER, cards: holeCards[DEALER].map(cardToString), hand: 1, session });

  // Step 5: Play hand
  console.log('\nPlaying...');
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  addPlayer(game, DEALER, 200); addPlayer(game, PLAYER, 200);
  startHand(game); postBlinds(game);
  setHoleCards(game, 0, holeCards[DEALER]); setHoleCards(game, 1, holeCards[PLAYER]);

  let revealPos = 4;
  while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    if (game.phase === 'flop' && game.board.length === 0) {
      const cards = []; for (let i = 0; i < 3; i++) { cards.push(decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52); revealPos++; }
      dealBoard(game, cards);
      await write('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'flop', session });
    } else if (game.phase === 'turn' && game.board.length === 3) {
      dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]); revealPos++;
      await write('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'turn', session });
    } else if (game.phase === 'river' && game.board.length === 4) {
      dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]); revealPos++;
      await write('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'river', session });
    }

    if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }
    const seat = game.currentTurn;
    const p = game.players[seat];
    const va = getValidActions(game);
    const toCall = getToCall(game, seat);

    if (p.id === PLAYER) {
      await write('chips.vrsc::poker.sg777z.t_betting_state', { turn: PLAYER, validActions: va, toCall, pot: game.pot, session, ts: Date.now() });
      // Poll for player action
      const baseline = await readPlayer('chips.vrsc::poker.sg777z.p_betting_action');
      let action = null;
      for (let i = 0; i < 60; i++) {
        const a = await readPlayer('chips.vrsc::poker.sg777z.p_betting_action');
        if (a && a.session === session && JSON.stringify(a) !== JSON.stringify(baseline)) { action = a; break; }
        if (i % 10 === 0) console.log('[' + ts() + '] waiting for action...');
        await WAIT(2000);
      }
      if (!action) { console.log('FAIL: player action timeout after 2 min'); process.exit(1); }
      playerAction(game, seat, action.action, action.amount || 0);
      console.log('[' + ts() + '] ' + PLAYER + ': ' + action.action);
    } else {
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      playerAction(game, seat, act, 0);
      console.log('[' + ts() + '] ' + DEALER + ': ' + act);
      await write('chips.vrsc::poker.sg777z.t_betting_state', { turn: DEALER, action: act, pot: game.pot, session, ts: Date.now() });
    }
  }

  // Showdown
  if (game.phase === SHOWDOWN) {
    while (game.board.length < 5) { dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]); revealPos++; }
    await write('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'showdown', session });
    const payouts = settleHand(game, evaluateHand); applyPayouts(game, payouts);
    console.log('[' + ts() + '] Board: ' + game.board.map(cardToString).join(' '));
    console.log('[' + ts() + '] ' + Object.entries(payouts).filter(([,v])=>v>0).map(([s,v])=>game.players[s].id+':+'+v).join(' '));
  }

  const v = verifyGame(pd, dd, cd, 52);
  await write('chips.vrsc::poker.sg777z.t_settlement_info', { verified: v.valid, session, hand: 1, results: game.players.map(p => ({ id: p.id, chips: p.chips })) });

  console.log('\n' + (v.valid ? 'PASS' : 'FAIL') + ' | Time: ' + ts() + ' | Chips: ' + game.players.reduce((s,p)=>s+p.chips,0));
  process.exit(v.valid ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
