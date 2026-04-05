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
      // 1. Check for shuffle request on table
      const req = await p2p.read(TABLE_ID, KEYS.SHUFFLE_REQ);
      if (req) console.log('[CASHIER ' + MY_ID + '] Read shuffle req: handId=' + (req.handId || 'none') + ' last=' + lastProcessedHand);

      if (req && req.handId && req.handId !== lastProcessedHand) {
        console.log('[CASHIER ' + MY_ID + '] Shuffle request: hand=' + req.handId + ' players=' + req.numPlayers);

        // Read each player's blinded deck
        const blindedDecks = [];
        for (let i = 0; i < req.numPlayers; i++) {
          const deckKey = 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + req.handId + '.p' + i;
          let deckData = null;
          for (let attempt = 0; attempt < 20; attempt++) {
            deckData = await p2p.read(TABLE_ID, deckKey);
            if (deckData && deckData.deck) break;
            await WAIT(500);
          }
          if (!deckData || !deckData.deck) {
            console.log('[CASHIER ' + MY_ID + '] Failed to read deck for player ' + i);
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

        // 3. Write result — batch all keys in ONE TX
        const resultEntries = [];
        resultEntries.push({ key: KEYS.CASHIER_RESULT + '.' + req.handId, data: {
          cashier: MY_ID, handId: req.handId, session: req.session,
          sigma_Cashier: cd.sigma_Cashier, cashierCommitment: cd.cashierCommitment,
          numPlayers: req.numPlayers, timestamp: Date.now()
        }});
        for (let i = 0; i < req.numPlayers; i++) {
          resultEntries.push({ key: KEYS.CASHIER_RESULT + '.' + req.handId + '.deck.' + i,
            data: { player: i, deck: cd.finalDecks[i] }
          });
          resultEntries.push({ key: KEYS.CASHIER_RESULT + '.' + req.handId + '.b.' + i,
            data: { player: i, b: cd.b[i] }
          });
        }
        await p2p.writeBatch(MY_ID, resultEntries);
        console.log('[CASHIER ' + MY_ID + '] Result written (' + resultEntries.length + ' keys, 1 TX)');

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
    }

    await WAIT(2000);
  }
}

main().catch(e => { console.error('[CASHIER] FATAL:', e.message); process.exit(1); });
