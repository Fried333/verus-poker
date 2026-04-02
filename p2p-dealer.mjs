/**
 * P2P Dealer — orchestrates poker hands on-chain
 * Writes game state to Table VerusID, reads player actions from Player VerusIDs.
 * Dealer also acts as cashier in MVP (single-wallet demo).
 */

import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
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
  const { smallBlind, bigBlind, buyin } = config;
  const players = []; // { id, seat, chips }
  let handCount = 0;
  let dealerSeatIdx = 0;
  let gameId = null;

  function notify(event, data) {
    if (localNotify) localNotify(event, data);
  }

  return {
    async openTable() {
      gameId = 'g' + Date.now().toString(36);
      console.log('[DEALER] Opening table ' + p2p.tableId + ' session=' + gameId);
      // Write ONLY to base key (player polls this). Skip game-specific key to avoid UTXO conflict.
      await p2p.write(p2p.tableId, 'chips.vrsc::poker.sg777z.t_table_info', {
        smallBlind, bigBlind, buyin, maxPlayers: 9, status: 'open', dealer: p2p.myId, session: gameId
      });
      await WAIT(2000);
    },

    addSelf(chips) {
      players.push({ id: p2p.myId, seat: players.length, chips: chips || buyin });
      console.log('[DEALER] Self-seated at seat ' + (players.length - 1));
    },

    addPlayer(playerId, chips) {
      players.push({ id: playerId, seat: players.length, chips: chips || buyin });
      console.log('[DEALER] ' + playerId + ' seated at seat ' + (players.length - 1));
    },

    async waitForJoin(playerId, timeout) {
      console.log('[DEALER] Waiting for ' + playerId + ' to join...');
      const join = await p2p.pollAction(playerId, gameId, null, timeout || 60000);
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
      const activePlayers = players.filter(p => p.chips > 0);
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

      // ── ALL 3 STAGES: Player init → Dealer shuffle → Cashier shuffle ──
      const playerData = [];
      for (let i = 0; i < numPlayers; i++) {
        playerData.push(playerInit(numCards, activePlayers[i].id));
      }
      const dd = dealerShuffle(playerData, numCards);
      const threshold = Math.max(2, Math.ceil(numPlayers / 2) + 1);
      const cd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);

      // ── DEAL HOLE CARDS (decode locally) ──
      let cardPos = 0;
      const holeCards = {};
      const d0 = { deck: cd.finalDecks[0], b: cd.b[0], e: dd.e[0], key: playerData[0].sessionKey, init: playerData[0].initialDeck };
      for (let i = 0; i < numPlayers; i++) {
        const cards = [];
        for (let c = 0; c < 2; c++) {
          cards.push(decodeCard(d0.deck[cardPos], d0.b[cardPos], d0.e, dd.d, d0.key, d0.init));
          cardPos++;
        }
        holeCards[activePlayers[i].id] = cards;
        dlog('  ' + activePlayers[i].id + ': ' + cards.map(cardToString).join(' '));
      }

      // ── SINGLE BATCH WRITE: all init data in ONE TX ──
      // Matches C code: "Single atomic update with all init data in single transaction"
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
      let wt = Date.now();
      await p2p.writeBatch(p2p.tableId, initEntries);
      dlog('Init batch written (' + initEntries.length + ' keys, ' + (Date.now()-wt) + 'ms)');

      // ── PLAY THE HAND (betting rounds) ──
      dlog('Playing hand...');
      const game = createGame({ smallBlind, bigBlind, rake: 0 });
      for (const p of activePlayers) addPlayer(game, p.id, p.chips);
      game.dealerSeat = dealerSeatIdx % numPlayers;

      startHand(game);
      postBlinds(game);
      for (let i = 0; i < numPlayers; i++) {
        setHoleCards(game, i, holeCards[activePlayers[i].id]);
      }

      // Notify AFTER blinds posted so browser gets correct chip counts
      // Update table_info with current handId so player knows which keys to poll
      await p2p.write(p2p.tableId, 'chips.vrsc::poker.sg777z.t_table_info', {
        smallBlind, bigBlind, buyin, maxPlayers: 9, status: 'playing', dealer: p2p.myId,
        session: gameId, currentHandId: handId, handCount
      });

      notify('cards_dealt', { holeCards, handId,
        gamePlayers: game.players.map(gp => ({ id: gp.id, chips: gp.chips, bet: gp.bet, seat: gp.seat })),
        pot: game.pot, phase: game.phase, dealerSeat: game.dealerSeat
      });

      // Write blinds state
      await p2p.writeBettingState(handId, {
        phase: game.phase, pot: game.pot, dealerSeat: game.dealerSeat,
        players: game.players.map(p => ({ id: p.id, chips: p.chips, bet: p.bet }))
      });
      // Community card crypto backend
      let revealPos = numPlayers * 2;

      // Main betting loop
      while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
        // Deal community cards if entering new street
        let streetDealt = false;
        if (game.phase === 'flop' && game.board.length === 0) {
          const cards = [];
          for (let i = 0; i < 3; i++) {
            cards.push(decodeCard(d0.deck[revealPos], d0.b[revealPos], d0.e, dd.d, d0.key, d0.init));
            revealPos++;
          }
          dealBoard(game, cards);
          dlog('Flop decoded: ' + cards.map(cardToString).join(' '));
          notify('community_cards', { phase: 'flop', cards, board: game.board });
          streetDealt = true;
        } else if (game.phase === 'turn' && game.board.length === 3) {
          const idx = decodeCard(d0.deck[revealPos], d0.b[revealPos], d0.e, dd.d, d0.key, d0.init);
          dealBoard(game, [idx]); revealPos++;
          dlog('Turn decoded: ' + cardToString(game.board[3]));
          notify('community_cards', { phase: 'turn', board: game.board });
          streetDealt = true;
        } else if (game.phase === 'river' && game.board.length === 4) {
          const idx = decodeCard(d0.deck[revealPos], d0.b[revealPos], d0.e, dd.d, d0.key, d0.init);
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
          players: game.players.map(pp => ({ id: pp.id, chips: pp.chips, bet: pp.bet, folded: pp.folded }))
        };

        // Only write to chain when it's a REMOTE player's turn
        // Dealer's own turn is handled locally — no chain write needed
        const isLocalPlayer = (p.id === p2p.myId);

        if (!isLocalPlayer) {
          let wt = Date.now();
          if (streetDealt) {
            // Batch: board_cards + betting_state in 1 TX
            const boardKey = gameKey(VDXF_KEYS.BOARD_CARDS, handId);
            const bsKey = gameKey(VDXF_KEYS.BETTING_STATE, handId);
            await p2p.writeBatch(p2p.tableId, [
              { key: boardKey, data: { board: game.board.map(cardToString), phase: game.phase, hand: handCount, session: gameId } },
              { key: bsKey, data: bsData }
            ]);
            dlog('Board+BS batch: ' + game.phase + ' turn=' + p.id + ' pot=' + game.pot + ' (' + (Date.now()-wt) + 'ms)');
          } else {
            await p2p.writeBettingState(handId, bsData);
            dlog('BS written: turn=' + p.id + ' phase=' + game.phase + ' pot=' + game.pot + ' (' + (Date.now()-wt) + 'ms)');
          }
        } else {
          dlog('Local turn: ' + p.id + ' phase=' + game.phase + ' (no chain write)');
        }

        // Wait for player action
        let action;
        const pollStart = Date.now();
        action = await new Promise(resolve => {
          notify('need_action', { resolve, validActions, toCall, seat, playerId: p.id, pot: game.pot, minRaise: game.minRaise,
            phase: game.phase, handId, gamePlayers: game.players.map(gp => ({ id: gp.id, chips: gp.chips, bet: gp.bet, folded: gp.folded })) });
          setTimeout(() => resolve(null), 30000);
        });

        const pollMs = Date.now() - pollStart;
        if (!action) {
          action = { action: validActions.includes(CHECK) ? CHECK : FOLD, amount: 0 };
          dlog(p.id + ' timed out → ' + action.action + ' (waited ' + (pollMs/1000).toFixed(1) + 's)');
        } else {
          dlog(p.id + ': ' + action.action + (action.amount ? ' ' + action.amount : '') + ' (waited ' + (pollMs/1000).toFixed(1) + 's)');
        }

        if (!validActions.includes(action.action)) {
          action = { action: FOLD, amount: 0 };
        }
        playerAction(game, seat, action.action, action.amount || 0);
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
            const idx = decodeCard(d0.deck[revealPos], d0.b[revealPos], d0.e, dd.d, d0.key, d0.init);
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
      for (const gp of game.players) {
        if (!gp.folded && gp.holeCards.length > 0 && game.board.length >= 3 && nonFoldedCount > 1) {
          const score = evaluateHand([...gp.holeCards, ...game.board]);
          handNames[gp.seat] = rankNames[Math.floor(score / 1e10)] || 'Unknown';
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
      const verification = verifyGame(playerData, dd, cd, numCards);
      dlog('Verify: ' + (verification.valid ? 'PASS' : 'FAIL') + ' (' + (Date.now()-vt) + 'ms)');

      // Write settlement
      vt = Date.now();
      await p2p.writeSettlement(handId, {
        hand: handCount, verified: verification.valid, session: gameId,
        results: game.players.map(p => ({ id: p.id, chips: p.chips })),
        board: game.board.map(cardToString),
        handNames, allHoleCards, winners, winAmount
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
    getGameId() { return gameId; }
  };
}
