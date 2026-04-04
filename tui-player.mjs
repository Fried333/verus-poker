#!/usr/bin/env node
/**
 * TUI Poker Player — terminal-based poker client
 * Uses player-backend.mjs for all chain communication.
 * This file is ONLY rendering + input handling.
 *
 * Usage: node tui-player.mjs --id=pc-player --table=poker-table
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
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
const MY_ID = args.id || 'pdealer2';
const TABLE_ID = args.table || 'ptable2';

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

const debugLog = [];
const MAX_DEBUG = 8;

function cardColor(card) {
  if (!card || card === '??' || card.length < 2) return DIM + '[' + (card || '??') + ']' + RESET;
  const suit = card[card.length - 1];
  const color = (suit === 'h' || suit === 'd') ? RED : WHITE;
  return color + '[' + card + ']' + RESET;
}

function render(state) {
  const W = 50;
  const line = '═'.repeat(W - 2);
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
  const center = (s, n) => {
    const l = Math.max(0, n - s.length);
    return ' '.repeat(Math.floor(l / 2)) + s + ' '.repeat(Math.ceil(l / 2));
  };

  let out = CLEAR;
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
      if (state.winner && state.showdownCards && state.showdownCards[p.seat]) {
        cards = state.showdownCards[p.seat].filter(Boolean).map(cardColor).join(' ');
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

  // Action log (last few entries)
  if (state.actionLog.length > 0) {
    out += CYAN + '╠' + line + '╣' + RESET + '\n';
    const recent = state.actionLog.slice(-5);
    for (const entry of recent) {
      out += CYAN + '║ ' + DIM + entry + RESET + '\n';
    }
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
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function promptAction(state) {
  return new Promise(resolve => {
    const prompt = state.toCall === 0 ? 'Action [f/c/r/a]: ' : 'Action [f/c/r <amt>/a]: ';
    const timer = setTimeout(() => {
      const defaultAct = state.validActions.includes('check') ? 'check' : 'fold';
      console.log(DIM + '  (timed out — ' + defaultAct + ')' + RESET);
      resolve({ action: defaultAct, amount: 0 });
    }, 120000);

    rl.question(prompt, answer => {
      clearTimeout(timer);
      const a = answer.trim().toLowerCase();
      if (a === 'f' || a === 'fold') resolve({ action: 'fold', amount: 0 });
      else if (a === 'c' || a === 'check' || a === 'call') resolve({ action: state.toCall === 0 ? 'check' : 'call', amount: state.toCall });
      else if (a.startsWith('r')) {
        const amt = parseInt(a.split(/\s+/)[1]) || state.minRaise;
        resolve({ action: 'raise', amount: Math.max(amt, state.minRaise) });
      }
      else if (a === 'a' || a === 'allin') resolve({ action: 'allin', amount: 0 });
      else resolve({ action: state.toCall === 0 ? 'check' : 'fold', amount: 0 });
    });
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
  const backend = createPlayerBackend(p2p, MY_ID, TABLE_ID);

  backend.onStateChange(s => render(s));

  backend.onLog(entry => {
    debugLog.push(entry);
    if (debugLog.length > MAX_DEBUG) debugLog.shift();
  });

  backend.onNeedAction(async (state, respond) => {
    render(state);
    const action = await promptAction(state);
    respond(action);
  });

  await backend.start();
}

main().catch(e => { console.error(e); process.exit(1); });
