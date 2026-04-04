#!/usr/bin/env node
/**
 * GUI Server — serves poker GUI + WebSocket bridge to player-backend.mjs
 * Thin layer: backend handles all chain communication, this just relays state to browser.
 *
 * Usage: node gui-server.mjs --id=pc-player --table=ptable2 --port=3000
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createP2PLayer } from './p2p-layer.mjs';
import { createPlayerBackend } from './player-backend.mjs';
import { readFileSync, existsSync, createReadStream, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Prevent crashes
process.on('uncaughtException', (err) => { console.error('[CRASH PREVENTED]', err.message); });
process.on('unhandledRejection', (err) => { console.error('[UNHANDLED]', err?.message || err); });

// ══════════════════════════════════════
// Config
// ══════════════════════════════════════
const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const PORT = parseInt(args.port || '3000');
const MY_ID = args.id || 'pc-player';
const TABLE_ID = args.table || 'ptable2';

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json'
};

// ══════════════════════════════════════
// RPC Config
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
// Backend
// ══════════════════════════════════════
const rpc = findRPC();
const p2p = createP2PLayer(rpc, MY_ID, TABLE_ID);
const backend = createPlayerBackend(p2p, MY_ID, TABLE_ID);

// ══════════════════════════════════════
// HTTP Server — serve static files from public/
// ══════════════════════════════════════
const server = createServer((req, res) => {
  let url = new URL(req.url, 'http://localhost').pathname;

  // API: full game state (for polling fallback)
  if (url === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(buildClientState()));
    return;
  }

  // API: table info
  if (url === '/api/table') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ table: TABLE_ID, player: MY_ID, role: 'player', mode: 'p2p' }));
    return;
  }

  // Serve GUI
  if (url === '/' || url === '/play' || url === '/poker.html') {
    url = '/poker-gui.html';
  }

  const filePath = join(__dirname, 'public', url);
  const ext = extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';

  try {
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      res.writeHead(200, { 'Content-Type': mime });
      createReadStream(filePath).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch {
    res.writeHead(500);
    res.end('Error');
  }
});

// ══════════════════════════════════════
// WebSocket — relay state to browsers
// ══════════════════════════════════════
const wss = new WebSocketServer({ server });
const clients = new Set();

function buildClientState() {
  const s = backend.state;
  const meFolded = s.players.find(p => p.id === MY_ID)?.folded || false;
  const handActive = s.handId !== null && s.myCards.length > 0;
  const isShowdown = s.phase === 'showdown' || s.phase === 'settled';

  const players = s.players.map(p => {
    let cards = null;
    if (handActive || isShowdown) {
      if (p.id === MY_ID && !meFolded) cards = s.myCards;
      else if (isShowdown && s.showdownCards[p.seat]) cards = s.showdownCards[p.seat];
      else if (!p.folded && handActive) cards = ['??', '??'];
    }
    return { id: p.id, seat: p.seat, chips: p.chips, bet: p.bet || 0, folded: !!p.folded, cards };
  });

  let winner = null;
  if (s.winner) {
    winner = {
      seats: s.winner.seats,
      name: s.winner.name,
      amount: s.winner.amount,
      handName: s.winner.handName,
      handNames: s.handNames || {},
      showdownCards: s.showdownCards || {}
    };
  }

  let actions = null;
  if (s.turn === MY_ID && s.validActions.length > 0 && !meFolded) {
    actions = { validActions: s.validActions, toCall: s.toCall, minRaise: s.minRaise };
  }

  return {
    table: TABLE_ID,
    myId: MY_ID,
    mode: 'p2p',
    smallBlind: 1,
    bigBlind: 2,
    phase: s.phase,
    pot: s.pot,
    handCount: s.handCount,
    board: s.board || [],
    myCards: handActive && !meFolded ? s.myCards : [],
    players,
    actions,
    winner,
    verified: s.verified,
    message: s.message || '',
    actionLog: s.actionLog || [],
    myId: MY_ID
  };
}

function broadcastState() {
  const data = JSON.stringify({ method: 'state', ...buildClientState() });
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

wss.on('connection', ws => {
  clients.add(ws);
  console.log('[GUI] Browser connected (' + clients.size + ' total)');

  // Send current state immediately
  ws.send(JSON.stringify({ method: 'state', ...buildClientState() }));

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.action === 'fold' || msg.action === 'check' || msg.action === 'call' || msg.action === 'raise' || msg.action === 'allin') {
        backend.submitAction({ action: msg.action, amount: msg.amount || 0 });
      }
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log('[GUI] Browser disconnected (' + clients.size + ' total)');
  });
});

// ══════════════════════════════════════
// Wire backend → browser
// ══════════════════════════════════════
backend.onStateChange(() => broadcastState());

backend.onNeedAction(() => {
  // Don't auto-respond — browser will send action via WebSocket
  // Just push state with action buttons
  broadcastState();
});

// ══════════════════════════════════════
// Start
// ══════════════════════════════════════
server.listen(PORT, '0.0.0.0', async () => {
  console.log('GUI Server at http://localhost:' + PORT);
  console.log('Player: ' + MY_ID + ' | Table: ' + TABLE_ID);
  backend.start().catch(e => console.error('[BACKEND]', e.message));
});
