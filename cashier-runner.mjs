#!/usr/bin/env node
/**
 * Cashier Runner — independent Stage III processor
 * Polls table for shuffle requests via chain, runs cashierShuffle.
 * Card reveals served via WebSocket (instant) — chain for commitment only.
 *
 * Usage: node cashier-runner.mjs --id=cashier1 --table=ptable2 --wsport=4000
 */

import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { createP2PLayer } from './p2p-layer.mjs';
import { cashierShuffle, verifyGame } from './protocol.mjs';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'fs';
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
const WS_PORT = parseInt(args.wsport || '4000');

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

// ──────────────────────────────────────
// Disk persistence — survive crashes mid-hand
// ──────────────────────────────────────
const STATE_DIR = join(process.env.HOME, '.verus-poker', 'cashier-' + MY_ID + '-' + TABLE_ID);
function ensureStateDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}
// BigInt-safe JSON: tag BigInts as {$bn: hex} on save, restore on load
function bnReplacer(_key, value) {
  if (typeof value === 'bigint') return { $bn: value.toString(16) };
  return value;
}
function bnReviver(_key, value) {
  if (value && typeof value === 'object' && typeof value.$bn === 'string') {
    return BigInt('0x' + value.$bn);
  }
  return value;
}
function persistHand(handId, handData) {
  ensureStateDir();
  const file = join(STATE_DIR, handId + '.json');
  try {
    writeFileSync(file, JSON.stringify(handData, bnReplacer));
  } catch (e) {
    console.log('[CASHIER] persist error: ' + e.message);
  }
}
function deleteHand(handId) {
  try { unlinkSync(join(STATE_DIR, handId + '.json')); } catch {}
}
function loadAllHands() {
  ensureStateDir();
  const map = new Map();
  for (const f of readdirSync(STATE_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const data = JSON.parse(readFileSync(join(STATE_DIR, f), 'utf8'), bnReviver);
      const handId = f.replace(/\.json$/, '');
      map.set(handId, data);
      console.log('[CASHIER] Reloaded hand ' + handId + ' from disk');
    } catch (e) {
      console.log('[CASHIER] Failed to reload ' + f + ': ' + e.message);
    }
  }
  return map;
}

async function main() {
  console.log('[CASHIER ' + MY_ID + '] Starting...');

  const rpc = findRPC();
  const p2p = createP2PLayer(rpc, MY_ID, TABLE_ID);

  const info = await p2p.client.getInfo();
  console.log('[CASHIER ' + MY_ID + '] Chain: block ' + info.blocks);

  // Reload any in-flight hands from disk (crash recovery)
  const activeHands = loadAllHands();
  let lastProcessedHand = null;
  let lastSession = null;
  if (activeHands.size > 0) {
    console.log('[CASHIER ' + MY_ID + '] Recovered ' + activeHands.size + ' in-flight hand(s) from disk');
    // Set lastProcessedHand to the most recent so we don't re-process
    for (const handId of activeHands.keys()) lastProcessedHand = handId;
  }

  console.log('[CASHIER ' + MY_ID + '] State dir: ' + STATE_DIR);
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

      if (req && req.handId && req.handId !== lastProcessedHand && !activeHands.has(req.handId)) {
        // Skip stale requests (older than 5 minutes — accounts for slow chain
        // propagation between un-peered daemons. If a hand request takes more
        // than 5 minutes to reach us, the dealer has almost certainly given up.)
        if (req.timestamp && Date.now() - req.timestamp > 300000) {
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

        // 2b. Persist b[] to disk IMMEDIATELY — before chain writes (which take ~26s)
        // This closes the crash window between Stage III and the post-write persist
        const handStateEarly = { b: cd.b, sigma: cd.sigma_Cashier };
        activeHands.set(req.handId, handStateEarly);
        persistHand(req.handId, handStateEarly);
        console.log('[CASHIER ' + MY_ID + '] Persisted b[] to disk (pre-chain-write)');

        // 3. Write meta + ALL decks in one batch (now possible because decks are
        //    small — only 11 cards instead of 52, ~1.5KB each).
        //    Total batch: ~250B meta + 3 × ~1.5KB decks ≈ 5KB. Fits one TX.
        const t1 = Date.now();
        const metaData = {
          cashier: MY_ID, handId: req.handId, session: req.session,
          cashierCommitment: cd.cashierCommitment,
          numPlayers: req.numPlayers, timestamp: Date.now()
        };
        const outBatch = [
          { key: KEYS.CASHIER_RESULT + '.' + req.handId, data: metaData }
        ];
        for (let i = 0; i < req.numPlayers; i++) {
          outBatch.push({
            key: KEYS.CASHIER_RESULT + '.' + req.handId + '.deck.' + i,
            data: { player: i, deck: cd.finalDecks[i] }
          });
        }
        try {
          await p2p.writeBatch(MY_ID, outBatch);
          console.log('[CASHIER ' + MY_ID + '] All decks batched in 1 TX (' + req.numPlayers + ' decks)');
        } catch (e) {
          // Fallback: too big — split meta+deck0 vs the rest
          console.log('[CASHIER ' + MY_ID + '] Batch failed, falling back: ' + e.message);
          await p2p.writeBatch(MY_ID, outBatch.slice(0, 2));
          for (let i = 1; i < req.numPlayers; i++) {
            await p2p.write(MY_ID, KEYS.CASHIER_RESULT + '.' + req.handId + '.deck.' + i,
              { player: i, deck: cd.finalDecks[i] });
          }
        }
        console.log('[CASHIER ' + MY_ID + '] Written (' + (Date.now() - t1) + 'ms)');

        // (Already persisted above — this is the post-chain-write checkpoint, no-op)
        lastProcessedHand = req.handId;
        lastSession = req.session;
      }

      // 4. Check for card reveal requests
      for (const [handId, handData] of activeHands) {
        const revealKey = 'chips.vrsc::poker.sg777z.t_reveal_request.' + handId;
        const revealReq = await p2p.read(TABLE_ID, revealKey);
        if (revealReq && revealReq.positions && !revealReq._processed) {
          // Check if we already responded to this exact request
          const reqId = revealReq.timestamp || 0;
          if (handData.lastRevealId === reqId) continue;
          handData.lastRevealId = reqId;

          const positions = revealReq.positions; // array of card positions to reveal
          const playerIdx = revealReq.playerIdx || 0;
          const blindings = {};
          for (const pos of positions) {
            if (handData.b[playerIdx] && handData.b[playerIdx][pos] !== undefined) {
              blindings[pos] = handData.b[playerIdx][pos];
            }
          }
          // Write blinding values back
          const revealResultKey = 'chips.vrsc::poker.sg777z.c_reveal_result.' + handId + '.' + reqId;
          await p2p.write(MY_ID, revealResultKey, {
            handId, playerIdx, positions, blindings, timestamp: Date.now()
          });
          console.log('[CASHIER ' + MY_ID + '] Revealed ' + positions.length + ' cards for player ' + playerIdx);
        }
      }

      // 5. Clean up settled hands — check ALL active hands, not just last
      for (const handId of Array.from(activeHands.keys())) {
        try {
          const settlement = await p2p.read(TABLE_ID, KEYS.SETTLEMENT + '.' + handId);
          if (settlement && settlement.verified !== undefined) {
            activeHands.delete(handId);
            deleteHand(handId);
            console.log('[CASHIER ' + MY_ID + '] Cleaned up settled hand ' + handId);
          }
        } catch {}
      }

    } catch (e) {
      console.log('[CASHIER ' + MY_ID + '] Error: ' + e.message);
      if (e.stack) console.log(e.stack);
    }

    await WAIT(1000);
  }
}

main().catch(e => { console.error('[CASHIER] FATAL:', e.message); process.exit(1); });
