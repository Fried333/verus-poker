/**
 * Cross-Daemon P2P Layer Test
 * Tests the actual p2p-layer.mjs read/write across two daemons.
 *
 * Usage:
 *   ROLE=dealer node test-p2p-crossdaemon.mjs   (run on SERVER)
 *   ROLE=player node test-p2p-crossdaemon.mjs   (run on LOCAL PC)
 *
 * Tests:
 * 1. Dealer writes table config → Player reads it (cross-daemon)
 * 2. Player writes join → Dealer reads it (cross-daemon)
 * 3. Dealer writes betting state → Player reads it
 * 4. Player writes action → Dealer reads it
 * 5. Full hand with real crypto protocol
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createClient } from './verus-rpc.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  SHOWDOWN, SETTLED
} from './game.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const ROLE = process.env.ROLE || 'dealer';
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

// ── RPC Config ──
function findRPC() {
  // Try standard CHIPS PBaaS config locations
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
  throw new Error('CHIPS config not found');
}

const TABLE = 'poker-table';
const DEALER_ID = 'poker-p1';
const PLAYER_ID = 'pc-player';
const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

async function runDealer() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  DEALER (p2p-layer.mjs) — run on SERVER ║');
  console.log('╚════════════════════════════════════════╝');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, DEALER_ID, TABLE);
  const info = await p2p.client.getInfo();
  console.log('Block: ' + info.blocks);

  const session = 'x_' + Date.now().toString(36);
  console.log('Session: ' + session + '\n');

  // 1. Write table config
  console.log('[' + ts() + '] Writing table config...');
  await p2p.write(TABLE, KEYS.TABLE_CONFIG, {
    smallBlind: 1, bigBlind: 2, buyin: 200, dealer: DEALER_ID, session, ts: Date.now()
  });
  console.log('[' + ts() + '] Table config written');

  // 2. Wait for player join (poll player's ID for join request)
  console.log('[' + ts() + '] Waiting for player join (up to 3 min)...');
  let joined = false;
  for (let i = 0; i < 90; i++) {
    const req = await p2p.read(PLAYER_ID, KEYS.JOIN_REQUEST);
    if (req && req.table === TABLE && req.timestamp && req.timestamp > (Date.now() - 300000)) {
      joined = true;
      console.log('[' + ts() + '] Player joined! (ts=' + req.timestamp + ' session=' + (req.session || 'none') + ')');
      break;
    }
    if (i % 10 === 0) console.log('[' + ts() + '] Polling for join... (' + i + ')');
    await WAIT(2000);
  }
  if (!joined) { console.log('FAIL: Player never joined after 3 min'); process.exit(1); }

  // 3. Shuffle & deal
  console.log('\n[' + ts() + '] Shuffling...');
  const pd = [playerInit(52, DEALER_ID), playerInit(52, PLAYER_ID)];
  const dd = dealerShuffle(pd, 52);
  const cd = cashierShuffle(dd.blindedDecks, 2, 52, 2);

  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let j = 0; j < 2; j++) {
      cards.push(decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck) % 52);
      cardPos++;
    }
    holeCards[[DEALER_ID, PLAYER_ID][i]] = cards;
  }
  console.log(DEALER_ID + ': ' + holeCards[DEALER_ID].map(cardToString).join(' '));
  console.log(PLAYER_ID + ': ' + holeCards[PLAYER_ID].map(cardToString).join(' '));

  // Write card reveals
  await p2p.write(TABLE, KEYS.CARD_BV + '.' + PLAYER_ID, {
    player: PLAYER_ID, cards: holeCards[PLAYER_ID].map(cardToString), hand: 1, session
  });
  await WAIT(1500);
  await p2p.write(TABLE, KEYS.CARD_BV + '.' + DEALER_ID, {
    player: DEALER_ID, cards: holeCards[DEALER_ID].map(cardToString), hand: 1, session
  });

  // 4. Play hand
  console.log('\n[' + ts() + '] Playing...');
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  addPlayer(game, DEALER_ID, 200);
  addPlayer(game, PLAYER_ID, 200);
  startHand(game);
  postBlinds(game);
  setHoleCards(game, 0, holeCards[DEALER_ID]);
  setHoleCards(game, 1, holeCards[PLAYER_ID]);

  let revealPos = 4;
  while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    // Deal community cards
    if (game.phase === 'flop' && game.board.length === 0) {
      const cards = [];
      for (let i = 0; i < 3; i++) {
        cards.push(decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52);
        revealPos++;
      }
      dealBoard(game, cards);
      await p2p.write(TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'flop', session });
    } else if (game.phase === 'turn' && game.board.length === 3) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52;
      dealBoard(game, [idx]); revealPos++;
      await p2p.write(TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'turn', session });
    } else if (game.phase === 'river' && game.board.length === 4) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52;
      dealBoard(game, [idx]); revealPos++;
      await p2p.write(TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'river', session });
    }

    if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }
    const seat = game.currentTurn;
    const p = game.players[seat];
    const va = getValidActions(game);
    const toCall = getToCall(game, seat);

    if (p.id === PLAYER_ID) {
      // Write betting state, poll for player action
      await p2p.write(TABLE, KEYS.BETTING_STATE, {
        turn: PLAYER_ID, validActions: va, toCall, pot: game.pot, session, ts: Date.now()
      });
      console.log('[' + ts() + '] Waiting for ' + PLAYER_ID + ' action...');
      const baseline = await p2p.read(PLAYER_ID, KEYS.PLAYER_ACTION);
      let action = null;
      for (let i = 0; i < 60; i++) {
        const a = await p2p.read(PLAYER_ID, KEYS.PLAYER_ACTION);
        if (a && a.session === session && JSON.stringify(a) !== JSON.stringify(baseline)) { action = a; break; }
        if (i % 10 === 0) console.log('[' + ts() + '] polling for action...');
        await WAIT(2000);
      }
      if (!action) { console.log('FAIL: Player action timeout'); process.exit(1); }
      playerAction(game, seat, action.action, action.amount || 0);
      console.log('[' + ts() + '] ' + PLAYER_ID + ': ' + action.action);
    } else {
      // Dealer auto-plays
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      playerAction(game, seat, act, 0);
      console.log('[' + ts() + '] ' + DEALER_ID + ': ' + act);
      await p2p.write(TABLE, KEYS.BETTING_STATE, {
        turn: DEALER_ID, action: act, pot: game.pot, session, ts: Date.now()
      });
    }
  }

  // Showdown
  if (game.phase === SHOWDOWN) {
    while (game.board.length < 5) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52;
      dealBoard(game, [idx]); revealPos++;
    }
    await p2p.write(TABLE, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'showdown', session });
    const payouts = settleHand(game, evaluateHand);
    applyPayouts(game, payouts);
    console.log('[' + ts() + '] Board: ' + game.board.map(cardToString).join(' '));
    console.log('[' + ts() + '] ' + Object.entries(payouts).filter(([,v])=>v>0).map(([s,v])=>game.players[s].id+':+'+v).join(' '));
  }

  const v = verifyGame(pd, dd, cd, 52);
  await p2p.write(TABLE, KEYS.SETTLEMENT, {
    verified: v.valid, session, hand: 1,
    results: game.players.map(p => ({ id: p.id, chips: p.chips }))
  });

  console.log('\n' + (v.valid ? 'PASS' : 'FAIL') + ' | Time: ' + ts());
  process.exit(v.valid ? 0 : 1);
}

async function runPlayer() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║  PLAYER (p2p-layer.mjs) — run on LOCAL  ║');
  console.log('╚════════════════════════════════════════╝');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, PLAYER_ID, TABLE);
  const info = await p2p.client.getInfo();
  console.log('Block: ' + info.blocks + '\n');

  // 1. Poll for table config with NEW session
  console.log('Polling for table config...');
  const oldTc = await p2p.read(TABLE, KEYS.TABLE_CONFIG);
  const oldSession = oldTc?.session || null;
  console.log('Current session on chain: ' + (oldSession || 'none'));

  let session = null;
  for (let i = 0; i < 45; i++) {
    const tc = await p2p.read(TABLE, KEYS.TABLE_CONFIG);
    if (tc && tc.session && tc.session !== oldSession) {
      session = tc.session;
      console.log('[' + ts() + '] New session: ' + session + ' Dealer: ' + tc.dealer);
      break;
    }
    if (i % 5 === 0) console.log('[' + ts() + '] waiting for dealer...');
    await WAIT(2000);
  }
  if (!session) { console.log('FAIL: no session after 90s'); process.exit(1); }

  // 2. Write join
  console.log('[' + ts() + '] Writing join...');
  await p2p.write(PLAYER_ID, KEYS.JOIN_REQUEST, {
    table: TABLE, player: PLAYER_ID, session, ready: true, timestamp: Date.now()
  });
  console.log('[' + ts() + '] Join written');

  // 3. Wait for cards
  console.log('\n[' + ts() + '] Waiting for cards...');
  let myCards = null;
  for (let i = 0; i < 60; i++) {
    const cr = await p2p.read(TABLE, KEYS.CARD_BV + '.' + PLAYER_ID);
    if (cr && cr.session === session) { myCards = cr.cards; break; }
    if (i % 10 === 0) console.log('[' + ts() + '] waiting for cards...');
    await WAIT(1500);
  }
  if (!myCards) { console.log('FAIL: no cards after 90s'); process.exit(1); }
  console.log('[' + ts() + '] My cards: ' + myCards.join(' '));

  // 4. Game loop
  let lastBS = null, lastBC = null, lastST = null, actionCount = 0;
  console.log('\n[' + ts() + '] Playing...');
  while (true) {
    // Betting state
    const bs = await p2p.read(TABLE, KEYS.BETTING_STATE);
    if (bs && bs.session === session && JSON.stringify(bs) !== JSON.stringify(lastBS)) {
      lastBS = bs;
      if (bs.turn === PLAYER_ID && bs.validActions) {
        const act = bs.validActions.includes('check') ? 'check' : bs.validActions.includes('call') ? 'call' : 'fold';
        console.log('[' + ts() + '] My turn! pot=' + bs.pot + ' → ' + act);
        await p2p.write(PLAYER_ID, KEYS.PLAYER_ACTION, {
          action: act, amount: 0, session, player: PLAYER_ID, timestamp: Date.now()
        });
        actionCount++;
      } else if (bs.action) {
        console.log('[' + ts() + '] Dealer: ' + bs.action);
      }
    }

    // Board cards
    const bc = await p2p.read(TABLE, KEYS.BOARD_CARDS);
    if (bc && bc.session === session && JSON.stringify(bc) !== JSON.stringify(lastBC)) {
      lastBC = bc;
      console.log('[' + ts() + '] Board (' + bc.phase + '): ' + bc.board.join(' '));
    }

    // Settlement
    const st = await p2p.read(TABLE, KEYS.SETTLEMENT);
    if (st && st.session === session && JSON.stringify(st) !== JSON.stringify(lastST)) {
      lastST = st;
      console.log('[' + ts() + '] Settlement: verified=' + st.verified);
      if (st.results) st.results.forEach(r => console.log('  ' + r.id + ': ' + r.chips));
      console.log('\nDONE | Time: ' + ts() + ' | Actions: ' + actionCount);
      process.exit(0);
    }

    await WAIT(1500);
  }
}

if (ROLE === 'dealer') runDealer().catch(e => { console.error(e); process.exit(1); });
else runPlayer().catch(e => { console.error(e); process.exit(1); });
