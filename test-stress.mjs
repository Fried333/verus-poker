#!/usr/bin/env node
/**
 * Stress Test — plays N hands with random actions across two daemons
 * Runs on LOCAL PC against dealer on SERVER. Random fold/check/call/raise/allin.
 * Reports: timing, card integrity, chip conservation, errors.
 *
 * Usage: node test-stress.mjs [--hands=10]
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { VDXF_KEYS } from './verus-rpc.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const TOTAL_HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '10');
const WAIT = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now();
function ts() { return ((Date.now() - T0) / 1000).toFixed(1); }

function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
    join(process.env.HOME, '.komodo/CHIPS/CHIPS.conf'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      const conf = readFileSync(p, 'utf8');
      const get = k => (conf.match(new RegExp('^' + k + '=(.+)$', 'm')) || [])[1];
      if (get('rpcuser') && get('rpcpassword'))
        return { host: '127.0.0.1', port: parseInt(get('rpcport') || '22778'), user: get('rpcuser'), pass: get('rpcpassword') };
    }
  }
  throw new Error('CHIPS config not found');
}

const MY_ID = 'pc-player';
const TABLE_ID = 'poker-table';
const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

// Stats
const stats = {
  played: 0, failed: 0, handTimes: [], actionWriteTimes: [], propagationTimes: [],
  settlementDelays: [], duplicateCards: 0, chipErrors: 0, verifyFails: 0,
  actions: {}, streets: {}, errors: []
};

function pickAction(valid, toCall, minRaise, chips) {
  const r = Math.random();
  if (r < 0.35 && valid.includes('check')) return { action: 'check', amount: 0 };
  if (r < 0.35 && valid.includes('call')) return { action: 'call', amount: toCall };
  if (r < 0.65 && valid.includes('raise')) {
    const amt = Math.min(chips - toCall, Math.max(minRaise, Math.floor(Math.random() * minRaise * 3)));
    return { action: 'raise', amount: Math.max(minRaise, amt) };
  }
  if (r < 0.85 && valid.includes('fold')) return { action: 'fold', amount: 0 };
  if (valid.includes('allin')) return { action: 'allin', amount: 0 };
  if (valid.includes('check')) return { action: 'check', amount: 0 };
  if (valid.includes('call')) return { action: 'call', amount: toCall };
  return { action: 'fold', amount: 0 };
}

async function playHand(p2p, handId, num) {
  const t0 = Date.now();
  let lastBSJson = null, acted = false, myCards = [], board = [], myChips = 200;
  let lastActTime = null, streetsHit = new Set();

  // Wait for cards (60s max)
  const ck = KEYS.CARD_BV + '.' + handId + '.' + MY_ID;
  for (let i = 0; i < 60; i++) {
    const cr = await p2p.read(TABLE_ID, ck);
    if (cr?.cards) { myCards = cr.cards; break; }
    await WAIT(1000);
  }
  if (!myCards.length) { stats.errors.push('H' + num + ': no cards 60s'); return false; }
  process.stdout.write(' ' + myCards.join(','));

  // Play
  for (let tick = 0; tick < 180; tick++) {
    await WAIT(1000);

    const bs = await p2p.readBettingState(handId);
    const bj = bs ? JSON.stringify(bs) : null;
    if (bj && bj !== lastBSJson) {
      lastBSJson = bj;
      if (bs.phase) streetsHit.add(bs.phase);
      if (bs.players) { const me = bs.players.find(p => p.id === MY_ID); if (me) myChips = me.chips; }

      if (bs.turn === MY_ID && bs.validActions && !acted) {
        if (lastActTime) stats.propagationTimes.push(Date.now() - lastActTime);
        const act = pickAction(bs.validActions, bs.toCall || 0, bs.minRaise || 2, myChips);
        stats.actions[act.action] = (stats.actions[act.action] || 0) + 1;
        const wt = Date.now();
        await p2p.write(MY_ID, KEYS.PLAYER_ACTION, { action: act.action, amount: act.amount, player: MY_ID, timestamp: Date.now() });
        stats.actionWriteTimes.push(Date.now() - wt);
        lastActTime = Date.now();
        acted = true;
        process.stdout.write(' ' + act.action[0]);
      } else if (bs.turn !== MY_ID) { acted = false; }
    }

    const bc = await p2p.readBoardCards(handId);
    if (bc?.board && bc.board.length > board.length) { board = bc.board; if (bc.phase) streetsHit.add(bc.phase); }

    const st = await p2p.read(TABLE_ID, KEYS.SETTLEMENT + '.' + handId);
    if (st?.verified !== undefined) {
      const handTime = (Date.now() - t0) / 1000;
      stats.handTimes.push(handTime);
      if (lastActTime) stats.settlementDelays.push(Date.now() - lastActTime);
      if (!st.verified) stats.verifyFails++;
      if (myCards.length > 0 && board.length > 0) {
        const all = [...myCards, ...board];
        if (new Set(all).size !== all.length) stats.duplicateCards++;
      }
      if (st.results) {
        const total = st.results.reduce((s, r) => s + r.chips, 0);
        if (total !== 400) { stats.chipErrors++; stats.errors.push('H' + num + ': chips=' + total); }
      }
      for (const s of streetsHit) stats.streets[s] = (stats.streets[s] || 0) + 1;
      process.stdout.write(' ' + handTime.toFixed(0) + 's ' + (st.verified ? '✓' : '✗'));
      return true;
    }
  }
  stats.errors.push('H' + num + ': timeout 180s');
  process.stdout.write(' TIMEOUT');
  return false;
}

async function main() {
  console.log('══════════════════════════════════════');
  console.log('  STRESS TEST — ' + TOTAL_HANDS + ' hands');
  console.log('══════════════════════════════════════\n');

  const p2p = createP2PLayer(findRPC(), MY_ID, TABLE_ID);
  const info = await p2p.client.getInfo();
  console.log('Block: ' + info.blocks);

  // Find session
  const stale = new Set();
  try { const s = await p2p.read(TABLE_ID, KEYS.SETTLEMENT); if (s?.session) stale.add(s.session); } catch {}
  let session = null;
  for (let i = 0; i < 60; i++) {
    const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
    if (tc?.session && !stale.has(tc.session)) { session = tc.session; break; }
    await WAIT(1000);
  }
  if (!session) { console.log('No session'); process.exit(1); }
  console.log('Session: ' + session);

  await p2p.write(MY_ID, KEYS.JOIN_REQUEST, { table: TABLE_ID, player: MY_ID, session, ready: true, timestamp: Date.now() });
  console.log('Joined\n');

  let lastHand = null;
  for (let h = 1; h <= TOTAL_HANDS; h++) {
    process.stdout.write('H' + h + ':');
    let handId = null;
    for (let i = 0; i < 120; i++) {
      const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
      if (tc?.currentHandId && tc.currentHandId !== lastHand) { handId = tc.currentHandId; break; }
      await WAIT(1000);
    }
    if (!handId) { console.log(' NO HAND'); stats.failed++; continue; }
    if (await playHand(p2p, handId, h)) { stats.played++; lastHand = handId; }
    else { stats.failed++; lastHand = handId; }
    console.log();
    await WAIT(2000);
  }

  // Report
  const avg = a => a.length ? (a.reduce((s,v) => s+v, 0) / a.length) : 0;
  const med = a => { const s = [...a].sort((x,y) => x-y); return s[Math.floor(s.length/2)] || 0; };

  console.log('\n══════════════════════════════════════');
  console.log('  REPORT');
  console.log('══════════════════════════════════════');
  console.log('Hands: ' + stats.played + '/' + TOTAL_HANDS + ' ok, ' + stats.failed + ' failed');
  console.log('Total: ' + ((Date.now()-T0)/1000).toFixed(0) + 's (' + (((Date.now()-T0)/1000)/Math.max(1,stats.played)).toFixed(0) + 's/hand)');
  console.log('\nHand time:  avg=' + avg(stats.handTimes).toFixed(0) + 's  med=' + med(stats.handTimes).toFixed(0) + 's  min=' + Math.min(...stats.handTimes||[0]).toFixed(0) + 's  max=' + Math.max(...stats.handTimes||[0]).toFixed(0) + 's');
  console.log('Action write: avg=' + avg(stats.actionWriteTimes).toFixed(0) + 'ms  med=' + med(stats.actionWriteTimes).toFixed(0) + 'ms');
  console.log('Propagation:  avg=' + (avg(stats.propagationTimes)/1000).toFixed(1) + 's  med=' + (med(stats.propagationTimes)/1000).toFixed(1) + 's');
  console.log('Settlement:   avg=' + (avg(stats.settlementDelays)/1000).toFixed(1) + 's  med=' + (med(stats.settlementDelays)/1000).toFixed(1) + 's');
  console.log('\nActions: ' + Object.entries(stats.actions).map(([k,v]) => k + '=' + v).join('  '));
  console.log('Streets: ' + Object.entries(stats.streets).map(([k,v]) => k + '=' + v).join('  '));
  console.log('\nIntegrity:');
  console.log('  Duplicate cards: ' + stats.duplicateCards);
  console.log('  Chip errors: ' + stats.chipErrors);
  console.log('  Verify fails: ' + stats.verifyFails);
  if (stats.errors.length) { console.log('  Errors:'); stats.errors.slice(0, 20).forEach(e => console.log('    ' + e)); }
  const ok = stats.duplicateCards === 0 && stats.chipErrors === 0 && stats.verifyFails === 0 && stats.failed === 0;
  console.log('\n' + (ok ? '★ ALL PASS' : '✗ ISSUES FOUND'));
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
