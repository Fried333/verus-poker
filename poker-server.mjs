/**
 * Poker Server — serves pangea-poker React UI + WebSocket game backend
 * Serves pre-built static files from pangea-poker/dist/
 * Handles WebSocket game protocol
 *
 * node poker-server.mjs
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { readFileSync, existsSync, createReadStream, statSync } from 'fs';
import { join, extname, resolve } from 'path';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED } from './game.mjs';
import { createChainLayer } from './chain-layer.mjs';
import { createP2PLayer } from './p2p-layer.mjs';
import { createP2PDealer } from './p2p-dealer.mjs';
import { createClient } from './verus-rpc.mjs';

const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1] || '3000');
const USE_CHAIN = process.argv.includes('--chain');
const USE_LOCAL = process.argv.includes('--local');
const LOCAL_ROLE = process.argv.find(a => a.startsWith('--role='))?.split('=')[1] || 'dealer';
const LOCAL_ID = process.argv.find(a => a.startsWith('--id='))?.split('=')[1] || 'poker-p1';
const TABLE_ID = process.argv.find(a => a.startsWith('--table='))?.split('=')[1] || 'poker-table';
let LOCAL_PLAYERS = (process.argv.find(a => a.startsWith('--players='))?.split('=')[1] || '').split(',').filter(Boolean);
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
        const playerNames = {};
        g.players.forEach((p, i) => { playerNames[mapSeat(i)] = p.id; });
        broadcast({
          method: 'finalInfo', winners, win_amount: winAmount, handNames, playerNames,
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
            sendTo(ws, { method: 'deal', deal: { holecards: cards, board: [], balance: 0 } });
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

  // Crypto backend — engine calls revealCard(position) for both hole cards and community
  // All cards decoded from deck 0 (single shuffled deck, no cross-deck duplicates)
  const crypto = {
    async initDeck(n) { return {}; },
    async revealCard(pos) {
      if (pos >= numCards) return pos % 52;
      return decodeCardAtPosition(0, pos);
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
  broadcastState(); // Send updated chips to browsers

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
      sendTo(ws, { method: 'info', playerid: seat, id, seat_taken: false });
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

  // In local P2P mode, redirect to /play with the correct player name
  if (USE_LOCAL && (url === '/' || url === '/multi')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (!params.has('name')) {
      res.writeHead(302, { 'Location': '/play?name=' + LOCAL_ID });
      res.end();
      return;
    }
    url = '/play';
  }

  // API: table info for lobby screen
  if (url === '/api/table') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });

    res.end(JSON.stringify({
      table: TABLE_ID,
      player: LOCAL_ID,
      role: LOCAL_ROLE,
      config: CONFIG,
      buyin: 0.5,
      dealer: USE_LOCAL ? (LOCAL_ROLE === 'dealer' ? LOCAL_ID : (LOCAL_PLAYERS[0] || 'unknown')) : 'server',
      cashiers: ['poker-cn1', 'poker-cn2'],
      multisig: 'bGWPJETwDveHzZxrtLepJHwD2hMg1qtaB8',
      mode: USE_LOCAL ? 'p2p' : (USE_CHAIN ? 'chain' : 'virtual'),
      session: p2pDealer ? p2pDealer.getGameId() : null
    }));
    return;
  }

  // API: deposit to multisig
  if (url === '/api/deposit') {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { amount } = JSON.parse(body);
        if (!RPC_CONFIG) throw new Error('No RPC config — CHIPS daemon not found');
        const c = createClient(RPC_CONFIG);

        // Get player address
        const id = await c.getIdentity(LOCAL_ID + '.CHIPS@');
        const addr = id.identity.primaryaddresses[0];

        // Send to multisig
        const multisig = 'bGWPJETwDveHzZxrtLepJHwD2hMg1qtaB8';
        console.log('[DEPOSIT] ' + LOCAL_ID + ' sending ' + amount + ' CHIPS to multisig...');
        const opid = await c.sendCurrency(addr, [{ address: multisig, amount }]);
        const result = await c.waitForOperation(opid, 60000);
        console.log('[DEPOSIT] TX: ' + result.txid);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, txid: result.txid }));
      } catch (e) {
        console.log('[DEPOSIT] Error: ' + e.message);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // Multi-view page — ?players=N (2-9, default 4)
  if (url === '/multi' || (url === '/' && !USE_LOCAL)) {
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

  // Bootstrap file — stream instead of readFileSync (too large for memory)
  if (url === '/chips-bootstrap.tar.gz') {
    const bsPath = '/root/chips-bootstrap.tar.gz';
    if (existsSync(bsPath)) {
      const stat = statSync(bsPath);
      res.writeHead(200, {
        'Content-Type': 'application/gzip',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="chips-bootstrap.tar.gz"'
      });
      createReadStream(bsPath).pipe(res);
      return;
    }
    res.writeHead(404); res.end('Bootstrap not found'); return;
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
    if (seated.length === 0 && !USE_LOCAL) {
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
const chain = (USE_CHAIN && !USE_LOCAL) ? createChainLayer() : null;
if (chain) {
  chain.init().then(ok => {
    if (ok) console.log('[CHAIN] On-chain mode enabled — deposits and settlement via CHIPS blockchain');
    else console.log('[CHAIN] Failed to init — running in virtual mode');
  });
}

// ════════════════════════════════════════
// LOCAL P2P MODE (--local)
// All game state via VerusID contentmultimap
// ════════════════════════════════════════
// Auto-detect CHIPS RPC config from local conf file
function findRPCConfig() {
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
  return null;
}
const RPC_CONFIG = findRPCConfig();

let p2pDealer = null;
let p2pActionResolver = null; // Resolves when browser player acts
let joinSession = null;       // Session from player join flow
let dealerSeated = false;     // Dealer browser clicked "Sit Here"
const chipTracker = {};       // Persistent chip counts across hands
let pushState = null;         // Set by player startup, used by reconnect handler
let acted = false;            // Player acted this turn (prevents double-action)

if (USE_LOCAL) {
  if (!RPC_CONFIG) { console.error('ERROR: CHIPS daemon config not found'); process.exit(1); }
  const p2p = createP2PLayer(RPC_CONFIG, LOCAL_ID, TABLE_ID);

  const KEYS = {
    TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
    BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
    BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
    CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
    JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
    PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
    SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
  };

  let playerActed = false; // Shared flag — set when player submits action

  // ── Shared: send seats state to browser ──
  function p2pSendSeats(playerList, opts) {
    const seats = playerList.map(p => ({
      id: p.id, name: p.id, seat: p.seat,
      playing: p.folded ? 0 : 1, empty: false,
      chips: Math.round(p.chips || 0), bet: p.bet || 0,
      folded: !!p.folded, allIn: !!p.allIn,
      holeCards: p.holeCards || (p.id === LOCAL_ID ? [] : ['??', '??']),
      holeCardNames: p.holeCards || (p.id === LOCAL_ID ? [] : ['??', '??'])
    }));
    const usedSeats = new Set(seats.map(s => s.seat));
    for (let s = seats.length; s < 9; s++) {
      if (!usedSeats.has(s)) seats.push({ id: '', name: '', seat: s, playing: 0, empty: true, chips: 0 });
    }
    seats.sort((a, b) => a.seat - b.seat);
    const isShowdown = opts.phase === 'showdown' || opts.phase === 'settled';
    for (const [ws, info] of clients) {
      if (ws.readyState !== 1) continue;
      const personalSeats = seats.map(s => {
        if (s.empty || s.id === (info ? info.id : '') || isShowdown) return s;
        return { ...s, holeCards: s.holeCards?.length > 0 ? ['??','??'] : [], holeCardNames: s.holeCardNames?.length > 0 ? ['??','??'] : [] };
      });
      sendTo(ws, {
        method: 'seats', seats: personalSeats,
        dealerSeat: opts.dealerSeat || 0, sbSeat: opts.sbSeat ?? 0, bbSeat: opts.bbSeat ?? 1,
        phase: opts.phase || 'waiting', pot: opts.pot || 0,
        currentTurn: opts.currentTurn ?? -1, handCount: opts.handCount || 0
      });
    }
  }

  // ── Shared: handleMessage override ──
  const origHandleMessage = handleMessage;
  handleMessage = function(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const method = msg.method || msg.action;

    if (method === 'fold' || method === 'check' || method === 'call' || method === 'raise' || method === 'allin') {
      if (LOCAL_ROLE === 'dealer' && p2pActionResolver) {
        const resolver = p2pActionResolver;
        p2pActionResolver = null;
        resolver({ action: method, amount: msg.amount || 0 });
      } else if (LOCAL_ROLE === 'player') {
        acted = true;
        // Clear action buttons in browser
        broadcast({ method: 'betting', action: 'waiting', playerid: 0 });
        const actionData = { action: method, amount: msg.amount || 0, player: LOCAL_ID, timestamp: Date.now() };
        console.log('[P2P] Writing action: ' + method);
        const idName = LOCAL_ID.replace('.CHIPS@', '');
        p2p.client.writeToIdentity(idName, KEYS.PLAYER_ACTION, actionData)
          .then(txid => { console.log('[P2P] Action written tx=' + txid.substring(0, 12)); })
          .catch(e => console.log('[P2P] Action write failed: ' + e.message));
      }
      const info = clients.get(ws);
      broadcast({ method: 'betting', action: method, playerid: info ? info.seat : 0, bet_amount: msg.amount || 0 });
      return;
    }

    if (method === 'reload') {
      const info = clients.get(ws);
      if (info) info.chips = 200;
      // Update dealer's player list
      if (p2pDealer) {
        const pp = p2pDealer.getPlayers().find(p => p.id === (info ? info.id : LOCAL_ID));
        if (pp) pp.chips = 200;
      }
      sendTo(ws, { method: 'reloaded', chips: 200 });
      console.log('[P2P] ' + (info ? info.id : LOCAL_ID) + ' reloaded to 200');
      return;
    }

    if (method === 'sitin') {
      const info = clients.get(ws);
      if (info) info.sittingOut = false;
      sendTo(ws, { method: 'satin' });
      console.log('[P2P] ' + (info ? info.id : LOCAL_ID) + ' sat back in');
      return;
    }

    if (method === 'join' || method === 'sit') {
      const reconnectChips = chipTracker[LOCAL_ID] || 200;
      clients.set(ws, { id: LOCAL_ID, seat: 0, chips: reconnectChips });
      sendTo(ws, { method: 'backend_status', backend_status: 1 });
      sendTo(ws, { method: 'info', playerid: 0, id: LOCAL_ID, seat_taken: false });
      console.log('[P2P] Browser reconnected: ' + LOCAL_ID);
      // Push full game state — browser gets everything instantly
      if (pushState) pushState();

      // For dealer: just mark as seated
      if (LOCAL_ROLE === 'dealer') {
        dealerSeated = true;
        return;
      }

      // For player: write chain join (only once)
      if (LOCAL_ROLE === 'player' && !joinSession) {
        console.log('[P2P] Writing chain join...');
        (async () => {
          let session = null;
          console.log('[P2P] Looking for active table session...');

          const staleSession = new Set();
          try {
            const st = await p2p.read(TABLE_ID, KEYS.SETTLEMENT);
            if (st && st.session) staleSession.add(st.session);
          } catch {}

          for (let i = 0; i < 90; i++) {
            try {
              const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
              if (tc && tc.session) {
                if (staleSession.has(tc.session)) {
                  if (i % 10 === 0) console.log('[P2P] Session ' + tc.session + ' already settled, waiting for new...');
                } else {
                  session = tc.session;
                  console.log('[P2P] Found active session: ' + session + ' Dealer: ' + (tc.dealer || '?'));
                  break;
                }
              }
            } catch(e) {}
            if (i % 10 === 0 && !session) console.log('[P2P] Waiting for dealer... (' + (i*2) + 's)');
            await new Promise(r => setTimeout(r, 2000));
          }
          if (!session) console.log('[P2P] WARNING: No active session found after 3 min');

          const joinData = { table: TABLE_ID, player: LOCAL_ID, session, ready: true, timestamp: Date.now() };
          joinSession = session;
          try {
            await p2p.write(LOCAL_ID, KEYS.JOIN_REQUEST, joinData);
            console.log('[P2P] Join written (session=' + (session || 'none') + ')');
          } catch(e) {
            console.log('[P2P] Join write failed: ' + e.message);
          }
          if (p2p._playerPollStart) p2p._playerPollStart();
        })();
      }
      return;
    }

    origHandleMessage(ws, raw);
  };

  // ══════════════════════════════════════
  // DEALER MODE
  // ══════════════════════════════════════
  const dealerStart = Date.now();
  function dt() { return ((Date.now() - dealerStart) / 1000).toFixed(1) + 's'; }
  function dLog(type, msg) { broadcast({ method: 'comm', type, msg: '[' + dt() + '] ' + msg }); }

  function p2pNotify(event, data) {
    if (event === 'shuffle_start') {
      dLog('system', 'Shuffling deck on-chain (hand #' + data.hand + ')...');
      const pl = p2pDealer.getPlayers();
      p2pSendSeats(pl.map(p => ({ ...p, bet: 0, folded: false, allIn: false, holeCards: [] })),
        { phase: 'shuffling', handCount: p2pDealer.getHandCount() });
    }
    if (event === 'cards_dealt') {
      dLog('cards', 'Cards dealt');
      const myCards = data.holeCards[LOCAL_ID];
      if (myCards) {
        dLog('cards', 'Your cards: ' + myCards.map(c => typeof c === 'number' ? cardToString(c) : c).join(' '));
        for (const [ws2] of clients) sendTo(ws2, { method: 'deal', deal: { board: [], holecards: myCards.map(c => typeof c === 'number' ? cardToString(c) : c) } });
      }
      // Use game player chips (after blinds) for accurate display
      const gp = data.gamePlayers || [];
      const pl = p2pDealer.getPlayers();
      p2pSendSeats(pl.map(p => {
        const gpp = gp.find(g => g.id === p.id);
        return { ...p, chips: gpp ? gpp.chips : p.chips, bet: gpp ? gpp.bet : 0, folded: false, allIn: false,
          holeCards: p.id === LOCAL_ID ? (myCards || []).map(c => typeof c === 'number' ? cardToString(c) : c) : ['??', '??']
        };
      }), { phase: 'preflop', pot: data.pot || 0, handCount: p2pDealer.getHandCount(), dealerSeat: data.dealerSeat || 0 });
    }
    if (event === 'action') {
      const seatIdx = p2pDealer.getPlayers().findIndex(p => p.id === data.player);
      dLog('betting', data.player + ' ' + data.action + (data.amount ? ' ' + data.amount : ''));
      broadcast({ method: 'betting', action: data.action, playerid: seatIdx, bet_amount: data.amount || 0 });
      // Update seats with current chip/bet/pot after action
      if (data.gamePlayers) {
        const gp = data.gamePlayers;
        const pl = p2pDealer.getPlayers();
        p2pSendSeats(pl.map(p => {
          const gpp = gp.find(g => g.id === p.id);
          return { ...p, chips: gpp ? gpp.chips : p.chips, bet: gpp ? gpp.bet : 0,
            folded: gpp ? !!gpp.folded : false, allIn: false, holeCards: ['??', '??'] };
        }), { phase: data.phase || 'preflop', pot: data.pot || 0, handCount: p2pDealer.getHandCount() });
        // Chip/pot updates flow to player via the next need_action betting state write
      }
    }
    if (event === 'community_cards') {
      const board = (data.board || []).map(c => typeof c === 'number' ? cardToString(c) : c);
      dLog('cards', (data.phase || 'Board') + ': ' + board.join(' '));
      broadcast({ method: 'deal', deal: { board } });
    }
    if (event === 'need_action') {
      if (data.playerId === LOCAL_ID) {
        // Dealer player — show buttons in browser, wait for click
        p2pActionResolver = data.resolve;
        const mySeat = p2pDealer.getPlayers().findIndex(p => p.id === LOCAL_ID);
        const poss = data.validActions.map(a => ({ fold: 0, check: 1, call: 2, raise: 3, allin: 7 })[a]).filter(p => p !== undefined);
        broadcast({ method: 'betting', action: 'round_betting', playerid: mySeat, turnPlayer: LOCAL_ID,
          pot: data.pot || 0, toCall: data.toCall || 0, minRaiseTo: data.minRaise || 2,
          turnTimeout: 30, turnStart: Date.now(), possibilities: poss });
      } else {
        // Remote player: write betting state to chain, poll for action
        (async () => {
          console.log('[P2P] Waiting for ' + data.playerId + ' on-chain...');
          try {
            const hid = data.handId || (p2pDealer.getGameId() + '_h' + p2pDealer.getHandCount());
            await p2p.writeBettingState(hid, {
              turn: data.playerId, validActions: data.validActions, toCall: data.toCall, pot: data.pot, minRaise: data.minRaise,
              phase: data.phase || 'preflop',
              session: p2pDealer.getGameId(), hand: p2pDealer.getHandCount(),
              players: data.gamePlayers || [], ts: Date.now()
            });
          } catch (e) { console.log('[P2P] Write betting state error: ' + e.message); }
          // Show waiting in dealer's browser
          const remoteSeat = p2pDealer.getPlayers().findIndex(p => p.id === data.playerId);
          broadcast({ method: 'betting', action: 'round_betting', playerid: remoteSeat, turnPlayer: data.playerId,
            pot: data.pot || 0, toCall: 0, minRaiseTo: 0, turnTimeout: 30, possibilities: [] });
          // Poll player's ID for action
          const lastAction = await p2p.read(data.playerId, KEYS.PLAYER_ACTION);
          const response = await p2p.poll(data.playerId, KEYS.PLAYER_ACTION, lastAction, 60000);
          if (response) {
            console.log('[P2P] ' + data.playerId + ': ' + response.action);
            data.resolve({ action: response.action, amount: response.amount || 0 });
          } else {
            console.log('[P2P] ' + data.playerId + ' timed out');
            data.resolve(null);
          }
        })();
      }
    }
    if (event === 'showdown') {
      // Include player names so browser doesn't need to look them up from seats
      const playerNames = {};
      if (p2pDealer) p2pDealer.getPlayers().forEach(p => { playerNames[p.seat] = p.id; });
      broadcast({ method: 'finalInfo', winners: data.winners, win_amount: data.winAmount, handNames: data.handNames,
        playerNames, showInfo: { allHoleCardsInfo: data.allHoleCards, boardCardInfo: data.board } });
    }
    if (event === 'hand_complete') {
      console.log('[P2P] Hand ' + data.hand + ': verified=' + data.verified);
      data.players.forEach(p => console.log('  ' + p.id + ': ' + p.chips));
      for (const [, info] of clients) { const pp = data.players.find(p => p.id === info.id); if (pp) info.chips = pp.chips; }
      broadcast({ method: 'verification', hand: data.hand, valid: data.verified, errors: [] });
      // Send updated seats with new chip counts
      p2pSendSeats(data.players.map(p => ({ ...p, bet: 0, folded: false, allIn: false, holeCards: [] })),
        { phase: 'settled', pot: 0, handCount: data.hand, dealerSeat: p2pDealer ? (p2pDealer.getHandCount() % data.players.length) : 0 });
      // Notify busted players (0 chips)
      for (const [ws2, info] of clients) {
        const pp = data.players.find(p => p.id === info.id);
        if (pp && pp.chips <= 0) {
          console.log('[P2P] ' + info.id + ' is busted');
          sendTo(ws2, { method: 'busted' });
        }
      }
      setTimeout(async () => {
        if (p2pDealer && p2pDealer.getPlayers().filter(p => p.chips > 0).length >= 2) {
          try { await p2pDealer.runHand(); } catch (e) { console.log('[P2P] Hand error: ' + e.message); }
        } else {
          console.log('[P2P] Not enough players with chips — waiting for reload');
        }
      }, 5000);
    }
  }

  // ══════════════════════════════════════
  // Start server
  // ══════════════════════════════════════
  server.listen(PORT, '0.0.0.0', async () => {
    console.log('Verus Poker at http://localhost:' + PORT);
    console.log('Mode: P2P ON-CHAIN (--local)');
    console.log('Role: ' + LOCAL_ROLE + ' | ID: ' + LOCAL_ID + ' | Table: ' + TABLE_ID);
    try { const info = await p2p.client.getInfo(); console.log('Chain: ' + info.name + ' Block: ' + info.blocks); } catch (e) { console.log('WARNING: ' + e.message); }

    // ── DEALER STARTUP ──
    if (LOCAL_ROLE === 'dealer') {
      p2pDealer = createP2PDealer(p2p, CONFIG, p2pNotify);
      await p2pDealer.openTable();
      p2pDealer.addSelf(200);
      const otherIds = LOCAL_PLAYERS.length > 0 ? LOCAL_PLAYERS : ['poker-p2'];
      // Don't add players yet — wait until they actually join
      const sessionId = p2pDealer.getGameId();
      const tableOpenTime = Date.now();

      dealerSeated = true; // Dealer auto-seats — no browser click needed
      console.log('[P2P] Dealer auto-seated. Waiting for remote players...');
      console.log('[P2P] Session: ' + sessionId + ' | Table opened at: ' + new Date(tableOpenTime).toISOString());
      const waitLoop = async () => {
        while (true) {

          // 2. Wait for ALL remote players to send fresh join requests
          let allReady = true;
          for (const pid of otherIds) {
            const req = await p2p.read(pid, KEYS.JOIN_REQUEST);
            // Must have: correct table AND matching session (best) OR recent timestamp
            const hasSession = req && req.session === sessionId;
            const isRecent = req && req.timestamp && req.timestamp > tableOpenTime && (Date.now() - req.timestamp) < 300000;
            const isCorrectTable = req && req.table === TABLE_ID;
            if (!req || !isCorrectTable || (!hasSession && !isRecent)) {
              allReady = false;
              if (req && !hasSession && !isRecent) {
                console.log('[P2P] ' + pid + ' join: session=' + (req.session||'none') + ' expected=' + sessionId + ' ts=' + req.timestamp + ' tableOpen=' + tableOpenTime);
              }
              break;
            }
          }
          if (allReady) {
            // Add remote players now that they've confirmed
            for (const pid of otherIds) p2pDealer.addPlayer(pid, 200);
            console.log('[P2P] All ready! Starting in 5s...');
            dLog('system', 'All players connected. Starting in 5s...');
            await new Promise(r => setTimeout(r, 5000));
            try { await p2pDealer.runHand(); } catch (e) { console.log('[P2P] Hand error: ' + e.message); }
            return;
          }
          dLog('system', 'Waiting for players to join...');
          await new Promise(r => setTimeout(r, 3000));
        }
      };
      waitLoop();
    }

    // ── PLAYER STARTUP ──
    if (LOCAL_ROLE === 'player') {
      // Auto-detect dealer from table config if --players not specified
      if (LOCAL_PLAYERS.length === 0) {
        try {
          const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
          if (tc && tc.dealer) { LOCAL_PLAYERS.push(tc.dealer); console.log('[P2P] Dealer from table config: ' + tc.dealer); }
        } catch (e) {}
        if (LOCAL_PLAYERS.length === 0) LOCAL_PLAYERS.push('poker-p1');
      }
      console.log('[P2P] Player mode — single state object architecture');

      // ═══════════════════════════════════════════════════
      // SINGLE GAME STATE — the ONLY source of truth
      // ═══════════════════════════════════════════════════
      const otherIds = LOCAL_PLAYERS.length > 0 ? LOCAL_PLAYERS : ['poker-p1'];
      const gs = {
        phase: 'waiting', handId: null, handCount: 0,
        myCards: [], board: [], pot: 0,
        players: [
          { id: LOCAL_ID, seat: 0, chips: 200, bet: 0, folded: false, holeCards: [] },
          ...otherIds.map((pid, i) => ({ id: pid, seat: i + 1, chips: 200, bet: 0, folded: false, holeCards: [] }))
        ],
        turn: null, validActions: [], toCall: 0, minRaise: 2, dealerSeat: 0,
        winner: null, verified: null, showdownCards: {}, handNames: {},
        message: 'Waiting for dealer...'
      };

      // Push FULL state to ALL browsers — called after every change
      pushState = function() {
        // Build seats with privacy (hide other players' cards except at showdown)
        const isShowdown = gs.phase === 'showdown' || gs.phase === 'settled';
        const seats = gs.players.map(p => ({
          ...p, name: p.id,
          playing: p.folded ? 0 : 1, empty: false, allIn: false,
          holeCards: p.id === LOCAL_ID ? gs.myCards :
            (isShowdown && gs.showdownCards[p.seat] ? gs.showdownCards[p.seat] :
              (gs.myCards.length > 0 ? ['??', '??'] : [])),
          holeCardNames: p.id === LOCAL_ID ? gs.myCards :
            (isShowdown && gs.showdownCards[p.seat] ? gs.showdownCards[p.seat] :
              (gs.myCards.length > 0 ? ['??', '??'] : []))
        }));
        // Add empty seats
        const usedSeats = new Set(seats.map(s => s.seat));
        for (let s = seats.length; s < 9; s++) {
          if (!usedSeats.has(s)) seats.push({ id: '', name: '', seat: s, playing: 0, empty: true, chips: 0 });
        }
        seats.sort((a, b) => a.seat - b.seat);

        const msg = {
          method: 'seats', seats, phase: gs.phase, pot: gs.pot,
          dealerSeat: gs.dealerSeat, sbSeat: 0, bbSeat: 1,
          currentTurn: gs.turn === LOCAL_ID ? 0 : (gs.turn ? 1 : -1),
          handCount: gs.handCount
        };

        // Also send deal data (cards + board)
        const dealMsg = { method: 'deal', deal: { holecards: gs.myCards, board: gs.board } };

        // Also send action buttons if it's our turn
        let bettingMsg = null;
        if (gs.turn === LOCAL_ID && gs.validActions.length > 0) {
          const poss = gs.validActions.map(a => ({ fold: 0, check: 1, call: 2, raise: 3, allin: 7 })[a]).filter(p => p !== undefined);
          bettingMsg = { method: 'betting', action: 'round_betting', playerid: 0, turnPlayer: LOCAL_ID,
            pot: gs.pot, toCall: gs.toCall, minRaiseTo: gs.minRaise || 2,
            turnTimeout: 30, turnStart: Date.now(), possibilities: poss };
        }

        // Winner banner
        let finalMsg = null;
        if (gs.winner) {
          const playerNames = {};
          gs.players.forEach((p, i) => playerNames[i] = p.id);
          finalMsg = { method: 'finalInfo', winners: gs.winner.seats || [], win_amount: gs.winner.amount || 0,
            playerNames, handNames: gs.handNames || {},
            showInfo: { allHoleCardsInfo: gs.showdownCards, boardCardInfo: gs.board } };
        }

        // Verification
        let verifyMsg = null;
        if (gs.verified !== null) {
          verifyMsg = { method: 'verification', hand: gs.handCount, valid: gs.verified, errors: [] };
        }

        for (const [ws] of clients) {
          if (ws.readyState !== 1) continue;
          ws.send(JSON.stringify(dealMsg));
          ws.send(JSON.stringify(msg));
          if (bettingMsg) ws.send(JSON.stringify(bettingMsg));
          if (finalMsg) ws.send(JSON.stringify(finalMsg));
          if (verifyMsg) ws.send(JSON.stringify(verifyMsg));
        }

        // Log
        if (gs.message) broadcast({ method: 'comm', type: 'system', msg: gs.message });
      };

      let lastBSJson = null;
      let lastSettledHandId = null;
      let pollRunning = false;
      let joinWritten = false;
      const pollStart = Date.now();
      function pt() { return ((Date.now() - pollStart) / 1000).toFixed(1) + 's'; }

      const pollLoop = async () => {
        if (pollRunning) return;
        pollRunning = true;
        console.log('[P2P] Poll loop started');

        while (true) {
          try {
            // 1. Check for new handId from table_info
            const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
            if (tc && tc.currentHandId && tc.currentHandId !== gs.handId && tc.currentHandId !== lastSettledHandId) {
              console.log('[P2P] ' + pt() + ' New hand: ' + tc.currentHandId);
              // Snapshot chips before reset
              const chipSnap = {};
              gs.players.forEach(p => chipSnap[p.id] = p.chips);
              // Reset state for new hand
              gs.handId = tc.currentHandId;
              gs.handCount = tc.handCount || (gs.handCount + 1);
              gs.phase = 'shuffling'; gs.myCards = []; gs.board = []; gs.pot = 0;
              gs.turn = null; gs.validActions = []; gs.toCall = 0; gs.minRaise = 2;
              gs.winner = null; gs.verified = null; gs.showdownCards = {}; gs.handNames = {};
              gs.message = 'Hand #' + gs.handCount + ' — shuffling...';
              gs.players.forEach(p => { p.bet = 0; p.folded = false; p.holeCards = []; });
              lastBSJson = null; acted = false;
              pushState();
            }

            if (!gs.handId) { await new Promise(r => setTimeout(r, 2000)); continue; }

            // 2. Check for my cards
            if (gs.myCards.length === 0) {
              const cardKey = 'chips.vrsc::poker.sg777z.card_bv.' + gs.handId + '.' + LOCAL_ID;
              const cr = await p2p.read(TABLE_ID, cardKey);
              if (cr && cr.cards) {
                console.log('[P2P] ' + pt() + ' Cards: ' + cr.cards.join(' '));
                gs.myCards = cr.cards;
                gs.phase = 'preflop';
                gs.message = '';
                pushState();
              }
            }

            // 3. Check betting state
            const bs = await p2p.readBettingState(gs.handId);
            const bsJson = bs ? JSON.stringify(bs) : null;
            if (bsJson && bsJson !== lastBSJson) {
              lastBSJson = bsJson;
              gs.pot = bs.pot || gs.pot;
              if (bs.phase) gs.phase = bs.phase;
              // Update player chips/bets from dealer data
              if (bs.players) {
                for (const bp of bs.players) {
                  const gp = gs.players.find(x => x.id === bp.id);
                  if (gp) { gp.chips = bp.chips; gp.bet = bp.bet || 0; gp.folded = !!bp.folded; }
                }
              }
              // Determine if it's our turn
              if (bs.turn === LOCAL_ID && bs.validActions && !acted) {
                gs.turn = LOCAL_ID;
                gs.validActions = bs.validActions;
                gs.toCall = bs.toCall || 0;
                gs.minRaise = bs.minRaise || 2;
                console.log('[P2P] ' + pt() + ' My turn! pot=' + gs.pot + ' toCall=' + gs.toCall);
              } else {
                gs.turn = bs.turn || null;
                gs.validActions = [];
                if (bs.turn !== LOCAL_ID) acted = false;
              }
              gs.message = '';
              pushState();
            }

            // 4. Check board cards
            const bc = await p2p.readBoardCards(gs.handId);
            if (bc && bc.board && bc.board.length > gs.board.length) {
              console.log('[P2P] ' + pt() + ' Board (' + (bc.phase||'') + '): ' + bc.board.join(' '));
              gs.board = bc.board;
              if (bc.phase) gs.phase = bc.phase;
              pushState();
            }

            // 5. Check settlement
            const stKey = KEYS.SETTLEMENT + '.' + gs.handId;
            const st = await p2p.read(TABLE_ID, stKey);
            if (st && st.verified !== undefined && gs.verified === null) {
              console.log('[P2P] ' + pt() + ' Settlement: verified=' + st.verified);
              // Update chips from results
              if (st.results) {
                for (const r of st.results) {
                  const gp = gs.players.find(x => x.id === r.id);
                  if (gp) gp.chips = r.chips;
                }
              }
              // Show showdown
              gs.phase = 'showdown';
              gs.verified = st.verified;
              gs.board = st.board || gs.board;
              gs.showdownCards = st.allHoleCards || {};
              gs.handNames = st.handNames || {};
              // Compute winner
              const winnerSeats = st.winners || [];
              const winAmount = st.winAmount || 0;
              if (winnerSeats.length > 0) {
                gs.winner = { seats: winnerSeats, amount: winAmount };
              }
              gs.message = 'Hand #' + gs.handCount + ' — verified';
              pushState();

              // Show results for 4 seconds, then clear
              await new Promise(r => setTimeout(r, 4000));

              gs.phase = 'waiting';
              gs.myCards = []; gs.board = [];
              gs.winner = null; gs.verified = null;
              gs.showdownCards = {}; gs.handNames = {};
              gs.turn = null; gs.validActions = [];
              gs.players.forEach(p => { p.bet = 0; p.folded = false; p.holeCards = []; });
              gs.message = 'Waiting for next hand...';
              lastSettledHandId = gs.handId;
              gs.handId = null;
              lastBSJson = null;
              pushState();
            }
          } catch (e) {
            console.log('[P2P] Poll error: ' + e.message);
          }
          await new Promise(r => setTimeout(r, 2000));
        }
      };

      // Expose joinWritten flag setter — called from handleMessage after join is written
      p2p._playerPollStart = () => {
        if (joinWritten) return;  // Already started
        joinWritten = true;
        console.log('[P2P] Join written. Starting poll loop...');
        pollLoop().catch(e => console.log('[P2P] Poll error: ' + e.message));
      };
    }
  });
} else {
  // Normal mode (WebSocket-only or --chain)
  server.listen(PORT, '0.0.0.0', () => {
    console.log('Verus Poker at http://localhost:' + PORT);
    console.log('Mode: ' + (USE_CHAIN ? 'ON-CHAIN (--chain)' : 'VIRTUAL (add --chain for real CHIPS)'));
  });
}
