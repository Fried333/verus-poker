/**
 * P2P Dealer — orchestrates poker hands on-chain
 * Writes game state to Table VerusID, reads player actions from Player VerusIDs.
 * Dealer also acts as cashier in MVP (single-wallet demo).
 */

import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, evaluateHandWithCards, cardToString } from './hand-eval.mjs';
import { VDXF_KEYS, gameKey } from './verus-rpc.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));
const DT0 = Date.now();
function dts() { return ((Date.now() - DT0) / 1000).toFixed(1); }
function dlog(msg) { console.log('[D ' + dts() + 's] ' + msg); }
let handStartTime = 0;

export function createP2PDealer(p2p, config, localNotify) {
  const { smallBlind, bigBlind, buyin, cashiers } = config;
  const players = []; // { id, seat, chips, sittingOut, timeouts }
  let handCount = 0;
  let dealerSeatIdx = 0;
  let gameId = null;
  const MAX_TIMEOUTS = 1; // Sit out after this many consecutive timeouts (industry standard)
  const useCashiers = cashiers && cashiers.length > 0;

  // ──────────────────────────────────────────────
  // Phase multisig state (additive — does not affect existing runHand flow yet)
  // ──────────────────────────────────────────────
  let phaseCount = 0;
  let currentPhase = null; // { phase, multisigAddr, redeemScript, signers, threshold, ... }

  function notify(event, data) {
    if (localNotify) localNotify(event, data);
  }

  return {
    async openTable() {
      gameId = 'g' + Date.now().toString(36);
      console.log('[DEALER] Opening table ' + p2p.tableId + ' session=' + gameId);
      // Write ONLY to base key (player polls this). Skip game-specific key to avoid UTXO conflict.
      await p2p.write(p2p.tableId, 'chips.vrsc::poker.sg777z.t_table_info', {
        smallBlind, bigBlind, buyin, maxPlayers: 9, status: 'open', dealer: p2p.myId, session: gameId, ts: Date.now()
      });
      await WAIT(2000);
    },

    addSelf(chips) {
      players.push({ id: p2p.myId, seat: players.length, chips: chips || buyin });
      console.log('[DEALER] Self-seated at seat ' + (players.length - 1));
    },

    addPlayer(playerId, chips, preferredSeat) {
      // Use preferred seat if available, otherwise next free seat
      const usedSeats = new Set(players.map(p => p.seat));
      let seat;
      if (preferredSeat !== undefined && preferredSeat >= 0 && preferredSeat < 9 && !usedSeats.has(preferredSeat)) {
        seat = preferredSeat;
      } else {
        seat = 0;
        while (usedSeats.has(seat)) seat++;
      }
      players.push({ id: playerId, seat, chips: chips || buyin, sittingOut: false, timeouts: 0, sittingOutSinceHand: null });
      console.log('[DEALER] ' + playerId + ' seated at seat ' + seat);
    },

    /** Remove a player from the table entirely (auto-kick after N sat-out hands) */
    removePlayer(playerId) {
      const idx = players.findIndex(p => p.id === playerId);
      if (idx >= 0) {
        const removed = players.splice(idx, 1)[0];
        console.log('[DEALER] ' + playerId + ' removed from table (was at seat ' + removed.seat + ')');
        return true;
      }
      return false;
    },

    async waitForJoin(playerId, timeout) {
      console.log('[DEALER] Waiting for ' + playerId + ' to join...');
      const join = await p2p.pollAction(playerId, gameId, null, timeout || 120000);
      if (join) {
        this.addPlayer(playerId, buyin);
        return true;
      }
      // Also check join request
      const req = await p2p.readJoin(playerId);
      if (req) {
        this.addPlayer(playerId, buyin);
        return true;
      }
      return false;
    },

    /**
     * Run one complete hand on-chain
     */
    async runHand() {
      handCount++;
      const handId = gameId + '_h' + handCount;
      const numCards = 52;
      const activePlayers = players.filter(p => p.chips > 0 && !p.sittingOut);
      const numPlayers = activePlayers.length;

      if (numPlayers < 2) {
        console.log('[DEALER] Not enough players');
        return null;
      }

      const handT0 = Date.now();
      dlog('══════ HAND ' + handCount + ' (' + numPlayers + 'P) ══════');

      // ── STAGE I: Player deck generation ──
      dlog('Shuffling...');
      notify('shuffle_start', { hand: handCount, players: activePlayers });

      // ── STAGE I + II: Player init → Dealer shuffle ──
      const playerData = [];
      for (let i = 0; i < numPlayers; i++) {
        playerData.push(playerInit(numCards, activePlayers[i].id));
      }
      const dd = dealerShuffle(playerData, numCards);
      const threshold = Math.max(2, Math.ceil(numPlayers / 2) + 1);

      // ── STAGE III: Cashier shuffle ──
      let cd;
      if (useCashiers) {
        // OPTIMIZATION: only send the cards the hand will actually use to the cashier.
        // For Texas Hold'em with N players: 2N hole cards + 5 community = 2N+5 cards.
        // The dealer's full 52-card permutation has already been applied, so positions
        // 0..(2N+4) are a uniformly-random sample from the deck. Slicing here cuts
        // each deck from ~3.5KB JSON to ~800 bytes — small enough to batch all 3
        // decks + the shuffle request in a single chain tx.
        const cardsNeeded = numPlayers * 2 + 5;  // 11 for 3 players, 9 for 2, etc.
        const slicedDecks = dd.blindedDecks.map(d => d.slice(0, cardsNeeded));

        dlog('Sending Stage III to cashier: ' + cashiers[0] + ' (' + cardsNeeded + ' cards/player)');
        // Tell the cashier to use the smaller card count via reqData
        const reqData = { handId, session: gameId, numPlayers, numCards: cardsNeeded, threshold, timestamp: Date.now() };
        // Build a single batch with the shuffle request + all 3 player decks.
        // Total size: ~500B request + 3 × ~1.5KB decks ≈ 5KB — fits one tx.
        const initialBatch = [
          { key: 'chips.vrsc::poker.sg777z.t_shuffle_request', data: reqData },
          { key: 'chips.vrsc::poker.sg777z.t_shuffle_request.' + handId, data: reqData }
        ];
        for (let i = 0; i < numPlayers; i++) {
          initialBatch.push({
            key: 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + handId + '.p' + i,
            data: { player: i, deck: slicedDecks[i] }
          });
        }
        try {
          await p2p.writeBatch(p2p.tableId, initialBatch);
          dlog('Request + ' + numPlayers + ' decks batched (1 TX, ' + cardsNeeded + ' cards each)');
        } catch (e) {
          // Fallback: if the combined batch is too big, fall back to separate writes
          dlog('Batch too big, falling back to sequential writes: ' + e.message);
          await p2p.writeBatch(p2p.tableId, initialBatch.slice(0, 2));
          for (let i = 0; i < numPlayers; i++) {
            await p2p.write(p2p.tableId, 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + handId + '.p' + i,
              { player: i, deck: slicedDecks[i] });
            dlog('Deck ' + i + ' written');
          }
        }

        // Wait for first cashier to respond (poll their identity)
        dlog('Waiting for cashier response...');
        const cashierResultKey = 'chips.vrsc::poker.sg777z.c_shuffle_result.' + handId;
        let cashierMeta = null;
        for (let i = 0; i < 120; i++) { // 60s timeout
          cashierMeta = await p2p.read(cashiers[0], cashierResultKey);
          if (cashierMeta && cashierMeta.handId === handId) break;
          cashierMeta = null;
          await WAIT(500);
        }

        if (!cashierMeta) {
          dlog('Cashier timeout — falling back to local Stage III');
          cd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);
        } else {
          dlog('Cashier response received from ' + cashierMeta.cashier + ', reading decks...');
          // Read all finalDecks in parallel — the cashier writes them all in one
          // batch now, so they're available simultaneously.
          const readDeck = async (i) => {
            for (let retry = 0; retry < 40; retry++) {
              const deckData = await p2p.read(cashiers[0], cashierResultKey + '.deck.' + i);
              if (deckData && deckData.deck) return deckData.deck;
              await WAIT(500);
            }
            return [];
          };
          const finalDecks = await Promise.all(
            Array.from({ length: numPlayers }, (_, i) => readDeck(i))
          );
          cd = { finalDecks, cashierCommitment: cashierMeta.cashierCommitment };
          dlog('Cashier decks received (' + numPlayers + ' players, parallel)');
        }
      } else {
        // No external cashiers — do Stage III locally
        cd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);
      }

      // ── Request blinding values from cashier for card positions ──
      // Retries up to 3 times with fresh request each attempt; throws on total failure
      async function requestBlindings(positions, playerIdx) {
        if (!useCashiers || !cashiers[0]) {
          // Local mode: b values are in cd.b
          const result = {};
          for (const pos of positions) result[pos] = cd.b[playerIdx][pos];
          return result;
        }
        const MAX_ATTEMPTS = 3;
        const POLL_ITERS = 40; // 40 * 500ms = 20s per attempt
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const reqTimestamp = Date.now();
          const revealKey = 'chips.vrsc::poker.sg777z.t_reveal_request.' + handId;
          try {
            await p2p.write(p2p.tableId, revealKey, {
              handId, positions, playerIdx, timestamp: reqTimestamp
            });
          } catch (e) {
            dlog('Reveal request write failed (attempt ' + attempt + '): ' + e.message);
            await WAIT(2000);
            continue;
          }
          dlog('Requested blindings for positions ' + positions.join(',') + ' (attempt ' + attempt + ')');

          // Poll for cashier's response
          const resultKey = 'chips.vrsc::poker.sg777z.c_reveal_result.' + handId + '.' + reqTimestamp;
          for (let i = 0; i < POLL_ITERS; i++) {
            const result = await p2p.read(cashiers[0], resultKey);
            if (result && result.blindings) {
              // Verify we got blindings for every requested position
              const missing = positions.filter(p => result.blindings[p] === undefined);
              if (missing.length === 0) return result.blindings;
              dlog('Cashier responded but missing positions: ' + missing.join(','));
              break; // partial response — try again
            }
            await WAIT(500);
          }
          dlog('Blinding request attempt ' + attempt + '/' + MAX_ATTEMPTS + ' timed out');
        }
        throw new Error('Cashier reveal failed after ' + MAX_ATTEMPTS + ' attempts (positions: ' + positions.join(',') + ')');
      }

      // ── DEAL HOLE CARDS ──
      let cardPos = 0;
      const holeCards = {};
      // Request ALL blindings upfront: hole cards + community cards (2N + 5 positions)
      // DCV doesn't play so knowing future cards doesn't compromise security
      const allPositions = [];
      for (let i = 0; i < numPlayers * 2 + 5; i++) allPositions.push(i);
      const allBlindings = await requestBlindings(allPositions, 0);
      const holeBlindings = allBlindings;
      const d0 = { deck: cd.finalDecks[0], e: dd.e[0], key: playerData[0].sessionKey, init: playerData[0].initialDeck };
      dlog('DEBUG: deck[0] type=' + typeof d0.deck[0] + ' blinding[0] type=' + typeof holeBlindings[0] + ' e type=' + typeof d0.e);
      dlog('DEBUG: blinding keys=' + Object.keys(holeBlindings).join(',') + ' count=' + Object.keys(holeBlindings).length);
      for (let i = 0; i < numPlayers; i++) {
        const cards = [];
        for (let c = 0; c < 2; c++) {
          const blinding = holeBlindings[cardPos];
          if (blinding === undefined || blinding === null) {
            dlog('ERROR: missing blinding for pos=' + cardPos);
            cards.push(-1);
          } else {
            const raw = decodeCard(d0.deck[cardPos], blinding, d0.e, dd.d, d0.key, d0.init);
            dlog('DEBUG: pos=' + cardPos + ' raw=' + raw + ' card=' + cardToString(raw));
            cards.push(raw);
          }
          cardPos++;
        }
        holeCards[activePlayers[i].id] = cards;
        dlog('  ' + activePlayers[i].id + ': ' + cards.map(cardToString).join(' '));
      }

      // ── PLAY THE HAND (setup game state locally first) ──
      const game = createGame({ smallBlind, bigBlind, rake: 0 });
      for (const p of activePlayers) addPlayer(game, p.id, p.chips);
      game.dealerSeat = dealerSeatIdx % numPlayers;
      startHand(game);
      postBlinds(game);
      for (let i = 0; i < numPlayers; i++) {
        setHoleCards(game, i, holeCards[activePlayers[i].id]);
      }

      // ── SINGLE BATCH WRITE: table_info + card_bv + blinds BS — ALL IN 1 TX ──
      handStartTime = Date.now();
      const initEntries = [];
      // Table info with currentHandId
      initEntries.push({ key: 'chips.vrsc::poker.sg777z.t_table_info', data: {
        smallBlind, bigBlind, buyin, maxPlayers: 9, status: 'playing',
        dealer: p2p.myId, session: gameId, currentHandId: handId, handCount
      }});
      // Card reveals per player
      for (let i = 0; i < numPlayers; i++) {
        const cardKey = 'chips.vrsc::poker.sg777z.card_bv.' + handId + '.' + activePlayers[i].id;
        initEntries.push({ key: cardKey, data: {
          player: activePlayers[i].id, cards: holeCards[activePlayers[i].id].map(cardToString),
          type: 'hole', hand: handCount, session: gameId
        }});
      }
      // Blinds betting state — unique key (s0)
      initEntries.push({ key: VDXF_KEYS.BETTING_STATE + '.' + handId + '.s0', data: {
        phase: game.phase, pot: game.pot, dealerSeat: game.dealerSeat, seq: 0,
        session: gameId,
        players: game.players.map(p => ({ id: p.id, seat: p.seat, chips: p.chips, bet: p.bet }))
      }});
      let wt = Date.now();
      await p2p.writeBatch(p2p.tableId, initEntries);
      dlog('Init batch written (' + initEntries.length + ' keys, ' + (Date.now()-wt) + 'ms)');

      notify('cards_dealt', { holeCards, handId,
        gamePlayers: game.players.map(gp => ({ id: gp.id, chips: gp.chips, bet: gp.bet, seat: gp.seat })),
        pot: game.pot, phase: game.phase, dealerSeat: game.dealerSeat
      });

      dlog('Playing hand...');
      let bsSeq = 0;
      let lastActionInfo = null; // { player, action, amount } — included in next BS for display
      // Community card crypto backend
      let revealPos = numPlayers * 2;

      // Main betting loop
      while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
        // Deal community cards if entering new street
        let streetDealt = false;
        if (game.phase === 'flop' && game.board.length === 0) {
          const cards = [];
          for (let i = 0; i < 3; i++) {
            const bl = allBlindings[revealPos];
            cards.push(bl ? decodeCard(d0.deck[revealPos], bl, d0.e, dd.d, d0.key, d0.init) : -1);
            revealPos++;
          }
          dealBoard(game, cards);
          dlog('Flop decoded: ' + cards.map(cardToString).join(' '));
          notify('community_cards', { phase: 'flop', cards, board: game.board });
          streetDealt = true;
        } else if (game.phase === 'turn' && game.board.length === 3) {
          const bl = allBlindings[revealPos];
          const idx = bl ? decodeCard(d0.deck[revealPos], bl, d0.e, dd.d, d0.key, d0.init) : -1;
          dealBoard(game, [idx]); revealPos++;
          dlog('Turn decoded: ' + cardToString(game.board[3]));
          notify('community_cards', { phase: 'turn', board: game.board });
          streetDealt = true;
        } else if (game.phase === 'river' && game.board.length === 4) {
          const bl = allBlindings[revealPos];
          const idx = bl ? decodeCard(d0.deck[revealPos], bl, d0.e, dd.d, d0.key, d0.init) : -1;
          dealBoard(game, [idx]); revealPos++;
          dlog('River decoded: ' + cardToString(game.board[4]));
          notify('community_cards', { phase: 'river', board: game.board });
          streetDealt = true;
        }

        if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }

        const seat = game.currentTurn;
        const p = game.players[seat];
        const validActions = getValidActions(game);
        const toCall = getToCall(game, seat);

        // BATCH: board + BS in ONE TX if new street was dealt
        const bsData = {
          phase: game.phase, pot: game.pot, turn: p.id, seat,
          session: gameId,
          validActions, toCall, minRaise: game.minRaise,
          // Dealer enforces a 90s hard timeout (player display shows 60s).
          // The 30s difference is buffer for chain propagation lag, so slow
          // players still get a fair perceived 60s of think time.
          turnStart: Date.now(), turnTimeout: 60, dealerHardTimeout: 90,
          players: game.players.map(pp => ({ id: pp.id, seat: pp.seat, chips: pp.chips, bet: pp.bet, folded: pp.folded })),
          lastAction: lastActionInfo
        };

        // Write BS to chain for every player's turn (dealer is not a player)
        bsSeq++;
        const bsKey = VDXF_KEYS.BETTING_STATE + '.' + handId + '.s' + bsSeq;
        bsData.seq = bsSeq;

        let wt = Date.now();
        if (streetDealt) {
          // Batch: board_cards + betting_state in 1 TX
          const boardKey = gameKey(VDXF_KEYS.BOARD_CARDS, handId);
          await p2p.writeBatch(p2p.tableId, [
            { key: boardKey, data: { board: game.board.map(cardToString), phase: game.phase, hand: handCount, session: gameId } },
            { key: bsKey, data: bsData }
          ]);
          dlog('Board+BS batch: ' + game.phase + ' turn=' + p.id + ' seq=' + bsSeq + ' (' + (Date.now()-wt) + 'ms)');
        } else {
          await p2p.write(p2p.tableId, bsKey, bsData);
          dlog('BS written: turn=' + p.id + ' phase=' + game.phase + ' seq=' + bsSeq + ' (' + (Date.now()-wt) + 'ms)');
        }

        // Wait for player action
        let action;
        const pollStart = Date.now();
        action = await new Promise(resolve => {
          notify('need_action', { resolve, validActions, toCall, seat, playerId: p.id, pot: game.pot, minRaise: game.minRaise,
            phase: game.phase, handId, bsSeq, gamePlayers: game.players.map(gp => ({ id: gp.id, chips: gp.chips, bet: gp.bet, folded: gp.folded })) });
          // 90s hard timeout = player's 60s display + 30s buffer for chain propagation
          setTimeout(() => resolve(null), 90000);
        });

        const pollMs = Date.now() - pollStart;
        if (!action) {
          action = { action: validActions.includes(CHECK) ? CHECK : FOLD, amount: 0, timeout: true };
          dlog(p.id + ' timed out → ' + action.action + ' (waited ' + (pollMs/1000).toFixed(1) + 's)');
          // Track consecutive timeouts — sit out after MAX_TIMEOUTS
          const pp = players.find(x => x.id === p.id);
          if (pp) {
            pp.timeouts = (pp.timeouts || 0) + 1;
            if (pp.timeouts >= MAX_TIMEOUTS) {
              pp.sittingOut = true;
              pp.sittingOutSinceHand = handCount;
              dlog(p.id + ' SAT OUT after ' + pp.timeouts + ' timeout(s)');
              notify('player_sat_out', { player: p.id, timeouts: pp.timeouts });
            }
          }
        } else {
          dlog(p.id + ': ' + action.action + (action.amount ? ' ' + action.amount : '') + ' (waited ' + (pollMs/1000).toFixed(1) + 's)');
          // Reset timeout counter on any valid action
          const pp = players.find(x => x.id === p.id);
          if (pp) pp.timeouts = 0;
        }

        if (!validActions.includes(action.action)) {
          action = { action: FOLD, amount: 0 };
        }
        playerAction(game, seat, action.action, action.amount || 0);
        lastActionInfo = { player: p.id, action: action.action, amount: action.amount || 0, timeout: !!action.timeout };
        notify('action', { player: p.id, action: action.action, amount: action.amount,
          gamePlayers: game.players.map(gp => ({ id: gp.id, chips: gp.chips, bet: gp.bet, folded: gp.folded })),
          pot: game.pot, phase: game.phase });
        await WAIT(500);
      }

      // ── SETTLE (showdown or fold win) ──
      let winners = [], winAmount = 0;
      const handNames = {}, allHoleCards = {};
      const rankNames = ['High Card','Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush','Royal Flush'];

      if (game.phase === SHOWDOWN) {
        const nonFolded = game.players.filter(p => !p.folded);
        if (nonFolded.length > 1) {
          while (game.board.length < 5) {
            const bl = allBlindings[revealPos];
            const idx = bl ? decodeCard(d0.deck[revealPos], bl, d0.e, dd.d, d0.key, d0.init) : -1;
            dealBoard(game, [idx]); revealPos++;
          }
          await p2p.writeBoardCards(handId, { board: game.board.map(cardToString), phase: 'showdown' });
          notify('community_cards', { phase: 'showdown', board: game.board });
          console.log('  Board: ' + game.board.map(cardToString).join(' '));
        }
      }

      const payouts = settleHand(game, evaluateHand);
      applyPayouts(game, payouts);

      for (const [seat, amt] of Object.entries(payouts)) {
        if (amt > 0) { winners.push(Number(seat)); winAmount = amt; }
      }
      const nonFoldedCount = game.players.filter(p => !p.folded).length;
      const bestHands = {}; // seat → best 5-card hand as strings
      for (const gp of game.players) {
        if (!gp.folded && gp.holeCards.length > 0 && game.board.length >= 3 && nonFoldedCount > 1) {
          const result = evaluateHandWithCards([...gp.holeCards, ...game.board]);
          handNames[gp.seat] = rankNames[Math.floor(result.score / 1e10)] || 'Unknown';
          bestHands[gp.seat] = result.bestCards.map(cardToString);
        }
        if (nonFoldedCount > 1 && !gp.folded) {
          allHoleCards[gp.seat] = gp.holeCards.map(cardToString);
        } else {
          allHoleCards[gp.seat] = [null, null];
        }
      }
      notify('showdown', {
        winners, winAmount, handNames, allHoleCards,
        board: game.board.map(cardToString), payouts
      });
      console.log('  Payouts: ' + Object.entries(payouts).filter(([, v]) => v > 0).map(([s, v]) => game.players[s].id + ':+' + v).join(' '));

      // ── VERIFY ──
      let vt = Date.now();
      let verification;
      if (cd.b && cd.sigma_Cashier) {
        // Local cashier — full verification possible
        verification = verifyGame(playerData, dd, cd, numCards);
        dlog('Verify: ' + (verification.valid ? 'PASS' : 'FAIL') + ' (' + (Date.now()-vt) + 'ms)');
      } else {
        // External cashier — b/sigma kept private, trust commitment hash
        verification = { valid: true, errors: [] };
        dlog('Verify: TRUSTED (external cashier, commitment: ' + (cd.cashierCommitment || '').substring(0, 16) + ')')
      }

      // Write settlement
      vt = Date.now();
      await p2p.writeSettlement(handId, {
        hand: handCount, verified: verification.valid, session: gameId,
        results: game.players.map(p => ({ id: p.id, chips: p.chips })),
        board: game.board.map(cardToString),
        handNames, bestHands, allHoleCards, winners, winAmount,
        // Per-pot results so the GUI can show "main pot wins X / side pot wins Y"
        potResults: game.potResults || [],
        // The action that ended the hand (often a fold) — never written to a BS
        // because the loop breaks. Players need this to show the final action.
        lastAction: lastActionInfo
      });
      dlog('Settlement written (' + (Date.now()-vt) + 'ms)');
      dlog('HAND TOTAL: ' + ((Date.now()-handT0)/1000).toFixed(1) + 's | chips: ' + game.players.map(p => p.id + '=' + p.chips).join(' '));

      // Update player chips; mark sittingOutSinceHand on bust so kick counter starts
      for (const gp of game.players) {
        const p = players.find(x => x.id === gp.id);
        if (p) {
          p.chips = gp.chips;
          if (p.chips <= 0 && p.sittingOutSinceHand == null) {
            p.sittingOutSinceHand = handCount;
          }
        }
      }

      notify('hand_complete', { hand: handCount, verified: verification.valid, players });
      dealerSeatIdx++;

      return { verified: verification.valid, players, payouts: game.players.map(p => ({ id: p.id, chips: p.chips })) };
    },

    getPlayers() { return players; },
    getHandCount() { return handCount; },
    getGameId() { return gameId; },

    /** Sit a player back in (called when they rejoin/reconnect) */
    sitBackIn(playerId) {
      const p = players.find(x => x.id === playerId);
      if (p && p.sittingOut) {
        p.sittingOut = false;
        p.timeouts = 0;
        p.sittingOutSinceHand = null;
        console.log('[DEALER] ' + playerId + ' sat back in');
        return true;
      }
      return false;
    },

    /** Mark a player as sitting out (called when they wrote sit-out marker to chain) */
    sitOut(playerId) {
      const p = players.find(x => x.id === playerId);
      if (p && !p.sittingOut) {
        p.sittingOut = true;
        p.sittingOutSinceHand = handCount;
        console.log('[DEALER] ' + playerId + ' sat out');
        return true;
      }
      return false;
    },

    // ══════════════════════════════════════
    // PHASE MULTISIG FUNDING (additive — not yet wired into runHand)
    // ══════════════════════════════════════

    getCurrentPhase() {
      return currentPhase;
    },

    /**
     * Open a new phase: compose the multisig from the roster, publish the
     * phase manifest to the table identity, return the phase descriptor.
     *
     * roster: [{ id, payAddr, pubkey, expectedDeposit }, ...]
     * threshold: number of signatures required (typically N-1 of N for N≥3, or 2 of 2 for heads-up)
     */
    async openPhase(roster, threshold) {
      if (!Array.isArray(roster) || roster.length < 1) {
        throw new Error('roster must have at least 1 player');
      }
      if (threshold > roster.length) {
        throw new Error('threshold cannot exceed roster size');
      }

      phaseCount++;
      const phase = (gameId || 'g0') + '_p' + phaseCount;
      console.log('[DEALER] Opening phase ' + phase + ' with ' + roster.length + ' players (threshold ' + threshold + ')');

      // Sort pubkeys deterministically so the multisig address is reproducible
      const sortedRoster = [...roster].sort((a, b) => a.pubkey.localeCompare(b.pubkey));
      const pubkeys = sortedRoster.map(r => r.pubkey);

      const ms = await p2p.computeMultisigAddress(pubkeys, threshold);
      console.log('[DEALER] Phase ' + phase + ' multisig: ' + ms.address);

      // Snapshot existing UTXOs at the multisig address — these are PRE-EXISTING
      // (from previous sessions or unexpected sources) and will be excluded
      // from this phase's deposit attribution. Only NEW UTXOs created AFTER
      // this snapshot will be considered legitimate phase deposits.
      const preExistingUtxos = new Set(
        (await p2p.getAddressUtxos(ms.address)).map(u => u.txid + ':' + u.vout)
      );
      if (preExistingUtxos.size > 0) {
        console.log('[DEALER] ' + preExistingUtxos.size + ' pre-existing UTXOs at multisig address (excluded from attribution)');
      }

      const manifest = {
        type: 'phase_open',
        phase,
        table: p2p.tableId,
        multisigAddr: ms.address,
        redeemScript: ms.redeemScript,
        threshold,
        // Include pubkeys for the canonical signers list so other parties
        // (players, observers) can independently compute the same multisig
        // and call addmultisigaddress on their own wallets.
        pubkeys,
        signers: sortedRoster.map(r => ({
          id: r.id,
          payAddr: r.payAddr,
          pubkey: r.pubkey,
          expectedDeposit: r.expectedDeposit,
        })),
        timestamp: Date.now(),
      };

      const manifestKey = 'chips.vrsc::poker.sg777z.t_phase_open.' + phase;
      await p2p.write(p2p.tableId, manifestKey, manifest);
      console.log('[DEALER] Phase manifest published: ' + manifestKey);

      currentPhase = {
        ...manifest,
        confirmed: false,
        deposits: {},
        preExistingUtxos,
      };

      return currentPhase;
    },

    /**
     * Wait for all expected deposits to be visible at the multisig address.
     * Polls the chain via getaddressutxos. When all deposits are confirmed,
     * publishes phase_confirmed and updates currentPhase.confirmed.
     *
     * Returns true if all deposits arrived within the timeout, false otherwise.
     */
    async waitForPhaseDeposits(timeoutMs = 120000) {
      if (!currentPhase) throw new Error('no current phase');

      const expectedTotal = currentPhase.signers.reduce((s, r) => s + r.expectedDeposit, 0);
      console.log('[DEALER] Waiting for deposits at ' + currentPhase.multisigAddr + ' (expecting ' + expectedTotal + ' CHIPS)');

      const deposits = {};
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const utxos = await p2p.getAddressUtxos(currentPhase.multisigAddr);

        // Try to attribute each UTXO back to a player by walking the source TX.
        // SKIP pre-existing UTXOs that were at the address before this phase
        // opened — those are from previous sessions or unexpected sources.
        for (const utxo of utxos) {
          const utxoKey = utxo.txid + ':' + utxo.vout;
          if (currentPhase.preExistingUtxos.has(utxoKey)) continue;
          if (deposits[utxo.txid]) continue; // already attributed
          try {
            const tx = await p2p.client.call('getrawtransaction', [utxo.txid, 1]);
            // The source address is the first input's previous output
            if (tx.vin && tx.vin.length > 0) {
              const prev = await p2p.client.call('getrawtransaction', [tx.vin[0].txid, 1]);
              const senderAddrs = prev.vout[tx.vin[0].vout].scriptPubKey.addresses || [];
              const sender = senderAddrs[0];
              const matchingSigner = currentPhase.signers.find(s => s.payAddr === sender);
              if (matchingSigner) {
                deposits[utxo.txid] = {
                  player: matchingSigner.id,
                  amount: utxo.amount,
                  txid: utxo.txid,
                  vout: utxo.vout,
                };
              }
            }
          } catch (e) {
            // TX not yet available — try again next poll
          }
        }

        // Check if all expected deposits are present
        const playersWithDeposits = new Set(Object.values(deposits).map(d => d.player));
        const allDeposited = currentPhase.signers.every(s => playersWithDeposits.has(s.id));

        if (allDeposited) {
          // Publish phase_confirmed
          const totalBalance = utxos.reduce((s, u) => s + u.amount, 0);
          const confirmedRecord = {
            type: 'phase_confirmed',
            phase: currentPhase.phase,
            multisigAddr: currentPhase.multisigAddr,
            deposits,
            totalBalance,
            timestamp: Date.now(),
          };
          const confirmedKey = 'chips.vrsc::poker.sg777z.t_phase_confirmed.' + currentPhase.phase;
          await p2p.write(p2p.tableId, confirmedKey, confirmedRecord);
          console.log('[DEALER] Phase confirmed: ' + Object.keys(deposits).length + ' deposits, total ' + totalBalance + ' CHIPS');

          currentPhase.confirmed = true;
          currentPhase.deposits = deposits;
          currentPhase.totalBalance = totalBalance;
          return true;
        }

        await WAIT(2000);
      }

      console.log('[DEALER] Phase deposits did not all arrive within timeout');
      return false;
    },

    /**
     * Compose a cashout proposal for the current phase.
     *
     * stacks: { playerId: amount, ... } — final chip stack per player from
     *   the latest betting state. The dealer (or whoever's calling this) is
     *   responsible for passing the correct stacks. Players will verify against
     *   their own view of the betting state before signing.
     *
     * The cashout proposal includes:
     * - Explicit JSON payouts list (id, payAddr, amount per player)
     * - The unsigned settlement TX template that spends the multisig
     * - Reference info so players can verify
     *
     * Publishes the cashout to the table identity at t_cashout.<phase>.
     * Returns the cashout descriptor.
     */
    async composeCashout(stacks, bettingStateRef = null) {
      if (!currentPhase || !currentPhase.confirmed) {
        throw new Error('no confirmed phase to cash out');
      }

      const fee = 0.0001;

      // Build the payouts list, validating each entry against the manifest
      const payouts = [];
      for (const signer of currentPhase.signers) {
        const amount = stacks[signer.id];
        if (typeof amount !== 'number' || amount < 0) {
          throw new Error(`missing or invalid stack for ${signer.id}: ${amount}`);
        }
        payouts.push({
          id: signer.id,
          payAddr: signer.payAddr,
          amount: Math.round(amount * 1e8) / 1e8,
        });
      }

      // Use only the attributed deposit UTXOs as inputs (not all UTXOs at the
      // multisig address). This avoids spending orphan UTXOs from previous
      // sessions or unexpected sources. Orphans stay at the multisig address
      // and can be recovered separately.
      const explicitUtxos = Object.values(currentPhase.deposits).map(d => ({
        txid: d.txid,
        vout: d.vout,
        amount: d.amount,
      }));
      const attributedTotal = explicitUtxos.reduce((s, u) => s + u.amount, 0);
      const attributedRounded = Math.round(attributedTotal * 1e8) / 1e8;

      // Sum invariant: payouts + fee == sum of attributed deposits (NOT raw multisig balance)
      const totalPayout = payouts.reduce((s, p) => s + p.amount, 0);
      const expectedTotal = Math.round((totalPayout + fee) * 1e8) / 1e8;
      if (Math.abs(expectedTotal - attributedRounded) > 0.0001) {
        throw new Error(`sum invariant violated: payouts (${totalPayout}) + fee (${fee}) = ${expectedTotal} != attributed deposits (${attributedRounded})`);
      }

      // Compose the unsigned settlement TX using ONLY the attributed UTXOs
      const txPayouts = payouts
        .filter(p => p.amount > 0)
        .map(p => ({ address: p.payAddr, amount: p.amount }));
      const unsignedHex = await p2p.composeSettlementTx(
        currentPhase.multisigAddr,
        txPayouts,
        fee,
        explicitUtxos
      );

      const cashout = {
        type: 'cashout',
        phase: currentPhase.phase,
        table: p2p.tableId,
        multisigAddr: currentPhase.multisigAddr,
        multisigBalance: attributedRounded,
        bettingStateRef,
        payouts,
        fee,
        unsignedTxHex: unsignedHex,
        timestamp: Date.now(),
      };

      const cashoutKey = 'chips.vrsc::poker.sg777z.t_cashout.' + currentPhase.phase;
      await p2p.write(p2p.tableId, cashoutKey, cashout);
      console.log('[DEALER] Cashout proposal published for phase ' + currentPhase.phase);
      console.log('[DEALER]   payouts: ' + payouts.map(p => p.id + '=' + p.amount).join(', '));

      return cashout;
    },

    /**
     * Read all cashout signature partials from the players for the current phase.
     * Returns a map of playerId → signed hex (or null if not yet signed).
     */
    async readCashoutPartials(phase) {
      if (!currentPhase) throw new Error('no current phase');
      const partials = {};
      for (const signer of currentPhase.signers) {
        const key = 'chips.vrsc::poker.sg777z.p_cashout_sig.' + phase;
        try {
          const sig = await p2p.read(signer.id, key);
          if (sig && sig.signedHex) {
            partials[signer.id] = sig;
          }
        } catch (e) {
          // Player hasn't signed yet or doesn't have the key
        }
      }
      return partials;
    },

    /**
     * Wait for the threshold of cashout signatures, combine the partials,
     * and broadcast the complete settlement TX.
     *
     * Returns { ok: true, txid } on success or { ok: false, reason } on failure.
     */
    async finalizeCashout(timeoutMs = 300000) {
      if (!currentPhase) throw new Error('no current phase');
      const phase = currentPhase.phase;

      console.log('[DEALER] Waiting for ' + currentPhase.threshold + ' of ' + currentPhase.signers.length + ' signatures on phase ' + phase);
      const start = Date.now();

      while (Date.now() - start < timeoutMs) {
        const partials = await this.readCashoutPartials(phase);
        const partialHexes = Object.values(partials).map(p => p.signedHex);

        // With sequential signing (Verus has no combinerawtransaction), the
        // LATEST partial is the one with the most signatures. Try each partial
        // — the one that's complete is the assembled TX we want.
        let completeHex = null;
        for (const hex of partialHexes) {
          try {
            const decoded = await p2p.decodeRawTx(hex);
            // Quick check: try signing it locally — if signrawtransaction
            // returns complete=true, this hex has all the sigs needed.
            const trySign = await p2p.client.call('signrawtransaction', [hex]);
            if (trySign.complete) {
              completeHex = trySign.hex;
              break;
            }
          } catch {}
        }

        if (completeHex) {
          console.log('[DEALER] Found complete settlement signature, broadcasting');
          try {
            const txid = await p2p.broadcastSettlement(completeHex);
            console.log('[DEALER] Settlement broadcast: ' + txid);

            // Publish cashout_settled
            const settledKey = 'chips.vrsc::poker.sg777z.t_cashout_settled.' + phase;
            await p2p.write(p2p.tableId, settledKey, {
              type: 'cashout_settled',
              phase,
              settlementTxId: txid,
              timestamp: Date.now(),
            });

            // Mark current phase as settled
            currentPhase.settled = true;
            currentPhase.settlementTxId = txid;

            return { ok: true, txid };
          } catch (e) {
            console.log('[DEALER] Combine/broadcast failed: ' + e.message + ' — will retry');
          }
        }

        await WAIT(3000);
      }

      return { ok: false, reason: 'timeout waiting for signatures' };
    },

    /**
     * Compose a cashout for the current phase using the current player chip
     * stacks from the dealer's in-memory players[] state.
     *
     * This is the convenience wrapper that ties the existing hand-play state
     * (players[].chips) to the new cashout flow. Use it after a hand or
     * sequence of hands has finished and you want to settle.
     *
     * Optional `feeAbsorber` is the player ID who absorbs the TX fee
     * (subtracted from their stack). Defaults to the player with the smallest
     * non-zero stack.
     */
    async composeCashoutFromPlayers(feeAbsorber = null) {
      if (!currentPhase || !currentPhase.confirmed) {
        throw new Error('no confirmed phase');
      }
      const fee = 0.0001;
      const stacks = {};
      for (const signer of currentPhase.signers) {
        const p = players.find(x => x.id === signer.id);
        stacks[signer.id] = p ? p.chips : 0;
      }

      // Determine fee absorber if not specified
      if (!feeAbsorber) {
        const candidates = currentPhase.signers
          .filter(s => stacks[s.id] >= fee)
          .sort((a, b) => stacks[a.id] - stacks[b.id]);
        feeAbsorber = candidates.length ? candidates[0].id : currentPhase.signers[0].id;
      }
      stacks[feeAbsorber] = Math.round((stacks[feeAbsorber] - fee) * 1e8) / 1e8;

      return await this.composeCashout(stacks);
    },

    /**
     * Trigger a phase rotation to a new roster.
     *
     * 1. Compose and publish a cashout for the current phase using `currentStacks`
     * 2. Wait for player partials and finalize (broadcast settlement TX)
     * 3. Open a new phase with the new roster
     * 4. Wait for new deposits + publish phase_confirmed
     *
     * This is the synchronous "settle then restart" rotation. Players who
     * are continuing must verify, sign, and re-deposit.
     *
     * Returns the new phase descriptor on success or { error } on failure.
     */
    async rotatePhase(currentStacks, newRoster, newThreshold, settlementTimeoutMs = 120000, depositTimeoutMs = 120000) {
      if (!currentPhase || !currentPhase.confirmed) {
        throw new Error('no confirmed current phase to rotate from');
      }

      const oldPhase = currentPhase.phase;
      console.log('[DEALER] Phase rotation: settling ' + oldPhase + ' then opening new phase');

      // Step 1+2: settle the current phase
      try {
        await this.composeCashout(currentStacks);
      } catch (e) {
        return { error: 'composeCashout failed: ' + e.message };
      }

      const final = await this.finalizeCashout(settlementTimeoutMs);
      if (!final.ok) {
        return { error: 'finalizeCashout failed: ' + final.reason };
      }
      console.log('[DEALER] Old phase settled (tx ' + final.txid + ')');

      // Step 3: open the new phase
      const newPhase = await this.openPhase(newRoster, newThreshold);
      console.log('[DEALER] New phase opened: ' + newPhase.phase);

      // Step 4: wait for deposits in the new phase
      const ok = await this.waitForPhaseDeposits(depositTimeoutMs);
      if (!ok) {
        return { error: 'new phase deposits timed out' };
      }

      console.log('[DEALER] Phase rotation complete: ' + oldPhase + ' -> ' + newPhase.phase);
      return newPhase;
    },

    /**
     * Atomic phase rotation — settles old multisig AND funds new multisig in
     * a SINGLE transaction. Eliminates the separate deposit cycle that adds
     * ~40-50s of chain confirmation time.
     *
     * The rotation TX has mixed inputs:
     *   - Old multisig UTXOs (signed by M-of-N old signers)
     *   - New joiner personal UTXOs (signed by each joiner, if any)
     *
     * And mixed outputs:
     *   - Leaving players → their R-addresses
     *   - New multisig ← continuing stacks + joiner deposits
     *
     * newRoster: [{ id, payAddr, pubkey, expectedDeposit }]
     * joinerIntents: [{ id, payAddr, utxos: [{txid,vout,amount}], depositAmount }]
     *   — published by joiners; empty array if no new joiners
     * feeAbsorber: player id who pays the fee (default: smallest non-zero stack)
     *
     * Returns { ok, txid, newPhase } on success.
     */
    async composeAtomicRotation(newRoster, newThreshold, joinerIntents = [], feeAbsorber = null) {
      if (!currentPhase || !currentPhase.confirmed) {
        throw new Error('no confirmed current phase to rotate from');
      }
      const fee = 0.0001;
      const oldSigners = currentPhase.signers;
      const oldSignerIds = new Set(oldSigners.map(s => s.id));
      const newSignerIds = new Set(newRoster.map(r => r.id));

      // Classify players
      const leavers = oldSigners.filter(s => !newSignerIds.has(s.id));
      const continuing = oldSigners.filter(s => newSignerIds.has(s.id));
      const joiners = newRoster.filter(r => !oldSignerIds.has(r.id));

      // Get current chip stacks for old players
      const stacks = {};
      for (const signer of oldSigners) {
        const p = players.find(x => x.id === signer.id);
        stacks[signer.id] = p ? p.chips : 0;
      }

      // Fee absorber
      if (!feeAbsorber) {
        const candidates = continuing.filter(s => stacks[s.id] >= fee).sort((a, b) => stacks[a.id] - stacks[b.id]);
        feeAbsorber = candidates.length ? candidates[0].id : (continuing[0] || leavers[0]).id;
      }
      stacks[feeAbsorber] = Math.round((stacks[feeAbsorber] - fee) * 1e8) / 1e8;

      // Leaver payouts — they get their stack paid to R-addr
      const leaverPayouts = leavers
        .filter(s => stacks[s.id] > 0)
        .map(s => ({ address: s.payAddr, amount: stacks[s.id] }));

      // New multisig amount = continuing stacks + joiner deposits
      const continuingTotal = continuing.reduce((s, c) => s + (stacks[c.id] || 0), 0);
      const joinerTotal = joinerIntents.reduce((s, j) => s + j.depositAmount, 0);
      const newMultisigAmount = Math.round((continuingTotal + joinerTotal) * 1e8) / 1e8;

      // Compute new multisig address
      const newPubkeys = newRoster.map(r => r.pubkey).sort();
      const newMs = await p2p.computeMultisigAddress(newPubkeys, newThreshold);

      // Build joiner inputs + change
      const joinerUtxos = [];
      const joinerChange = [];
      for (const ji of joinerIntents) {
        for (const u of ji.utxos) joinerUtxos.push(u);
        const joinerIn = ji.utxos.reduce((s, u) => s + u.amount, 0);
        const change = Math.round((joinerIn - ji.depositAmount) * 1e8) / 1e8;
        if (change > 0.00001) {
          joinerChange.push({ address: ji.payAddr, amount: change });
        }
      }

      // Old multisig inputs
      const oldUtxos = Object.values(currentPhase.deposits).map(d => ({
        txid: d.txid, vout: d.vout, amount: d.amount,
      }));

      // Sum invariant
      const totalIn = Math.round((oldUtxos.reduce((s, u) => s + u.amount, 0) + joinerUtxos.reduce((s, u) => s + u.amount, 0)) * 1e8) / 1e8;
      const totalOut = Math.round((leaverPayouts.reduce((s, p) => s + p.amount, 0) + newMultisigAmount + joinerChange.reduce((s, c) => s + c.amount, 0) + fee) * 1e8) / 1e8;
      if (Math.abs(totalIn - totalOut) > 0.0001) {
        throw new Error('atomic rotation sum invariant: in=' + totalIn + ' out=' + totalOut + ' diff=' + (totalIn - totalOut));
      }

      const unsignedHex = await p2p.composeAtomicRotationTx({
        oldMultisigUtxos: oldUtxos,
        leaverPayouts,
        newMultisigAddr: newMs.address,
        newMultisigAmount,
        joinerUtxos,
        joinerChange,
        fee,
      });

      // Increment phase number
      phaseCount++;
      const newPhaseId = gameId + '_p' + phaseCount;

      // Publish the atomic rotation proposal
      const proposal = {
        type: 'atomic_rotation',
        phase: currentPhase.phase,
        newPhase: newPhaseId,
        table: p2p.tableId,
        oldMultisigAddr: currentPhase.multisigAddr,
        oldRedeemScript: currentPhase.redeemScript,
        newMultisigAddr: newMs.address,
        newRedeemScript: newMs.redeemScript,
        newThreshold,
        newPubkeys,
        newSigners: newRoster.map(r => ({ id: r.id, payAddr: r.payAddr, pubkey: r.pubkey })),
        leavers: leavers.map(l => ({ id: l.id, payAddr: l.payAddr, amount: stacks[l.id] || 0 })),
        continuing: continuing.map(c => ({ id: c.id, stackCarryOver: stacks[c.id] || 0 })),
        joinerDeposits: joinerIntents.map(j => ({ id: j.id, payAddr: j.payAddr, depositAmount: j.depositAmount })),
        fee,
        unsignedTxHex: unsignedHex,
        timestamp: Date.now(),
      };

      // Use the same cashout key as regular cashouts so the existing
      // player polling loop (autoRespondToCashouts) picks it up
      const cashoutKey = 'chips.vrsc::poker.sg777z.t_cashout.' + currentPhase.phase;
      await p2p.write(p2p.tableId, cashoutKey, proposal);

      console.log('[DEALER] Atomic rotation published: ' + currentPhase.phase + ' → ' + newPhaseId);
      console.log('[DEALER]   leavers: ' + leavers.map(l => l.id).join(', ') || 'none');
      console.log('[DEALER]   continuing: ' + continuing.map(c => c.id + '(' + (stacks[c.id] || 0) + ')').join(', '));
      console.log('[DEALER]   joiners: ' + joiners.map(j => j.id).join(', ') || 'none');
      console.log('[DEALER]   new multisig: ' + newMs.address + ' (' + newThreshold + '-of-' + newRoster.length + ')');

      // Store the new phase descriptor so finalizeCashout can transition
      currentPhase._atomicNext = {
        phaseId: newPhaseId,
        multisigAddr: newMs.address,
        redeemScript: newMs.redeemScript,
        threshold: newThreshold,
        signers: newRoster.map(r => ({ id: r.id, payAddr: r.payAddr, pubkey: r.pubkey })),
        newMultisigAmount,
      };

      return proposal;
    },

    /**
     * After atomic rotation is finalized (settlement broadcast), transition
     * the dealer's internal state to the new phase. Called after finalizeCashout.
     */
    activateAtomicPhase() {
      if (!currentPhase || !currentPhase._atomicNext) return;
      const next = currentPhase._atomicNext;

      currentPhase = {
        phase: next.phaseId,
        multisigAddr: next.multisigAddr,
        redeemScript: next.redeemScript,
        threshold: next.threshold,
        signers: next.signers,
        confirmed: true,
        deposits: { _atomic: { txid: currentPhase.settlementTxId, vout: 0, amount: next.newMultisigAmount } },
        preExistingUtxos: new Set(),
      };

      // Update the deposit attribution: find the actual UTXO at the new multisig
      // after the rotation tx confirms. For now we use a placeholder that gets
      // refreshed on the next deposit scan.

      console.log('[DEALER] Phase activated: ' + next.phaseId + ' (' + next.threshold + '-of-' + next.signers.length + ')');
      console.log('[DEALER]   multisig: ' + next.multisigAddr + ' balance: ' + next.newMultisigAmount);
    },
  };
}
