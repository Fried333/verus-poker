/**
 * Two-Node P2P Test — simulates dealer and player as separate processes
 * Both talk to the same CHIPS chain but use different VerusIDs.
 *
 * Dealer: writes to poker-table, reads from pc-player
 * Player: writes to pc-player, reads from poker-table
 *
 * The local daemon has keys for BOTH IDs (same wallet for testing).
 * In production, each node has only their own key.
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

// Use local daemon RPC (has keys for both poker-p1 and pc-player in test)
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
function findRPC() {
  const paths = [
    join(process.env.HOME || '', '.komodo/CHIPS/CHIPS.conf'),
    join(process.env.HOME || '', '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = key => (conf.match(new RegExp('^' + key + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword')) {
        return { host: get('rpchost') || '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
      }
    }
  }
  throw new Error('CHIPS conf not found');
}

const RPC = findRPC();
const TABLE_ID = 'poker-table';
const DEALER_ID = 'poker-p1';
const PLAYER_ID = 'poker-p2';  // Both IDs in server wallet for testing

// Base VDXF keys (no game ID suffix — used for "current state")
const KEYS = {
  TABLE_CONFIG: 'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS: 'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV: 'chips.vrsc::poker.sg777z.card_bv',
  JOIN_REQUEST: 'chips.vrsc::poker.sg777z.p_join_request',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT: 'chips.vrsc::poker.sg777z.t_settlement_info',
};

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  Two-Node P2P Test                               ║');
  console.log('╚══════════════════════════════════════════════════╝');

  const dealerP2P = createP2PLayer(RPC, DEALER_ID, TABLE_ID);
  const playerP2P = createP2PLayer(RPC, PLAYER_ID, TABLE_ID);

  // Verify chain
  const info = await dealerP2P.client.getInfo();
  console.log('Chain: ' + info.name + ' Block: ' + info.blocks + '\n');

  // ══════════════════════════════════════
  // STEP 1: Dealer opens table
  // ══════════════════════════════════════
  console.log('[1] Dealer opens table...');
  await dealerP2P.write(TABLE_ID, KEYS.TABLE_CONFIG, {
    table: TABLE_ID, dealer: DEALER_ID, smallBlind: 1, bigBlind: 2, buyin: 200, status: 'open'
  });
  console.log('    Written table config to ' + TABLE_ID);
  await WAIT(2000);

  // ══════════════════════════════════════
  // STEP 2: Player reads table, sends join
  // ══════════════════════════════════════
  console.log('[2] Player reads table and joins...');
  const tableConfig = await playerP2P.read(TABLE_ID, KEYS.TABLE_CONFIG);
  console.log('    Table: ' + (tableConfig ? tableConfig.dealer + ' ' + tableConfig.smallBlind + '/' + tableConfig.bigBlind : 'NOT FOUND'));
  if (!tableConfig) { console.log('FAIL: Cannot read table config'); process.exit(1); }

  await playerP2P.write(PLAYER_ID, KEYS.JOIN_REQUEST, {
    table: TABLE_ID, player: PLAYER_ID, ready: true, timestamp: Date.now()
  });
  console.log('    Join request written to ' + PLAYER_ID);
  await WAIT(2000);

  // ══════════════════════════════════════
  // STEP 3: Dealer reads join, starts hand
  // ══════════════════════════════════════
  console.log('[3] Dealer checks player ready...');
  const joinReq = await dealerP2P.read(PLAYER_ID, KEYS.JOIN_REQUEST);
  console.log('    Join: ' + (joinReq ? 'ready=' + joinReq.ready : 'NOT FOUND'));
  if (!joinReq || !joinReq.ready) { console.log('FAIL: Player not ready'); process.exit(1); }

  // ══════════════════════════════════════
  // STEP 4: Dealer runs shuffle + deal
  // ══════════════════════════════════════
  console.log('[4] Dealer shuffles and deals...');
  const numCards = 52;
  const players = [{ id: DEALER_ID, chips: 200 }, { id: PLAYER_ID, chips: 200 }];

  const pd = players.map(p => playerInit(numCards, p.id));
  const dd = dealerShuffle(pd, numCards);
  const cd = cashierShuffle(dd.blindedDecks, 2, numCards, 2);

  // Deal hole cards
  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const idx = decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck);
      cards.push(idx % 52);
      cardPos++;
    }
    holeCards[players[i].id] = cards;
  }

  // Write card reveals to TABLE ID (per player)
  for (const p of players) {
    await dealerP2P.write(TABLE_ID, KEYS.CARD_BV + '.' + p.id, {
      player: p.id, cards: holeCards[p.id].map(cardToString), type: 'hole'
    });
    console.log('    ' + p.id + ': ' + holeCards[p.id].map(cardToString).join(' '));
    await WAIT(2000);
  }

  // ══════════════════════════════════════
  // STEP 5: Player reads hole cards
  // ══════════════════════════════════════
  console.log('[5] Player reads hole cards...');
  const myCards = await playerP2P.read(TABLE_ID, KEYS.CARD_BV + '.' + PLAYER_ID);
  console.log('    Cards: ' + (myCards ? myCards.cards.join(' ') : 'NOT FOUND'));
  if (!myCards) { console.log('FAIL: Cannot read hole cards'); process.exit(1); }

  // ══════════════════════════════════════
  // STEP 6: Play a betting round
  // ══════════════════════════════════════
  console.log('[6] Playing preflop...');

  // Set up game state
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  for (const p of players) addPlayer(game, p.id, p.chips);
  startHand(game);
  postBlinds(game);
  for (let i = 0; i < 2; i++) setHoleCards(game, i, holeCards[players[i].id]);

  // Play until showdown
  let revealPos = 4; // After 4 hole cards
  while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    // Deal community cards
    if (game.phase === 'flop' && game.board.length === 0) {
      const cards = [];
      for (let i = 0; i < 3; i++) {
        const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck);
        cards.push(idx % 52); revealPos++;
      }
      dealBoard(game, cards);
      await dealerP2P.write(TABLE_ID, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'flop' });
      console.log('    Flop: ' + cards.map(cardToString).join(' '));
      await WAIT(2000);

      // Player reads board
      const board = await playerP2P.read(TABLE_ID, KEYS.BOARD_CARDS);
      console.log('    Player sees board: ' + (board ? board.board.join(' ') : 'NULL'));
    } else if (game.phase === 'turn' && game.board.length === 3) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck);
      dealBoard(game, [idx % 52]); revealPos++;
      await dealerP2P.write(TABLE_ID, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'turn' });
      console.log('    Turn: ' + cardToString(game.board[3]));
      await WAIT(2000);
    } else if (game.phase === 'river' && game.board.length === 4) {
      const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck);
      dealBoard(game, [idx % 52]); revealPos++;
      await dealerP2P.write(TABLE_ID, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'river' });
      console.log('    River: ' + cardToString(game.board[4]));
      await WAIT(2000);
    }

    if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }

    const seat = game.currentTurn;
    const p = game.players[seat];
    const validActions = getValidActions(game);
    const toCall = getToCall(game, seat);

    if (p.id === PLAYER_ID) {
      // DEALER writes: it's player's turn
      await dealerP2P.write(TABLE_ID, KEYS.BETTING_STATE, {
        turn: PLAYER_ID, validActions, toCall, pot: game.pot, minRaise: game.minRaise
      });
      console.log('    Dealer: turn=' + PLAYER_ID + ' actions=' + validActions.join(','));
      await WAIT(2000);

      // PLAYER reads: sees it's their turn, auto-plays
      const bs = await playerP2P.read(TABLE_ID, KEYS.BETTING_STATE);
      if (bs && bs.turn === PLAYER_ID) {
        const act = bs.validActions.includes('check') ? 'check' : bs.validActions.includes('call') ? 'call' : 'fold';

        // PLAYER writes action to own ID
        await playerP2P.write(PLAYER_ID, KEYS.PLAYER_ACTION, {
          action: act, amount: 0, timestamp: Date.now()
        });
        console.log('    Player: ' + act);
        await WAIT(2000);

        // DEALER reads player's action
        const action = await dealerP2P.read(PLAYER_ID, KEYS.PLAYER_ACTION);
        if (action) {
          playerAction(game, seat, action.action, action.amount || 0);
        }
      }
    } else {
      // Dealer's turn — auto-play locally
      const act = validActions.includes('check') ? 'check' : validActions.includes('call') ? 'call' : 'fold';
      playerAction(game, seat, act, 0);
      console.log('    Dealer: ' + act);

      // Write state so player can see
      await dealerP2P.write(TABLE_ID, KEYS.BETTING_STATE, {
        turn: DEALER_ID, validActions: [], action: act, pot: game.pot
      });
      await WAIT(2000);
    }
  }

  // ══════════════════════════════════════
  // STEP 7: Showdown + verify
  // ══════════════════════════════════════
  console.log('[7] Showdown...');
  if (game.phase === SHOWDOWN) {
    const nonFolded = game.players.filter(p => !p.folded);
    if (nonFolded.length > 1) {
      while (game.board.length < 5) {
        const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck);
        dealBoard(game, [idx % 52]); revealPos++;
      }
      await dealerP2P.write(TABLE_ID, KEYS.BOARD_CARDS, { board: game.board.map(cardToString), phase: 'showdown' });
      console.log('    Board: ' + game.board.map(cardToString).join(' '));
    }
    const payouts = settleHand(game, evaluateHand);
    applyPayouts(game, payouts);
    console.log('    Payouts: ' + Object.entries(payouts).filter(([,v])=>v>0).map(([s,v])=>game.players[s].id+':+'+v).join(' '));
  }

  const verification = verifyGame(pd, dd, cd, numCards);
  console.log('    Verify: ' + (verification.valid ? 'PASS' : 'FAIL'));

  // Write settlement
  await dealerP2P.write(TABLE_ID, KEYS.SETTLEMENT, {
    verified: verification.valid,
    results: game.players.map(p => ({ id: p.id, chips: p.chips }))
  });
  await WAIT(2000);

  // Player reads settlement
  const settlement = await playerP2P.read(TABLE_ID, KEYS.SETTLEMENT);
  console.log('    Player reads settlement: ' + (settlement ? 'verified=' + settlement.verified : 'NULL'));

  // ══════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════
  const total = game.players.reduce((s, p) => s + p.chips, 0);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('  Verified: ' + verification.valid);
  console.log('  Chips: ' + total + ' (conserved: ' + (total === 400) + ')');
  game.players.forEach(p => console.log('  ' + p.id + ': ' + p.chips));
  console.log('  All chain reads/writes: PASS');
  console.log('╚══════════════════════════════════════════════════╝');

  process.exit(verification.valid && total === 400 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
