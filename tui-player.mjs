#!/usr/bin/env node
/**
 * TUI Poker Player — terminal-based poker client
 * Connects directly to the CHIPS blockchain via local daemon.
 * No WebSocket, no browser, no HTTP. Pure chain communication.
 *
 * Usage: node tui-player.mjs --id=pc-player --table=poker-table
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { VDXF_KEYS } from './verus-rpc.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import readline from 'readline';

// ══════════════════════════════════════
// Config
// ══════════════════════════════════════
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const MY_ID = args.id || 'pc-player';
const TABLE_ID = args.table || 'poker-table';
const WAIT = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════
// RPC Config (auto-detect from CHIPS daemon)
// ══════════════════════════════════════
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

// ══════════════════════════════════════
// VDXF Keys
// ══════════════════════════════════════
const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

// ══════════════════════════════════════
// Game State (single object)
// ══════════════════════════════════════
const state = {
  phase: 'connecting',
  session: null,
  handId: null,
  handCount: 0,
  myCards: [],
  board: [],
  pot: 0,
  players: [],
  turn: null,
  validActions: [],
  toCall: 0,
  minRaise: 2,
  winner: null,
  verified: null,
  message: 'Connecting...',
};

// ══════════════════════════════════════
// Debug Log + Timing
// ══════════════════════════════════════
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }
const debugLog = []; // Last N log entries
const MAX_LOG = 8;
function dlog(msg) {
  debugLog.push('[' + ts() + '] ' + msg);
  if (debugLog.length > MAX_LOG) debugLog.shift();
}
// Timed read wrapper
async function timedRead(p2p, id, key, label) {
  const t = Date.now();
  const result = await p2p.read(id, key);
  const ms = Date.now() - t;
  if (ms > 50) dlog(label + ': ' + ms + 'ms');
  return result;
}

// ══════════════════════════════════════
// Terminal Rendering (ANSI, no npm)
// ══════════════════════════════════════
const CLEAR = '\x1b[2J\x1b[H';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const RESET = '\x1b[0m';

function cardColor(card) {
  if (!card || card === '??' || card.length < 2) return DIM + '[' + (card || '??') + ']' + RESET;
  const suit = card[card.length - 1];
  const color = (suit === 'h' || suit === 'd') ? RED : WHITE;
  return color + '[' + card + ']' + RESET;
}

function render() {
  const W = 50;
  const line = '═'.repeat(W - 2);
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const center = (s, n) => {
    const l = Math.max(0, n - s.length);
    return ' '.repeat(Math.floor(l / 2)) + s + ' '.repeat(Math.ceil(l / 2));
  };

  let out = CLEAR;
  // Header
  const handStr = state.handCount > 0 ? 'Hand #' + state.handCount : 'Waiting';
  out += CYAN + '╔' + line + '╗\n';
  out += '║' + BOLD + center('CHIPS POKER — ' + handStr + '  •  pot: ' + state.pot, W - 2) + RESET + CYAN + '║\n';
  out += '╠' + line + '╣\n' + RESET;

  // Players
  for (const p of state.players) {
    const isMe = p.id === MY_ID;
    const name = pad(p.id || '?', 14);
    const chips = pad(p.chips + ' chips', 12);
    const bet = p.bet > 0 ? YELLOW + ' bet:' + p.bet + RESET : '';
    const folded = p.folded ? DIM + ' FOLD' + RESET : '';
    let cards = '';
    if (isMe && state.myCards.length > 0) {
      cards = state.myCards.map(cardColor).join(' ');
    } else if (!isMe && state.myCards.length > 0) {
      // Show showdown cards if available
      if (state.winner && state.winner.showdownCards && state.winner.showdownCards[p.seat]) {
        cards = state.winner.showdownCards[p.seat].filter(Boolean).map(cardColor).join(' ');
      } else {
        cards = cardColor('??') + ' ' + cardColor('??');
      }
    }
    const turnMarker = state.turn === p.id ? YELLOW + ' ◄' + RESET : '';
    out += CYAN + '║ ' + RESET + (isMe ? GREEN : WHITE) + BOLD + name + RESET + ' ' + chips + cards + bet + folded + turnMarker + '\n';
  }

  // Board
  if (state.board.length > 0) {
    out += CYAN + '║' + RESET + '\n';
    out += CYAN + '║' + RESET + center('Board: ' + state.board.map(cardColor).join(' '), W + 20) + '\n';
  }
  out += CYAN + '║' + RESET + '\n';

  // Status / Actions
  out += CYAN + '╠' + line + '╣\n' + RESET;

  if (state.winner) {
    const w = state.winner;
    out += CYAN + '║ ' + GREEN + BOLD + '★ ' + w.name + ' WINS ' + w.amount + RESET;
    if (w.handName) out += YELLOW + ' — ' + w.handName + RESET;
    out += '\n';
  } else if (state.turn === MY_ID && state.validActions.length > 0) {
    out += CYAN + '║ ' + YELLOW + BOLD + 'YOUR TURN' + RESET + ' — to call: ' + state.toCall + '  min raise: ' + state.minRaise + '\n';
    const acts = [];
    if (state.validActions.includes('fold')) acts.push('[F]old');
    if (state.validActions.includes('check')) acts.push('[C]heck');
    if (state.validActions.includes('call')) acts.push('[C]all ' + state.toCall);
    if (state.validActions.includes('raise')) acts.push('[R]aise <amount>');
    if (state.validActions.includes('allin')) acts.push('[A]ll-in');
    out += CYAN + '║ ' + RESET + acts.join('  ') + '\n';
  } else if (state.message) {
    out += CYAN + '║ ' + DIM + state.message + RESET + '\n';
  } else if (state.turn) {
    out += CYAN + '║ ' + DIM + 'Waiting for ' + state.turn + '...' + RESET + '\n';
  } else {
    out += CYAN + '║ ' + DIM + state.phase + RESET + '\n';
  }

  if (state.verified !== null) {
    out += CYAN + '║ ' + (state.verified ? GREEN + '✓ Verified' : RED + '✗ FAILED') + RESET + '\n';
  }

  out += CYAN + '╠' + line + '╣' + RESET + '\n';
  // Debug log
  for (const entry of debugLog) {
    out += CYAN + '║ ' + DIM + entry + RESET + '\n';
  }
  out += CYAN + '╚' + line + '╝' + RESET + '\n';
  process.stdout.write(out);
}

// ══════════════════════════════════════
// Input Handling
// ══════════════════════════════════════
let actionResolver = null;
let missedTurns = 0;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function promptAction() {
  return new Promise(resolve => {
    actionResolver = resolve;
    const prompt = state.toCall === 0 ? 'Action [f/c/r/a]: ' : 'Action [f/c/r <amt>/a]: ';
    rl.question(prompt, answer => {
      actionResolver = null;
      const a = answer.trim().toLowerCase();
      if (a === 'f' || a === 'fold') resolve({ action: 'fold', amount: 0 });
      else if (a === 'c' || a === 'check' || a === 'call') resolve({ action: state.toCall === 0 ? 'check' : 'call', amount: state.toCall });
      else if (a.startsWith('r')) {
        const amt = parseInt(a.split(/\s+/)[1]) || state.minRaise;
        resolve({ action: 'raise', amount: Math.max(amt, state.minRaise) });
      }
      else if (a === 'a' || a === 'allin') resolve({ action: 'allin', amount: 0 });
      else resolve({ action: state.toCall === 0 ? 'check' : 'fold', amount: 0 }); // default
    });
    // Timeout: 30s
    setTimeout(() => {
      if (actionResolver) {
        actionResolver = null;
        missedTurns++;
        const defaultAct = state.validActions.includes('check') ? 'check' : 'fold';
        console.log(DIM + '  (timed out — ' + defaultAct + ')' + RESET);
        resolve({ action: defaultAct, amount: 0 });
      }
    }, 30000);
  });
}

// ══════════════════════════════════════
// Main
// ══════════════════════════════════════
async function main() {
  console.log(CYAN + BOLD + 'CHIPS Poker TUI' + RESET);
  console.log('Connecting to local CHIPS daemon...');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, MY_ID, TABLE_ID);
  const info = await p2p.client.getInfo();
  console.log('Block: ' + info.blocks + ' ✓');
  console.log('Identity: ' + MY_ID);
  console.log('Table: ' + TABLE_ID);

  // Find table session
  console.log('\nWaiting for dealer to open table...');
  let oldSession = null;
  try {
    const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
    if (tc && tc.session) oldSession = tc.session;
  } catch {}

  // Check if old session is settled (stale)
  const staleSession = new Set();
  try {
    const st = await p2p.read(TABLE_ID, KEYS.SETTLEMENT);
    if (st && st.session) staleSession.add(st.session);
  } catch {}

  let session = null;
  for (let i = 0; i < 180; i++) {
    const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
    if (tc && tc.session) {
      if (!staleSession.has(tc.session)) {
        session = tc.session;
        state.session = session;
        console.log('Session: ' + session + ' — Dealer: ' + (tc.dealer || '?'));
        break;
      }
    }
    if (i % 10 === 0) process.stdout.write('.');
    await WAIT(1000);
  }
  if (!session) { console.log('\nNo table session found after 3 min'); process.exit(1); }

  // Write join
  console.log('Writing join...');
  await p2p.write(MY_ID, KEYS.JOIN_REQUEST, {
    table: TABLE_ID, player: MY_ID, session, ready: true, timestamp: Date.now()
  });
  console.log('Join written ✓\n');

  // ── POLL LOOP ──
  let lastBSJson = null;
  let lastSettledHandId = null;
  let acted = false;

  state.phase = 'waiting';
  state.message = 'Waiting for dealer to deal...';
  render();

  while (true) {
    try {
      // 1. Check for new handId
      const tc = await timedRead(p2p, TABLE_ID, KEYS.TABLE_CONFIG, 'table_info');
      if (tc && tc.currentHandId && tc.currentHandId !== state.handId && tc.currentHandId !== lastSettledHandId) {
        dlog('New hand detected: ' + tc.currentHandId);
        state.handId = tc.currentHandId;
        state.handCount = tc.handCount || (state.handCount + 1);
        state.phase = 'shuffling';
        state.myCards = []; state.board = []; state.pot = 0;
        state.turn = null; state.validActions = [];
        state.winner = null; state.verified = null;
        state.message = 'Shuffling hand #' + state.handCount + '...';
        // Set players from table config if available
        if (tc.dealer && state.players.length === 0) {
          state.players = [
            { id: MY_ID, seat: 0, chips: 200, bet: 0, folded: false },
            { id: tc.dealer, seat: 1, chips: 200, bet: 0, folded: false }
          ];
        }
        lastBSJson = null; acted = false; missedTurns = 0;
        render();
      }

      if (!state.handId) { await WAIT(1000); continue; }

      // 2. Check for my cards
      if (state.myCards.length === 0) {
        const cardKey = KEYS.CARD_BV + '.' + state.handId + '.' + MY_ID;
        const cr = await timedRead(p2p, TABLE_ID, cardKey, 'card_bv');
        if (cr && cr.cards) {
          dlog('Cards received: ' + cr.cards.join(' '));
          state.myCards = cr.cards;
          state.phase = 'preflop';
          state.message = '';
          render();
        }
      }

      // 3. Check betting state
      const bsT = Date.now();
      const bs = await p2p.readBettingState(state.handId);
      const bsMs = Date.now() - bsT;
      const bsJson = bs ? JSON.stringify(bs) : null;
      if (bsJson && bsJson !== lastBSJson) {
        lastBSJson = bsJson;
        state.pot = bs.pot || state.pot;
        if (bs.phase) state.phase = bs.phase;
        // Update player chips/bets
        if (bs.players) {
          for (const bp of bs.players) {
            let gp = state.players.find(x => x.id === bp.id);
            if (!gp) { state.players.push({ id: bp.id, seat: state.players.length, chips: bp.chips, bet: 0, folded: false }); gp = state.players[state.players.length - 1]; }
            gp.chips = bp.chips; gp.bet = bp.bet || 0; gp.folded = !!bp.folded;
          }
        }
        if (bsMs > 50) dlog('betting_state read: ' + bsMs + 'ms');
        // My turn?
        if (bs.turn === MY_ID && bs.validActions && !acted) {
          dlog('My turn! pot=' + bs.pot + ' toCall=' + (bs.toCall||0) + ' phase=' + (bs.phase||''));
          state.turn = MY_ID;
          state.validActions = bs.validActions;
          state.toCall = bs.toCall || 0;
          state.minRaise = bs.minRaise || 2;
          state.message = '';
          render();

          // Check inactivity
          if (missedTurns >= 2) {
            console.log(RED + '  Auto-fold (inactive for 2 turns)' + RESET);
            await p2p.write(MY_ID, KEYS.PLAYER_ACTION, {
              action: 'fold', amount: 0, session: state.session, player: MY_ID, timestamp: Date.now()
            });
            acted = true;
            state.turn = null; state.validActions = [];
            state.message = 'Sitting out (inactive)';
            render();
          } else {
            // Prompt for action
            const action = await promptAction();
            const writeT = Date.now();
            await p2p.write(MY_ID, KEYS.PLAYER_ACTION, {
              action: action.action, amount: action.amount, session: state.session, player: MY_ID, timestamp: Date.now()
            });
            dlog('Action ' + action.action + ' written in ' + (Date.now() - writeT) + 'ms');
            acted = true; missedTurns = 0;
            state.turn = null; state.validActions = [];
            state.message = 'Action sent: ' + action.action + (action.amount ? ' ' + action.amount : '');
            render();
          }
        } else {
          if (bs.turn !== MY_ID) acted = false;
          state.turn = bs.turn || null;
          state.validActions = [];
          state.message = bs.turn ? 'Waiting for ' + bs.turn + '...' : '';
          render();
        }
      }

      // 4. Check board
      const bc = await p2p.readBoardCards(state.handId);
      if (bc && bc.board && bc.board.length > state.board.length) {
        dlog('Board (' + (bc.phase||'') + '): ' + bc.board.join(' '));
        state.board = bc.board;
        if (bc.phase) state.phase = bc.phase;
        render();
      }

      // 5. Check settlement
      const stKey = KEYS.SETTLEMENT + '.' + state.handId;
      const st = await timedRead(p2p, TABLE_ID, stKey, 'settlement');
      if (st && st.verified !== undefined && state.verified === null) {
        dlog('Settlement received — verified=' + st.verified);
        state.verified = st.verified;
        state.phase = 'showdown';
        if (st.board) state.board = st.board;
        // Update chips
        if (st.results) {
          for (const r of st.results) {
            const gp = state.players.find(x => x.id === r.id);
            if (gp) gp.chips = r.chips;
          }
        }
        // Winner
        if (st.winners && st.winners.length > 0) {
          const winSeat = st.winners[0];
          const winPlayer = state.players[winSeat];
          const handNames = st.handNames || {};
          state.winner = {
            name: winPlayer ? winPlayer.id : 'Seat ' + winSeat,
            amount: st.winAmount || 0,
            handName: handNames[winSeat] || '',
            showdownCards: st.allHoleCards || {}
          };
        }
        render();

        // Show result for 4 seconds, then reset
        await WAIT(4000);
        state.phase = 'waiting';
        state.myCards = []; state.board = [];
        state.winner = null; state.verified = null;
        state.turn = null; state.validActions = [];
        state.players.forEach(p => { p.bet = 0; p.folded = false; });
        state.message = 'Waiting for next hand...';
        lastSettledHandId = state.handId;
        state.handId = null;
        lastBSJson = null;
        render();
      }
    } catch (e) {
      state.message = 'Error: ' + e.message;
      render();
    }
    await WAIT(1000);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
