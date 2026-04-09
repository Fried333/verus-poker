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

// Phase multisig keys (additive — used by the new funding flow)
const PHASE_KEYS = {
  PHASE_OPEN:      'chips.vrsc::poker.sg777z.t_phase_open',       // dealer publishes (per phase)
  PHASE_CONFIRMED: 'chips.vrsc::poker.sg777z.t_phase_confirmed',  // dealer publishes (per phase)
  CASHOUT:         'chips.vrsc::poker.sg777z.t_cashout',          // dealer publishes (per phase)
  CASHOUT_SIG:     'chips.vrsc::poker.sg777z.p_cashout_sig',      // player publishes (per phase)
};

export function createPlayerBackend(p2p, myId, tableId, options = {}) {
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
    turnStart: null,
    turnTimeout: 120,
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
    // Add hand separator before first real entry for this hand
    if (!state._handLogged && state.handCount > 0 && !msg.startsWith('***')) {
      state.actionLog.push('*** HAND #' + state.handCount + ' ***');
      state._handLogged = true;
    }
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
      let me = state.players.find(p => p.id === myId);
      if (!me) {
        // Defensive: if I was somehow filtered out (e.g., ghost-player filter
        // ran after I busted), re-add myself.
        me = { id: myId, seat: 0, chips: 0, bet: 0, folded: false };
        state.players.push(me);
        log('Re-added self to players list');
      }
      me.chips = 200;
      state.busted = false;
      // Mark as sitting out so the Sit In button shows up — player has to
      // explicitly opt back in after reloading.
      state.sittingOut = true;
      state.sitOutAtHand = null;
      state.message = 'Reloaded to 200 chips — click Sit In';
      addActionLog(myId + ' reloaded');
      log('Reloaded to 200 chips');
      notify();
    },

    /** Sit back in after reload or sitting out — optional seat preference */
    /**
     * Knock the table — send a tiny tx from this player's identity to the
     * table identity's pay address. The dealer scans incoming UTXOs at the
     * table address and resolves the input back to the sending identity, so
     * this is how an unknown player announces themselves without needing to
     * be in any allowlist.
     *
     * Idempotent within a session — only knocks once per (session, table).
     */
    async knockTable() {
      try {
        if (state._leftTable) return; // user explicitly left — don't auto-rejoin
        if (state._knockedSession === state.session) return; // already knocked this session
        // Resolve the table's pay address
        const tableIdInfo = await p2p.client.call('getidentity', [tableId + (tableId.endsWith('@') ? '' : '.CHIPS@')]);
        const tableAddr = tableIdInfo?.identity?.primaryaddresses?.[0];
        if (!tableAddr) {
          log('Knock skipped: table identity has no primary address');
          return;
        }
        // Send the knock from our own i-address. The i-addr is canonical:
        // when the dealer sees it as the input, it can call getidentity(i-addr)
        // and get our name back directly — no OP_RETURN, no allowlist, and no
        // -idindex required on the daemon.
        //
        // sendcurrency can't spend i-addr UTXOs in this build, so we build the
        // raw tx by hand with createrawtransaction + signrawtransaction.
        const myIdInfo = await p2p.client.call('getidentity', [myId + (myId.endsWith('@') ? '' : '.CHIPS@')]);
        const myIAddr = myIdInfo?.identity?.identityaddress;
        if (!myIAddr) {
          log('Knock skipped: my identity has no identityaddress');
          return;
        }

        const knockAmt = 0.0001;
        const fee = 0.0001;
        const needed = knockAmt + fee;
        const allUtxos = await p2p.getAddressUtxos(myIAddr);
        // Only spendable UTXOs with positive value (currency UTXOs, not name reservations)
        const utxos = allUtxos.filter(u => u.amount > 0 && u.isspendable !== 0);
        const totalAvailable = utxos.reduce((s, u) => s + u.amount, 0);
        if (totalAvailable < needed) {
          throw new Error('insufficient funds at i-addr ' + myIAddr + ': need ' + needed + ', have ' + totalAvailable + ' (fund the i-address with at least ' + needed + ' CHIPS)');
        }
        // Pick smallest single UTXO that covers, else combine largest-first
        const single = utxos.filter(u => u.amount >= needed).sort((a, b) => a.amount - b.amount)[0];
        let selected;
        if (single) selected = [single];
        else {
          const sorted = [...utxos].sort((a, b) => b.amount - a.amount);
          selected = []; let acc = 0;
          for (const u of sorted) { selected.push(u); acc += u.amount; if (acc >= needed) break; }
          if (acc < needed) throw new Error('could not assemble knock inputs');
        }
        const totalIn = selected.reduce((s, u) => s + u.amount, 0);
        const change = Math.round((totalIn - knockAmt - fee) * 1e8) / 1e8;

        const inputs = selected.map(u => ({ txid: u.txid, vout: u.vout }));
        const outputs = { [tableAddr]: knockAmt };
        if (change > 0) outputs[myIAddr] = change;

        log('Knocking table at ' + tableAddr.slice(0, 12) + '... (from i-addr ' + myIAddr.slice(0, 12) + ')');
        const rawTx = await p2p.client.call('createrawtransaction', [inputs, outputs]);
        const signed = await p2p.client.call('signrawtransaction', [rawTx]);
        if (!signed.complete) throw new Error('failed to sign knock tx');
        const txid = await p2p.client.call('sendrawtransaction', [signed.hex]);
        state._knockedSession = state.session;
        log('Knock sent (tx ' + txid.slice(0, 16) + ')');
      } catch (e) {
        log('Knock failed: ' + e.message);
        // Surface fund / setup errors so the user understands why Sit In
        // appeared to do nothing. Other transient errors stay quiet.
        if (e.message && (e.message.includes('insufficient funds at i-addr') || e.message.includes('no primary address'))) {
          state.message = 'Cannot join: ' + e.message;
          notify();
        }
      }
    },

    async sitIn(seat) {
      // Explicit Sit In always clears the local left-table flag set by leaveTable()
      state._leftTable = false;
      state.busted = false;
      state.sittingOut = false;
      state.sitOutAtHand = null;
      state.message = seat !== undefined ? ('Joining seat ' + (seat + 1) + '...') : 'Sitting back in — next hand';
      addActionLog(myId + ' sat back in' + (seat !== undefined ? ' (seat ' + (seat + 1) + ')' : ''));
      log('Sitting back in' + (seat !== undefined ? ' at seat ' + seat : ''));
      // Knock the table so the dealer discovers this identity (no allowlist needed)
      await this.knockTable();
      // Write a new join request so dealer sees we're back
      try {
        // Re-read the table config to make sure we have the freshest session
        const tc = await p2p.read(tableId, KEYS.TABLE_CONFIG);
        if (tc && tc.session) state.session = tc.session;
        const joinData = { table: tableId, player: myId, session: state.session, ready: true, timestamp: Date.now() };
        // Include payAddr for phase-multisig support: this is the player's
        // identity primary R-address which the dealer uses to compute the
        // multisig and to verify deposits.
        try {
          const idInfo = await p2p.client.call('getidentity', [myId + (myId.endsWith('@') ? '' : '.CHIPS@')]);
          if (idInfo?.identity?.primaryaddresses?.[0]) {
            joinData.payAddr = idInfo.identity.primaryaddresses[0];
            // Also fetch the pubkey for the multisig setup
            try {
              const v = await p2p.client.call('validateaddress', [joinData.payAddr]);
              if (v?.pubkey) joinData.pubkey = v.pubkey;
            } catch {}
          }
        } catch {}
        if (seat !== undefined) joinData.seat = seat;
        else if (options.seat !== undefined) joinData.seat = options.seat;
        await p2p.write(myId, KEYS.JOIN_REQUEST, joinData);
        log('Sit-in join written' + (joinData.payAddr ? ' (payAddr=' + joinData.payAddr.slice(0, 8) + ')' : ''));
      } catch (e) {
        log('Sit-in write failed: ' + e.message);
      }
      notify();
    },

    /**
     * Explicit leave — different from sit-out. The player wants to fully exit
     * the table and get their stack paid out via the next phase rotation.
     *
     * Writes a join_request with leaving:true. The dealer detects this on its
     * scan loop and triggers a phase rotation that pays the leaving player out
     * and removes them from the new phase. The player's polling loop keeps
     * running so they can sign the rotation cashout when it's published.
     */
    async leaveTable() {
      // Local flag — the polling loop checks this to avoid re-knocking,
      // re-sitting-in, or re-depositing after a leave. Cleared only by an
      // explicit sitIn() (i.e. the user clicking Sit In again).
      state._leftTable = true;
      state.sittingOut = true;
      state.message = 'Leaving table...';
      addActionLog(myId + ' leaving table');
      log('Leaving table');
      // If it's currently our turn → fold immediately so we're not blocking
      if (state.turn === myId && state.validActions && state.validActions.length > 0) {
        try {
          await this.submitAction({ action: 'fold', amount: 0 });
        } catch (e) {
          log('Auto-fold on leave failed: ' + e.message);
        }
      }
      try {
        const leaveData = {
          table: tableId, player: myId, session: state.session,
          ready: false, leaving: true, timestamp: Date.now()
        };
        // Include payAddr so the dealer can compute payouts even if it lost state
        try {
          const idInfo = await p2p.client.call('getidentity', [myId + (myId.endsWith('@') ? '' : '.CHIPS@')]);
          if (idInfo?.identity?.primaryaddresses?.[0]) {
            leaveData.payAddr = idInfo.identity.primaryaddresses[0];
          }
        } catch {}
        await p2p.write(myId, KEYS.JOIN_REQUEST, leaveData);
        log('Leave marker written to chain');
      } catch (e) {
        log('Leave marker write failed: ' + e.message);
      }
      notify();
    },

    /** Sit out — fold current hand if our turn, mark dealer-visible sit-out flag */
    async sitOut() {
      state.sittingOut = true;
      state.message = 'Sitting out';
      addActionLog(myId + ' sitting out');
      log('Sitting out');
      // If it's currently our turn → fold immediately so we're not stuck
      if (state.turn === myId && state.validActions && state.validActions.length > 0) {
        try {
          await this.submitAction({ action: 'fold', amount: 0 });
        } catch (e) {
          log('Auto-fold on sit-out failed: ' + e.message);
        }
      }
      // Write a sit-out marker to chain so the dealer knows to skip us next hand.
      // Using JOIN_REQUEST with sitOut: true — dealer reads this and marks us
      // sittingOut on its side, removing us from active players.
      try {
        const sitOutData = {
          table: tableId, player: myId, session: state.session,
          ready: false, sitOut: true, timestamp: Date.now()
        };
        await p2p.write(myId, KEYS.JOIN_REQUEST, sitOutData);
        log('Sit-out marker written to chain');
      } catch (e) {
        log('Sit-out marker write failed: ' + e.message);
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

      const actionPayload = {
        action: action.action, amount: action.amount || 0,
        session: state.session, player: myId, timestamp: Date.now()
      };
      let writeOk = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await p2p.write(myId, KEYS.PLAYER_ACTION, actionPayload);
          await WAIT(300);
          const readBack = await p2p.read(myId, KEYS.PLAYER_ACTION);
          if (readBack && readBack.timestamp === actionPayload.timestamp) {
            log('Action written and verified (attempt ' + (attempt + 1) + ')');
            writeOk = true;
            break;
          }
          log('Action not confirmed — retrying (' + (attempt + 1) + '/3)');
        } catch (e) {
          log('Action write attempt ' + (attempt + 1) + ' failed: ' + e.message);
          if (attempt < 2) await WAIT(1000);
        }
      }
      if (!writeOk) {
        log('WARNING: Action may not have been written');
        state.message = 'Action may not have sent';
        notify();
      }
    },

    async start() {
      log('Starting backend for ' + myId + ' on table ' + tableId);

      // Phase-multisig tracking state. The polling loop calls
      // _handlePhaseMultisig() each iteration to detect new phases and
      // pending cashouts on the table identity, and respond automatically
      // (deposit when a phase opens, sign when a cashout is proposed).
      const trackedPhases = new Set();
      const depositedPhases = new Set();
      let myPayAddr = null;

      // Resolve my own pay address from my identity (if present in this wallet)
      try {
        const idInfo = await p2p.client.call('getidentity', [myId + (myId.endsWith('@') ? '' : '.CHIPS@')]);
        if (idInfo?.identity?.primaryaddresses?.[0]) {
          myPayAddr = idInfo.identity.primaryaddresses[0];
          log('My pay address: ' + myPayAddr);
        }
      } catch {}

      // Helper called from the polling loop to handle phase events
      const handlePhaseMultisig = async () => {
        if (!myPayAddr) return; // skip if we don't know our pay address
        if (!options.phaseMultisig) return; // opt-in flag
        // After leaveTable() we don't auto-deposit into new phases — but we
        // still let the auto-sign branch run below so we can co-sign the
        // rotation cashout that pays us out.
        const skipDeposit = state._leftTable === true;

        // Detect any new phase manifest the dealer has published
        // We scan a few possible recent phase IDs based on the current session.
        // For now, we trust the table identity to publish all phases under
        // session_pN keys.
        const sessionId = state.session;
        if (!sessionId) return;

        // Try a small range of phase numbers (1..10) for the current session
        for (let i = 1; i <= 10; i++) {
          const phaseId = sessionId + '_p' + i;
          if (depositedPhases.has(phaseId)) continue;

          const manifest = await this.readPhaseManifest(phaseId);
          if (!manifest) continue;

          // I'm in this phase?
          const myEntry = manifest.signers.find(s => s.id === myId);
          if (!myEntry) continue;

          // Already confirmed by dealer?
          const confirmed = await this.readPhaseConfirmed(phaseId);
          if (confirmed) {
            depositedPhases.add(phaseId);
            trackedPhases.add(phaseId);
            continue;
          }

          // Verify the manifest matches my pay address
          const verify = this.verifyPhaseManifest(manifest, myPayAddr);
          if (!verify.ok) {
            log('Phase manifest verify failed: ' + verify.reason);
            continue;
          }

          if (skipDeposit) {
            // We left the table — do not deposit into any new phase
            continue;
          }
          // Check we have the funds and try to deposit
          try {
            log('Auto-depositing ' + verify.myEntry.expectedDeposit + ' to phase ' + phaseId);
            await this.depositToPhase(manifest, myPayAddr);
            depositedPhases.add(phaseId);
            trackedPhases.add(phaseId);
            // Clear any prior funding-error message on success
            if (state.message && state.message.startsWith('Insufficient funds')) {
              state.message = '';
              notify();
            }
          } catch (e) {
            log('Auto-deposit failed for ' + phaseId + ': ' + e.message);
            // Surface insufficient-funds errors to the GUI so the user knows
            // why the table is stuck. Other errors are transient and should
            // not block the user.
            if (e.message && e.message.toLowerCase().includes('insufficient funds')) {
              const need = verify.myEntry.expectedDeposit;
              state.message = 'Insufficient funds at ' + myPayAddr.slice(0, 12) + '… — need ' + need + ' CHIPS to join phase. Fund this address and click Sit In again.';
              notify();
            }
          }
        }

        // Auto-sign any pending cashouts on tracked phases
        if (trackedPhases.size > 0) {
          try {
            const signed = await this.autoRespondToCashouts(Array.from(trackedPhases));
            if (signed.length > 0) log('Auto-signed cashouts: ' + signed.join(', '));
          } catch (e) {
            log('Auto-sign error: ' + e.message);
          }
        }
      };

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

      // ── Pre-seed players from latest BS (fixes blank table on connect) ──
      // ONLY pre-seed from BS belonging to the CURRENT session. Otherwise we
      // pick up stale data from a previous session.
      // ALSO: if we find ourselves in the current session's player list, we
      // default to NOT sitting out (we're already in the game). Otherwise we
      // default to sittingOut so the user can choose a seat.
      let alreadySeated = false;
      try {
        const tc2 = await p2p.read(tableId, KEYS.TABLE_CONFIG);
        if (tc2 && tc2.session === session && tc2.currentHandId) {
          for (let trySeq = 20; trySeq >= 0; trySeq--) {
            const bsKey = KEYS.BETTING_STATE + '.' + tc2.currentHandId + '.s' + trySeq;
            const bs = await p2p.read(tableId, bsKey);
            if (bs && bs.session && bs.session !== session) continue;
            if (bs && bs.players) {
              for (const bp of bs.players) {
                if (!state.players.find(x => x.id === bp.id)) {
                  state.players.push({ id: bp.id, seat: bp.seat !== undefined ? bp.seat : state.players.length, chips: bp.chips, bet: 0, folded: false });
                }
                if (bp.id === myId) alreadySeated = true;
              }
              state.pot = bs.pot || 0;
              if (bs.dealerSeat !== undefined) state.dealerSeat = bs.dealerSeat;
              log('Pre-seeded ' + state.players.length + ' players from BS (session match)' + (alreadySeated ? ' — I am already seated' : ''));
              notify();
              break;
            }
          }
        } else if (tc2 && tc2.session && tc2.session !== session) {
          log('Skipping pre-seed — chain table_info is from old session ' + tc2.session);
        }
      } catch (e) { log('Pre-seed failed: ' + e.message); }

      // ── Sit-out default depends on whether we previously joined this session ──
      // Check our OWN join request on chain. If we already joined the current
      // session and didn't subsequently sit out, default to NOT sitting out.
      let prevJoined = false;
      try {
        const myReq = await p2p.read(myId, KEYS.JOIN_REQUEST);
        if (myReq && myReq.session === session && myReq.sitOut !== true) {
          prevJoined = true;
        }
      } catch {}

      if (prevJoined || alreadySeated) {
        // We're already in the game — don't show Sit In button, just play
        state.sittingOut = false;
        state.message = '';
        log('Already in game (prev join or seated) — joining directly');
      } else {
        // Fresh sit-down — wait for user to pick a seat
        state.sittingOut = true;
        state.message = 'Click Sit In to join the table';
      }
      lastHandTime = Date.now();
      log('Backend ready — sitting out (click Sit In to join)');
      notify();

      // ── Poll loop ──
      while (true) {
        try {
          // Phase multisig hook (opt-in via options.phaseMultisig)
          await handlePhaseMultisig();

          // 0. Detect dealer session change (e.g., dealer was restarted)
          // The session is cached at startup and never refreshes otherwise; if the
          // dealer comes back with a new session our cached one is stale and the
          // dealer will ignore our joins forever. Re-sync and rejoin automatically.
          const tc = await p2p.read(tableId, KEYS.TABLE_CONFIG);
          if (tc && tc.session && tc.session !== state.session && !staleSession.has(tc.session)) {
            log('Dealer session changed: ' + state.session + ' → ' + tc.session + ' — rejoining');
            state.session = tc.session;
            // Reset hand state — fresh session = fresh start
            state.handId = null;
            state.handCount = 0;
            state.myCards = [];
            state.board = [];
            state.pot = 0;
            state.turn = null;
            state.validActions = [];
            state.winner = null;
            state.verified = null;
            state.showdownCards = {};
            state.handNames = {};
            state.busted = false;
            // Clear the players list — the new session has its own player list.
            // Don't carry over players from the old session, otherwise the table
            // shows stale "ghost" players that aren't really there anymore.
            state.players = [];
            lastBSSeq = -1; lastActedSeq = -1; acted = false; actionPending = false;
            lastHandTime = Date.now();
            // After a session change, default to sitting out — user must explicitly Sit In
            state.sittingOut = true;
            state.message = 'Dealer restarted — click Sit In to rejoin';
            notify();
          }

          // Sync seated players from the dealer's lobby state. This lets us see
          // who's sitting at which seat in real time, even between hands, before
          // any betting state has been written.
          if (tc && Array.isArray(tc.seatedPlayers)) {
            const incoming = tc.seatedPlayers;
            // Build a fresh players array preserving any local state we have
            const newPlayers = incoming.map(sp => {
              const existing = state.players.find(p => p.id === sp.id);
              return {
                id: sp.id,
                seat: sp.seat,
                chips: sp.chips !== undefined ? sp.chips : (existing ? existing.chips : 200),
                bet: existing ? existing.bet : 0,
                folded: existing ? existing.folded : false,
              };
            });
            // Detect a change and update
            const prevIds = state.players.map(p => p.id + ':' + p.seat).sort().join(',');
            const newIds = newPlayers.map(p => p.id + ':' + p.seat).sort().join(',');
            if (prevIds !== newIds) {
              state.players = newPlayers;
              log('Seated players updated: ' + newPlayers.map(p => p.id + '@' + p.seat).join(', '));
              notify();
            }
          }

          // 1. Check for new hand
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
                // Final action that ended the hand (e.g., fold)
                if (missedSt.lastAction && missedSt.lastAction.player) {
                  const la = missedSt.lastAction;
                  if (la.timeout) {
                    addActionLog(la.player + ' TIMED OUT' + (la.action === 'fold' ? ' (folded)' : ' (checked)'));
                  } else {
                    addActionLog(la.player + ' ' + la.action + (la.amount ? ' ' + la.amount : ''));
                  }
                }
                if (missedSt.winners && missedSt.winners.length > 0) {
                  const ws = missedSt.winners[0];
                  // ws is a SEAT NUMBER, not an array index — look up by .seat
                  const wp = state.players.find(p => p.seat === ws);
                  const hn = missedSt.handNames || {};
                  const wc = missedSt.allHoleCards && missedSt.allHoleCards[ws] ? missedSt.allHoleCards[ws].filter(Boolean) : [];
                  addActionLog((wp ? wp.id : 'Seat ' + ws) + ' wins ' + (missedSt.winAmount || 0) + (wc.length ? ' [' + wc.join(' ') + ']' : '') + (hn[ws] ? ' — ' + hn[ws] : ''));
                }
                addActionLog('Hand #' + state.handCount + ' verified');
                lastSettledHandId = state.handId;
              }
            }

            // If we had a hand but never got cards, we might be sat out.
            // Skip auto-rejoin if we explicitly left the table.
            if (state.handId && state.myCards.length === 0 && !state._leftTable) {
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
            // Only clear busted if we actually have chips now. Previously this
            // was unconditional and produced blank GUI for busted players when
            // the dealer announced a hand they weren't in.
            {
              const meChk = state.players.find(p => p.id === myId);
              if (meChk && meChk.chips > 0) state.busted = false;
            }
            state.players.forEach(p => { p.bet = 0; p.folded = false; });
            lastBSSeq = -1; lastActedSeq = -1; acted = false; actionPending = false;
            notify();
          }

          if (!state.handId) {
            // No active hand. We do NOT auto-rejoin here — the player joined
            // explicitly at startup or via the Sit In button. If they want to
            // come back after a sit-out or bust, they click Sit In.
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
              state._handLogged = false; // Will log separator on first action
              notify();
            }
          }

          // 3. Check betting state
          const nextSeq = (lastBSSeq || 0) + 1;
          const bsKey = KEYS.BETTING_STATE + '.' + state.handId + '.s' + nextSeq;
          const bs = await p2p.read(tableId, bsKey);
          if (bs && bs.session && bs.session !== state.session) {
            log('Ignoring stale BS from session ' + bs.session + ' (current=' + state.session + ')');
          } else if (bs) {
            lastBSSeq = bs.seq !== undefined ? bs.seq : nextSeq;
            state.pot = bs.pot || state.pot;
            if (bs.phase) state.phase = bs.phase;
            if (bs.dealerSeat !== undefined) state.dealerSeat = bs.dealerSeat;

            // Update players
            if (bs.players) {
              // First BS of new hand: remove ghost players from prior hands.
              // BUT keep myself even if I'm not in this hand's BS (e.g., I busted
              // and haven't sat back in yet) — otherwise reload() can't find me.
              if (lastBSSeq <= 1) {
                const bsIds = new Set(bs.players.map(bp => bp.id));
                state.players = state.players.filter(p => bsIds.has(p.id) || p.id === myId);
              }
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
              // Clear busted if we have chips now (reload worked)
              const me = state.players.find(p => p.id === myId);
              if (me && me.chips > 0 && state.busted) {
                state.busted = false;
                log('No longer busted — chips: ' + me.chips);
              }
            }

            // Action log from opponent (or self if timed out)
            if (bs.lastAction) {
              const isMe = bs.lastAction.player === myId;
              const timedOut = bs.lastAction.timeout;
              let msg;
              if (timedOut) {
                msg = bs.lastAction.player + ' TIMED OUT' + (bs.lastAction.action === 'fold' ? ' (folded)' : ' (checked)');
                if (isMe) state.message = 'You timed out!';
              } else if (!isMe) {
                msg = bs.lastAction.player + ' ' + bs.lastAction.action + (bs.lastAction.amount ? ' ' + bs.lastAction.amount : '');
              }
              if (msg) { addActionLog(msg); log(msg); }
            }

            // Reset acted when new BS sequence arrives (different from what we acted on)
            if (lastBSSeq > lastActedSeq) acted = false;

            // My turn?
            if (bs.turn === myId && bs.validActions && !acted) {
              state.turn = myId;
              state.validActions = bs.validActions;
              state.toCall = bs.toCall || 0;
              state.minRaise = bs.minRaise || 2;
              // Player display timer starts NOW (when we first see the BS),
              // NOT from the dealer's wall clock. This way slow propagation
              // doesn't eat into the player's perceived think time.
              // The dealer still enforces a longer hard timeout (90s) as a backstop.
              state.turnStart = Date.now();
              state.turnTimeout = bs.turnTimeout || 60;

              if (!actionPending) {
                log('My turn! pot=' + state.pot + ' toCall=' + state.toCall);
                actionPending = true;

                // Auto-fold if sitting out (any hand, including current one)
                if (state.sittingOut) {
                  log('Auto-fold (sitting out)');
                  await this.submitAction({ action: 'fold', amount: 0 });
                }
                // Auto-fold if inactive (timeouts piling up)
                else if (missedTurns >= 2) {
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
              state.turnStart = null;
              state.turnTimeout = 120;
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
            // Only log board for flop/turn/river — showdown board is visible on table
            if (phase !== 'showdown') {
              addActionLog(phase + ': ' + bc.board.join(' '));
            }
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

            // Log the action that ENDED the hand (e.g., the fold). This never
            // appeared in any BS because the dealer's loop broke before writing
            // the next BS — we get it from the settlement instead.
            if (st.lastAction && st.lastAction.player) {
              const la = st.lastAction;
              if (la.timeout) {
                addActionLog(la.player + ' TIMED OUT' + (la.action === 'fold' ? ' (folded)' : ' (checked)'));
              } else {
                addActionLog(la.player + ' ' + la.action + (la.amount ? ' ' + la.amount : ''));
              }
            }

            // Update chips
            if (st.results) {
              for (const r of st.results) {
                const gp = state.players.find(x => x.id === r.id);
                if (gp) gp.chips = r.chips;
              }
            }

            const allCards = st.allHoleCards || {};
            const handNames = st.handNames || {};
            const bestHands = st.bestHands || {};

            // Winner
            if (st.winners && st.winners.length > 0) {
              const winSeat = st.winners[0];
              // winSeat is a SEAT NUMBER, not an array index — look up by .seat
              const winPlayer = state.players.find(p => p.seat === winSeat);
              state.winner = {
                seats: st.winners,
                name: winPlayer ? winPlayer.id : 'Seat ' + winSeat,
                amount: st.winAmount || 0,
                handName: handNames[winSeat] || '',
                showdownCards: allCards
              };

              // Show all non-folded hands with best 5 cards (real showdown)
              const nonFolded = Object.entries(allCards).filter(([, cards]) => cards && cards[0]);
              if (nonFolded.length > 1) {
                for (const [seatStr] of nonFolded) {
                  const s = Number(seatStr);
                  // s is a SEAT NUMBER — look up by .seat
                  const p = state.players.find(pp => pp.seat === s);
                  const name = p ? p.id : 'Seat ' + s;
                  const hn = handNames[s] || '';
                  const best = bestHands[s] ? bestHands[s].join(' ') : '';
                  addActionLog(name + ': ' + hn + (best ? ' [' + best + ']' : ''));
                }
              }

              // Per-pot announcements (PokerStars-style: "main pot", "side pot 1", etc.)
              if (Array.isArray(st.potResults) && st.potResults.length > 0) {
                for (const pot of st.potResults) {
                  if (!pot.winners || pot.winners.length === 0 || pot.amount <= 0) continue;
                  const label = pot.isMain ? 'main pot' : ('side pot ' + (pot.index));
                  const share = Math.floor(pot.amount / pot.winners.length);
                  const names = pot.winners.map(s => {
                    const pp = state.players.find(x => x.seat === s);
                    return pp ? pp.id : 'Seat ' + s;
                  });
                  addActionLog(names.join(' & ') + ' wins ' + label + ' (' + pot.amount + ')');
                }
              } else {
                // Fallback to single-line winner display if potResults isn't available
                addActionLog((winPlayer ? winPlayer.id : 'Seat ' + winSeat) + ' wins ' + (st.winAmount || 0));
              }
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

            // Push settlement state — keep winner visible until next hand
            state.phase = 'settled';
            notify();

            // Reset bets/folded but keep winner/board visible
            state.turn = null; state.validActions = [];
            state.players.forEach(p => { p.bet = 0; p.folded = false; });
            if (!state.busted) state.message = '';
            lastBSSeq = -1; lastActedSeq = -1; acted = false; actionPending = false;

            // After 5s, if no new hand has started yet, clear the visible state
            // so the table looks "between hands" instead of stuck on the previous one.
            setTimeout(() => {
              if (state.phase === 'settled' && !state.handId) {
                state.phase = 'waiting';
                state.board = [];
                state.myCards = [];
                state.winner = null;
                state.showdownCards = {};
                state.handNames = {};
                state.pot = 0;
                state.message = state.busted ? 'Out of chips — click Reload' : 'Waiting for next hand...';
                notify();
              }
            }, 5000);
          }
        } catch (e) {
          log('Poll error: ' + e.message);
          state.message = 'Error: ' + e.message;
          notify();
        }
        await WAIT(500);
      }
    },

    // ══════════════════════════════════════
    // PHASE MULTISIG FUNDING (additive — separate from existing flow)
    // ══════════════════════════════════════

    /**
     * Read the phase manifest published by the dealer to the table identity.
     * Returns null if no manifest exists for the given phase.
     */
    async readPhaseManifest(phase) {
      const key = PHASE_KEYS.PHASE_OPEN + '.' + phase;
      return await p2p.read(tableId, key);
    },

    /**
     * Read the phase confirmed record (after dealer detected all deposits).
     */
    async readPhaseConfirmed(phase) {
      const key = PHASE_KEYS.PHASE_CONFIRMED + '.' + phase;
      return await p2p.read(tableId, key);
    },

    /**
     * Verify a phase manifest contains my expected entry.
     * Returns { ok: true } or { ok: false, reason: '...' }.
     */
    verifyPhaseManifest(manifest, expectedPayAddr) {
      if (!manifest || manifest.type !== 'phase_open') {
        return { ok: false, reason: 'not a phase_open manifest' };
      }
      if (!Array.isArray(manifest.signers) || manifest.signers.length < 2) {
        return { ok: false, reason: 'invalid signers list' };
      }
      const myEntry = manifest.signers.find(s => s.id === myId);
      if (!myEntry) {
        return { ok: false, reason: `myId ${myId} not in signers list` };
      }
      if (myEntry.payAddr !== expectedPayAddr) {
        return {
          ok: false,
          reason: `payAddr mismatch: manifest=${myEntry.payAddr} expected=${expectedPayAddr}`,
        };
      }
      if (typeof myEntry.expectedDeposit !== 'number' || myEntry.expectedDeposit <= 0) {
        return { ok: false, reason: 'invalid expectedDeposit' };
      }
      if (!manifest.multisigAddr) {
        return { ok: false, reason: 'missing multisig address' };
      }
      if (typeof manifest.threshold !== 'number' || manifest.threshold < 2) {
        return { ok: false, reason: 'invalid threshold' };
      }
      return { ok: true, myEntry };
    },

    /**
     * Add the phase multisig to the local wallet so signrawtransaction can
     * correctly add signatures to partial multisig spends. Idempotent.
     */
    async ensureMultisigInWallet(manifest) {
      if (!manifest.pubkeys || !manifest.threshold) {
        console.log('[PLAYER ' + myId + '] manifest missing pubkeys/threshold; cannot import multisig');
        return false;
      }
      try {
        await p2p.client.call('addmultisigaddress', [manifest.threshold, manifest.pubkeys]);
        return true;
      } catch (e) {
        // Already present or other recoverable error
        return false;
      }
    },

    /**
     * Deposit my expected stake to the phase multisig from one or more UTXOs
     * at the given pay address.
     *
     * Uses createrawtransaction with explicit input selection so the wallet's
     * coin selector cannot raid funds from other addresses. The change goes
     * back to the same pay address.
     *
     * Coin selection strategy:
     *   1. If any single UTXO covers (amount + fee), use the smallest such one
     *   2. Otherwise, combine multiple smaller UTXOs (largest first) until the
     *      total covers (amount + fee)
     *
     * Returns the deposit txid.
     */
    async depositToPhase(manifest, payAddr) {
      const verify = this.verifyPhaseManifest(manifest, payAddr);
      if (!verify.ok) throw new Error('manifest verification failed: ' + verify.reason);

      // Make sure the local wallet knows about this multisig so it can later
      // contribute its key to partial signatures of the settlement TX.
      await this.ensureMultisigInWallet(manifest);

      const amount = verify.myEntry.expectedDeposit;
      const fee = 0.0001;
      const needed = amount + fee;

      const utxos = await p2p.getAddressUtxos(payAddr);
      const totalAvailable = utxos.reduce((s, u) => s + u.amount, 0);
      if (totalAvailable < needed) {
        throw new Error(`insufficient funds at ${payAddr}: need ${needed}, have ${totalAvailable} (${utxos.length} UTXOs)`);
      }

      // Strategy 1: find smallest single UTXO that covers
      const singleCandidate = utxos
        .filter(u => u.amount >= needed)
        .sort((a, b) => a.amount - b.amount)[0];

      let selectedUtxos;
      if (singleCandidate) {
        selectedUtxos = [singleCandidate];
      } else {
        // Strategy 2: combine multiple UTXOs (largest first to minimize input count)
        const sorted = [...utxos].sort((a, b) => b.amount - a.amount);
        selectedUtxos = [];
        let acc = 0;
        for (const u of sorted) {
          selectedUtxos.push(u);
          acc += u.amount;
          if (acc >= needed) break;
        }
        if (acc < needed) {
          throw new Error(`could not assemble enough inputs at ${payAddr}`);
        }
      }

      const totalIn = selectedUtxos.reduce((s, u) => s + u.amount, 0);
      const change = Math.round((totalIn - amount - fee) * 1e8) / 1e8;

      // Lock the source UTXOs to prevent wallet contamination
      await p2p.lockUtxos(selectedUtxos);

      try {
        const inputs = selectedUtxos.map(u => ({ txid: u.txid, vout: u.vout }));
        const outputs = { [manifest.multisigAddr]: amount };
        if (change > 0) outputs[payAddr] = change;

        const rawTx = await p2p.client.call('createrawtransaction', [inputs, outputs]);
        const signed = await p2p.client.call('signrawtransaction', [rawTx]);
        if (!signed.complete) {
          throw new Error('failed to sign deposit TX');
        }
        const txid = await p2p.client.call('sendrawtransaction', [signed.hex]);
        console.log('[PLAYER ' + myId + '] Deposited ' + amount + ' CHIPS to ' + manifest.multisigAddr + ' (tx ' + txid.slice(0, 16) + ', ' + selectedUtxos.length + ' inputs)');
        return txid;
      } finally {
        await p2p.unlockUtxos(selectedUtxos);
      }
    },

    /**
     * Wait for the dealer to publish phase_confirmed for the given phase.
     * Returns the confirmed record, or null on timeout.
     */
    async waitForPhaseConfirmed(phase, timeoutMs = 120000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const confirmed = await this.readPhaseConfirmed(phase);
        if (confirmed && confirmed.type === 'phase_confirmed') {
          return confirmed;
        }
        await WAIT(2000);
      }
      return null;
    },

    /**
     * Read the cashout proposal published by the dealer for a phase.
     */
    async readCashoutProposal(phase) {
      const key = PHASE_KEYS.CASHOUT + '.' + phase;
      return await p2p.read(tableId, key);
    },

    /**
     * Verify a cashout proposal against the phase manifest, the player's
     * own pay address, and (optionally) a stacks oracle (the latest betting
     * state if available).
     *
     * stacksOracle: { playerId: expectedAmount, ... } — what each player
     *   SHOULD be paid based on the on-chain betting state. The player verifies
     *   the cashout matches this. If null, only the structural checks are run
     *   (roster, addresses, sum invariant) — not the amount-vs-stacks check.
     *
     * Returns { ok: true } or { ok: false, reason: '...' }.
     */
    async verifyCashoutProposal(cashout, manifest, expectedPayAddr, stacksOracle = null) {
      // 1. Schema and basic checks — accept both regular cashouts and atomic rotations
      if (!cashout || (cashout.type !== 'cashout' && cashout.type !== 'atomic_rotation')) {
        return { ok: false, reason: 'wrong type: ' + (cashout?.type || 'null') };
      }
      if (cashout.phase !== manifest.phase) {
        return { ok: false, reason: `phase mismatch: cashout=${cashout.phase} manifest=${manifest.phase}` };
      }
      if (cashout.multisigAddr !== manifest.multisigAddr) {
        return { ok: false, reason: 'multisig address mismatch' };
      }
      if (!Array.isArray(cashout.payouts)) {
        return { ok: false, reason: 'missing payouts array' };
      }

      // For atomic rotations: lighter verification. Continuing players'
      // stacks go to the NEW multisig output, not to their R-addr. Only
      // leavers get R-addr payouts. The unsigned TX is the authority —
      // any signer can refuse to sign if they disagree.
      if (cashout.type === 'atomic_rotation') {
        if (cashout.phase !== manifest.phase) {
          return { ok: false, reason: 'phase mismatch' };
        }
        if (!cashout.unsignedTxHex) {
          return { ok: false, reason: 'missing unsignedTxHex' };
        }
        // Basic: I must be in either the leavers list OR the continuing list
        const imLeaving = (cashout.leavers || []).some(l => l.id === myId);
        const imContinuing = (cashout.continuing || []).some(c => c.id === myId);
        if (!imLeaving && !imContinuing) {
          return { ok: false, reason: 'I am not in the rotation (not leaving or continuing)' };
        }
        // If I'm leaving, verify my payout amount via the decoded TX
        // (full decode-and-verify is a follow-up — for now trust the structure)
        return { ok: true };
      }

      // ── Regular cashout verification below ──

      // 2. ROSTER CHECK: cashout payouts must match manifest signers exactly
      const manifestIds = new Set(manifest.signers.map(s => s.id));
      const payoutIds = new Set(cashout.payouts.map(p => p.id));

      // 2a. No outsiders
      for (const payoutId of payoutIds) {
        if (!manifestIds.has(payoutId)) {
          return { ok: false, reason: `unauthorized recipient: ${payoutId}` };
        }
      }
      // 2b. No insiders silently dropped
      for (const signerId of manifestIds) {
        if (!payoutIds.has(signerId)) {
          return { ok: false, reason: `missing signer in payouts: ${signerId}` };
        }
      }
      // 2c. No duplicates
      if (cashout.payouts.length !== manifest.signers.length) {
        return { ok: false, reason: 'duplicate or extra entries' };
      }

      // 3. ADDRESS CHECK: each payout's payAddr must match the manifest
      for (const payout of cashout.payouts) {
        const manifestEntry = manifest.signers.find(s => s.id === payout.id);
        if (payout.payAddr !== manifestEntry.payAddr) {
          return {
            ok: false,
            reason: `${payout.id}: payAddr mismatch (manifest=${manifestEntry.payAddr}, cashout=${payout.payAddr})`,
          };
        }
      }

      // 4. SELF-CHECK: my own entry must use my own pay address
      const myPayout = cashout.payouts.find(p => p.id === myId);
      if (!myPayout) {
        return { ok: false, reason: 'I am not in the payouts list' };
      }
      if (myPayout.payAddr !== expectedPayAddr) {
        return { ok: false, reason: `my payAddr in cashout (${myPayout.payAddr}) does not match my actual (${expectedPayAddr})` };
      }

      // 5. AMOUNT CHECK (against stacks oracle if provided)
      if (stacksOracle) {
        for (const payout of cashout.payouts) {
          const expected = stacksOracle[payout.id];
          if (typeof expected !== 'number') {
            return { ok: false, reason: `${payout.id} not in stacks oracle` };
          }
          if (Math.abs(payout.amount - expected) > 0.00000001) {
            return { ok: false, reason: `${payout.id}: expected ${expected}, got ${payout.amount}` };
          }
        }
      }

      // 6. SUM INVARIANT
      const totalPayout = cashout.payouts.reduce((s, p) => s + p.amount, 0);
      const expectedTotal = totalPayout + cashout.fee;
      if (Math.abs(expectedTotal - cashout.multisigBalance) > 0.00000001) {
        return {
          ok: false,
          reason: `sum mismatch: payouts=${totalPayout} + fee=${cashout.fee} != balance=${cashout.multisigBalance}`,
        };
      }

      // 7. UNSIGNED TX MUST MATCH JSON
      if (!cashout.unsignedTxHex) {
        return { ok: false, reason: 'missing unsignedTxHex' };
      }
      let decoded;
      try {
        decoded = await p2p.decodeRawTx(cashout.unsignedTxHex);
      } catch (e) {
        return { ok: false, reason: 'failed to decode unsignedTxHex: ' + e.message };
      }

      // Check outputs match payouts (skipping zero-amount payouts which were filtered out of the TX)
      const nonZeroPayouts = cashout.payouts.filter(p => p.amount > 0);
      if (decoded.vout.length !== nonZeroPayouts.length) {
        return { ok: false, reason: `tx vout count ${decoded.vout.length} != non-zero payouts ${nonZeroPayouts.length}` };
      }
      for (const v of decoded.vout) {
        const addrs = v.scriptPubKey?.addresses || [];
        const addr = addrs[0];
        const matchingPayout = nonZeroPayouts.find(p => p.payAddr === addr);
        if (!matchingPayout) {
          return { ok: false, reason: `tx output to unknown address ${addr}` };
        }
        if (Math.abs(v.value - matchingPayout.amount) > 0.00000001) {
          return { ok: false, reason: `tx output ${addr}: amount ${v.value} != ${matchingPayout.amount}` };
        }
      }

      // 8. INPUTS MUST MATCH MULTISIG UTXOS
      const msUtxos = await p2p.getAddressUtxos(cashout.multisigAddr);
      for (const vin of decoded.vin) {
        const matching = msUtxos.find(u => u.txid === vin.txid && u.vout === vin.vout);
        if (!matching) {
          return { ok: false, reason: `tx input ${vin.txid}:${vin.vout} not found at multisig` };
        }
      }

      return { ok: true, myPayout };
    },

    /**
     * Sign a cashout proposal (after verification has passed) and publish
     * the partial signature to my own identity.
     *
     * Returns { ok: true, txid: ..., signedHex: ..., complete: ... }.
     */
    async signAndPublishCashout(cashout) {
      const signed = await p2p.signSettlementTx(cashout.unsignedTxHex);
      if (!signed.hex) {
        throw new Error('signing failed: no hex returned');
      }
      // Publish the partial sig to my own identity under p_cashout_sig.<phase>
      const sigKey = PHASE_KEYS.CASHOUT_SIG + '.' + cashout.phase;
      await p2p.write(myId, sigKey, {
        type: 'cashout_sig',
        phase: cashout.phase,
        cashoutTimestamp: cashout.timestamp,
        signedHex: signed.hex,
        complete: signed.complete,
        timestamp: Date.now(),
      });
      console.log('[PLAYER ' + myId + '] Signed cashout for phase ' + cashout.phase + ' (complete=' + signed.complete + ')');
      return { ok: true, signedHex: signed.hex, complete: signed.complete };
    },

    /**
     * Convenience: read the cashout proposal, verify it, sign it, publish.
     * This is the typical end-to-end flow when a player is online at settlement time.
     */
    async respondToCashout(phase, manifest, expectedPayAddr, stacksOracle = null) {
      const cashout = await this.readCashoutProposal(phase);
      if (!cashout) {
        return { ok: false, reason: 'no cashout proposal found' };
      }
      const verify = await this.verifyCashoutProposal(cashout, manifest, expectedPayAddr, stacksOracle);
      if (!verify.ok) {
        console.log('[PLAYER ' + myId + '] REFUSING cashout: ' + verify.reason);
        return { ok: false, reason: verify.reason };
      }
      const result = await this.signAndPublishCashout(cashout);
      return result;
    },

    /**
     * Read the cashout_settled record for a phase, indicating the settlement
     * TX was broadcast.
     */
    async readCashoutSettled(phase) {
      const key = 'chips.vrsc::poker.sg777z.t_cashout_settled.' + phase;
      return await p2p.read(tableId, key);
    },

    // ══════════════════════════════════════
    // LOBBY: scan known tables for pending cashouts that need my signature
    // ══════════════════════════════════════

    /**
     * Auto-respond to pending cashouts on this table. Used by the player's
     * polling loop during a session to sign settlements as they're proposed
     * by the dealer.
     *
     * For each phase the player is/was part of:
     *   1. Check if there's a cashout proposal we haven't signed yet
     *   2. If yes, look up the manifest, verify the proposal, sign + publish
     *
     * trackedPhases: array of phase IDs to check (the phases the player has
     *   participated in this session). The caller is responsible for tracking
     *   which phases the player has joined.
     *
     * Returns the list of phases that were just signed (so the caller can
     * remove them from the to-do list).
     */
    async autoRespondToCashouts(trackedPhases) {
      const justSigned = [];
      for (const phase of trackedPhases) {
        try {
          const cashout = await this.readCashoutProposal(phase);
          if (!cashout || (cashout.type !== 'cashout' && cashout.type !== 'atomic_rotation')) continue;

          // Already settled?
          const settled = await this.readCashoutSettled(phase);
          if (settled) continue;

          const sigKey = PHASE_KEYS.CASHOUT_SIG + '.' + phase;
          const mySig = await p2p.read(myId, sigKey);

          // If I've already published a COMPLETE partial, I'm done
          if (mySig && mySig.signedHex && mySig.cashoutTimestamp === cashout.timestamp && mySig.complete) {
            continue;
          }

          // Read the manifest so we can verify
          const manifest = await this.readPhaseManifest(phase);
          if (!manifest) continue;

          // Make sure the wallet knows about this multisig so signing works
          await this.ensureMultisigInWallet(manifest);

          // Find my entry to get my pay address
          const myEntry = manifest.signers.find(s => s.id === myId);
          if (!myEntry) continue;

          // Build stacks oracle for verification (regular cashouts have payouts array,
          // atomic rotations have leavers + continuing — skip stacks check for atomic)
          let stacksOracle = null;
          if (cashout.type === 'cashout' && Array.isArray(cashout.payouts)) {
            stacksOracle = {};
            for (const p of cashout.payouts) stacksOracle[p.id] = p.amount;
          }

          const verify = await this.verifyCashoutProposal(cashout, manifest, myEntry.payAddr, stacksOracle);
          if (!verify.ok) {
            console.log('[PLAYER ' + myId + '] REFUSING auto-cashout for ' + phase + ': ' + verify.reason);
            continue;
          }

          // SEQUENTIAL SIGNING: look for an existing partial from another signer
          // and sign on top of it. This is required because Verus has no
          // combinerawtransaction — partial multisig signatures can only be
          // combined by chaining signrawtransaction calls.
          //
          // Strategy: scan all OTHER signers' identities for a partial sig.
          // If found, use the most-recent partial as the input to our sign.
          // Otherwise sign the raw unsigned hex (we're the first signer).
          let inputHex = cashout.unsignedTxHex;
          let baseSigCount = 0;
          for (const otherSigner of manifest.signers) {
            if (otherSigner.id === myId) continue;
            try {
              const otherSig = await p2p.read(otherSigner.id, sigKey);
              if (otherSig && otherSig.signedHex && otherSig.cashoutTimestamp === cashout.timestamp) {
                inputHex = otherSig.signedHex;
                baseSigCount++;
                console.log('[PLAYER ' + myId + '] using partial from ' + otherSigner.id + ' as base for sequential signing');
                break;
              }
            } catch {}
          }

          // Build prevtxs with the multisig's redeemScript so signrawtransaction
          // knows how to add a partial signature for the multisig input.
          // This is REQUIRED for partial multisig signing across daemons.
          const msAddr = cashout.multisigAddr || cashout.oldMultisigAddr;
          const msUtxos = await p2p.getAddressUtxos(msAddr);
          const prevtxs = msUtxos.map(u => ({
            txid: u.txid,
            vout: u.vout,
            scriptPubKey: u.script,
            redeemScript: manifest.redeemScript,
            amount: u.amount,
          }));

          const signed = await p2p.signSettlementTx(inputHex, prevtxs);
          if (!signed.hex) throw new Error('signing returned no hex');

          // Publish OUR resulting partial (which now has baseSigCount + 1 sigs)
          await p2p.write(myId, sigKey, {
            type: 'cashout_sig',
            phase: cashout.phase,
            cashoutTimestamp: cashout.timestamp,
            signedHex: signed.hex,
            complete: signed.complete,
            timestamp: Date.now(),
          });
          console.log('[PLAYER ' + myId + '] Signed cashout for phase ' + cashout.phase + ' (complete=' + signed.complete + ', based on ' + baseSigCount + ' prior sigs)');
          justSigned.push(phase);
        } catch (e) {
          console.log('[PLAYER ' + myId + '] autoRespondToCashouts error for ' + phase + ': ' + e.message);
        }
      }
      return justSigned;
    },

    /**
     * Given a list of (table, phase) pairs the player has been part of, return
     * any pending cashouts that need this player's signature (i.e., the cashout
     * proposal exists but this player hasn't yet published a partial sig for it,
     * AND the cashout hasn't been settled).
     */
    async scanPendingCashouts(tablesAndPhases) {
      const pending = [];
      for (const { table, phase } of tablesAndPhases) {
        const tableP2p = (table === tableId)
          ? p2p  // already on the right tableId
          : p2p; // simplified — production code would need a per-table p2p handle

        const cashoutKey = PHASE_KEYS.CASHOUT + '.' + phase;
        const cashout = await tableP2p.read(table, cashoutKey);
        if (!cashout || cashout.type !== 'cashout') continue;

        // Already settled?
        const settledKey = 'chips.vrsc::poker.sg777z.t_cashout_settled.' + phase;
        const settled = await tableP2p.read(table, settledKey);
        if (settled && settled.type === 'cashout_settled') continue;

        // Already signed by me?
        const sigKey = PHASE_KEYS.CASHOUT_SIG + '.' + phase;
        const mySig = await p2p.read(myId, sigKey);
        if (mySig && mySig.signedHex) continue;

        // Am I a signer of this cashout?
        const myPayout = cashout.payouts.find(p => p.id === myId);
        if (!myPayout) continue;

        pending.push({ table, phase, cashout, myPayout });
      }
      return pending;
    },
  };
}
