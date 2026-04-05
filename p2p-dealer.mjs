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
      players.push({ id: playerId, seat, chips: chips || buyin, sittingOut: false, timeouts: 0 });
      console.log('[DEALER] ' + playerId + ' seated at seat ' + seat);
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
        // Write shuffle request for external cashier nodes
        // Split across keys — header + one key per player deck (each ~3.5KB)
        dlog('Sending Stage III to cashier: ' + cashiers[0]);
        // Batch small writes: base key + per-hand key (440 bytes total, 1 TX)
        const reqData = { handId, session: gameId, numPlayers, numCards, threshold, timestamp: Date.now() };
        await p2p.writeBatch(p2p.tableId, [
          { key: 'chips.vrsc::poker.sg777z.t_shuffle_request', data: reqData },
          { key: 'chips.vrsc::poker.sg777z.t_shuffle_request.' + handId, data: reqData }
        ]);
        dlog('Request batch written (1 TX)');
        // Player decks separate (3.5KB each, too big to batch)
        for (let i = 0; i < numPlayers; i++) {
          await p2p.write(p2p.tableId, 'chips.vrsc::poker.sg777z.t_shuffle_deck.' + handId + '.p' + i,
            { player: i, deck: dd.blindedDecks[i] }
          );
          dlog('Deck ' + i + ' written');
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
          // Read only finalDecks (blindedcards) — b values come per-card during hand
          const finalDecks = [];
          for (let i = 0; i < numPlayers; i++) {
            let deckData = null;
            for (let retry = 0; retry < 40; retry++) {
              deckData = await p2p.read(cashiers[0], cashierResultKey + '.deck.' + i);
              if (deckData && deckData.deck) break;
              deckData = null;
              await WAIT(500);
            }
            finalDecks.push(deckData ? deckData.deck : []);
          }
          cd = { finalDecks, cashierCommitment: cashierMeta.cashierCommitment };
          dlog('Cashier decks received (' + numPlayers + ' players)');
        }
      } else {
        // No external cashiers — do Stage III locally
        cd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);
      }

      // ── Request blinding values from cashier for card positions ──
      async function requestBlindings(positions, playerIdx) {
        if (!useCashiers || !cashiers[0]) {
          // Local mode: b values are in cd.b
          const result = {};
          for (const pos of positions) result[pos] = cd.b[playerIdx][pos];
          return result;
        }
        const reqTimestamp = Date.now();
        const revealKey = 'chips.vrsc::poker.sg777z.t_reveal_request.' + handId;
        await p2p.write(p2p.tableId, revealKey, {
          handId, positions, playerIdx, timestamp: reqTimestamp
        });
        dlog('Requested blindings for positions ' + positions.join(','));

        // Poll for cashier's response
        const resultKey = 'chips.vrsc::poker.sg777z.c_reveal_result.' + handId + '.' + reqTimestamp;
        for (let i = 0; i < 60; i++) {
          const result = await p2p.read(cashiers[0], resultKey);
          if (result && result.blindings) return result.blindings;
          await WAIT(500);
        }
        dlog('Blinding request timed out');
        return {};
      }

      // ── DEAL HOLE CARDS ──
      let cardPos = 0;
      const holeCards = {};
      // Request all hole card blindings at once (2 per player × numPlayers)
      const holePositions = [];
      for (let i = 0; i < numPlayers * 2; i++) holePositions.push(i);
      const holeBlindings = await requestBlindings(holePositions, 0);
      const d0 = { deck: cd.finalDecks[0], e: dd.e[0], key: playerData[0].sessionKey, init: playerData[0].initialDeck };
      dlog('DEBUG: deck[0] type=' + typeof d0.deck[0] + ' blinding[0] type=' + typeof holeBlindings[0] + ' e type=' + typeof d0.e);
      dlog('DEBUG: blinding keys=' + Object.keys(holeBlindings).join(',') + ' count=' + Object.keys(holeBlindings).length);
      for (let i = 0; i < numPlayers; i++) {
        const cards = [];
        for (let c = 0; c < 2; c++) {
          const raw = decodeCard(d0.deck[cardPos], holeBlindings[cardPos], d0.e, dd.d, d0.key, d0.init);
          dlog('DEBUG: pos=' + cardPos + ' raw=' + raw + ' card=' + cardToString(raw));
          cards.push(raw);
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
          const flopPositions = [revealPos, revealPos + 1, revealPos + 2];
          const flopBlindings = await requestBlindings(flopPositions, 0);
          const cards = [];
          for (let i = 0; i < 3; i++) {
            cards.push(decodeCard(d0.deck[revealPos], flopBlindings[revealPos], d0.e, dd.d, d0.key, d0.init));
            revealPos++;
          }
          dealBoard(game, cards);
          dlog('Flop decoded: ' + cards.map(cardToString).join(' '));
          notify('community_cards', { phase: 'flop', cards, board: game.board });
          streetDealt = true;
        } else if (game.phase === 'turn' && game.board.length === 3) {
          const turnBlindings = await requestBlindings([revealPos], 0);
          const idx = decodeCard(d0.deck[revealPos], turnBlindings[revealPos], d0.e, dd.d, d0.key, d0.init);
          dealBoard(game, [idx]); revealPos++;
          dlog('Turn decoded: ' + cardToString(game.board[3]));
          notify('community_cards', { phase: 'turn', board: game.board });
          streetDealt = true;
        } else if (game.phase === 'river' && game.board.length === 4) {
          const riverBlindings = await requestBlindings([revealPos], 0);
          const idx = decodeCard(d0.deck[revealPos], riverBlindings[revealPos], d0.e, dd.d, d0.key, d0.init);
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
          validActions, toCall, minRaise: game.minRaise,
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
          setTimeout(() => resolve(null), 30000);
        });

        const pollMs = Date.now() - pollStart;
        if (!action) {
          action = { action: validActions.includes(CHECK) ? CHECK : FOLD, amount: 0 };
          dlog(p.id + ' timed out → ' + action.action + ' (waited ' + (pollMs/1000).toFixed(1) + 's)');
          // Track consecutive timeouts — sit out after MAX_TIMEOUTS
          const pp = players.find(x => x.id === p.id);
          if (pp) {
            pp.timeouts = (pp.timeouts || 0) + 1;
            if (pp.timeouts >= MAX_TIMEOUTS) {
              pp.sittingOut = true;
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
        lastActionInfo = { player: p.id, action: action.action, amount: action.amount || 0 };
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
            const sdBlindings = await requestBlindings([revealPos], 0);
            const idx = decodeCard(d0.deck[revealPos], sdBlindings[revealPos], d0.e, dd.d, d0.key, d0.init);
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
        handNames, bestHands, allHoleCards, winners, winAmount
      });
      dlog('Settlement written (' + (Date.now()-vt) + 'ms)');
      dlog('HAND TOTAL: ' + ((Date.now()-handT0)/1000).toFixed(1) + 's | chips: ' + game.players.map(p => p.id + '=' + p.chips).join(' '));

      // Update player chips
      for (const gp of game.players) {
        const p = players.find(x => x.id === gp.id);
        if (p) p.chips = gp.chips;
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
        console.log('[DEALER] ' + playerId + ' sat back in');
        return true;
      }
      return false;
    }
  };
}
