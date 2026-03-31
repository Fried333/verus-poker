/**
 * Poker Server — serves pangea-poker React UI + WebSocket game backend
 * Serves pre-built static files from pangea-poker/dist/
 * Handles WebSocket game protocol
 *
 * node poker-server.mjs
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync } from 'fs';
import { join, extname, resolve } from 'path';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED } from './game.mjs';
import { createChainLayer } from './chain-layer.mjs';

const PORT = 3000;
const USE_CHAIN = process.argv.includes('--chain');
const STATIC_DIR = '/root/pangea-poker/dist';
const MAX_PLAYERS = 9;
const MIN_PLAYERS = 2;      // Start hand when this many are seated
const CONFIG = { smallBlind: 1, bigBlind: 2, rake: 0 };

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
  '.map': 'application/json', '.json': 'application/json'
};

// ════════════════════════════════════════
// Game state
// ════════════════════════════════════════
let clients = new Map();
let engine = null;
let handInProgress = false;
let handCount = 0;
let pendingAction = null;
let startTimer = null;
let seatMap = [];  // engine seat index → client seat index
let serverDealerIdx = 0;  // persists dealer rotation across hands

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) if (ws.readyState === 1) ws.send(data);
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function mapSeat(engineSeat) {
  if (engineSeat < 0 || engineSeat >= seatMap.length) return engineSeat;
  return seatMap[engineSeat];
}

function broadcastState() {
  if (!engine) return;
  const g = engine.game;
  const n = g.players.length;
  const engineSB = n <= 1 ? -1 : (n === 2 ? g.dealerSeat : (g.dealerSeat + 1) % n);
  const engineBB = n <= 1 ? -1 : (n === 2 ? (g.dealerSeat + 1) % n : (g.dealerSeat + 2) % n);

  // Build seats array using client seat indices
  const allSeated = [...clients.values()].filter(c => c.seat !== undefined);
  const seats = [];
  for (const c of allSeated) {
    // Find this client in the engine's player list
    const ep = g.players.find(p => p.id === c.id);
    if (ep) {
      // Only reveal cards at showdown if 2+ players remain (not fold-win)
      const nonFolded = g.players.filter(p => !p.folded).length;
      const showCards = (g.phase === 'showdown' || g.phase === 'settled') && nonFolded > 1;
      seats.push({
        id: ep.id, name: ep.id, seat: c.seat,
        playing: ep.folded ? 0 : 1, empty: false,
        chips: Math.round(ep.chips), bet: ep.bet || 0,
        folded: ep.folded, allIn: ep.allIn,
        holeCards: showCards
          ? ep.holeCards.map(c => typeof c === 'number' ? cardToString(c) : c)
          : (ep.holeCards.length > 0 ? ['??', '??'] : []),
        holeCardNames: showCards
          ? ep.holeCards.map(c => typeof c === 'number' ? cardToString(c) : c)
          : (ep.holeCards.length > 0 ? ['??', '??'] : [])
      });
    } else {
      // Player not in current hand (sitting out or waiting)
      seats.push({
        id: c.id, name: c.id, seat: c.seat,
        playing: 0, empty: false, chips: Math.round(c.chips || 0),
        bet: 0, folded: true, allIn: false,
        holeCards: [], holeCardNames: [],
        sittingOut: c.sittingOut || false
      });
    }
  }
  // Pad empty seats to 9
  const usedSeats = new Set(seats.map(s => s.seat));
  for (let s = 0; s < 9; s++) {
    if (!usedSeats.has(s)) seats.push({ id: '', name: '', seat: s, playing: 0, empty: true, chips: 0 });
  }
  seats.sort((a, b) => a.seat - b.seat);

  const clientDealer = mapSeat(g.dealerSeat);
  const clientSB = engineSB >= 0 ? mapSeat(engineSB) : -1;
  const clientBB = engineBB >= 0 ? mapSeat(engineBB) : -1;
  const clientTurn = g.currentTurn >= 0 ? mapSeat(g.currentTurn) : -1;

  for (const [ws, info] of clients) {
    if (ws.readyState !== 1 || info.seat === undefined) continue;
    // Personalize: only show this client their own hole cards (others get ??)
    const personalSeats = seats.map(s => {
      if (s.empty || s.seat === info.seat) return s;
      if (g.phase === 'showdown' || g.phase === 'settled') return s; // Reveal all at showdown
      return { ...s, holeCards: s.holeCards.length > 0 ? ['??','??'] : [], holeCardNames: s.holeCardNames.length > 0 ? ['??','??'] : [] };
    });
    sendTo(ws, {
      method: 'seats', seats: personalSeats,
      dealerSeat: clientDealer,
      sbSeat: clientSB,
      bbSeat: clientBB,
      phase: g.phase,
      pot: g.pot,
      currentTurn: clientTurn,
      handCount: handCount
    });
  }
}

function createIO() {
  return {
    broadcast(event, data) {
      if (event === 'hand_start') {
        broadcast({ method: 'dealer', playerid: mapSeat(data.dealer) });
        broadcast({ method: 'blindsInfo', small_blind: CONFIG.smallBlind, big_blind: CONFIG.bigBlind });
      }
      if (event === 'blinds_posted') {
        broadcast({
          method: 'betting', action: 'small_blind_bet',
          playerid: mapSeat(data.smallBlind.seat), amount: data.smallBlind.amount
        });
        broadcast({
          method: 'betting', action: 'big_blind_bet',
          playerid: mapSeat(data.bigBlind.seat), amount: data.bigBlind.amount
        });
      }
      if (event === 'community_cards') {
        broadcast({ method: 'deal', deal: { board: (data.board || []).map(c => typeof c === 'number' ? cardToString(c) : c) } });
      }
      if (event === 'turn') {
        const g = engine.game;
        const turnClientSeat = mapSeat(data.seat);
        const turnPlayerId = data.player;
        console.log('[TURN] engine=' + data.seat + ' client=' + turnClientSeat + ' name=' + turnPlayerId);
        broadcast({
          method: 'betting', action: 'round_betting',
          playerid: turnClientSeat, turnPlayer: turnPlayerId, pot: data.pot,
          toCall: data.toCall, minRaiseTo: data.minRaise,
          turnTimeout: 30, turnStart: Date.now(),
          possibilities: data.validActions.map(a => ({ fold: 0, check: 1, call: 2, raise: 3, allin: 7 })[a]).filter(p => p !== undefined),
          player_funds: g.players.map(p => p.chips)
        });
      }
      if (event === 'action') {
        broadcast({
          method: 'betting', action: data.action,
          playerid: mapSeat(data.seat), bet_amount: data.amount || 0,
          timeout: data.timeout || false
        });
      }
      if (event === 'showdown') {
        const g = engine.game;
        // Build hole cards indexed by CLIENT seat
        const allHoleCards = {};
        for (let i = 0; i < g.players.length; i++) {
          const p = g.players[i];
          const clientSeat = mapSeat(i);
          if (!p.folded && p.holeCards.length === 2) {
            allHoleCards[clientSeat] = p.holeCards.map(c => typeof c === 'number' ? cardToString(c) : c);
          } else {
            allHoleCards[clientSeat] = [null, null];
          }
        }
        const board = (data.board || []).map(c => typeof c === 'number' ? cardToString(c) : c);
        const winners = [];
        let winAmount = 0;
        const handNames = {};
        for (const [engineSeat, amt] of Object.entries(data.payouts || {})) {
          if (amt > 0) { winners.push(mapSeat(Number(engineSeat))); winAmount = amt; }
        }
        for (const [engineSeat, info] of Object.entries(data.hands || {})) {
          handNames[mapSeat(Number(engineSeat))] = info.handName || '';
        }
        broadcast({
          method: 'finalInfo', winners, win_amount: winAmount, handNames,
          showInfo: { allHoleCardsInfo: allHoleCards, boardCardInfo: board }
        });
      }
      broadcastState();
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        const cards = data.cards.map(c => typeof c === 'number' ? cardToString(c) : c);
        for (const [ws, info] of clients) {
          if (info.id === playerId) {
            sendTo(ws, { method: 'deal', deal: { holecards: cards, balance: 0 } });
          }
        }
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      broadcastState();
      return new Promise(resolve => {
        pendingAction = { playerId, resolve };
        setTimeout(() => {
          if (pendingAction && pendingAction.playerId === playerId) {
            pendingAction = null;
            resolve(null);
          }
        }, timeout || 60000);
      });
    },
    broadcastState() { broadcastState(); },
    log(msg) { console.log('[GAME] ' + msg); }
  };
}

async function runHand() {
  // Clear any pending start timers
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
  handInProgress = true;
  handCount++;

  // Clear waitingForNext — late joiners now play
  for (const [, info] of clients) {
    if (info.waitingForNext) info.waitingForNext = false;
  }

  const activePlayers = [...clients.values()].filter(c => c.seat !== undefined && (c.chips || 0) > 0 && !c.sittingOut);
  const numPlayers = activePlayers.length;
  const numCards = 52;

  // Protocol shuffle
  const playerData = activePlayers.map(p => playerInit(numCards, p.id));
  const dealerData = dealerShuffle(playerData, numCards);
  const cashierData = cashierShuffle(dealerData.blindedDecks, numPlayers, numCards, Math.ceil(numPlayers / 2) + 1);

  // Engine — build seat mapping (engine index → client seat)
  const io = createIO();
  engine = createEngine(CONFIG, io);
  seatMap = [];
  for (const p of activePlayers) {
    seatMap.push(p.seat);  // engine seat i → client seat p.seat
    engine.addPlayer(p.id, p.chips || 200);
  }
  // Set dealer from server-tracked position (persists across hands)
  engine.game.dealerSeat = serverDealerIdx % numPlayers;

  // Cryptographic card decode: reverse all blinding layers to get card index
  function decodeCardAtPosition(playerIdx, position) {
    const encryptedCard = cashierData.finalDecks[playerIdx][position];
    const b_ij = cashierData.b[playerIdx][position];
    const e_i = dealerData.e[playerIdx];
    const d = dealerData.d;
    const p_i = playerData[playerIdx].sessionKey;
    const initialDeck = playerData[playerIdx].initialDeck;
    return decodeCard(encryptedCard, b_ij, e_i, d, p_i, initialDeck);
  }

  // Deal hole cards using full cryptographic unblinding
  let cardPos = 0;
  for (let i = 0; i < numPlayers; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const idx = decodeCardAtPosition(i, cardPos);
      cards.push(idx % 52);
      cardPos++;
    }
    engine.game.players[i].holeCards = cards;
  }

  let revealPos = numPlayers * 2;
  const crypto = {
    async initDeck(n) { revealPos = numPlayers * 2; return {}; },
    async revealCard() {
      if (revealPos >= numCards) return revealPos % 52;
      // Community cards: use player 0's deck (all players share same community cards)
      const idx = decodeCardAtPosition(0, revealPos);
      revealPos++;
      return idx % 52;
    }
  };

  await engine.playHand(crypto);

  // Post-hand verification — use chain layer if available, else local
  let verification;
  if (chain && chain.isReady()) {
    verification = await chain.verifyHand(handCount, playerData, dealerData, cashierData, numCards);
  } else {
    verification = verifyGame(playerData, dealerData, cashierData, numCards);
    if (verification.valid) console.log('[VERIFY] Hand ' + handCount + ' VERIFIED');
    else console.log('[VERIFY] Hand ' + handCount + ' FAILED: ' + verification.errors.join(', '));
  }
  broadcast({ method: 'verification', hand: handCount, valid: verification.valid, errors: verification.errors || [] });

  // Update client chips + chain balances
  const chipUpdate = {};
  for (const p of engine.game.players) {
    chipUpdate[p.id] = p.chips;
    for (const [, info] of clients) {
      if (info.id === p.id) info.chips = p.chips;
    }
  }
  if (chain && chain.isReady()) chain.updateBalances(chipUpdate);

  // Advance dealer for next hand
  serverDealerIdx++;

  broadcastState();
  handInProgress = false;

  // Notify busted players they need to reload
  for (const [ws, info] of clients) {
    if (info.seat !== undefined && (info.chips || 0) <= 0 && !info.sittingOut) {
      info.sittingOut = true;
      sendTo(ws, { method: 'busted' });
      console.log('[BUSTED] ' + info.id + ' is sitting out');
    }
  }

  // Auto-deal
  setTimeout(() => {
    const active = [...clients.values()].filter(c => c.seat !== undefined && (c.chips || 0) > 0 && !c.sittingOut);
    if (active.length >= 2 && !handInProgress) {
      runHand();
    } else {
      broadcast({ method: 'waiting', active: active.length, needed: 2 });
    }
  }, 5000);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const info = clients.get(ws);
  const method = msg.method || msg.action;

  switch (method) {
    case 'join': {
      // Sanitize name: alphanumeric + dash/underscore only, max 20 chars
      const rawName = String(msg.name || 'Player-' + (clients.size + 1));
      const id = rawName.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 20) || 'Player';
      const seated = [...clients.values()].filter(c => c.seat !== undefined);

      // If same name reconnects, take over the old seat + chips
      const existing = seated.find(c => c.id === id);
      let seat, chips, sittingOut = false;
      if (existing) {
        // Reconnect: close old WS, inherit state
        for (const [oldWs, oldInfo] of clients) {
          if (oldInfo.id === id && oldWs !== ws) {
            clients.delete(oldWs);
            try { oldWs.close(); } catch(e) {}
          }
        }
        seat = existing.seat;
        chips = existing.chips || 0;
        sittingOut = existing.sittingOut || false;
      } else {
        if (seated.length >= MAX_PLAYERS) return;
        const usedSeats = new Set(seated.map(c => c.seat));
        seat = 0;
        while (usedSeats.has(seat)) seat++;
        chips = 200;
      }
      const waitForNext = handInProgress && !existing;
      clients.set(ws, { id, seat, chips, sittingOut, waitingForNext: waitForNext });
      // Pangea protocol: send backend_status, table_info, info
      sendTo(ws, { method: 'backend_status', backend_status: 1 });
      sendTo(ws, {
        method: 'table_info', backend_status: 1, balance: 200, addr: '',
        max_players: MAX_PLAYERS, table_id: 'verus-poker',
        small_blind: CONFIG.smallBlind, big_blind: CONFIG.bigBlind,
        table_min_stake: 50,
        occupied_seats: [...clients.values()].filter(c => c.seat !== undefined).map(c => ({ seat: c.seat, player_id: c.id, stack: c.chips || 200 }))
      });
      sendTo(ws, { method: 'info', playerid: seat, seat_taken: false });
      if (sittingOut && chips <= 0) {
        sendTo(ws, { method: 'busted' });
      } else if (waitForNext) {
        sendTo(ws, { method: 'waiting_next', msg: 'Seated — joining next hand' });
      }
      console.log('[JOIN] ' + id + ' seat ' + seat + (sittingOut ? ' (busted)' : '') + (waitForNext ? ' (next hand)' : '') + ' (' + ([...clients.values()].filter(c=>c.seat!==undefined).length) + '/' + MAX_PLAYERS + ')');
      broadcastState();
      // Start game when enough players are seated — wait longer for more to arrive
      if (seated.length + 1 >= MIN_PLAYERS && !handInProgress && !startTimer) {
        startTimer = setTimeout(() => { startTimer = null; if (!handInProgress) runHand(); }, 8000);
      }
      break;
    }
    case 'betting': {
      if (!pendingAction || !info || pendingAction.playerId !== info.id) return;
      const possMap = { 0: 'fold', 1: 'check', 2: 'call', 3: 'raise', 7: 'allin' };
      if (msg.possibilities && msg.possibilities.length > 0) {
        pendingAction.resolve({ action: possMap[msg.possibilities[0]] || 'fold', amount: msg.bet_amount || msg.amount || 0 });
        pendingAction = null;
      }
      break;
    }
    case 'fold': case 'check': case 'call': case 'raise': case 'allin': {
      if (pendingAction && info && pendingAction.playerId === info.id) {
        pendingAction.resolve({ action: method, amount: msg.amount || 0 });
        pendingAction = null;
      }
      break;
    }
    case 'reload': {
      if (!info || info.seat === undefined) return;
      if ((info.chips || 0) > 0) { sendTo(ws, { method: 'error', error: 'You still have chips' }); return; }
      info.chips = 200;
      info.sittingOut = true;  // Stay sitting out until they click Sit In
      sendTo(ws, { method: 'reloaded', chips: 200 });
      console.log('[RELOAD] ' + info.id + ' reloaded to 200 chips (waiting for sit-in)');
      broadcastState();
      break;
    }
    case 'sitin': {
      if (!info || info.seat === undefined) return;
      if ((info.chips || 0) <= 0) { sendTo(ws, { method: 'error', error: 'Reload first' }); return; }
      info.sittingOut = false;
      sendTo(ws, { method: 'satin' });
      console.log('[SIT IN] ' + info.id + ' is back in');
      broadcastState();
      const active = [...clients.values()].filter(c => c.seat !== undefined && (c.chips || 0) > 0 && !c.sittingOut);
      if (active.length >= 2 && !handInProgress) {
        if (startTimer) clearTimeout(startTimer);
        startTimer = setTimeout(() => { startTimer = null; if (!handInProgress) runHand(); }, 3000);
      }
      break;
    }
  }
}

// ════════════════════════════════════════
// HTTP server — serves pangea static files
// ════════════════════════════════════════
const server = createServer((req, res) => {
  let url = new URL(req.url, 'http://localhost').pathname;

  // Multi-view page — ?players=N (2-9, default 4)
  if (url === '/multi' || url === '/') {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const numPlayers = Math.min(9, Math.max(2, parseInt(params.get('players')) || 4));
    const allNames = ['Alice','Bob','Charlie','Dave','Eve','Frank','Grace','Heidi','Ivan'];
    const names = allNames.slice(0, numPlayers);
    const perPage = 2;
    const cols = 1;
    const rows = perPage;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store', 'Pragma': 'no-cache' });
    res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Verus Poker — ${numPlayers} Players</title>
<link rel="preload" href="/cards.bebfd660.svg" as="image">
<link rel="preload" href="/bg-red.44d92640.svg" as="image">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111}
.hdr{display:flex;align-items:center;justify-content:center;gap:12px;padding:5px;background:#0a0a0a;font-family:system-ui}
.hdr h1{color:#ffd700;font-size:1em}
.hdr a{color:#4caf50;font-size:0.8em;text-decoration:none;padding:2px 8px;border:1px solid #4caf50;border-radius:3px}
.hdr a:hover{background:#4caf50;color:#000}
.g{display:grid;grid-template-columns:1fr 1fr;grid-auto-rows:calc((100vh - 30px) / ${Math.ceil(numPlayers / 2)});gap:2px;padding:2px;height:calc(100vh - 30px);overflow:hidden}
.f{position:relative;border:1px solid #333;border-radius:3px;overflow:hidden}
.f .l{position:absolute;top:2px;left:5px;z-index:10;background:rgba(0,0,0,0.8);color:#4caf50;padding:1px 6px;border-radius:2px;font-size:0.7em;font-weight:bold;font-family:system-ui}
.f iframe{width:100%;height:100%;border:none}
</style></head><body>
<div class="hdr">
  <h1>Verus Poker — ${numPlayers}P</h1>
  <a href="/?players=2">2P</a><a href="/?players=6">6P</a><a href="/?players=9">9P</a>
</div>
<div class="g" id="grid"></div>
<script>
const names=${JSON.stringify(names)};
const grid=document.getElementById('grid');
const delay=names.length>6?800:names.length>3?1200:2000;
names.forEach((n,i)=>{
  setTimeout(()=>{
    const f=document.createElement('div');f.className='f';
    f.innerHTML='<div class="l">'+n+'</div><iframe src="/play?name='+n+'"></iframe>';
    grid.appendChild(f);
  },i*delay);
});
</script></body></html>`);
    return;
  }

  // Player page — serve our vanilla poker client
  if (url === '/play') {
    const noCacheHeaders = { 'Content-Type': 'text/html', 'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' };
    const clientPath = join(import.meta.url.replace('file://', '').replace('/poker-server.mjs', ''), 'public', 'poker.html');
    if (existsSync(clientPath)) {
      res.writeHead(200, noCacheHeaders);
      res.end(readFileSync(clientPath));
    } else {
      // Fallback: try relative to cwd
      const fallback = join(process.cwd(), 'public', 'poker.html');
      if (existsSync(fallback)) {
        res.writeHead(200, noCacheHeaders);
        res.end(readFileSync(fallback));
      } else {
        res.writeHead(404);
        res.end('poker.html not found');
      }
    }
    return;
  }

  // Static files — check pangea dist first, then local public/
  // Path traversal protection: resolve and verify path stays within allowed dirs
  const pangeaBase = resolve(STATIC_DIR);
  const localBase = resolve(process.cwd(), 'public');
  const pangeaPath = resolve(STATIC_DIR, '.' + url);
  const localPath = resolve(process.cwd(), 'public', '.' + url);

  let filePath = null;
  if (pangeaPath.startsWith(pangeaBase + '/') && existsSync(pangeaPath)) filePath = pangeaPath;
  else if (localPath.startsWith(localBase + '/') && existsSync(localPath)) filePath = localPath;

  if (filePath) {
    const ext = extname(filePath);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (['.svg','.png','.jpg','.ttf','.woff2','.mp3'].includes(ext)) {
      headers['Cache-Control'] = 'public, max-age=3600';
    }
    res.writeHead(200, headers);
    res.end(readFileSync(filePath));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server });
const rateLimits = new Map(); // ws → { count, resetTime }

wss.on('connection', (ws, req) => {
  // Origin validation (allow same-origin and common dev origins)
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  if (origin && !origin.includes(host.split(':')[0]) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
    console.log('[SEC] Rejected origin: ' + origin);
    ws.close(1008, 'Forbidden origin');
    return;
  }

  clients.set(ws, {});
  ws.on('message', d => {
    // Rate limiting: max 30 messages per second
    const now = Date.now();
    let rl = rateLimits.get(ws);
    if (!rl || now > rl.resetTime) { rl = { count: 0, resetTime: now + 1000 }; rateLimits.set(ws, rl); }
    rl.count++;
    if (rl.count > 30) { ws.close(4029, 'Rate limit exceeded'); return; }

    // Message size limit (16KB)
    const msg = d.toString();
    if (msg.length > 16384) return;

    handleMessage(ws, msg);
  });
  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);
    rateLimits.delete(ws);
    const seated = [...clients.values()].filter(c => c.seat !== undefined);
    if (seated.length === 0) {
      engine = null; handInProgress = false; pendingAction = null;
      if (startTimer) { clearTimeout(startTimer); startTimer = null; }
      serverDealerIdx = 0;
      console.log('[RESET] All players left — game reset');
    }
    if (pendingAction && info && pendingAction.playerId === info.id) {
      pendingAction.resolve({ action: 'fold' });
      pendingAction = null;
    }
    // If hand in progress but not enough active players left, abort
    if (handInProgress && seated.filter(c => (c.chips||0) > 0 && !c.sittingOut).length < 2) {
      if (pendingAction) { pendingAction.resolve(null); pendingAction = null; }
    }
  });
});

// Initialize chain layer if --chain flag is set
const chain = USE_CHAIN ? createChainLayer() : null;
if (chain) {
  chain.init().then(ok => {
    if (ok) console.log('[CHAIN] On-chain mode enabled — deposits and settlement via CHIPS blockchain');
    else console.log('[CHAIN] Failed to init — running in virtual mode');
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Verus Poker at http://localhost:' + PORT);
  console.log('Mode: ' + (USE_CHAIN ? 'ON-CHAIN (--chain)' : 'VIRTUAL (add --chain for real CHIPS)'));
});
