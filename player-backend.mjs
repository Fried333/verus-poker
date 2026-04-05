/**
 * Player Backend — shared chain-polling state machine for poker players.
 * Used by both TUI (tui-player.mjs) and GUI (gui-server.mjs).
 * No rendering, no I/O — pure state + callbacks.
 *
 * Usage:
 *   const backend = createPlayerBackend(p2p, myId, tableId);
 *   backend.onStateChange(state => render(state));
 *   backend.onNeedAction((state, respond) => respond({ action: 'check', amount: 0 }));
 *   await backend.start();
 */

import { createP2PLayer } from './p2p-layer.mjs';

const WAIT = ms => new Promise(r => setTimeout(r, ms));

const KEYS = {
  TABLE_CONFIG:  'chips.vrsc::poker.sg777z.t_table_info',
  BETTING_STATE: 'chips.vrsc::poker.sg777z.t_betting_state',
  BOARD_CARDS:   'chips.vrsc::poker.sg777z.t_board_cards',
  CARD_BV:       'chips.vrsc::poker.sg777z.card_bv',
  JOIN_REQUEST:  'chips.vrsc::poker.sg777z.p_join_request',
  PLAYER_ACTION: 'chips.vrsc::poker.sg777z.p_betting_action',
  SETTLEMENT:    'chips.vrsc::poker.sg777z.t_settlement_info',
};

export function createPlayerBackend(p2p, myId, tableId) {
  // ── State (single source of truth) ──
  const state = {
    phase: 'connecting',
    session: null,
    handId: null,
    handCount: 0,
    myCards: [],
    board: [],
    pot: 0,
    players: [],
    turn: null,
    validActions: [],
    toCall: 0,
    minRaise: 2,
    dealerSeat: 0,
    winner: null,
    verified: null,
    message: 'Connecting...',
    showdownCards: {},
    handNames: {},
    actionLog: [],
  };

  // ── Callbacks ──
  let _onStateChange = null;
  let _onNeedAction = null;
  let _onLog = null;

  // ── Internal tracking ──
  let lastBSSeq = -1;
  let lastActedSeq = -1;
  let lastSettledHandId = null;
  let acted = false;
  let actionPending = false; // true while waiting for user input (prevents re-trigger)
  let missedTurns = 0;
  let handsWithoutCards = 0; // Track if we're being skipped (sat out by dealer)
  let lastHandTime = 0; // Track when we last saw a new hand

  const T0 = Date.now();
  function ts() { return ((Date.now() - T0) / 1000).toFixed(1) + 's'; }

  function log(msg) {
    const entry = '[' + ts() + '] ' + msg;
    if (_onLog) _onLog(entry);
    console.log('[BACKEND ' + myId + '] ' + msg);
  }

  function notify() {
    if (_onStateChange) _onStateChange(state);
  }

  function addActionLog(msg) {
    state.actionLog.push(msg);
  }

  // ── Public API ──
  return {
    state,

    onStateChange(fn) { _onStateChange = fn; },
    onNeedAction(fn) { _onNeedAction = fn; },
    onLog(fn) { _onLog = fn; },

    /** Reload chips (reset to 200) — used when busted */
    reload() {
      const me = state.players.find(p => p.id === myId);
      if (me) {
        me.chips = 200;
        state.busted = false;
        state.message = 'Reloaded to 200 chips — click Sit In';
        addActionLog(myId + ' reloaded');
        log('Reloaded to 200 chips');
        notify();
      }
    },

    /** Sit back in after reload or sitting out */
    async sitIn() {
      state.busted = false;
      state.message = 'Sitting back in — next hand';
      addActionLog(myId + ' sat back in');
      log('Sitting back in');
      // Write a new join request so dealer sees we're back
      try {
        await p2p.write(myId, KEYS.JOIN_REQUEST, {
          table: tableId, player: myId, session: state.session, ready: true, timestamp: Date.now()
        });
        log('Sit-in join written');
      } catch (e) {
        log('Sit-in write failed: ' + e.message);
      }
      notify();
    },

    async submitAction(action) {
      log('Submitting action: ' + action.action + (action.amount ? ' ' + action.amount : ''));
      acted = true;
      actionPending = false;
      lastActedSeq = lastBSSeq;
      missedTurns = 0;
      state.turn = null;
      state.validActions = [];
      state.message = '';
      addActionLog(myId + ' ' + action.action + (action.amount ? ' ' + action.amount : ''));

      // Immediately update local state so UI reflects the action
      const me = state.players.find(p => p.id === myId);
      if (me) {
        if (action.action === 'fold') {
          me.folded = true;
        } else if (action.action === 'call') {
          const callAmt = Math.min(state.toCall - (me.bet || 0), me.chips);
          me.chips -= callAmt;
          me.bet = (me.bet || 0) + callAmt;
          state.pot += callAmt;
        } else if (action.action === 'raise' || action.action === 'bet') {
          const raiseAmt = Math.min(action.amount || state.minRaise, me.chips);
          me.chips -= raiseAmt;
          me.bet = (me.bet || 0) + raiseAmt;
          state.pot += raiseAmt;
        } else if (action.action === 'allin') {
          const allAmt = me.chips;
          state.pot += allAmt;
          me.bet = (me.bet || 0) + allAmt;
          me.chips = 0;
        }
      }
      notify();

      try {
        await p2p.write(myId, KEYS.PLAYER_ACTION, {
          action: action.action, amount: action.amount || 0,
          session: state.session, player: myId, timestamp: Date.now()
        });
        log('Action written to chain');
      } catch (e) {
        log('Action write failed: ' + e.message);
        state.message = 'Error: ' + e.message;
        notify();
      }
    },

    async start() {
      log('Starting backend for ' + myId + ' on table ' + tableId);

      // Verify chain connection
      try {
        const info = await p2p.client.getInfo();
        log('Chain connected: block ' + info.blocks);
      } catch (e) {
        log('Chain connection failed: ' + e.message);
        state.message = 'Chain error: ' + e.message;
        notify();
        return;
      }

      // ── Find active session ──
      state.phase = 'waiting';
      state.message = 'Looking for dealer...';
      notify();

      const staleSession = new Set();
      try {
        const st = await p2p.read(tableId, KEYS.SETTLEMENT);
        if (st && st.session) staleSession.add(st.session);
      } catch {}

      let session = null;
      for (let i = 0; i < 180; i++) {
        const tc = await p2p.read(tableId, KEYS.TABLE_CONFIG);
        if (tc && tc.session && !staleSession.has(tc.session)) {
          session = tc.session;
          state.session = session;
          log('Session found: ' + session + ' — Dealer: ' + (tc.dealer || '?'));
          break;
        }
        if (i % 10 === 0) log('Waiting for dealer... (' + i + 's)');
        await WAIT(1000);
      }
      if (!session) {
        state.message = 'No table session found';
        notify();
        return;
      }

      // ── Write join ──
      state.message = 'Joining table...';
      notify();
      try {
        await p2p.write(myId, KEYS.JOIN_REQUEST, {
          table: tableId, player: myId, session, ready: true, timestamp: Date.now()
        });
        log('Join written');
      } catch (e) {
        log('Join write failed: ' + e.message);
      }

      state.message = 'Waiting for dealer to deal...';
      lastHandTime = Date.now();
      notify();

      // ── Poll loop ──
      while (true) {
        try {
          // 1. Check for new hand
          const tc = await p2p.read(tableId, KEYS.TABLE_CONFIG);
          if (tc && tc.currentHandId && tc.currentHandId !== state.handId && tc.currentHandId !== lastSettledHandId) {
            // Before switching hands, read settlement for current hand if we missed it
            if (state.handId && state.verified === null) {
              const missedStKey = KEYS.SETTLEMENT + '.' + state.handId;
              const missedSt = await p2p.read(tableId, missedStKey);
              if (missedSt && missedSt.verified !== undefined) {
                log('Caught missed settlement for ' + state.handId);
                if (missedSt.results) {
                  for (const r of missedSt.results) {
                    const gp = state.players.find(x => x.id === r.id);
                    if (gp) gp.chips = r.chips;
                  }
                }
                if (missedSt.winners && missedSt.winners.length > 0) {
                  const ws = missedSt.winners[0];
                  const wp = state.players[ws];
                  const hn = missedSt.handNames || {};
                  const wc = missedSt.allHoleCards && missedSt.allHoleCards[ws] ? missedSt.allHoleCards[ws].filter(Boolean) : [];
                  addActionLog((wp ? wp.id : 'Seat ' + ws) + ' wins ' + (missedSt.winAmount || 0) + (wc.length ? ' [' + wc.join(' ') + ']' : '') + (hn[ws] ? ' — ' + hn[ws] : ''));
                }
                addActionLog('Hand #' + state.handCount + ' verified');
                lastSettledHandId = state.handId;
              }
            }

            // If we had a hand but never got cards, we might be sat out
            if (state.handId && state.myCards.length === 0) {
              handsWithoutCards++;
              if (handsWithoutCards >= 2) {
                log('Skipped ' + handsWithoutCards + ' hands — writing rejoin');
                handsWithoutCards = 0;
                try {
                  await p2p.write(myId, KEYS.JOIN_REQUEST, {
                    table: tableId, player: myId, session: state.session, ready: true, timestamp: Date.now()
                  });
                  log('Rejoin written');
                } catch (e) { log('Rejoin failed: ' + e.message); }
              }
            } else {
              handsWithoutCards = 0;
            }

            log('New hand: ' + tc.currentHandId);
            lastHandTime = Date.now();
            state.handId = tc.currentHandId;
            state.handCount = tc.handCount || (state.handCount + 1);
            state.phase = 'shuffling';
            state.myCards = []; state.board = []; state.pot = 0;
            state.turn = null; state.validActions = []; state.toCall = 0; state.minRaise = 2;
            state.winner = null; state.verified = null;
            state.showdownCards = {}; state.handNames = {};
            state.message = 'Hand #' + state.handCount + ' — shuffling...';
            state.players.forEach(p => { p.bet = 0; p.folded = false; });
            lastBSSeq = -1; lastActedSeq = -1; acted = false; actionPending = false;
            notify();
          }

          if (!state.handId) {
            // If no hand for 15s, re-write join in case we were sat out or busted
            const rejoinInterval = state.busted ? 10000 : 15000;
            if (lastHandTime > 0 && Date.now() - lastHandTime > rejoinInterval) {
              log('No hand for ' + (rejoinInterval/1000) + 's — re-writing join');
              lastHandTime = Date.now(); // Reset so we don't spam
              try {
                await p2p.write(myId, KEYS.JOIN_REQUEST, {
                  table: tableId, player: myId, session: state.session, ready: true, timestamp: Date.now()
                });
                log('Rejoin written');
              } catch (e) { log('Rejoin failed: ' + e.message); }
            }
            await WAIT(2000); continue;
          }

          // 2. Check for my cards
          if (state.myCards.length === 0) {
            const cardKey = KEYS.CARD_BV + '.' + state.handId + '.' + myId;
            const cr = await p2p.read(tableId, cardKey);
            if (cr && cr.cards) {
              log('Cards: ' + cr.cards.join(' '));
              state.myCards = cr.cards;
              state.phase = 'preflop';
              state.message = '';
              addActionLog('*** HAND #' + state.handCount + ' ***');
              notify();
            }
          }

          // 3. Check betting state
          const nextSeq = (lastBSSeq || 0) + 1;
          const bsKey = KEYS.BETTING_STATE + '.' + state.handId + '.s' + nextSeq;
          const bs = await p2p.read(tableId, bsKey);
          if (bs) {
            lastBSSeq = bs.seq !== undefined ? bs.seq : nextSeq;
            state.pot = bs.pot || state.pot;
            if (bs.phase) state.phase = bs.phase;
            if (bs.dealerSeat !== undefined) state.dealerSeat = bs.dealerSeat;

            // Update players
            if (bs.players) {
              for (const bp of bs.players) {
                let gp = state.players.find(x => x.id === bp.id);
                if (!gp) {
                  gp = { id: bp.id, seat: bp.seat !== undefined ? bp.seat : state.players.length, chips: bp.chips, bet: 0, folded: false };
                  state.players.push(gp);
                  log('Player discovered: ' + bp.id);
                }
                gp.chips = bp.chips; gp.bet = bp.bet || 0; gp.folded = !!bp.folded;
                if (bp.seat !== undefined) gp.seat = bp.seat;
              }
            }

            // Action log from opponent
            if (bs.lastAction && bs.lastAction.player !== myId) {
              const msg = bs.lastAction.player + ' ' + bs.lastAction.action + (bs.lastAction.amount ? ' ' + bs.lastAction.amount : '');
              addActionLog(msg);
              log(msg);
            }

            // Reset acted when new BS sequence arrives (different from what we acted on)
            if (lastBSSeq > lastActedSeq) acted = false;

            // My turn?
            if (bs.turn === myId && bs.validActions && !acted) {
              state.turn = myId;
              state.validActions = bs.validActions;
              state.toCall = bs.toCall || 0;
              state.minRaise = bs.minRaise || 2;

              if (!actionPending) {
                log('My turn! pot=' + state.pot + ' toCall=' + state.toCall);
                actionPending = true;

                // Auto-fold if inactive
                if (missedTurns >= 2) {
                  log('Auto-fold (inactive)');
                  await this.submitAction({ action: 'fold', amount: 0 });
                } else if (_onNeedAction) {
                  _onNeedAction(state, (action) => this.submitAction(action));
                }
              }
              notify();
            } else if (bs.turn !== myId) {
              // Only clear action state if we already acted or it's genuinely someone else's turn
              if (actionPending && !acted) {
                log('Turn moved away before we acted (dealer timeout?)');
                missedTurns++;
              }
              acted = false;
              actionPending = false;
              state.turn = bs.turn || null;
              state.validActions = [];
              if (state.turn) {
                state.message = 'Waiting for ' + state.turn + '...';
              }
              notify();
            }
          }

          // 4. Check board
          const bc = await p2p.readBoardCards(state.handId);
          if (bc && bc.board && bc.board.length > state.board.length) {
            const phase = bc.phase || '';
            log('Board (' + phase + '): ' + bc.board.join(' '));
            addActionLog(phase + ': ' + bc.board.join(' '));
            state.board = bc.board;
            if (bc.phase) state.phase = bc.phase;
            notify();
          }

          // 5. Check settlement
          const stKey = KEYS.SETTLEMENT + '.' + state.handId;
          const st = await p2p.read(tableId, stKey);
          if (st && st.verified !== undefined && state.verified === null) {
            log('Settlement: verified=' + st.verified);
            state.verified = st.verified;
            state.phase = 'showdown';
            state.board = st.board || state.board;
            state.showdownCards = st.allHoleCards || {};
            state.handNames = st.handNames || {};

            // Update chips
            if (st.results) {
              for (const r of st.results) {
                const gp = state.players.find(x => x.id === r.id);
                if (gp) gp.chips = r.chips;
              }
            }

            // Showdown — show all non-folded hands
            const allCards = st.allHoleCards || {};
            const handNames = st.handNames || {};
            const nonFolded = Object.entries(allCards).filter(([, cards]) => cards && cards[0]);
            if (nonFolded.length > 1) {
              addActionLog('*** SHOWDOWN ***');
              for (const [seatStr, cards] of nonFolded) {
                const s = Number(seatStr);
                const p = state.players[s];
                const hn = handNames[s] || '';
                addActionLog((p ? p.id : 'Seat ' + s) + ' shows [' + cards.join(' ') + ']' + (hn ? ' (' + hn + ')' : ''));
              }
            }

            // Winner
            if (st.winners && st.winners.length > 0) {
              const winSeat = st.winners[0];
              const winPlayer = state.players[winSeat];
              state.winner = {
                seats: st.winners,
                name: winPlayer ? winPlayer.id : 'Seat ' + winSeat,
                amount: st.winAmount || 0,
                handName: handNames[winSeat] || '',
                showdownCards: allCards
              };
              const winCards = allCards[winSeat] ? allCards[winSeat].filter(Boolean) : [];
              const winCardsStr = winCards.length > 0 ? ' [' + winCards.join(' ') + ']' : '';
              addActionLog((winPlayer ? winPlayer.id : 'Seat ' + winSeat) + ' wins ' + (st.winAmount || 0) + winCardsStr + (handNames[winSeat] ? ' — ' + handNames[winSeat] : ''));
            }

            state.message = '';
            addActionLog('Hand #' + state.handCount + ' verified');
            lastSettledHandId = state.handId;
            state.handId = null;

            // Check if we busted
            const me = state.players.find(p => p.id === myId);
            if (me && me.chips <= 0) {
              state.busted = true;
              addActionLog(myId + ' busted');
              log('BUSTED — 0 chips');
            }

            // Push settlement state (GUI will show winner banner on its own timer)
            notify();

            // Reset immediately — don't block the poll loop
            state.phase = 'waiting';
            state.myCards = []; state.board = [];
            state.showdownCards = {}; state.handNames = {};
            state.turn = null; state.validActions = [];
            state.players.forEach(p => { p.bet = 0; p.folded = false; });
            if (!state.busted) state.message = '';
            lastBSSeq = -1; lastActedSeq = -1; acted = false; actionPending = false;
            // Don't notify again yet — let the winner stay visible until next hand
          }
        } catch (e) {
          log('Poll error: ' + e.message);
          state.message = 'Error: ' + e.message;
          notify();
        }
        await WAIT(500);
      }
    }
  };
}
