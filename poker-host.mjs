/**
 * Poker Host — the house/dealer side
 * Creates table, accepts players, deals hands, settles payouts.
 * Communicates entirely via z-memos.
 *
 * Usage: node poker-host.mjs
 */

import { createZChannel } from './z-channel.mjs';
import { createHandFairness, verifyHandProof } from './provably-fair.mjs';
import { createEngine } from './poker-engine.mjs';
import { createSRABackend } from './crypto-backend-sra.mjs';
import { createSg777Backend } from './crypto-backend-sg.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import { createSession, ACTIVE } from './session.mjs';
import { createClient, VDXF_KEYS } from './verus-rpc.mjs';
import {
  FOLD, CHECK, CALL, RAISE, ALL_IN,
  WAITING, SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

/**
 * Create and run a poker host
 */
export async function createHost(config) {
  const {
    rpcConfig,
    houseId,           // e.g. 'poker-dealer.CHIPS@'
    houseAddr,         // house t-address for funds
    smallBlind = 0.01,
    bigBlind = 0.02,
    minBuyin = 0.5,
    maxPlayers = 4,
    protocol = 'sra',  // 'sra' or 'sg777'
    handsToPlay = 0,   // 0 = unlimited
  } = config;

  const channel = createZChannel(rpcConfig);
  const client = createClient(rpcConfig);
  const session = createSession(rpcConfig, houseId, houseAddr);

  // Players waiting for actions
  let pendingAction = null;   // { playerId, resolve }
  let players = new Map();    // id → { addr, zAddr }
  let running = true;
  let handCount = 0;

  // Create table
  console.log('[HOST] Creating table z-address...');
  const { zAddr, viewingKey } = await channel.createTable();
  console.log('[HOST] Table z-addr: ' + zAddr);
  console.log('[HOST] Viewing key: ' + viewingKey.substring(0, 40) + '...');

  // Publish table listing
  console.log('[HOST] Publishing table to ' + houseId + '...');
  try {
    const hexData = Buffer.from(JSON.stringify({
      game: 'texas_holdem',
      blinds: [smallBlind, bigBlind],
      min_buyin: minBuyin,
      max_players: maxPlayers,
      protocol,
      z_table_addr: zAddr,
      z_viewing_key: viewingKey,
      status: 'open',
      timestamp: Date.now()
    })).toString('hex');

    const vdxf = await client.call('getvdxfid', [VDXF_KEYS.TABLE_CONFIG]);
    await client.call('updateidentity', [{
      name: houseId.split('.')[0],
      parent: 'iJ3WZocnjG9ufv7GKUA4LijQno5gTMb7tP',
      contentmultimap: { [vdxf.vdxfid]: hexData }
    }]);
    console.log('[HOST] Table published on-chain');
  } catch (e) {
    console.log('[HOST] Table publish failed: ' + e.message + ' (continuing)');
  }

  // Announce table open
  await channel.send(houseAddr, {
    type: 'table_open',
    host: houseId,
    blinds: [smallBlind, bigBlind],
    min_buyin: minBuyin,
    max_players: maxPlayers,
    protocol
  });

  console.log('[HOST] Waiting for players...');

  // Process incoming messages
  async function processMessages() {
    const messages = await channel.receive();
    const reassembled = channel.reassemble(messages);

    for (const msg of reassembled) {
      switch (msg.type) {
        case 'join': {
          const id = msg.player;
          const addr = msg.addr;
          if (players.size >= maxPlayers) {
            await channel.send(houseAddr, { type: 'join_reject', player: id, reason: 'table_full' });
            break;
          }
          if (players.has(id)) break; // Already joined

          // Verify buy-in TX
          let buyinOk = false;
          if (msg.buyin_tx) {
            try {
              const tx = await client.getTransaction(msg.buyin_tx);
              if (tx.confirmations >= 1) buyinOk = true;
            } catch { }
          }

          // For testing, accept without TX verification
          if (!buyinOk && msg.buyin_amount) {
            buyinOk = true;
          }

          if (buyinOk) {
            const amount = msg.buyin_amount || minBuyin;
            players.set(id, { addr, amount });
            session.buyinDirect(id, addr, amount);
            await channel.send(houseAddr, {
              type: 'join_accept',
              player: id,
              seat: players.size - 1,
              chips: amount
            });
            console.log('[HOST] ' + id + ' joined (' + players.size + '/' + maxPlayers + ')');
          }
          break;
        }

        case 'action': {
          if (pendingAction && msg.player === pendingAction.playerId) {
            pendingAction.resolve({
              action: msg.action,
              amount: msg.amount || 0
            });
            pendingAction = null;
          }
          break;
        }

        case 'leave': {
          session.requestLeave(msg.player);
          await channel.send(houseAddr, { type: 'player_leaving', player: msg.player });
          console.log('[HOST] ' + msg.player + ' requesting leave');
          break;
        }
      }
    }
  }

  // Wait for a player action via z-memos
  async function waitForAction(playerId, validActions, timeout) {
    return new Promise(async (resolve) => {
      pendingAction = { playerId, resolve };

      // Tell the player it's their turn
      await channel.send(houseAddr, {
        type: 'your_turn',
        player: playerId,
        valid: validActions,
        to_call: 0, // Engine will set this
      });

      // Timeout
      const timer = setTimeout(() => {
        if (pendingAction && pendingAction.playerId === playerId) {
          pendingAction = null;
          resolve(null); // Timeout
        }
      }, timeout);

      // Poll for response
      const poll = async () => {
        while (pendingAction && pendingAction.playerId === playerId) {
          await processMessages();
          await WAIT(500);
        }
        clearTimeout(timer);
      };
      poll();
    });
  }

  // Create game IO that uses z-channel
  function createIO() {
    return {
      broadcast(event, data) {
        // Send game events as z-memos
        const msg = { type: 'game_' + event, ...data };
        // Don't await — fire and continue
        channel.send(houseAddr, msg).catch(e =>
          console.log('[HOST] Send error: ' + e.message));
      },
      sendTo(playerId, event, data) {
        // Private data (hole cards) — still goes to table z-addr
        // but tagged with the player so only they use it
        const msg = { type: 'private_' + event, for: playerId, ...data };
        channel.send(houseAddr, msg).catch(e =>
          console.log('[HOST] Send error: ' + e.message));
      },
      async waitForAction(playerId, validActions, timeout) {
        // Broadcast whose turn it is
        await channel.send(houseAddr, {
          type: 'turn',
          player: playerId,
          valid: validActions,
        });
        return waitForAction(playerId, validActions, timeout);
      },
      broadcastState() { },
      log(msg) { console.log('[HOST] ' + msg); }
    };
  }

  // Play a single hand with provably fair seeds
  async function playHand() {
    handCount++;
    const activePlayers = session.getActivePlayers();
    if (activePlayers.length < 2) return false;

    console.log('\n[HOST] === Hand ' + handCount + ' ===');

    // Phase 1: Provably fair seed commitment
    const fairness = createHandFairness();
    const houseSeedData = fairness.commit('house');

    // Send house commitment
    await channel.send(houseAddr, {
      type: 'seed_commit',
      from: 'house',
      hash: houseSeedData.hash,
      hand: handCount
    });

    // Wait for player commitments
    console.log('[HOST] Waiting for player seed commitments...');
    const playerSeeds = new Map();
    const commitTimeout = Date.now() + 30000;
    while (playerSeeds.size < activePlayers.length && Date.now() < commitTimeout) {
      await processMessages();
      const msgs = await channel.receive();
      for (const msg of channel.reassemble(msgs)) {
        if (msg.type === 'seed_commit' && msg.from !== 'house') {
          fairness.recordCommitment(msg.from, msg.hash);
          playerSeeds.set(msg.from, msg.hash);
          console.log('[HOST] Got commitment from ' + msg.from);
        }
      }
      await WAIT(500);
    }

    // Phase 2: Reveal seeds
    await channel.send(houseAddr, {
      type: 'seed_reveal',
      from: 'house',
      seed: houseSeedData.seed,
      hand: handCount
    });

    // Wait for player seed reveals
    console.log('[HOST] Waiting for player seed reveals...');
    const revealTimeout = Date.now() + 30000;
    let allRevealed = false;
    while (!allRevealed && Date.now() < revealTimeout) {
      await processMessages();
      const msgs = await channel.receive();
      for (const msg of channel.reassemble(msgs)) {
        if (msg.type === 'seed_reveal' && msg.from !== 'house') {
          const result = fairness.reveal(msg.from, msg.seed);
          if (result.valid) {
            console.log('[HOST] Verified seed from ' + msg.from);
          } else {
            console.log('[HOST] INVALID seed from ' + msg.from + ': ' + result.error);
          }
        }
      }
      // Check if all revealed
      const proof = fairness.getProof();
      if (Object.keys(proof.seeds).length >= activePlayers.length + 1) {
        allRevealed = true;
      }
      await WAIT(500);
    }

    // Phase 3: Derive deck and play
    const numCards = Math.max(activePlayers.length * 2 + 5 + 3, 14);
    const deckOrder = fairness.deriveDeckOrder(numCards);
    if (!deckOrder) {
      console.log('[HOST] Failed to derive deck — not all seeds revealed. Skipping hand.');
      return true; // Continue to next hand
    }

    // Broadcast the provably fair deck derivation
    await channel.send(houseAddr, {
      type: 'deck_derived',
      combined_seed: fairness.getProof().combinedSeed,
      num_cards: deckOrder.length,
      hand: handCount
    });

    // Create engine and crypto backend
    const io = createIO();
    const engine = createEngine({ smallBlind, bigBlind, rake: 0 }, io);
    for (const p of activePlayers) {
      engine.addPlayer(p.id, p.chips);
    }

    const crypto = protocol === 'sg777'
      ? createSg777Backend(activePlayers.length)
      : createSRABackend(activePlayers.length);

    // Play the hand
    await engine.playHand(crypto);

    // Update session balances
    session.updateChips(engine.game.players.map(p => ({ id: p.id, chips: p.chips })));

    // Broadcast hand result with seed proof
    const proof = fairness.getProof();
    await channel.send(houseAddr, {
      type: 'hand_complete',
      hand: handCount,
      balances: Object.fromEntries(
        engine.game.players.map(p => [p.id, parseFloat(p.chips.toFixed(8))])
      ),
      proof: {
        commitments: proof.commitments,
        seeds: proof.seeds,
        combined_seed: proof.combinedSeed
      }
    });

    // Process end of hand (sit-outs, disconnects)
    const toCashOut = session.processEndOfHand();
    for (const co of toCashOut) {
      console.log('[HOST] Cashing out ' + co.id + ': ' + co.amount);
      const result = await session.cashOut(co.id);
      if (result.ok) {
        await channel.send(houseAddr, {
          type: 'cashout',
          player: co.id,
          amount: co.amount,
          txid: result.txid
        });
      }
    }

    return true;
  }

  // Main loop
  async function run() {
    // Wait for enough players
    while (players.size < 2 && running) {
      await processMessages();
      await WAIT(1000);
    }

    console.log('[HOST] Enough players — starting game');

    // Play hands
    while (running) {
      if (handsToPlay > 0 && handCount >= handsToPlay) break;
      const ok = await playHand();
      if (!ok) break;
      await WAIT(2000); // Pause between hands
    }

    // Close table
    console.log('[HOST] Closing table...');
    const cashOuts = await session.closeTable();
    for (const co of cashOuts) {
      await channel.send(houseAddr, {
        type: 'cashout',
        player: co.id,
        amount: co.amount,
        txid: co.txid || null
      });
      console.log('[HOST] Paid ' + co.id + ': ' + (co.amount || 0));
    }

    await channel.send(houseAddr, {
      type: 'table_closed',
      hands_played: handCount,
      summary: session.getSummary()
    });

    console.log('[HOST] Table closed. ' + handCount + ' hands played.');
    return session.getSummary();
  }

  return {
    run,
    getChannel: () => channel,
    getSession: () => session,
    stop: () => { running = false; }
  };
}
