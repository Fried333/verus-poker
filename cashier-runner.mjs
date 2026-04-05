#!/usr/bin/env node
/**
 * Cashier Runner — independent Stage III processor
 * Polls table for shuffle requests, runs cashierShuffle, writes results back.
 * Runs on .59 server with cashier1/cashier2 identities.
 *
 * Usage: node cashier-runner.mjs --id=cashier1 --table=ptable2
 */

import { createP2PLayer } from './p2p-layer.mjs';
import { cashierShuffle, verifyGame } from './protocol.mjs';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

process.on('uncaughtException', (err) => { console.error('[CASHIER CRASH]', err.message, err.stack); });
process.on('unhandledRejection', (err) => { console.error('[CASHIER UNHANDLED]', err?.message || err); });

const args = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, v] = a.substring(2).split('=');
    return [k, v || true];
  })
);
const MY_ID = args.id || 'cashier1';
const TABLE_ID = args.table || 'ptable2';

const KEYS = {
  TABLE_CONFIG:   'chips.vrsc::poker.sg777z.t_table_info',
  SHUFFLE_REQ:    'chips.vrsc::poker.sg777z.t_shuffle_request',
  CASHIER_RESULT: 'chips.vrsc::poker.sg777z.c_shuffle_result',
  SETTLEMENT:     'chips.vrsc::poker.sg777z.t_settlement_info',
};

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

async function main() {
  console.log('[CASHIER ' + MY_ID + '] Starting...');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, MY_ID, TABLE_ID);

  const info = await p2p.client.getInfo();
  console.log('[CASHIER ' + MY_ID + '] Chain: block ' + info.blocks);

  let lastProcessedHand = null;
  let lastSession = null;

  console.log('[CASHIER ' + MY_ID + '] Watching table ' + TABLE_ID + '...\n');

  while (true) {
    try {
      // 1. Check for shuffle request — try base key first, then per-hand key
      let req = await p2p.read(TABLE_ID, KEYS.SHUFFLE_REQ);

      // If base key shows same hand we already did, check per-hand keys via table config
      if (req && req.handId === lastProcessedHand) {
        const tc = await p2p.read(TABLE_ID, KEYS.TABLE_CONFIG);
        if (tc && tc.currentHandId && tc.currentHandId !== lastProcessedHand) {
          // Table has moved on — check per-hand key
          const perHandReq = await p2p.read(TABLE_ID, KEYS.SHUFFLE_REQ + '.' + tc.currentHandId);
          if (perHandReq && perHandReq.handId) req = perHandReq;
        }
      }

      if (req && req.handId && req.handId !== lastProcessedHand) {
        // Skip stale requests (older than 60s)
        if (req.timestamp && Date.now() - req.timestamp > 60000) {
          console.log('[CASHIER ' + MY_ID + '] Skipping stale: ' + req.handId + ' (' + Math.round((Date.now() - req.timestamp) / 1000) + 's old)');
          lastProcessedHand = req.handId;
          continue;
        }
        console.log('[CASHIER ' + MY_ID + '] Shuffle request: hand=' + req.handId + ' players=' + req.numPlayers);

        // Read each player's blinded deck — keep trying until 50s (dealer times out at 60s)
        const blindedDecks = [];
        const readStart = Date.now();
        for (let i = 0; i < req.numPlayers; i++) {
          const deckKey = 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + req.handId + '.p' + i;
          let deckData = null;
          while (Date.now() - readStart < 50000) {
            deckData = await p2p.read(TABLE_ID, deckKey);
            if (deckData && deckData.deck) break;
            deckData = null;
            await WAIT(500);
          }
          if (!deckData || !deckData.deck) {
            console.log('[CASHIER ' + MY_ID + '] Failed to read deck for player ' + i + ' after ' + Math.round((Date.now() - readStart) / 1000) + 's');
            continue;
          }
          blindedDecks.push(deckData.deck);
        }

        if (blindedDecks.length !== req.numPlayers) {
          console.log('[CASHIER ' + MY_ID + '] Missing decks, skipping');
          lastProcessedHand = req.handId;
          continue;
        }

        // 2. Run Stage III
        const t0 = Date.now();
        const cd = cashierShuffle(blindedDecks, req.numPlayers, req.numCards, req.threshold);
        const ms = Date.now() - t0;
        console.log('[CASHIER ' + MY_ID + '] Stage III done (' + ms + 'ms). Commitment: ' + cd.cashierCommitment.substring(0, 16) + '...');

        // 3. Write meta FIRST (dealer polls for this), then decks sequentially
        const t1 = Date.now();
        await p2p.write(MY_ID, KEYS.CASHIER_RESULT + '.' + req.handId, {
          cashier: MY_ID, handId: req.handId, session: req.session,
          sigma_Cashier: cd.sigma_Cashier, cashierCommitment: cd.cashierCommitment,
          numPlayers: req.numPlayers, timestamp: Date.now()
        });
        // Write deck/b data — dealer will retry-read these
        for (let i = 0; i < req.numPlayers; i++) {
          await p2p.write(MY_ID, KEYS.CASHIER_RESULT + '.' + req.handId + '.deck.' + i,
            { player: i, deck: cd.finalDecks[i] });
          await p2p.write(MY_ID, KEYS.CASHIER_RESULT + '.' + req.handId + '.b.' + i,
            { player: i, b: cd.b[i] });
        }
        console.log('[CASHIER ' + MY_ID + '] Result written (' + (req.numPlayers * 2 + 1) + ' keys, ' + (Date.now() - t1) + 'ms)');

        lastProcessedHand = req.handId;
        lastSession = req.session;
      }

      // 4. Check for settlement — verify and vote
      if (lastSession) {
        const settlement = await p2p.read(TABLE_ID, KEYS.SETTLEMENT + '.' + lastProcessedHand);
        if (settlement && settlement.verified !== undefined) {
          // Already settled — we could write a vote here
          // For now just log
        }
      }

    } catch (e) {
      console.log('[CASHIER ' + MY_ID + '] Error: ' + e.message);
      if (e.stack) console.log(e.stack);
    }

    await WAIT(1000);
  }
}

main().catch(e => { console.error('[CASHIER] FATAL:', e.message); process.exit(1); });
