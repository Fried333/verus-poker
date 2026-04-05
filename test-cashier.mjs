#!/usr/bin/env node
/**
 * Cashier reliability test — no players, no GUI, just shuffle round-trips.
 * Runs locally, writes to ptable2, waits for cashier1 on .59 to respond.
 *
 * Usage: node test-cashier.mjs [--hands=10]
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { playerInit, dealerShuffle, cashierShuffle, decodeCard } from './protocol.mjs';
import { cardToString } from './hand-eval.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const HANDS = parseInt(process.argv.find(a => a.startsWith('--hands='))?.split('=')[1] || '5');
const TABLE_ID = 'ptable2';
const CASHIER_ID = 'cashier1';

function findRPC() {
  const paths = [
    join(process.env.HOME, '.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf'),
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

async function main() {
  console.log('=== Cashier Reliability Test ===');
  console.log('Hands: ' + HANDS + ' | Table: ' + TABLE_ID + ' | Cashier: ' + CASHIER_ID + '\n');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, TABLE_ID, TABLE_ID);
  const info = await p2p.client.getInfo();
  console.log('Chain: block ' + info.blocks + '\n');

  const results = [];

  for (let h = 1; h <= HANDS; h++) {
    const handId = 'test_' + Date.now().toString(36) + '_h' + h;
    console.log('--- Hand ' + h + ' (' + handId + ') ---');
    const t0 = Date.now();

    // Stage I + II (local)
    const numPlayers = 2;
    const numCards = 52;
    const playerData = [playerInit(numCards, 'p1'), playerInit(numCards, 'p2')];
    const dd = dealerShuffle(playerData, numCards);
    const threshold = 2;
    const tShuffle = Date.now() - t0;
    console.log('  Stage I+II: ' + tShuffle + 'ms');

    // Write shuffle request to table (sequential writes)
    const tWrite0 = Date.now();
    await p2p.write(TABLE_ID, 'chips.vrsc::poker.sg777z.t_shuffle_request', {
      handId, session: 'test', numPlayers, numCards, threshold, timestamp: Date.now()
    });
    for (let i = 0; i < numPlayers; i++) {
      await p2p.write(TABLE_ID, 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + handId + '.p' + i,
        { player: i, deck: dd.blindedDecks[i] });
    }
    const tWrite = Date.now() - tWrite0;
    console.log('  Dealer writes: ' + tWrite + 'ms (' + (numPlayers + 1) + ' TXs)');

    // Wait for cashier response
    const tPoll0 = Date.now();
    const cashierResultKey = 'chips.vrsc::poker.sg777z.c_shuffle_result.' + handId;
    let cashierMeta = null;
    let pollCount = 0;
    for (let i = 0; i < 120; i++) {
      cashierMeta = await p2p.read(CASHIER_ID, cashierResultKey);
      pollCount++;
      if (cashierMeta && cashierMeta.handId === handId) break;
      cashierMeta = null;
      await WAIT(500);
    }
    const tPoll = Date.now() - tPoll0;

    if (!cashierMeta) {
      console.log('  CASHIER TIMEOUT after ' + tPoll + 'ms (' + pollCount + ' polls)');
      results.push({ hand: h, status: 'TIMEOUT', total: Date.now() - t0 });
      continue;
    }
    console.log('  Cashier responded: ' + tPoll + 'ms (' + pollCount + ' polls)');

    // Read cashier decks — retry since cross-node mempool propagation takes time
    const tRead0 = Date.now();
    const finalDecks = [];
    const bValues = [];
    for (let i = 0; i < numPlayers; i++) {
      let deckData = null, bData = null;
      for (let retry = 0; retry < 20; retry++) {
        if (!deckData) deckData = await p2p.read(CASHIER_ID, cashierResultKey + '.deck.' + i);
        if (!bData) bData = await p2p.read(CASHIER_ID, cashierResultKey + '.b.' + i);
        if (deckData && bData) break;
        await WAIT(500);
      }
      finalDecks.push(deckData ? deckData.deck : null);
      bValues.push(bData ? bData.b : null);
    }
    const tRead = Date.now() - tRead0;
    console.log('  Read decks: ' + tRead + 'ms');

    // Verify: try to decode first card
    let decoded = '?';
    console.log('  DEBUG: finalDecks[0]=' + (finalDecks[0] ? 'has ' + finalDecks[0].length + ' cards' : 'NULL'));
    console.log('  DEBUG: bValues[0]=' + (bValues[0] ? 'has ' + bValues[0].length + ' values' : 'NULL'));
    if (finalDecks[0] && bValues[0]) {
      // Debug: check types after chain round-trip
      const fd0 = finalDecks[0][0];
      const bv0 = bValues[0][0];
      const e0 = dd.e[0];
      const d0 = dd.d;
      const sk = playerData[0].sessionKey;
      console.log('  DEBUG types: fd0=' + typeof fd0 + ' bv0=' + typeof bv0 + ' e0=' + typeof e0 + ' d0=' + typeof d0 + ' sk=' + typeof sk);
      console.log('  DEBUG vals: fd0=' + String(fd0).substring(0, 20) + ' bv0=' + String(bv0).substring(0, 20));

      // Also try local cashier shuffle for comparison
      const localCd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);
      const localCard = decodeCard(localCd.finalDecks[0][0], localCd.b[0][0], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
      console.log('  LOCAL decode: ' + cardToString(localCard) + ' (type fd0=' + typeof localCd.finalDecks[0][0] + ' bv0=' + typeof localCd.b[0][0] + ')');

      try {
        const cd = { finalDecks, b: bValues, sigma_Cashier: cashierMeta.sigma_Cashier };
        const cardIdx = decodeCard(cd.finalDecks[0][0], cd.b[0][0], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
        decoded = cardToString(cardIdx);
      } catch (e) {
        decoded = 'ERROR: ' + e.message;
      }
    }

    const total = Date.now() - t0;
    console.log('  First card: ' + decoded);
    console.log('  TOTAL: ' + total + 'ms');
    console.log('');

    results.push({
      hand: h, status: 'OK', total,
      shuffle: tShuffle, write: tWrite, poll: tPoll, read: tRead,
      card: decoded
    });
  }

  // Summary
  console.log('=== SUMMARY ===');
  const ok = results.filter(r => r.status === 'OK');
  const fail = results.filter(r => r.status !== 'OK');
  console.log('Success: ' + ok.length + '/' + HANDS);
  console.log('Failed: ' + fail.length);
  if (ok.length > 0) {
    const avg = Math.round(ok.reduce((s, r) => s + r.total, 0) / ok.length);
    const avgWrite = Math.round(ok.reduce((s, r) => s + r.write, 0) / ok.length);
    const avgPoll = Math.round(ok.reduce((s, r) => s + r.poll, 0) / ok.length);
    const avgRead = Math.round(ok.reduce((s, r) => s + r.read, 0) / ok.length);
    console.log('Avg total: ' + avg + 'ms');
    console.log('Avg dealer writes: ' + avgWrite + 'ms');
    console.log('Avg cashier response: ' + avgPoll + 'ms');
    console.log('Avg read decks: ' + avgRead + 'ms');
  }
  fail.forEach(r => console.log('  Hand ' + r.hand + ': ' + r.status));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
