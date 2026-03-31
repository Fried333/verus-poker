/**
 * Poker Client — the player side
 * Joins a table, plays hands, cashes out.
 * Communicates via z-memos.
 *
 * Usage: node poker-client.mjs <player_id> <player_addr> [auto|interactive]
 */

import { createZChannel } from './z-channel.mjs';
import { createHandFairness, verifyHandProof, hashSeed, combineSeeds } from './provably-fair.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import * as readline from 'readline';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

/**
 * Create and run a poker client
 */
export async function createPokerClient(config) {
  const {
    rpcConfig,
    playerId,        // e.g. 'poker-p1'
    playerAddr,      // player's t-address
    tableZAddr,      // from table listing
    viewingKey,      // from table listing
    buyinAmount = 0.5,
    interactive = false,
  } = config;

  const channel = createZChannel(rpcConfig);
  let myChips = 0;
  let mySeat = -1;
  let myCards = [];
  let board = [];
  let handNum = 0;
  let fairness = null;
  let fairnessHistory = new Map(); // hand → fairness
  let running = true;

  // Join table
  console.log('[' + playerId + '] Joining table...');
  await channel.joinTable(tableZAddr, viewingKey);

  // Send join request
  await channel.send(playerAddr, {
    type: 'join',
    player: playerId,
    addr: playerAddr,
    buyin_amount: buyinAmount
  });

  console.log('[' + playerId + '] Join request sent, waiting for acceptance...');

  // Main message loop
  async function run() {
    while (running) {
      const messages = await channel.receive();
      const reassembled = channel.reassemble(messages);

      for (const msg of reassembled) {
        await handleMessage(msg);
      }

      await WAIT(500);
    }
  }

  async function handleMessage(msg) {
    switch (msg.type) {
      case 'join_accept':
        if (msg.player === playerId) {
          mySeat = msg.seat;
          myChips = msg.chips;
          console.log('[' + playerId + '] Seated at position ' + mySeat + ' with ' + myChips + ' chips');
        }
        break;

      case 'join_reject':
        if (msg.player === playerId) {
          console.log('[' + playerId + '] Rejected: ' + msg.reason);
          running = false;
        }
        break;

      case 'seed_commit':
        if (msg.from === 'house') {
          // New hand starting — create our fairness tracker
          handNum = msg.hand || handNum + 1;
          fairness = createHandFairness();
          fairnessHistory.set(handNum, fairness);
          fairness.recordCommitment('house', msg.hash);

          // Commit our own seed
          const mySeed = fairness.commit(playerId);
          await channel.send(playerAddr, {
            type: 'seed_commit',
            from: playerId,
            hash: mySeed.hash,
            hand: handNum
          });
          console.log('[' + playerId + '] Hand ' + handNum + ' — seed committed');
        } else if (msg.from !== playerId) {
          // Another player's commitment
          if (fairness) fairness.recordCommitment(msg.from, msg.hash);
        }
        break;

      case 'seed_reveal':
        if (msg.from === 'house' && fairness) {
          const result = fairness.reveal('house', msg.seed);
          if (!result.valid) {
            console.log('[' + playerId + '] WARNING: House seed invalid!');
          }
          // Reveal our seed
          const proof = fairness.getProof();
          await channel.send(playerAddr, {
            type: 'seed_reveal',
            from: playerId,
            seed: proof.seeds[playerId],
            hand: handNum
          });
          console.log('[' + playerId + '] Seeds revealed');
        } else if (msg.from !== playerId && fairness) {
          fairness.reveal(msg.from, msg.seed);
        }
        break;

      case 'deck_derived':
        console.log('[' + playerId + '] Deck derived from combined seed');
        break;

      case 'game_hand_start':
        board = [];
        myCards = [];
        console.log('[' + playerId + '] --- Hand starting, dealer seat ' + msg.dealer + ' ---');
        break;

      case 'game_blinds_posted':
        console.log('[' + playerId + '] Blinds posted. Pot: ' + (msg.pot || 0));
        break;

      case 'private_hole_cards':
        if (msg.for === playerId) {
          myCards = msg.cards;
          console.log('[' + playerId + '] My cards: ' + myCards.map(c => typeof c === 'number' ? cardToString(c) : c).join(' '));
        }
        break;

      case 'game_community_cards':
        board = msg.board || board;
        const newCards = (msg.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c);
        console.log('[' + playerId + '] Board: ' + newCards.join(' '));
        break;

      case 'turn':
        if (msg.player === playerId) {
          // It's my turn!
          const action = await chooseAction(msg.valid || ['fold', 'check', 'call', 'raise']);
          await channel.send(playerAddr, {
            type: 'action',
            player: playerId,
            action: action.action,
            amount: action.amount || 0,
            hand: handNum
          });
        }
        break;

      case 'game_action':
        if (msg.player !== playerId) {
          console.log('[' + playerId + '] ' + msg.player + ': ' + msg.action +
            (msg.amount ? ' ' + msg.amount : ''));
        }
        break;

      case 'game_showdown':
        console.log('[' + playerId + '] *** SHOWDOWN ***');
        for (const [seat, info] of Object.entries(msg.hands || {})) {
          const cards = (info.cards || []).map(c => typeof c === 'number' ? cardToString(c) : c).join(' ');
          console.log('[' + playerId + ']   ' + info.id + ': ' + cards +
            ' (' + info.handName + ')' + (info.won ? ' WINS ' + info.payout : ''));
        }
        break;

      case 'hand_complete':
        // Verify provably fair proof from host's data
        if (msg.proof) {
          let valid = true;
          let error = '';

          // Check each seed matches its commitment
          for (const [id, seed] of Object.entries(msg.proof.seeds || {})) {
            const commitment = msg.proof.commitments[id];
            if (!commitment) { valid = false; error = 'Missing commitment for ' + id; break; }
            if (hashSeed(seed) !== commitment) { valid = false; error = 'Seed mismatch for ' + id; break; }
          }

          // Verify my own commitment is included
          const handFairness = fairnessHistory.get(msg.hand) || fairness;
          if (valid && handFairness) {
            const myProof = handFairness.getProof();
            const myCommitment = myProof.commitments[playerId];
            if (myCommitment && !msg.proof.commitments[playerId]) {
              valid = false; error = 'My commitment missing from proof!';
            }
          }

          // Verify combined seed
          if (valid) {
            const expected = combineSeeds(Object.values(msg.proof.seeds));
            if (expected !== msg.proof.combined_seed) {
              valid = false; error = 'Combined seed mismatch';
            }
          }

          console.log('[' + playerId + '] Provably fair: ' + (valid ? 'VERIFIED' : 'FAILED: ' + error));
        }
        if (msg.balances && msg.balances[playerId] !== undefined) {
          myChips = msg.balances[playerId];
          console.log('[' + playerId + '] Balance: ' + myChips);
        }
        break;

      case 'cashout':
        if (msg.player === playerId) {
          console.log('[' + playerId + '] Cashed out: ' + msg.amount + ' CHIPS' +
            (msg.txid ? ' TX: ' + msg.txid : ''));
          running = false;
        }
        break;

      case 'table_closed':
        console.log('[' + playerId + '] Table closed. ' + msg.hands_played + ' hands played.');
        running = false;
        break;
    }
  }

  async function chooseAction(validActions) {
    if (interactive) {
      return interactiveAction(validActions);
    }
    return botAction(validActions);
  }

  function botAction(validActions) {
    const r = Math.random();
    if (validActions.includes('check')) {
      return r < 0.6 ? { action: 'check' } : (r < 0.85 ? { action: 'raise', amount: 0.04 } : { action: 'fold' });
    }
    if (validActions.includes('call')) {
      return r < 0.5 ? { action: 'call' } : (r < 0.7 ? { action: 'raise', amount: 0.04 } : { action: 'fold' });
    }
    return { action: 'fold' };
  }

  async function interactiveAction(validActions) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let prompt = '[' + playerId + '] Your cards: ' + myCards.map(c => typeof c === 'number' ? cardToString(c) : c).join(' ') + '\n';
    prompt += '  Actions: ';
    if (validActions.includes('fold')) prompt += '[F]old ';
    if (validActions.includes('check')) prompt += '[C]heck ';
    if (validActions.includes('call')) prompt += 'Cal[L] ';
    if (validActions.includes('raise')) prompt += '[R]aise ';
    if (validActions.includes('allin')) prompt += '[A]ll-in ';
    prompt += '> ';

    return new Promise(resolve => {
      rl.question(prompt, answer => {
        rl.close();
        const key = (answer.trim().toLowerCase()[0]) || 'f';
        const map = { f: 'fold', c: 'check', l: 'call', r: 'raise', a: 'allin' };
        const action = map[key] || 'fold';
        let amount = 0;
        if (action === 'raise') {
          amount = parseFloat(answer.trim().split(/\s+/)[1]) || 0.04;
        }
        resolve({ action, amount });
      });
    });
  }

  return {
    run,
    stop: () => { running = false; },
    getChips: () => myChips,
    getCards: () => myCards,
  };
}
