/**
 * 4-Player GUI Server — poker table with live comms panel
 * Shows: table, cards, actions, and all on-chain activity in real-time
 *
 * node gui-server.mjs
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { playerInit, dealerShuffle, cashierShuffle, verifyGame } from './protocol.mjs';
import { createEngine } from './poker-engine.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED } from './game.mjs';

const PORT = 3000;
const EXPECTED_PLAYERS = 4;
const CONFIG = { smallBlind: 1, bigBlind: 2, rake: 0 };
const NUM_CARDS = 52;

let clients = new Map();
let engine = null;
let handInProgress = false;
let handCount = 0;
let pendingAction = null;
let commsLog = [];

function addComm(type, msg, data = null) {
  const entry = { type, msg, time: new Date().toISOString().substring(11, 19), data };
  commsLog.push(entry);
  if (commsLog.length > 200) commsLog.shift();
  console.log('[' + type + '] ' + msg);
  broadcast({ event: 'comm', ...entry });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [ws] of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  if (!engine) return;
  const g = engine.game;
  const n = g.players.length;
  const sb = n <= 1 ? -1 : (n === 2 ? g.dealerSeat : (g.dealerSeat + 1) % n);
  const bb = n <= 1 ? -1 : (n === 2 ? (g.dealerSeat + 1) % n : (g.dealerSeat + 2) % n);

  for (const [ws, info] of clients) {
    if (ws.readyState === 1 && info.seat !== undefined) {
      const state = engine.getState(info.seat);
      state.boardNames = (state.board || []).map(c => typeof c === 'number' ? cardToString(c) : c);
      state.dealerSeat = g.dealerSeat;
      state.sbSeat = sb;
      state.bbSeat = bb;
      state.handCount = handCount;
      for (const p of state.players) {
        p.holeCardNames = Array.isArray(p.holeCards)
          ? p.holeCards.map(c => typeof c === 'number' ? cardToString(c) : c) : [];
      }
      sendTo(ws, { event: 'state', ...state });
    }
  }
}

function createIO() {
  return {
    broadcast(event, data) {
      if (event === 'hand_start') {
        addComm('protocol', 'Hand ' + handCount + ' started, dealer seat ' + data.dealer);
      }
      if (event === 'blinds_posted') {
        addComm('betting', 'Blinds posted: SB ' + data.smallBlind.amount + ' BB ' + data.bigBlind.amount);
      }
      if (event === 'community_cards') {
        const cards = (data.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c);
        addComm('cards', data.phase + ': ' + cards.join(' '));
      }
      if (event === 'action') {
        addComm('betting', data.player + ': ' + data.action + (data.amount ? ' ' + data.amount : '') + ' (pot: ' + data.pot + ')');
      }
      if (event === 'showdown') {
        addComm('showdown', 'SHOWDOWN');
        for (const [, info] of Object.entries(data.hands || {})) {
          const cards = (info.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' ');
          addComm('showdown', info.id + ': ' + cards + ' (' + info.handName + ')' + (info.won ? ' WINS ' + info.payout : ''));
        }
      }
      broadcastState();
    },
    sendTo(playerId, event, data) {
      if (event === 'hole_cards') {
        addComm('cards', playerId + ' dealt hole cards');
        for (const [ws, info] of clients) {
          if (info.id === playerId) {
            sendTo(ws, { event: 'hole_cards', cards: data.cards.map(c => typeof c === 'number' ? cardToString(c) : c) });
          }
        }
      }
    },
    async waitForAction(playerId, validActions, timeout) {
      broadcastState();
      addComm('turn', playerId + '\'s turn: ' + validActions.join('/'));
      return new Promise(resolve => {
        pendingAction = { playerId, resolve };
        setTimeout(() => {
          if (pendingAction && pendingAction.playerId === playerId) {
            pendingAction = null;
            addComm('timeout', playerId + ' timed out');
            resolve(null);
          }
        }, 120000);
      });
    },
    broadcastState() { broadcastState(); },
    log(msg) { if (msg.includes('Complete')) addComm('system', msg); }
  };
}

async function runHand() {
  handInProgress = true;
  handCount++;
  addComm('protocol', '═══ Starting Hand ' + handCount + ' ═══');

  // Protocol: 3-stage shuffle
  const activePlayers = [...clients.values()].filter(c => c.seat !== undefined);
  const numPlayers = activePlayers.length;
  const numCards = 52; // Always use full deck for proper suit distribution

  addComm('protocol', 'Stage I: Players initializing decks (' + numCards + ' cards)...');
  const playerData = activePlayers.map(p => playerInit(numCards, p.id));

  addComm('protocol', 'Stage II: Dealer shuffle + blind (with e_i factors)...');
  const dealerData = dealerShuffle(playerData, numCards);

  addComm('protocol', 'Stage III: Cashier shuffle + blind + SSS distribution...');
  const cashierData = cashierShuffle(dealerData.blindedDecks, numPlayers, numCards, Math.ceil(numPlayers / 2) + 1);

  addComm('protocol', 'Deck ready. Dealing...');

  // Create engine
  const io = createIO();
  engine = createEngine(CONFIG, io);
  for (const p of activePlayers) {
    engine.addPlayer(p.id, p.chips || 200);
  }

  // Deal hole cards
  let cardPos = 0;
  for (let i = 0; i < numPlayers; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const cp = cashierData.sigma_Cashier[cardPos];
      const dp = dealerData.sigma_Dealer[cp];
      const pp = playerData[i].permutation[dp];
      cards.push(pp % 52);
      cardPos++;
    }
    engine.game.players[i].holeCards = cards;
    // Send to specific player
    for (const [ws, info] of clients) {
      if (info.id === activePlayers[i].id) {
        sendTo(ws, { event: 'hole_cards', cards: cards.map(cardToString) });
      }
    }
  }

  // Crypto adapter
  let revealPos = numPlayers * 2;
  const crypto = {
    async initDeck(n) { revealPos = numPlayers * 2; return {}; },
    async revealCard() {
      if (revealPos >= numCards) {
        console.log('[WARN] revealCard beyond deck: pos=' + revealPos + ' numCards=' + numCards);
        return revealPos % 52;
      }
      const cp = cashierData.sigma_Cashier[revealPos];
      const dp = (cp !== undefined) ? dealerData.sigma_Dealer[cp] : revealPos;
      const pp = (dp !== undefined) ? playerData[0].permutation[dp] : revealPos;
      revealPos++;
      return (pp !== undefined ? pp : revealPos) % 52;
    }
  };

  await engine.playHand(crypto);

  // Verify
  addComm('verify', 'Post-game verification...');
  const verification = verifyGame(playerData, dealerData, cashierData, numCards);
  addComm('verify', 'Verification: ' + (verification.valid ? 'PASSED ✓' : 'FAILED ✗ ' + verification.errors.join(', ')));

  // Update chips
  for (const p of engine.game.players) {
    for (const [, info] of clients) {
      if (info.id === p.id) info.chips = p.chips;
    }
  }

  broadcastState();
  handInProgress = false;

  // Auto-deal next hand after 5s
  setTimeout(() => {
    const active = [...clients.values()].filter(c => c.seat !== undefined && (c.chips || 0) > 0);
    if (active.length >= 2 && !handInProgress) {
      runHand();
    }
  }, 5000);
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  const info = clients.get(ws);

  switch (msg.action) {
    case 'join': {
      if (handInProgress) { sendTo(ws, { event: 'error', message: 'Wait for current hand' }); return; }
      if (!engine) engine = createEngine(CONFIG, createIO());
      const id = msg.name || 'Player-' + (clients.size + 1);
      const seated = [...clients.values()].filter(c => c.seat !== undefined);
      if (seated.length >= EXPECTED_PLAYERS) { sendTo(ws, { event: 'error', message: 'Table full' }); return; }
      if (seated.find(c => c.id === id)) { sendTo(ws, { event: 'error', message: 'Name taken' }); return; }
      const seat = seated.length;
      clients.set(ws, { id, seat, chips: 200 });
      sendTo(ws, { event: 'joined', id, seat, chips: 200 });
      addComm('join', id + ' sat down (seat ' + seat + ')');
      broadcastState();
      // Send comm history
      sendTo(ws, { event: 'comm_history', log: commsLog.slice(-50) });
      // Auto-start
      if (seated.length + 1 >= EXPECTED_PLAYERS && !handInProgress) {
        addComm('system', 'All ' + EXPECTED_PLAYERS + ' players seated. Dealing in 3s...');
        setTimeout(() => { if (!handInProgress) runHand(); }, 3000);
      }
      break;
    }
    case 'fold': case 'check': case 'call': case 'raise': case 'allin': {
      if (pendingAction && info && pendingAction.playerId === info.id) {
        pendingAction.resolve({ action: msg.action, amount: msg.amount || 0 });
        pendingAction = null;
      }
      break;
    }
  }
}

// ════════════════════════════════════════
// HTML
// ════════════════════════════════════════

const PLAYER_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verus Poker</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a1f0a;color:#fff;font-family:system-ui,sans-serif;height:100vh;display:flex;flex-direction:column;overflow:hidden;font-size:13px}

#table{flex:1;display:flex;align-items:center;justify-content:center;position:relative;min-height:0}
#felt{width:90%;height:70%;background:radial-gradient(ellipse at center,#2e7d32 0%,#1b5e20 60%,#0d3d0d 100%);border:3px solid #4e342e;border-radius:40%;position:relative;box-shadow:inset 0 0 20px rgba(0,0,0,0.4)}

#board-area{position:absolute;top:40%;left:50%;transform:translate(-50%,-50%);text-align:center}
#board{display:flex;gap:3px}
.cd{width:44px;height:60px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.1em;font-weight:bold;box-shadow:1px 2px 4px rgba(0,0,0,0.3)}
.cd.e{background:rgba(255,255,255,0.08);border:1px dashed rgba(255,255,255,0.15)}
.cd.f{background:#fff;border:1px solid #bbb}
#pot-d{color:#ffd700;font-size:0.85em;margin-top:2px}
#hand-d{color:#aaa;font-size:0.7em}

.ps{position:absolute;text-align:center;font-size:0.65em}
.ps .pb{background:rgba(0,0,0,0.5);border:2px solid rgba(255,255,255,0.15);border-radius:6px;padding:2px 5px;min-width:60px;white-space:nowrap}
.ps.act .pb{border-color:#ffd700;box-shadow:0 0 8px rgba(255,215,0,0.5)}
.ps.fold .pb{opacity:0.2}
.ps.me .pb{border-color:#4caf50}
.pn{font-weight:bold;font-size:0.8em}
.pk{display:flex;gap:1px;justify-content:center;margin-top:1px}
.pc{width:30px;height:42px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-size:0.85em;font-weight:bold}
.pc.fc{background:#fff;border:1px solid #aaa}
.pc.bk{background:#1565c0;border:1px solid #1976d2;color:#1565c0}
.badge{display:inline-block;width:13px;height:13px;border-radius:50%;font-size:0.45em;line-height:13px;text-align:center;font-weight:bold;margin:0 1px;vertical-align:middle}
.bd{background:#ffd700;color:#000}.bs{background:#5c6bc0;color:#fff}.bb{background:#ef5350;color:#fff}

.chip-marker{position:absolute;text-align:center;font-size:0.6em;font-weight:bold;pointer-events:none}
.bet-chip{background:#ffd700;color:#000;border:2px solid #b8860b;border-radius:50%;width:22px;height:22px;line-height:18px;text-align:center;display:inline-block;box-shadow:1px 1px 3px rgba(0,0,0,0.5)}
.dealer-chip{background:#fff;color:#000;border:2px solid #333;border-radius:50%;width:20px;height:20px;line-height:16px;text-align:center;display:inline-block;font-weight:bold;font-size:0.7em;box-shadow:1px 1px 3px rgba(0,0,0,0.5)}

#my{background:rgba(0,0,0,0.5);padding:2px 8px;text-align:center;border-top:2px solid #4caf50;display:flex;align-items:center;gap:8px;justify-content:center}
#my-n{font-weight:bold;color:#4caf50;font-size:0.85em}
#my-c{display:flex;gap:3px}
.mc{width:40px;height:56px;border-radius:4px;display:flex;align-items:center;justify-content:center;font-size:1.2em;font-weight:bold;background:#fff;border:2px solid #4caf50;box-shadow:1px 2px 4px rgba(0,0,0,0.3)}

#ctrl{display:flex;gap:4px;justify-content:center;padding:5px;background:rgba(0,0,0,0.4);flex-wrap:wrap;align-items:center}
#ctrl button{padding:5px 12px;font-size:0.85em;border:none;border-radius:4px;cursor:pointer;font-weight:bold}
.bf{background:#c62828;color:#fff}.bk{background:#2e7d32;color:#fff}
.bc{background:#1565c0;color:#fff}.br{background:#e65100;color:#fff}
.ba{background:#6a1b9a;color:#fff}
#ri{padding:4px;width:50px;border-radius:3px;border:1px solid #555;background:#222;color:#fff;text-align:center;font-size:0.8em}
.wm{color:#666;font-size:0.8em}

#comms{height:60px;overflow-y:auto;padding:2px 6px;font-size:0.6em;background:#050f05;border-top:1px solid #1a3a1a;font-family:monospace}
#comms div{padding:1px 0;border-bottom:1px solid rgba(255,255,255,0.03)}
.c-protocol{color:#4fc3f7}.c-cards{color:#81c784}.c-betting{color:#ffd54f}
.c-turn{color:#fff176}.c-showdown{color:#ef5350}.c-verify{color:#ce93d8}
.c-join{color:#4db6ac}.c-system{color:#90a4ae}.c-timeout{color:#e57373}
.c-time{color:#555;margin-right:4px}

.sc{color:#2e7d32}.sd{color:#1565c0}.sh{color:#d32f2f}.ss{color:#424242}
</style></head><body>
<div id="table"><div id="felt">
  <div id="board-area"><div id="board"></div><div id="pot-d"></div><div id="hand-d"></div></div>
</div></div>
<div id="my"><div id="my-n"></div><div id="my-c"></div></div>
<div id="ctrl"><span class="wm">Connecting...</span></div>
<div id="comms"></div>

<script>
const R='23456789TJQKA';
const SU={c:'<span class="sc">\\u2663</span>',d:'<span class="sd">\\u2666</span>',h:'<span class="sh">\\u2665</span>',s:'<span class="ss">\\u2660</span>'};
function ch(n){if(!n||n==='??')return{h:'?',c:''};let r=n[0]==='T'?'10':n[0];let s=n[n.length-1];return{h:r+(({c:'\\u2663',d:'\\u2666',h:'\\u2665',s:'\\u2660'})[s]||''),c:({c:'sc',d:'sd',h:'sh',s:'ss'})[s]||''}}

let ws,seat=-1,id='',st=null,myCards=[];
const name=new URLSearchParams(location.search).get('name')||'Player';
const POS=[{x:50,y:92},{x:8,y:55},{x:50,y:8},{x:92,y:55},{x:8,y:25},{x:92,y:25},{x:25,y:8},{x:75,y:8}];

function connect(){
  const p=location.protocol==='https:'?'wss:':'ws:';
  ws=new WebSocket(p+'//'+location.host);
  ws.onopen=()=>{ws.send(JSON.stringify({action:'join',name}))};
  ws.onmessage=e=>{try{handle(JSON.parse(e.data))}catch(x){console.error(x)}};
  ws.onclose=()=>setTimeout(connect,2000);
}

function handle(m){
  switch(m.event){
    case 'joined':seat=m.seat;id=m.id;document.getElementById('my-n').textContent=m.id+' (seat '+(m.seat+1)+')';break;
    case 'state':st=m;render();break;
    case 'hole_cards':myCards=m.cards||[];render();break;
    case 'comm':addComm(m);break;
    case 'comm_history':(m.log||[]).forEach(c=>addComm(c));break;
    case 'error':addComm({type:'system',msg:'ERR: '+m.message,time:''});break;
  }
}

function getPos(total,mySeat){
  const pos=[];
  for(let i=0;i<total;i++){
    const offset=(i-mySeat+total)%total;
    let vi;
    if(total<=2)vi=[0,2][offset];
    else if(total<=3)vi=[0,1,3][offset];
    else if(total<=4)vi=[0,1,2,3][offset];
    else vi=[0,1,2,3,4,5,6,7][offset];
    pos.push(POS[vi]);
  }
  return pos;
}

function render(){
  if(!st)return;
  const felt=document.getElementById('felt');
  const np=st.players.length;
  const positions=getPos(np,seat>=0?seat:0);

  felt.querySelectorAll('.ps,.chip-marker').forEach(e=>e.remove());

  // Board
  let bh='';
  for(let i=0;i<5;i++){
    const n=st.boardNames&&st.boardNames[i];
    if(n){const c=ch(n);bh+='<div class="cd f '+c.c+'">'+c.h+'</div>'}
    else bh+='<div class="cd e"></div>'
  }
  document.getElementById('board').innerHTML=bh;
  document.getElementById('pot-d').textContent=st.pot>0?'Pot: '+st.pot:'';
  document.getElementById('hand-d').textContent='Hand #'+(st.handCount||0)+' | '+st.phase;

  // Center of table for calculating marker positions
  const cx=50,cy=45;

  // Players around table
  for(let i=0;i<np;i++){
    const p=st.players[i];
    const pos=positions[i];
    const isMe=p.seat===seat;
    const isAct=st.currentTurn===p.seat;

    // Player info box
    const el=document.createElement('div');
    el.className='ps'+(isAct?' act':'')+(p.folded?' fold':'')+(isMe?' me':'');
    el.style.cssText='left:'+pos.x+'%;top:'+pos.y+'%;transform:translate(-50%,-50%)';

    let cards='';
    if(!isMe&&p.holeCardNames)for(const c of p.holeCardNames){
      if(c==='??')cards+='<div class="pc bk">?</div>';
      else{const d=ch(c);cards+='<div class="pc fc '+d.c+'">'+d.h+'</div>'}
    }

    el.innerHTML='<div class="pb"><div class="pn">'+p.id+'</div><div style="color:#aaa">'+p.chips+'</div>'
      +(cards?'<div class="pk">'+cards+'</div>':'')+'</div>';
    felt.appendChild(el);

    // Bet chip — positioned between player and center
    const betX=pos.x+(cx-pos.x)*0.4;
    const betY=pos.y+(cy-pos.y)*0.4;

    if(p.bet>0){
      const bet=document.createElement('div');
      bet.className='chip-marker';
      bet.style.cssText='left:'+betX+'%;top:'+betY+'%;transform:translate(-50%,-50%)';
      bet.innerHTML='<span class="bet-chip">'+p.bet+'</span>';
      felt.appendChild(bet);
    }

    // Dealer button — positioned next to player, offset toward center
    if(p.seat===st.dealerSeat){
      const dx=pos.x+(cx-pos.x)*0.2;
      const dy=pos.y+(cy-pos.y)*0.2;
      const dbtn=document.createElement('div');
      dbtn.className='chip-marker';
      dbtn.style.cssText='left:'+dx+'%;top:'+dy+'%;transform:translate(-50%,-50%)';
      dbtn.innerHTML='<span class="dealer-chip">D</span>';
      felt.appendChild(dbtn);
    }
  }

  // My cards
  let mc='';
  for(const c of myCards){const d=ch(c);mc+='<div class="mc '+d.c+'">'+d.h+'</div>'}
  document.getElementById('my-c').innerHTML=mc;

  // Controls
  const va=st.validActions||[];
  let ct='';
  if(va.length>0){
    if(va.includes('fold'))ct+='<button class="bf" onclick="act(\\'fold\\')">Fold</button>';
    if(va.includes('check'))ct+='<button class="bk" onclick="act(\\'check\\')">Check</button>';
    if(va.includes('call'))ct+='<button class="bc" onclick="act(\\'call\\')">Call '+(st.toCall||'')+'</button>';
    if(va.includes('raise')){const lb=st.toCall>0?'Raise':'Bet';ct+='<input id="ri" type="number" step="1" value="'+(st.minRaise||2)+'"><button class="br" onclick="doR()">'+lb+'</button>'}
    if(va.includes('allin'))ct+='<button class="ba" onclick="act(\\'allin\\')">All In</button>';
  }else if(st.phase==='showdown'||st.phase==='settled'){
    ct='<span class="wm">Next hand in 5s...</span>';
  }else if(st.currentTurn>=0){
    ct='<span class="wm">Waiting for '+(st.players[st.currentTurn]?.id||'...')+'</span>';
  }else{
    ct='<span class="wm">Waiting ('+np+'/${EXPECTED_PLAYERS} players)...</span>';
  }
  document.getElementById('ctrl').innerHTML=ct;
}

function act(a){ws.send(JSON.stringify({action:a}))}
function doR(){const v=document.getElementById('ri');ws.send(JSON.stringify({action:'raise',amount:parseFloat(v.value)}))}

function addComm(c){
  const el=document.getElementById('comms');
  const d=document.createElement('div');
  d.className='c-'+(c.type||'system');
  d.innerHTML='<span class="c-time">'+(c.time||'')+'</span>'+c.msg;
  el.appendChild(d);
  el.scrollTop=el.scrollHeight;
}

connect();
</script></body></html>`;

const MULTI_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verus Poker — 4 Players</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#111}
h1{text-align:center;padding:5px;color:#ffd700;font-size:1em;background:#0a0a0a;font-family:system-ui}
.g{display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:2px;padding:2px;height:calc(100vh - 30px)}
.f{position:relative;border:1px solid #333;border-radius:3px;overflow:hidden}
.f .l{position:absolute;top:2px;left:5px;z-index:10;background:rgba(0,0,0,0.8);color:#4caf50;padding:1px 6px;border-radius:2px;font-size:0.7em;font-weight:bold;font-family:system-ui}
.f iframe{width:100%;height:100%;border:none}
</style></head><body>
<h1>Verus Poker — Decentralized • Provably Fair • On-Chain</h1>
<div class="g">
<div class="f" id="f0"><div class="l">Alice</div></div>
<div class="f" id="f1"><div class="l">Bob</div></div>
<div class="f" id="f2"><div class="l">Charlie</div></div>
<div class="f" id="f3"><div class="l">Dave</div></div>
</div>
<script>
const names=['Alice','Bob','Charlie','Dave'];
names.forEach((n,i)=>{
  setTimeout(()=>{
    const f=document.getElementById('f'+i);
    const iframe=document.createElement('iframe');
    iframe.src='/player?name='+n;
    f.appendChild(iframe);
  },i*1500);
});
</script>
<div style="display:none">
</div></body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(url.pathname === '/player' ? PLAYER_HTML : MULTI_HTML);
});

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  clients.set(ws, {});
  ws.on('message', d => handleMessage(ws, d.toString()));
  ws.on('close', () => {
    const info = clients.get(ws);
    clients.delete(ws);
    if (info && info.id) addComm('join', info.id + ' disconnected');
    if ([...clients.values()].filter(c => c.seat !== undefined).length === 0) {
      engine = null; handInProgress = false; pendingAction = null; commsLog = [];
    }
    if (pendingAction && info && pendingAction.playerId === info.id) {
      pendingAction.resolve({ action: 'fold' });
      pendingAction = null;
    }
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('Verus Poker GUI at http://localhost:' + PORT));
