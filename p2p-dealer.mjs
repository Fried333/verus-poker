/**
 * P2P Dealer — orchestrates poker hands on-chain
 * Writes game state to Table VerusID, reads player actions from Player VerusIDs.
 * Dealer also acts as cashier in MVP (single-wallet demo).
 */

import { playerInit, dealerShuffle, cashierShuffle, decodeCard, verifyGame } from './protocol.mjs';
import { evaluateHand, cardToString } from './hand-eval.mjs';
import {
  createGame, addPlayer, startHand, postBlinds, playerAction,
  dealBoard, setHoleCards, settleHand, applyPayouts, getValidActions, getToCall,
  FOLD, CHECK, CALL, RAISE, ALL_IN, SHOWDOWN, SETTLED
} from './game.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

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
      console.log('[DEALER] Opening table ' + p2p.tableId + ' game=' + gameId);
      await p2p.writeTableInfo(gameId, {
        smallBlind, bigBlind, buyin, maxPlayers: 9, status: 'open', dealer: p2p.myId
      });
      await WAIT(1500);
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

      console.log('\n[DEALER] ══════ HAND ' + handCount + ' (' + numPlayers + 'P) ══════');

      // ── STAGE I: Player deck generation ──
      console.log('[DEALER] Stage I: Player decks...');
      await p2p.writeGameState(gameId, { phase: 'shuffle', hand: handCount, players: activePlayers.map(p => ({ id: p.id, seat: p.seat })) });
      await WAIT(1500);

      const playerData = [];
      for (let i = 0; i < numPlayers; i++) {
        const pd = playerInit(numCards, activePlayers[i].id);
        playerData.push(pd);
        // Write player deck to player's own ID (in MVP, all from same wallet)
        await p2p.writePlayerDeck(handId, {
          playerId: activePlayers[i].id,
          publicKey: pd.publicKey,
          blindedDeck: pd.blindedDeck,
          commitment: pd.commitment
        });
        await WAIT(1500);
      }

      // ── STAGE II: Dealer shuffle ──
      console.log('[DEALER] Stage II: Dealer shuffle...');
      const dd = dealerShuffle(playerData, numCards);

      // Write per-player dealer decks (each ~3.5KB, under 5KB limit)
      for (let i = 0; i < numPlayers; i++) {
        await p2p.writeDealerPlayerDeck(handId, i + 1, {
          deck: dd.blindedDecks[i],
          E: dd.E[i],
          player: activePlayers[i].id
        });
        await WAIT(1500);
      }

      // ── STAGE III: Cashier shuffle (dealer acts as cashier in MVP) ──
      console.log('[DEALER] Stage III: Cashier shuffle...');
      const threshold = Math.max(2, Math.ceil(numPlayers / 2) + 1);
      const cd = cashierShuffle(dd.blindedDecks, numPlayers, numCards, threshold);

      for (let i = 0; i < numPlayers; i++) {
        await p2p.writeCashierPlayerDeck(handId, i + 1, {
          deck: cd.finalDecks[i],
          player: activePlayers[i].id
        });
        await WAIT(1500);
      }

      // ── DEAL HOLE CARDS ──
      console.log('[DEALER] Dealing hole cards...');
      let cardPos = 0;
      const holeCards = {};
      for (let i = 0; i < numPlayers; i++) {
        const cards = [];
        for (let c = 0; c < 2; c++) {
          const idx = decodeCard(
            cd.finalDecks[i][cardPos], cd.b[i][cardPos],
            dd.e[i], dd.d, playerData[i].sessionKey, playerData[i].initialDeck
          );
          cards.push(idx % 52);
          cardPos++;
        }
        holeCards[activePlayers[i].id] = cards;
        console.log('  ' + activePlayers[i].id + ': ' + cards.map(cardToString).join(' '));

        // Write card reveal (blinding values) for this player
        await p2p.writeCardBV(handId, {
          player: activePlayers[i].id,
          cards: cards.map(cardToString),
          type: 'hole'
        });
        await WAIT(1500);
      }
      notify('cards_dealt', { holeCards });

      // ── PLAY THE HAND (betting rounds) ──
      console.log('[DEALER] Playing hand...');
      const game = createGame({ smallBlind, bigBlind, rake: 0 });
      for (const p of activePlayers) addPlayer(game, p.id, p.chips);
      game.dealerSeat = dealerSeatIdx % numPlayers;

      startHand(game);
      postBlinds(game);
      for (let i = 0; i < numPlayers; i++) {
        setHoleCards(game, i, holeCards[activePlayers[i].id]);
      }

      // Write blinds state
      await p2p.writeBettingState(handId, {
        phase: game.phase, pot: game.pot, dealerSeat: game.dealerSeat,
        players: game.players.map(p => ({ id: p.id, chips: p.chips, bet: p.bet }))
      });
      await WAIT(1500);

      // Community card crypto backend
      let revealPos = numPlayers * 2;

      // Main betting loop
      while (game.phase !== SHOWDOWN && game.phase !== SETTLED) {
        // Deal community cards if entering new street
        if (game.phase === 'flop' && game.board.length === 0) {
          const cards = [];
          for (let i = 0; i < 3; i++) {
            const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
            cards.push(idx % 52); revealPos++;
          }
          dealBoard(game, cards);
          await p2p.writeBoardCards(handId, { board: game.board.map(cardToString), phase: 'flop' });
          console.log('  Flop: ' + cards.map(cardToString).join(' '));
          await WAIT(1500);
        } else if (game.phase === 'turn' && game.board.length === 3) {
          const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
          dealBoard(game, [idx % 52]); revealPos++;
          await p2p.writeBoardCards(handId, { board: game.board.map(cardToString), phase: 'turn' });
          console.log('  Turn: ' + cardToString(game.board[3]));
          await WAIT(1500);
        } else if (game.phase === 'river' && game.board.length === 4) {
          const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
          dealBoard(game, [idx % 52]); revealPos++;
          await p2p.writeBoardCards(handId, { board: game.board.map(cardToString), phase: 'river' });
          console.log('  River: ' + cardToString(game.board[4]));
          await WAIT(1500);
        }

        if (game.currentTurn < 0) { game.phase = SHOWDOWN; break; }

        const seat = game.currentTurn;
        const p = game.players[seat];
        const validActions = getValidActions(game);
        const toCall = getToCall(game, seat);

        // Write betting state (whose turn)
        await p2p.writeBettingState(handId, {
          phase: game.phase, pot: game.pot, turn: p.id, seat,
          validActions, toCall, minRaise: game.minRaise,
          players: game.players.map(pp => ({ id: pp.id, chips: pp.chips, bet: pp.bet, folded: pp.folded }))
        });

        // Wait for player action
        let action;
        // Ask for action via callback (works for local player and auto-play)
        action = await new Promise(resolve => {
          notify('need_action', { resolve, validActions, toCall, seat, playerId: p.id });
          setTimeout(() => resolve(null), 30000);
        });

        if (!action) {
          action = { action: validActions.includes(CHECK) ? CHECK : FOLD, amount: 0 };
          console.log('  ' + p.id + ' timed out → ' + action.action);
        } else {
          console.log('  ' + p.id + ': ' + action.action + (action.amount ? ' ' + action.amount : ''));
        }

        if (!validActions.includes(action.action)) {
          action = { action: FOLD, amount: 0 };
        }
        playerAction(game, seat, action.action, action.amount || 0);
        notify('action', { player: p.id, action: action.action, amount: action.amount });
        await WAIT(500);
      }

      // ── SHOWDOWN ──
      if (game.phase === SHOWDOWN) {
        const nonFolded = game.players.filter(p => !p.folded);
        if (nonFolded.length > 1) {
          while (game.board.length < 5) {
            const idx = decodeCard(cd.finalDecks[0][revealPos], cd.b[0][revealPos], dd.e[0], dd.d, playerData[0].sessionKey, playerData[0].initialDeck);
            dealBoard(game, [idx % 52]); revealPos++;
          }
          await p2p.writeBoardCards(handId, { board: game.board.map(cardToString), phase: 'showdown' });
          console.log('  Board: ' + game.board.map(cardToString).join(' '));
        }

        const payouts = settleHand(game, evaluateHand);
        applyPayouts(game, payouts);

        console.log('  Payouts: ' + Object.entries(payouts).filter(([, v]) => v > 0).map(([s, v]) => game.players[s].id + ':+' + v).join(' '));
      }

      // ── VERIFY ──
      const verification = verifyGame(playerData, dd, cd, numCards);
      console.log('[DEALER] Verify: ' + (verification.valid ? 'PASS' : 'FAIL: ' + verification.errors.join(', ')));

      // Write settlement
      await p2p.writeSettlement(handId, {
        hand: handCount, verified: verification.valid,
        results: game.players.map(p => ({ id: p.id, chips: p.chips })),
        board: game.board.map(cardToString)
      });

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
