/**
 * Verus Poker Server — speaks pangea-poker GUI protocol
 * node server.mjs
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createEngine, createMockCrypto } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, PREFLOP, FLOP, TURN, RIVER, SHOWDOWN, SETTLED
} from './game.mjs';

const PORT = 3000;
const EXPECTED_PLAYERS = 4;
const CONFIG = { smallBlind: 1, bigBlind: 2, rake: 0 };
const HAND_NAMES = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];

// Possibilities enum matching pangea protocol
const POSS = { fold: 0, check: 1, call: 2, raise: 3, allin: 7 };
function actionsToPossibilities(actions) {
  return actions.map(a => POSS[a] !== undefined ? POSS[a] : -1).filter(p => p >= 0);
}

// Card name conversion: card index 0-51 → "Ah", "2c" etc (pangea format uses uppercase suit)
function toCardStr(c) {
  if (typeof c !== 'number') return c;
  const r = '23456789TJQKA'[c % 13];
  const s = 'cdhs'[Math.floor(c / 13)];
  return r + s;
}

let clients = new Map();
let engine = null;
let waitingResolve = null;
let waitingPlayerId = null;
let handInProgress = false;
let handCount = 0;

function resetAll() {
  engine = null;
  handInProgress = false;
  waitingResolve = null;
  waitingPlayerId = null;
  clients = new Map();
  handCount = 0;
}

// Send to specific player by ID
function sendToPlayer(playerId, msg) {
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.id === playerId && ws.readyState === 1) ws.send(data);
  }
}

// Send to all connected clients
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

// Get seat number for a player ID
function seatOf(playerId) {
  for (const [, info] of clients) {
    if (info.id === playerId) return info.seat;
  }
  return -1;
}

function createWSIO() {
  return {
    broadcast(event, data) {
      // Map engine events to pangea protocol messages
      switch (event) {
        case 'hand_start':
          broadcast({ method: 'dealer', playerid: data.dealer });
          break;
        case 'blinds_posted':
          broadcast({ method: 'blindsInfo', small_blind: CONFIG.smallBlind, big_blind: CONFIG.bigBlind });
          // Send blind bet notifications
          broadcast({
            method: 'betting', action: 'small_blind_bet',
            playerid: data.smallBlind.seat, amount: data.smallBlind.amount
          });
          broadcast({
            method: 'betting', action: 'big_blind_bet',
            playerid: data.bigBlind.seat, amount: data.bigBlind.amount
          });
          break;
        case 'cards_dealt':
          // Individual hole cards are sent via sendTo
          break;
        case 'community_cards': {
          // Send board cards as deal message
          const allBoard = (data.board || []).map(toCardStr);
          broadcast({ method: 'deal', deal: { board: allBoard } });
          break;
        }
        case 'turn': {
          // Send round_betting to all, with possibilities for the active player
          const g = engine.game;
          const funds = g.players.map(p => p.chips);
          broadcast({
            method: 'betting',
            action: 'round_betting',
            playerid: data.seat,
            pot: data.pot,
            toCall: data.toCall,
            minRaiseTo: data.minRaise,
            possibilities: actionsToPossibilities(data.validActions),
            player_funds: funds,
            round: g.board.length <= 0 ? 0 : g.board.length <= 3 ? 1 : g.board.length <= 4 ? 2 : 3
          });
          break;
        }
        case 'action': {
          const actionMap = {
            fold: 'fold', check: 'check', call: 'call', raise: 'raise', allin: 'allin'
          };
          broadcast({
            method: 'betting',
            action: actionMap[data.action] || data.action,
            playerid: data.seat,
            bet_amount: data.amount || 0
          });
          // Update pot
          if (data.pot) broadcast({ method: 'betting', action: 'update_pot', pot: data.pot });
          break;
        }
        case 'showdown': {
          // Build finalInfo message
          const allHoleCards = [];
          const g = engine.game;
          for (let i = 0; i < g.players.length; i++) {
            const p = g.players[i];
            if (!p.folded && p.holeCards.length === 2) {
              allHoleCards.push(p.holeCards.map(toCardStr));
            } else {
              allHoleCards.push([null, null]);
            }
          }
          const boardCards = (data.board || []).map(toCardStr);
          const winners = [];
          let winAmount = 0;
          for (const [seat, amt] of Object.entries(data.payouts || {})) {
            if (amt > 0) { winners.push(Number(seat)); winAmount = amt; }
          }
          broadcast({
            method: 'finalInfo',
            winners,
            win_amount: winAmount,
            showInfo: {
              allHoleCardsInfo: allHoleCards,
              boardCardInfo: boardCards
            }
          });
          break;
        }
        case 'player_joined':
          sendSeats();
          break;
        case 'deck_ready':
          break;
      }
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        const cards = data.cards.map(toCardStr);
        sendToPlayer(playerId, {
          method: 'deal',
          deal: { holecards: cards, balance: 0 }
        });
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      // Broadcast state before waiting
      sendSeats();
      return new Promise((resolve) => {
        waitingPlayerId = playerId;
        const timer = setTimeout(() => {
          if (waitingPlayerId === playerId) {
            waitingResolve = null;
            waitingPlayerId = null;
            resolve(null);
          }
        }, Math.min(timeout, 120000));
        waitingResolve = (result) => {
          clearTimeout(timer);
          waitingPlayerId = null;
          waitingResolve = null;
          resolve(result);
        };
      });
    },
    broadcastState() { sendSeats(); },
    log(msg) { console.log('[GAME] ' + msg); }
  };
}

function sendSeats() {
  if (!engine) return;
  const g = engine.game;
  const seatsData = g.players.map(p => ({
    name: `player${p.seat + 1}`,
    seat: p.seat,
    playing: p.folded ? 0 : 1,
    empty: false,
    chips: Math.round(p.chips)
  }));
  // Fill remaining seats as empty
  for (let i = g.players.length; i < 9; i++) {
    seatsData.push({ name: `player${i + 1}`, seat: i, playing: 0, empty: true, chips: 0 });
  }
  broadcast({ method: 'seats', seats: seatsData });
}

function handleMessage(ws, data) {
  let msg;
  try { msg = JSON.parse(data); } catch { return; }
  const info = clients.get(ws);

  // Handle pangea GUI messages
  const method = msg.method || msg.action;

  switch (method) {
    case 'join': {
      if (handInProgress) {
        ws.send(JSON.stringify({ method: 'error', error: 'Hand in progress, wait' }));
        return;
      }
      if (!engine) {
        engine = createEngine(CONFIG, createWSIO());
      }
      // Check duplicate name
      const id = msg.name || 'player-' + (clients.size + 1);
      let alreadySeated = false;
      for (const [, info] of clients) {
        if (info.id === id) { alreadySeated = true; break; }
      }
      if (alreadySeated) {
        ws.send(JSON.stringify({ method: 'error', error: 'Name taken' }));
        return;
      }
      // Check if already at max
      if (engine.game.players.length >= EXPECTED_PLAYERS) {
        ws.send(JSON.stringify({ method: 'error', error: 'Table full' }));
        return;
      }
      try {
        const seat = engine.addPlayer(id, 200);
        clients.set(ws, { id, seat });
        // Send backend_status
        ws.send(JSON.stringify({ method: 'backend_status', backend_status: 1 }));
        // Send table_info
        ws.send(JSON.stringify({
          method: 'table_info',
          backend_status: 1,
          balance: 200,
          addr: '',
          max_players: EXPECTED_PLAYERS,
          table_id: 'test-table',
          dealer_id: 'test-dealer',
          small_blind: CONFIG.smallBlind,
          big_blind: CONFIG.bigBlind,
          table_min_stake: 50,
          occupied_seats: engine.game.players.map(p => ({ seat: p.seat, player_id: p.id, stack: p.chips })),
          table_stack_in_chips: 200
        }));
        // Send info (seat assignment)
        ws.send(JSON.stringify({ method: 'info', playerid: seat, seat_taken: false }));
        console.log('[GAME] ' + id + ' seated (' + engine.game.players.length + '/' + EXPECTED_PLAYERS + ')');
        sendSeats();
        // Auto-start
        if (engine.game.players.length >= EXPECTED_PLAYERS && !handInProgress) {
          console.log('[GAME] All players seated — dealing in 2 seconds');
          setTimeout(() => {
            if (!handInProgress && engine && engine.game.players.length >= 2) runHand();
          }, 2000);
        }
      } catch (e) {
        ws.send(JSON.stringify({ method: 'error', error: e.message }));
      }
      break;
    }
    case 'game':
    case 'start': {
      if (handInProgress || !engine || engine.game.players.length < 2) return;
      runHand();
      break;
    }
    case 'betting': {
      // Player action from GUI
      if (!info || !waitingResolve || waitingPlayerId !== info.id) return;
      const possibilities = msg.possibilities || [];
      // GUI sends possibilities array: [action_number]
      // Map back to our action strings
      const possMap = { 0: 'fold', 1: 'check', 2: 'call', 3: 'raise', 7: 'allin' };
      if (possibilities.length > 0) {
        const action = possMap[possibilities[0]];
        if (action) {
          waitingResolve({ action, amount: msg.bet_amount || msg.amount || 0 });
        }
      }
      break;
    }
    // Direct action format (from our simple UI)
    case 'fold': case 'check': case 'call': case 'raise': case 'allin': {
      if (waitingResolve && info && waitingPlayerId === info.id) {
        waitingResolve({ action: method, amount: msg.amount || 0 });
      }
      break;
    }
    case 'reset': {
      if (!handInProgress) {
        resetAll();
        broadcast({ method: 'reset' });
      }
      break;
    }
  }
}

async function runHand() {
  handInProgress = true;
  handCount++;
  try {
    await engine.playHand(createMockCrypto());
    sendSeats();
    // Auto-deal next hand
    setTimeout(() => {
      if (!handInProgress && engine && engine.game.players.filter(p => p.chips > 0).length >= 2) {
        console.log('[GAME] Auto-dealing next hand');
        runHand();
      }
    }, 6000);
  } catch (e) { console.error('Game error:', e.stack || e); }
  handInProgress = false;
}

// ============================================================
// Pangea Poker GUI - served from /root/pangea-poker
// ============================================================

import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';

const PANGEA_DIR = '/root/pangea-poker';
const PANGEA_DIST = join(PANGEA_DIR, '.cache', 'dist');
const PANGEA_SRC = join(PANGEA_DIR, 'src');

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
  '.map': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg'
};

// Simple player UI for each iframe (bypasses pangea React build issues)
const PLAYER_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a1f0a;color:#fff;font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden}

#table-wrap{flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-height:0}
#felt{width:92%;height:85%;background:radial-gradient(ellipse at center,#2e7d32 0%,#1b5e20 60%,#0d3d0d 100%);border:6px solid #4e342e;border-radius:45%;position:relative;box-shadow:inset 0 0 30px rgba(0,0,0,0.4),0 4px 15px rgba(0,0,0,0.5)}

#board-area{position:absolute;top:50%;left:50%;transform:translate(-50%,-55%);text-align:center}
#board{display:flex;gap:3px;justify-content:center}
.cd{width:36px;height:50px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:0.95em;font-weight:bold;box-shadow:1px 1px 3px rgba(0,0,0,0.4)}
.cd.e{background:rgba(255,255,255,0.08);border:1px dashed rgba(255,255,255,0.15)}
.cd.f{background:#fff;color:#333;border:1px solid #bbb}
.cd.r{color:#d32f2f}
#pot-area{color:#ffd700;font-size:0.8em;margin-top:3px}

.ps{position:absolute;text-align:center;font-size:0.7em;transition:all 0.3s}
.ps .pbox{background:rgba(0,0,0,0.5);border:2px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 6px;min-width:70px;white-space:nowrap}
.ps.act .pbox{border-color:#ffd700;box-shadow:0 0 8px rgba(255,215,0,0.5)}
.ps.fold .pbox{opacity:0.25}
.ps.me .pbox{border-color:#4caf50;background:rgba(76,175,80,0.2)}
.pname{font-weight:bold;font-size:0.85em}
.pchips{color:#aaa;font-size:0.8em}
.pbet{color:#ffd700;font-size:0.75em}
.pcards{display:flex;gap:2px;justify-content:center;margin-top:2px}
.pc{width:24px;height:34px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:0.7em;font-weight:bold}
.pc.f{background:#fff;color:#333;border:1px solid #aaa}
.pc.r{color:#d32f2f}
.pc.b{background:#1565c0;border:1px solid #1976d2;color:#1565c0;font-size:0.6em}
.chip{display:inline-block;width:16px;height:16px;border-radius:50%;font-size:0.5em;line-height:16px;text-align:center;font-weight:bold;margin:1px}
.chip-d{background:#ffd700;color:#000;border:2px dashed #b8860b}
.chip-sb{background:#5c6bc0;color:#fff;border:2px solid #3949ab}
.chip-bb{background:#ef5350;color:#fff;border:2px solid #c62828}

#my-section{background:rgba(0,0,0,0.5);padding:6px;text-align:center;border-top:2px solid #4caf50}
#my-label{font-weight:bold;color:#4caf50;font-size:0.9em}
#my-cards{display:flex;gap:4px;justify-content:center;margin:4px 0}
.mc{width:44px;height:62px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.3em;font-weight:bold;background:#fff;color:#333;border:2px solid #4caf50;box-shadow:2px 2px 5px rgba(0,0,0,0.4)}
.mc.r{color:#d32f2f}

#ctrls{display:flex;gap:5px;justify-content:center;padding:6px;background:rgba(0,0,0,0.4);flex-wrap:wrap;align-items:center}
#ctrls button{padding:6px 14px;font-size:0.85em;border:none;border-radius:5px;cursor:pointer;font-weight:bold}
.bf{background:#c62828;color:#fff}.bk{background:#2e7d32;color:#fff}
.bc{background:#1565c0;color:#fff}.br{background:#e65100;color:#fff}
.ba{background:#6a1b9a;color:#fff}
#ri{padding:5px;width:55px;border-radius:3px;border:1px solid #555;background:#222;color:#fff;text-align:center;font-size:0.85em}
.wm{color:#777;font-size:0.8em}

#log{max-height:60px;overflow-y:auto;padding:3px 6px;font-size:0.65em;color:#558b55;background:#050f05}
#log div{padding:1px 0}
</style></head><body>
<div id="table-wrap">
  <div id="felt">
    <div id="board-area"><div id="board"></div><div id="pot-area"></div></div>
  </div>
</div>
<div id="my-section">
  <div id="my-label"></div>
  <div id="my-cards"></div>
</div>
<div id="ctrls"><span class="wm">Connecting...</span></div>
<div id="log"></div>

<script>
const R='23456789TJQKA',SU={c:'\\u2663',d:'\\u2666',h:'\\u2665',s:'\\u2660'};
const SCOL={c:'#2e7d32',d:'#1565c0',h:'#d32f2f',s:'#333'};
function cd(n){if(!n||n==='??'||n===null)return{t:'?',col:'#999',empty:true};let k=n[0]==='T'?'10':n[0];let s=n[n.length-1];return{t:k+(SU[s]||''),col:SCOL[s]||'#333',empty:false}}

let ws,seat=-1,id='',myCards=[],boardCards=[],phase='waiting',pot=0;
let players=[],dealerSeat=-1,activeSeat=-1,myChips=0,validPoss=[],toCallAmt=0,minRaise=2;
const name=new URLSearchParams(location.search).get('name')||'Player';

function connect(){
  const p=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(p+'//'+location.host);
  ws.onopen=()=>{ws.send(JSON.stringify({action:'join',name}))};
  ws.onmessage=e=>{try{onMsg(JSON.parse(e.data))}catch(x){console.error(x,e.data)}};
  ws.onclose=()=>setTimeout(connect,2000);
}

function onMsg(m){
  switch(m.method){
    case 'backend_status': break;
    case 'table_info':
      myChips=m.balance||200;
      log('Table: '+m.table_id+' Blinds: '+m.small_blind+'/'+m.big_blind);
      break;
    case 'info':
      seat=m.playerid;
      id=name;
      document.getElementById('my-name').textContent=name+' (Seat '+(seat+1)+')';
      log('Seated at position '+(seat+1));
      break;
    case 'seats':
      players=m.seats||[];
      render();
      break;
    case 'dealer':
      dealerSeat=m.playerid;
      log('Dealer: seat '+(m.playerid+1));
      render();
      break;
    case 'blindsInfo':
      log('Blinds: '+m.small_blind+'/'+m.big_blind);
      break;
    case 'deal':
      if(m.deal.holecards){
        myCards=m.deal.holecards;
        log('Hole cards: '+myCards.join(' '));
      }
      if(m.deal.board){
        boardCards=m.deal.board;
      }
      render();
      break;
    case 'betting':
      switch(m.action){
        case 'small_blind_bet':
          log('Seat '+(m.playerid+1)+' posts SB '+m.amount);
          break;
        case 'big_blind_bet':
          log('Seat '+(m.playerid+1)+' posts BB '+m.amount);
          break;
        case 'round_betting':
          activeSeat=m.playerid;
          pot=m.pot||pot;
          if(m.player_funds)m.player_funds.forEach((f,i)=>{if(players[i])players[i].chips=f});
          if(m.playerid===seat){
            validPoss=m.possibilities||[];
            toCallAmt=m.toCall||0;
            minRaise=m.minRaiseTo||2;
          }else{validPoss=[]}
          render();
          break;
        case 'fold':
          log('Seat '+(m.playerid+1)+' folds');
          if(players[m.playerid])players[m.playerid].playing=0;
          activeSeat=-1;validPoss=[];
          render();
          break;
        case 'check':
          log('Seat '+(m.playerid+1)+' checks');
          activeSeat=-1;validPoss=[];render();
          break;
        case 'call':
          log('Seat '+(m.playerid+1)+' calls '+m.bet_amount);
          activeSeat=-1;validPoss=[];render();
          break;
        case 'raise':
          log('Seat '+(m.playerid+1)+' raises '+m.bet_amount);
          activeSeat=-1;validPoss=[];render();
          break;
        case 'allin':
          log('Seat '+(m.playerid+1)+' ALL IN '+m.bet_amount);
          activeSeat=-1;validPoss=[];render();
          break;
      }
      break;
    case 'finalInfo':{
      const w=m.winners||[];
      const cards=m.showInfo?.allHoleCardsInfo||[];
      const board=m.showInfo?.boardCardInfo||[];
      boardCards=board;
      log('=== SHOWDOWN ===');
      cards.forEach((h,i)=>{if(h&&h[0])log('Seat '+(i+1)+': '+h.join(' '))});
      w.forEach(s=>log('*** Seat '+(s+1)+' WINS '+m.win_amount+' ***'));
      activeSeat=-1;validPoss=[];
      phase='showdown';
      // Reset for next hand after delay
      setTimeout(()=>{myCards=[];boardCards=[];phase='waiting';pot=0;render()},5000);
      render();
      break;
    }
    case 'error':
      log('ERR: '+(m.error||m.message||''));
      break;
    case 'reset':
      myCards=[];boardCards=[];phase='waiting';pot=0;render();
      break;
  }
}

function render(){
  // Board
  let bh='';
  for(let i=0;i<5;i++){
    const n=boardCards[i];
    if(n){const d=cd(n);bh+='<div class="card face" style="color:'+d.col+'">'+d.t+'</div>'}
    else bh+='<div class="card empty"></div>'
  }
  document.getElementById('board').innerHTML=bh;

  // Pot
  document.getElementById('pot-area').textContent=pot>0?'Pot: '+pot:'';

  // Dealer button
  const dbtn=document.getElementById('dealer-btn');
  if(dealerSeat===seat){dbtn.style.display='block'}else{dbtn.style.display='none'}

  // Other players
  let oh='';
  for(const p of players){
    if(p.seat===seat||p.empty)continue;
    let cls='seat'+(activeSeat===p.seat?' active':'')+(p.playing===0?' folded':'');
    let badges='';
    if(p.seat===dealerSeat)badges+='<span class="badge d-badge">D</span>';
    const n=players.length;
    const sb=n===2?dealerSeat:(dealerSeat+1)%n;
    const bb=n===2?(dealerSeat+1)%n:(dealerSeat+2)%n;
    if(p.seat===sb)badges+='<span class="badge sb-badge">SB</span>';
    if(p.seat===bb)badges+='<span class="badge bb-badge">BB</span>';
    oh+='<div class="'+cls+'">'+p.name+badges+'<br>'+(p.chips!==undefined?p.chips:'')+'</div>';
  }
  document.getElementById('others').innerHTML=oh;

  // My cards
  let mch='';
  for(const c of myCards){const d=cd(c);mch+='<div class="my-card" style="color:'+d.col+'">'+d.t+'</div>'}
  document.getElementById('my-cards').innerHTML=mch;

  // My info
  const me=players.find(p=>p.seat===seat);
  let myBadges='';
  if(seat===dealerSeat)myBadges=' [DEALER]';
  const n=players.length;
  const sb=n===2?dealerSeat:(dealerSeat+1)%n;
  const bb=n===2?(dealerSeat+1)%n:(dealerSeat+2)%n;
  if(seat===sb)myBadges=' [SB]';
  if(seat===bb)myBadges=' [BB]';
  document.getElementById('my-info').textContent=(me?me.chips+' chips':'')+myBadges;

  // Controls
  let ct='';
  if(validPoss.length>0&&activeSeat===seat){
    if(validPoss.includes(0))ct+='<button class="btn-fold" onclick="act(0)">Fold</button>';
    if(validPoss.includes(1))ct+='<button class="btn-check" onclick="act(1)">Check</button>';
    if(validPoss.includes(2))ct+='<button class="btn-call" onclick="act(2)">Call '+toCallAmt+'</button>';
    if(validPoss.includes(3)){const label=toCallAmt>0?'Raise':'Bet';ct+='<input id="raise-input" type="number" step="1" value="'+minRaise+'"><button class="btn-raise" onclick="doRaise()">'+label+'</button>'}
    if(validPoss.includes(7))ct+='<button class="btn-allin" onclick="act(7)">All In</button>';
  }else if(phase==='showdown'){
    ct='<span class="wait-msg">Showdown — next hand soon...</span>';
  }else if(activeSeat>=0&&activeSeat!==seat){
    const who=players[activeSeat]?.name||'Seat '+(activeSeat+1);
    ct='<span class="wait-msg">Waiting for '+who+'...</span>';
  }else if(players.filter(p=>!p.empty).length<EXPECTED_PLAYERS){
    ct='<span class="wait-msg">Waiting for players... ('+players.filter(p=>!p.empty).length+'/'+EXPECTED_PLAYERS+')</span>';
  }else{
    ct='<span class="wait-msg">Starting...</span>';
  }
  document.getElementById('controls').innerHTML=ct;
}

const EXPECTED_PLAYERS=${EXPECTED_PLAYERS};
function act(p){ws.send(JSON.stringify({method:'betting',possibilities:[p]}))}
function doRaise(){const v=document.getElementById('raise-input');ws.send(JSON.stringify({method:'betting',possibilities:[3],bet_amount:parseFloat(v.value)}))}
function log(t){const el=document.getElementById('log'),d=document.createElement('div');d.textContent=t;el.appendChild(d);el.scrollTop=el.scrollHeight}
connect();
</script></body></html>`;

// Multiview page
const MULTIVIEW_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verus Poker - 4 Player</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111}
h1{text-align:center;padding:6px;color:#ffd700;font-size:1.1em;background:#0a0a0a}
.grid{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:3px;padding:3px;height:calc(100vh - 35px)}
.f{position:relative;border:2px solid #333;border-radius:4px;overflow:hidden}
.f .l{position:absolute;top:3px;left:6px;z-index:10;background:rgba(0,0,0,0.8);color:#4caf50;padding:2px 8px;border-radius:3px;font-size:0.75em;font-weight:bold}
.f iframe{width:100%;height:100%;border:none}
</style></head><body>
<h1>Verus Poker</h1>
<div class="grid">
<div class="f"><div class="l">Alice</div><iframe src="/player?name=Alice"></iframe></div>
<div class="f"><div class="l">Bob</div><iframe src="/player?name=Bob"></iframe></div>
<div class="f"><div class="l">Charlie</div><iframe src="/player?name=Charlie"></iframe></div>
<div class="f"><div class="l">Dave</div><iframe src="/player?name=Dave"></iframe></div>
</div></body></html>`;

// HTTP server
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/player') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(PLAYER_HTML);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(MULTIVIEW_HTML);
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.set(ws, {});
  console.log('Connected (' + clients.size + ')');
  ws.on('message', d => handleMessage(ws, d.toString()));
  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);
    console.log('Disconnected (' + clients.size + ')');
    const seated = [...clients.values()].filter(c => c.seat !== undefined);
    if (seated.length === 0 && engine) { console.log('[GAME] All left — reset'); resetAll(); }
    if (info && waitingPlayerId === info.id && waitingResolve) {
      waitingResolve({ action: 'fold' });
    }
  });
});
server.listen(PORT, '0.0.0.0', () => console.log('Verus Poker at http://localhost:' + PORT));
