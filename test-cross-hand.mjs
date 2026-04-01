/**
 * Cross-Daemon Full Hand Test
 *
 * Dealer side: runs on SERVER daemon (via SSH RPC proxy)
 * Player side: runs on LOCAL daemon
 *
 * Both communicate ONLY through the CHIPS blockchain.
 * Every step timed. Must complete a full hand reliably.
 */

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
import { request } from 'http';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

// LOCAL daemon RPC (has pc-player key)
function findLocalRPC() {
  const p = join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf');
  const conf = readFileSync(p, 'utf8');
  const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
  return { host: '127.0.0.1', port: parseInt(get('rpcport')), user: get('rpcuser'), pass: get('rpcpassword') };
}

// SERVER daemon RPC — proxy through SSH tunnel
// We'll call the server via a helper that SSHs and runs the RPC there
const LOCAL_RPC = findLocalRPC();

const TABLE = 'poker-table';
const DEALER = 'poker-p1';
const PLAYER = 'pc-player';
const WRITE_GAP = 800; // ms between writes to same identity

// VDXF key cache
const vdxfCache = new Map();

async function getVdxfId(client, key) {
  if (vdxfCache.has(key)) return vdxfCache.get(key);
  const r = await client.getVdxfId(key);
  vdxfCache.set(key, r.vdxfid);
  return r.vdxfid;
}

// Write to identity (with gap tracking)
const lastWriteTime = new Map();
async function writeToId(client, idName, parent, key, data) {
  const last = lastWriteTime.get(idName) || 0;
  const gap = Date.now() - last;
  if (gap < WRITE_GAP) await WAIT(WRITE_GAP - gap);

  const vdxfid = await getVdxfId(client, key);
  const hex = Buffer.from(JSON.stringify(data)).toString('hex');
  const tx = await client.call('updateidentity', [{ name: idName, parent, contentmultimap: { [vdxfid]: hex } }]);
  lastWriteTime.set(idName, Date.now());
  return tx;
}

// Write multiple keys to one identity in 1 TX
async function batchWriteToId(client, idName, parent, entries) {
  const last = lastWriteTime.get(idName) || 0;
  const gap = Date.now() - last;
  if (gap < WRITE_GAP) await WAIT(WRITE_GAP - gap);

  const cmm = {};
  for (const [key, data] of entries) {
    const vdxfid = await getVdxfId(client, key);
    cmm[vdxfid] = Buffer.from(JSON.stringify(data)).toString('hex');
  }
  const tx = await client.call('updateidentity', [{ name: idName, parent, contentmultimap: cmm }]);
  lastWriteTime.set(idName, Date.now());
  return tx;
}

// Read a key from identity
async function readFromId(client, fullName, key) {
  const vdxfid = await getVdxfId(client, key);
  const r = await client.call('getidentitycontent', [fullName, 0, -1]);
  const cmm = r?.identity?.contentmultimap;
  if (!cmm) return null;
  const val = cmm[vdxfid];
  if (!val) return null;
  const hex = typeof val === 'string' ? val : (Array.isArray(val) ? (typeof val[0] === 'string' ? val[0] : Object.values(val[0])[0]) : null);
  if (!hex) return null;
  try { return JSON.parse(Buffer.from(hex, 'hex').toString('utf8')); } catch { return null; }
}

// Poll until data changes
async function pollForChange(client, fullName, key, lastKnown, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const data = await readFromId(client, fullName, key);
    if (data && JSON.stringify(data) !== JSON.stringify(lastKnown)) return data;
    await WAIT(1500);
  }
  return null;
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Cross-Daemon Full Hand Test                         ║');
  console.log('║  Dealer: SERVER (46.225.132.28) → poker-table        ║');
  console.log('║  Player: LOCAL (this PC) → pc-player                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  // Both use LOCAL daemon — it can read from both identities
  // But only sign for pc-player. For dealer writes, we SSH to server.
  const localClient = createClient(LOCAL_RPC);
  const localInfo = await localClient.getInfo();
  console.log('Local daemon: block ' + localInfo.blocks + '\n');

  // Get parent for identities
  const tableId = await localClient.getIdentity(TABLE + '.CHIPS@');
  const tableParent = tableId.identity.parent;
  const playerId = await localClient.getIdentity(PLAYER + '.CHIPS@');
  const playerParent = playerId.identity.parent;

  // For dealer writes, we need the SERVER daemon (has poker-table key)
  // Use SSH to execute RPC commands on the server
  async function serverRPC(method, params) {
    return new Promise((resolve, reject) => {
      const { execSync } = require ? null : {};
      import('child_process').then(cp => {
        const paramsJson = JSON.stringify(params).replace(/"/g, '\\"');
        const cmd = `ssh -i ${process.env.HOME}/.ssh/id_ed25519 -p 2400 root@46.225.132.28 "cd /root/bet && node --input-type=module -e \\"
import { createClient } from './verus-rpc.mjs';
const c = createClient({host:'127.0.0.1',port:22778,user:'user918810440',pass:'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'});
const r = await c.call('${method}', ${paramsJson.replace(/'/g, "\\'")});
console.log(JSON.stringify(r));
\\""`;
        try {
          const result = cp.execSync(cmd, { timeout: 30000 }).toString().trim();
          resolve(JSON.parse(result));
        } catch (e) {
          reject(new Error('SSH RPC failed: ' + e.message.substring(0, 80)));
        }
      });
    });
  }

  // Helper: dealer writes to poker-table via server daemon
  async function dealerWrite(key, data) {
    const last = lastWriteTime.get('dealer') || 0;
    const gap = Date.now() - last;
    if (gap < WRITE_GAP) await WAIT(WRITE_GAP - gap);

    const { execSync } = await import('child_process');
    const dataJson = JSON.stringify(data).replace(/'/g, "\\'").replace(/"/g, '\\"');
    const cmd = `ssh -i ${process.env.HOME}/.ssh/id_ed25519 -p 2400 root@46.225.132.28 "cd /root/bet && node --input-type=module -e \\"
import { createClient } from './verus-rpc.mjs';
const c = createClient({host:'127.0.0.1',port:22778,user:'user918810440',pass:'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'});
const id = await c.getIdentity('${TABLE}.CHIPS@');
const vk = await c.getVdxfId('${key}');
const hex = Buffer.from(JSON.stringify(${dataJson})).toString('hex');
const tx = await c.call('updateidentity', [{name:'${TABLE}',parent:id.identity.parent,contentmultimap:{[vk.vdxfid]:hex}}]);
console.log(tx);
\\""`;
    const tx = execSync(cmd, { timeout: 30000 }).toString().trim();
    lastWriteTime.set('dealer', Date.now());
    console.log('[' + ts() + '] DEALER → ' + key.split('.').pop() + ' tx=' + tx.substring(0, 12));
    return tx;
  }

  // Helper: player writes to pc-player via local daemon
  async function playerWrite(key, data) {
    const tx = await writeToId(localClient, PLAYER, playerParent, key, data);
    console.log('[' + ts() + '] PLAYER → ' + key.split('.').pop() + ' tx=' + tx.substring(0, 12));
    return tx;
  }

  // Helper: player reads from poker-table via local daemon
  async function playerRead(key) {
    return readFromId(localClient, TABLE + '.CHIPS@', key);
  }

  // Helper: player reads from pc-player via local daemon
  async function playerReadSelf(key) {
    return readFromId(localClient, PLAYER + '.CHIPS@', key);
  }

  const session = 'xhand_' + Date.now().toString(36);

  // ════════════════════════════════════
  // STEP 1: Dealer opens table
  // ════════════════════════════════════
  console.log('── STEP 1: Open table ──');
  await dealerWrite('chips.vrsc::poker.sg777z.t_table_info', { dealer: DEALER, session, smallBlind: 1, bigBlind: 2 });

  // Player reads table config
  let tc = null;
  for (let i = 0; i < 10; i++) {
    tc = await playerRead('chips.vrsc::poker.sg777z.t_table_info');
    if (tc && tc.session === session) break;
    console.log('[' + ts() + '] Waiting for table config...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player sees table: session=' + tc?.session);
  if (tc?.session !== session) { console.log('FAIL: table config'); process.exit(1); }

  // ════════════════════════════════════
  // STEP 2: Shuffle + deal
  // ════════════════════════════════════
  console.log('\n── STEP 2: Shuffle ──');
  const pd = [playerInit(52, DEALER), playerInit(52, PLAYER)];
  const dd = dealerShuffle(pd, 52);
  const cd = cashierShuffle(dd.blindedDecks, 2, 52, 2);

  // Decode hole cards
  let cardPos = 0;
  const holeCards = {};
  for (let i = 0; i < 2; i++) {
    const cards = [];
    for (let c = 0; c < 2; c++) {
      const idx = decodeCard(cd.finalDecks[i][cardPos], cd.b[i][cardPos], dd.e[i], dd.d, pd[i].sessionKey, pd[i].initialDeck);
      cards.push(idx % 52); cardPos++;
    }
    holeCards[[DEALER, PLAYER][i]] = cards;
  }
  console.log('[' + ts() + '] ' + DEALER + ': ' + holeCards[DEALER].map(cardToString).join(' '));
  console.log('[' + ts() + '] ' + PLAYER + ': ' + holeCards[PLAYER].map(cardToString).join(' '));

  // Write card reveals to table (batch both + betting state in 1 TX via server)
  const { execSync } = await import('child_process');
  const dealCards = {
    [DEALER]: holeCards[DEALER].map(cardToString),
    [PLAYER]: holeCards[PLAYER].map(cardToString)
  };
  // Write card reveals separately (can't batch across SSH easily)
  await dealerWrite('chips.vrsc::poker.sg777z.card_bv.' + PLAYER, { player: PLAYER, cards: dealCards[PLAYER], hand: 1, session });
  await dealerWrite('chips.vrsc::poker.sg777z.card_bv.' + DEALER, { player: DEALER, cards: dealCards[DEALER], hand: 1, session });

  // Player reads their cards
  console.log('\n── STEP 3: Player reads cards ──');
  let myCards = null;
  for (let i = 0; i < 15; i++) {
    const cr = await playerRead('chips.vrsc::poker.sg777z.card_bv.' + PLAYER);
    if (cr && cr.session === session) { myCards = cr.cards; break; }
    console.log('[' + ts() + '] Waiting for cards...');
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player cards: ' + (myCards ? myCards.join(' ') : 'NONE'));
  if (!myCards) { console.log('FAIL: no cards'); process.exit(1); }

  // ════════════════════════════════════
  // STEP 4: Play betting rounds
  // ════════════════════════════════════
  console.log('\n── STEP 4: Betting ──');
  const game = createGame({ smallBlind: 1, bigBlind: 2, rake: 0 });
  addPlayer(game, DEALER, 200); addPlayer(game, PLAYER, 200);
  startHand(game); postBlinds(game);
  setHoleCards(game, 0, holeCards[DEALER]); setHoleCards(game, 1, holeCards[PLAYER]);

  let revealPos = 4;

  while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
    // Deal community cards if needed
    if (game.phase === 'flop' && game.board.length === 0) {
      const cards = [];
      for (let i = 0; i < 3; i++) { cards.push(decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52); revealPos++; }
      dealBoard(game, cards);
      await dealerWrite('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'flop', session });
      // Player reads board
      let bc = null;
      for (let i = 0; i < 10; i++) { bc = await playerRead('chips.vrsc::poker.sg777z.t_board_cards'); if (bc && bc.session === session && bc.phase === 'flop') break; await WAIT(2000); }
      console.log('[' + ts() + '] Flop: ' + (bc?.board?.join(' ') || '?'));
    } else if (game.phase === 'turn' && game.board.length === 3) {
      dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]); revealPos++;
      await dealerWrite('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'turn', session });
      let bc = null;
      for (let i = 0; i < 10; i++) { bc = await playerRead('chips.vrsc::poker.sg777z.t_board_cards'); if (bc && bc.session === session && bc.phase === 'turn') break; await WAIT(2000); }
      console.log('[' + ts() + '] Turn: ' + cardToString(game.board[3]));
    } else if (game.phase === 'river' && game.board.length === 4) {
      dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]); revealPos++;
      await dealerWrite('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'river', session });
      let bc = null;
      for (let i = 0; i < 10; i++) { bc = await playerRead('chips.vrsc::poker.sg777z.t_board_cards'); if (bc && bc.session === session && bc.phase === 'river') break; await WAIT(2000); }
      console.log('[' + ts() + '] River: ' + cardToString(game.board[4]));
    }

    if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }

    const seat = game.currentTurn;
    const p = game.players[seat];
    const va = getValidActions(game);
    const toCall = getToCall(game, seat);

    if (p.id === PLAYER) {
      // Dealer writes turn → player reads → player writes action → dealer reads
      await dealerWrite('chips.vrsc::poker.sg777z.t_betting_state', { turn: PLAYER, validActions: va, toCall, pot: game.pot, session });

      // Player reads turn
      let bs = null;
      for (let i = 0; i < 15; i++) {
        bs = await playerRead('chips.vrsc::poker.sg777z.t_betting_state');
        if (bs && bs.session === session && bs.turn === PLAYER) break;
        await WAIT(2000);
      }
      if (!bs || bs.turn !== PLAYER) { console.log('[' + ts() + '] FAIL: player never saw turn'); process.exit(1); }

      // Player acts (auto-play: check or call)
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      await playerWrite('chips.vrsc::poker.sg777z.p_betting_action', { action: act, amount: 0, session, timestamp: Date.now() });

      // Dealer reads action (via server daemon reading pc-player)
      let action = null;
      for (let i = 0; i < 15; i++) {
        // Read from server side
        try {
          const result = execSync(`ssh -i ${process.env.HOME}/.ssh/id_ed25519 -p 2400 root@46.225.132.28 "cd /root/bet && node --input-type=module -e \\"
import { createClient } from './verus-rpc.mjs';
const c = createClient({host:'127.0.0.1',port:22778,user:'user918810440',pass:'passfde4eac81e50dd465529238848a8a77b32c8d17ebb4345c8ebe4150ca3aa9374d1'});
const vk = await c.getVdxfId('chips.vrsc::poker.sg777z.p_betting_action');
const r = await c.call('getidentitycontent', ['pc-player.CHIPS@', 0, -1]);
const cmm = r?.identity?.contentmultimap;
if (cmm && cmm[vk.vdxfid]) {
  const hex = typeof cmm[vk.vdxfid]==='string'?cmm[vk.vdxfid]:(Array.isArray(cmm[vk.vdxfid])?(typeof cmm[vk.vdxfid][0]==='string'?cmm[vk.vdxfid][0]:Object.values(cmm[vk.vdxfid][0])[0]):null);
  if(hex) console.log(Buffer.from(hex,'hex').toString('utf8'));
  else console.log('null');
} else console.log('null');
\\""`, { timeout: 15000 }).toString().trim();
          if (result && result !== 'null') {
            const parsed = JSON.parse(result);
            if (parsed.session === session) { action = parsed; break; }
          }
        } catch (e) {}
        console.log('[' + ts() + '] Waiting for action to propagate to server...');
        await WAIT(2000);
      }

      if (action) {
        playerAction(game, seat, action.action, action.amount || 0);
        console.log('[' + ts() + '] ' + PLAYER + ': ' + action.action);
      } else {
        console.log('[' + ts() + '] FAIL: dealer never saw player action');
        process.exit(1);
      }
    } else {
      // Dealer auto-plays
      const act = va.includes('check') ? 'check' : va.includes('call') ? 'call' : 'fold';
      playerAction(game, seat, act, 0);
      console.log('[' + ts() + '] ' + DEALER + ': ' + act);
      // Write so player can see
      await dealerWrite('chips.vrsc::poker.sg777z.t_betting_state', { turn: DEALER, action: act, pot: game.pot, session });
    }
  }

  // ════════════════════════════════════
  // STEP 5: Showdown + verify
  // ════════════════════════════════════
  console.log('\n── STEP 5: Showdown ──');
  if (game.phase === SHOWDOWN) {
    while (game.board.length < 5) {
      dealBoard(game, [decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, pd[0].sessionKey, pd[0].initialDeck) % 52]);
      revealPos++;
    }
    await dealerWrite('chips.vrsc::poker.sg777z.t_board_cards', { board: game.board.map(cardToString), phase: 'showdown', session });
    const payouts = settleHand(game, evaluateHand);
    applyPayouts(game, payouts);
    console.log('[' + ts() + '] Board: ' + game.board.map(cardToString).join(' '));
    console.log('[' + ts() + '] Winner: ' + Object.entries(payouts).filter(([, v]) => v > 0).map(([s, v]) => game.players[s].id + ':+' + v).join(' '));
  }

  const v = verifyGame(pd, dd, cd, 52);
  console.log('[' + ts() + '] Verify: ' + (v.valid ? 'PASS' : 'FAIL'));

  // Write settlement
  await dealerWrite('chips.vrsc::poker.sg777z.t_settlement_info', { verified: v.valid, session, results: game.players.map(p => ({ id: p.id, chips: p.chips })) });

  // Player reads settlement
  let st = null;
  for (let i = 0; i < 10; i++) {
    st = await playerRead('chips.vrsc::poker.sg777z.t_settlement_info');
    if (st && st.session === session) break;
    await WAIT(2000);
  }
  console.log('[' + ts() + '] Player sees settlement: ' + (st ? 'verified=' + st.verified : 'NONE'));

  // ════════════════════════════════════
  const total = game.players.reduce((s, p) => s + p.chips, 0);
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('  Time: ' + ts());
  console.log('  Verified: ' + v.valid);
  console.log('  Chips: ' + total + ' (conserved: ' + (total === 400) + ')');
  game.players.forEach(p => console.log('  ' + p.id + ': ' + p.chips));
  console.log('  Cross-daemon: PASS');
  console.log('╚══════════════════════════════════════════════════════════╝');
  process.exit(v.valid && total === 400 ? 0 : 1);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
