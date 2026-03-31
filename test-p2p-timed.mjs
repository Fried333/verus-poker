/**
 * Timed P2P test — logs every chain read/write with timestamps
 * Shows exactly when data is written and when the other side reads it.
 * Plays a full hand via CLI, no browser needed.
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED
} from './game.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return '+' + ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

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
const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

const TABLE = 'poker-table';
const DEALER = 'poker-p1';
const PLAYER = 'poker-p2';

async function timedWrite(p2p, id, key, data, label) {
  const t1 = ts();
  await p2p.write(id, key, data);
  console.log(t1 + ' WRITE ' + label + ' → ' + id);
  return data;
}

async function timedRead(p2p, id, key, label) {
  const t1 = ts();
  const data = await p2p.read(id, key);
  console.log(t1 + ' READ  ' + label + ' ← ' + id + ': ' + (data ? 'OK' : 'NULL'));
  return data;
}

async function timedPoll(p2p, id, key, lastKnown, timeout, label) {
  const t1 = ts();
  console.log(t1 + ' POLL  ' + label + ' ← ' + id + '...');
  const data = await p2p.poll(id, key, lastKnown, timeout);
  const t2 = ts();
  console.log(t2 + ' POLL  ' + label + ': ' + (data ? 'FOUND' : 'TIMEOUT'));
  return data;
}

async function main() {
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║  TIMED P2P TEST — every read/write logged     ║');
  console.log('╚═══════════════════════════════════════════════╝\n');

  const dealerP2P = createP2PLayer(RPC, DEALER, TABLE);
  const playerP2P = createP2PLayer(RPC, PLAYER, TABLE);
  const info = await dealerP2P.client.getInfo();
  console.log('Chain: ' + info.name + ' Block: ' + info.blocks + '\n');

  // ── STEP 1: Table config ──
  console.log('── STEP 1: Table config ──');
  await timedWrite(dealerP2P, TABLE, KEYS.TABLE_CONFIG, { dealer: DEALER, smallBlind: 1, bigBlind: 2 }, 'table_config');
  await WAIT(2000);
  const tc = await timedRead(playerP2P, TABLE, KEYS.TABLE_CONFIG, 'table_config');

  // ── STEP 2: Player joins ──
  console.log('\n── STEP 2: Player join ──');
  await timedWrite(playerP2P, PLAYER, KEYS.JOIN_REQUEST, { table: TABLE, player: PLAYER, ready: true, timestamp: Date.now() }, 'join');
  await WAIT(2000);
  const join = await timedRead(dealerP2P, PLAYER, KEYS.JOIN_REQUEST, 'join');

  // ── STEP 3: Shuffle ──
  console.log('\n── STEP 3: Shuffle (dealer-side only) ──');
  const t3 = ts();
  const pd = [playerInit(52, DEALER), playerInit(52, PLAYER)];
  const dd = dealerShuffle(pd, 52);
  const cd = cashierShuffle(dd.blindedDecks, 2, 52, 2);
  console.log(ts() + ' Shuffle complete (local, ' + ((Date.now() - T0)/1000 - parseFloat(t3.slice(1))).toFixed(1) + 's)');

  // ── STEP 4: Deal hole cards ──
  console.log('\n── STEP 4: Deal hole cards ──');
  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const idx = decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck);
      cards.push(idx % 52); cardPos++;
    }
    const pid = [DEALER, PLAYER][i];
    holeCards[pid] = cards;
    await timedWrite(dealerP2P, TABLE, KEYS.CARD_BV + '.' + pid, { player: pid, cards: cards.map(cardToString), hand: 1 }, 'cards.' + pid);
    await WAIT(2000);
  }
  console.log('  ' + DEALER + ': ' + holeCards[DEALER].map(cardToString).join(' '));
  console.log('  ' + PLAYER + ': ' + holeCards[PLAYER].map(cardToString).join(' '));

  // Player reads their cards
  await WAIT(1000);
  const myCards = await timedRead(playerP2P, TABLE, KEYS.CARD_BV + '.' + PLAYER, 'my_cards');

  // ── STEP 5: Play hand ──
  console.log('\n── STEP 5: Betting ──');
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  addPlayer(game, DEALER, 200); addPlayer(game, PLAYER, 200);
  startHand(game); postBlinds(game);
  setHoleCards(game, 0, holeCards[DEALER]); setHoleCards(game, 1, holeCards[PLAYER]);

  let revealPos = 4;
  while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    // Deal community cards
    if (game.phase === 'flop' && game.board.length === 0) {
      const cards = []; for (let i = 0; i < 3; i++) { const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck); cards.push(idx % 52); revealPos++; }
      dealBoard(game, cards);
      await timedWrite(dealerP2P, TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'flop', hand: 1 }, 'flop');
      await WAIT(2000);
      await timedRead(playerP2P, TABLE, KEYS.BOARD_CARDS, 'flop');
    } else if (game.phase === 'turn' && game.board.length === 3) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck); dealBoard(game, [idx % 52]); revealPos++;
      await timedWrite(dealerP2P, TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'turn', hand: 1 }, 'turn');
      await WAIT(2000);
      await timedRead(playerP2P, TABLE, KEYS.BOARD_CARDS, 'turn');
    } else if (game.phase === 'river' && game.board.length === 4) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck); dealBoard(game, [idx % 52]); revealPos++;
      await timedWrite(dealerP2P, TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'river', hand: 1 }, 'river');
      await WAIT(2000);
      await timedRead(playerP2P, TABLE, KEYS.BOARD_CARDS, 'river');
    }
    if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }

    const seat = game.currentTurn;
    const p = game.players[seat];
    const va = getValidActions(game);
    const toCall = getToCall(game, seat);

    if (p.id === PLAYER) {
      // Dealer writes betting state, player reads and acts
      await timedWrite(dealerP2P, TABLE, KEYS.BETTING_STATE, { turn: PLAYER, validActions: va, toCall, pot: game.pot, minRaise: game.minRaise }, 'turn=' + PLAYER);
      await WAIT(1000);
      const bs = await timedRead(playerP2P, TABLE, KEYS.BETTING_STATE, 'my_turn');

      // Player auto-plays
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      await timedWrite(playerP2P, PLAYER, KEYS.PLAYER_ACTION, { action: act, amount: 0, timestamp: Date.now() }, 'action=' + act);
      await WAIT(1000);

      // Dealer reads action
      const action = await timedRead(dealerP2P, PLAYER, KEYS.PLAYER_ACTION, 'player_action');
      if (action) playerAction(game, seat, action.action, action.amount || 0);
      console.log('  ' + PLAYER + ': ' + act);
    } else {
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      playerAction(game, seat, act, 0);
      await timedWrite(dealerP2P, TABLE, KEYS.BETTING_STATE, { turn: DEALER, action: act, pot: game.pot }, 'dealer_acts=' + act);
      console.log('  ' + DEALER + ': ' + act);
      await WAIT(2000);
    }
  }

  // ── STEP 6: Showdown ──
  console.log('\n── STEP 6: Showdown ──');
  if (game.phase === SHOWDOWN) {
    while (game.board.length < 5) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck); dealBoard(game, [idx % 52]); revealPos++;
    }
    await timedWrite(dealerP2P, TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'showdown', hand: 1 }, 'final_board');
    const payouts = settleHand(game, evaluateHand); applyPayouts(game, payouts);
    console.log('  Board: ' + game.board.map(cardToString).join(' '));
    console.log('  Winner: ' + Object.entries(payouts).filter(([,v])=>v>0).map(([s,v])=>game.players[s].id+':+'+v).join(' '));
  }

  // ── STEP 7: Verify + settle ──
  console.log('\n── STEP 7: Verify + Settle ──');
  const v = verifyGame(pd, dd, cd, 52);
  console.log(ts() + ' Verify: ' + (v.valid ? 'PASS' : 'FAIL'));
  await timedWrite(dealerP2P, TABLE, KEYS.SETTLEMENT, { verified: v.valid, results: game.players.map(p => ({ id: p.id, chips: p.chips })), hand: 1 }, 'settlement');
  await WAIT(2000);
  await timedRead(playerP2P, TABLE, KEYS.SETTLEMENT, 'settlement');

  // ── Summary ──
  const total = game.players.reduce((s, p) => s + p.chips, 0);
  console.log('\n╔═══════════════════════════════════════════════╗');
  console.log('  Total time: ' + ts());
  console.log('  Verified: ' + v.valid);
  console.log('  Chips: ' + total + ' (conserved: ' + (total === 400) + ')');
  game.players.forEach(p => console.log('  ' + p.id + ': ' + p.chips));
  console.log('╚═══════════════════════════════════════════════╝');
  process.exit(v.valid && total === 400 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
