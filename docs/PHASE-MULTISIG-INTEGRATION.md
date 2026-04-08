# Phase Multisig Integration Design

## Status

This is the **agreed design** for integrating phase-multisig funding into the existing poker code. Every decision in this document has been validated against real CHIPS chain behavior via the standalone test scripts (`test-multisig.mjs`, `test-multisig-3player.mjs`, `test-multisig-join.mjs`, `test-multisig-realistic-join.mjs`, `test-parallelism.mjs`).

## Goals

- **No third-party custody**: player funds are only ever held by players themselves
- **No protocol fees**: no rake, no skim, no platform cut
- **No dealer or shuffler in the multisig**: zero collusion attack vector via "extra signers"
- **Asynchronous signing**: players don't need to be online simultaneously to settle
- **Verifiable cashouts**: every player verifies the WHOLE cashout proposal before signing
- **Recovery without trusted parties**: settlements progress as players come back online; the dealer is purely an orchestrator that can disappear without breaking settlement
- **Public discoverability**: the "lobby" lets returning players find pending cashouts requiring their signature
- **Defensive verification**: the dealer cannot fabricate fraudulent payouts that any honest player will sign

## Key validated facts (from tests)

- ✓ Standard CHIPS multisig (`createmultisig`, `addmultisigaddress`, `signrawtransaction`, `sendrawtransaction`) works for the full deposit/spend flow
- ✓ Multi-input/multi-output settlement TXs work in one transaction
- ✓ `(N-1)-of-N` threshold tolerance: absent signer still receives their payout
- ✓ Cross-daemon partial signing works (validated with un-peered .28 / .59 / local)
- ✓ Settlement latency on real CHIPS: ~10-21 seconds end-to-end
- ✓ Phase rotation works: settle old multisig, create new multisig with different roster, all 3 deposit, settle new
- ✓ `getaddressutxos` is the right RPC for non-wallet address queries (NOT `listunspent`)
- ✓ `lockunspent` works on multisig and identity-controlled UTXOs
- ✓ `sourceoffunds` parameter on `updateidentity` constrains coin selection to a specific address
- ✓ `fromaddress` parameter on `sendcurrency` is required and constrains coin selection
- ✓ Concurrent operations from a single wallet succeed when UTXO pool is healthy
- ✓ Wallet serializes `updateidentity` calls regardless of target identity (single-daemon parallelism gives no benefit)

## Trust model

The protocol relies on **client-side verification**: each player's backend must verify the WHOLE cashout proposal against on-chain data before signing. The dealer can propose anything, but a correctly-implemented player backend will refuse to sign a proposal that doesn't match the canonical on-chain state.

Trust assumptions:
- Players use a correct backend implementation (open source so this is verifiable)
- At least one honest player is online at settlement time (catches dealer fraud at the moment it's attempted)
- Players treat each other reasonably (the protocol can't prevent collusion if literally all present players agree to cheat an absent one — that requires a social trust layer)

The protocol does NOT require:
- Trust in the dealer
- Trust in the shuffler
- Trust in any third-party arbitrator
- Trust in pre-signed fallback signatures
- Trust in any external party

## On-chain data structures

### 1. Join request

Published by each player to their OWN identity (`<player>.CHIPS@`) when they want to join a table. This binds their identity to a specific pay address.

```json
{
  "type": "join_request",
  "table": "mytable.CHIPS@",
  "player": "playera.CHIPS@",
  "payAddr": "RAaaaa...",
  "buyIn": 10.0,
  "timestamp": 1775000000000
}
```

VDXF key: `chips.vrsc::poker.sg777z.t_join_request`

### 2. Phase manifest

Published by the dealer to the **table identity** when a phase opens. Establishes the canonical roster, multisig address, and expected deposits.

```json
{
  "type": "phase_open",
  "phase": "p7",
  "table": "mytable.CHIPS@",
  "multisigAddr": "bABCxyz...",
  "redeemScript": "5221...",
  "threshold": 2,
  "signers": [
    { "id": "playera.CHIPS@", "payAddr": "RAaaaa...", "expectedDeposit": 5.0 },
    { "id": "playerb.CHIPS@", "payAddr": "RBbbbb...", "expectedDeposit": 5.0 },
    { "id": "playerc.CHIPS@", "payAddr": "RCcccc...", "expectedDeposit": 5.0 }
  ],
  "timestamp": 1775000000000
}
```

VDXF key: `chips.vrsc::poker.sg777z.t_phase_open.<phase>`

The signers list is the canonical roster for this phase. Players verify their own entry matches their actual pay address before depositing.

### 3. Phase confirmed

Published by the dealer once all expected deposits are visible at the multisig address. Marks the phase as ready to play.

```json
{
  "type": "phase_confirmed",
  "phase": "p7",
  "multisigAddr": "bABCxyz...",
  "deposits": {
    "playera.CHIPS@": { "txid": "abc...", "amount": 5.0 },
    "playerb.CHIPS@": { "txid": "def...", "amount": 5.0 },
    "playerc.CHIPS@": { "txid": "ghi...", "amount": 5.0 }
  },
  "totalBalance": 15.0,
  "timestamp": 1775000000000
}
```

VDXF key: `chips.vrsc::poker.sg777z.t_phase_confirmed.<phase>`

### 4. Cashout proposal

Published by the dealer to the **table identity** at settlement time. Contains the JSON intent of who gets paid what, plus the unsigned settlement TX template.

```json
{
  "type": "cashout",
  "phase": "p7",
  "table": "mytable.CHIPS@",
  "multisigAddr": "bABCxyz...",
  "multisigBalance": 15.0,
  "bettingStateRef": "chips.vrsc::poker.sg777z.t_betting_state.<handId>.s12",
  "payouts": [
    { "id": "playera.CHIPS@", "payAddr": "RAaaaa...", "amount": 6.0 },
    { "id": "playerb.CHIPS@", "payAddr": "RBbbbb...", "amount": 4.0 },
    { "id": "playerc.CHIPS@", "payAddr": "RCcccc...", "amount": 4.9999 }
  ],
  "fee": 0.0001,
  "unsignedTxHex": "0100000003...",
  "timestamp": 1775000000000
}
```

VDXF key: `chips.vrsc::poker.sg777z.t_cashout.<phase>`

### 5. Cashout signature partial

Published by each signing player to their OWN identity. Contains the partially-signed TX hex after that player added their signature.

```json
{
  "type": "cashout_sig",
  "phase": "p7",
  "cashoutTimestamp": 1775000000000,
  "signedHex": "0100000003...",
  "complete": false,
  "timestamp": 1775000001000
}
```

VDXF key: `chips.vrsc::poker.sg777z.p_cashout_sig.<phase>`

The most recent signed partial from each player is the active state. Anyone can read all the partials, combine them via `signrawtransaction` (which combines partial signatures from multiple sources), and broadcast the complete result.

### 6. Cashout settled

Published by whoever broadcasts the final settlement TX (typically the dealer, but could be any party).

```json
{
  "type": "cashout_settled",
  "phase": "p7",
  "settlementTxId": "xyz...",
  "timestamp": 1775000005000
}
```

VDXF key: `chips.vrsc::poker.sg777z.t_cashout_settled.<phase>`

## Lifecycle

### Phase open

1. Dealer collects join requests from all interested players (reads each player's identity for their `t_join_request`)
2. Dealer composes the phase manifest with each player's `id`, `payAddr`, and `expectedDeposit`
3. Dealer computes the multisig address: `createmultisig(threshold, sortedPubkeys)` where pubkeys come from each player's pay address
4. Dealer publishes `phase_open` to the table identity
5. Each player's backend reads the manifest and verifies:
   - My `id` is in the signers list
   - My `payAddr` in the manifest matches my actual pay address
   - The expected deposit matches what I agreed to
6. Each player deposits their expected amount from their pay address to the multisig (using `lockunspent` and explicit input selection to prevent wallet contamination)
7. Dealer polls `getaddressutxos` on the multisig address until all expected deposits are visible
8. Dealer publishes `phase_confirmed` with the deposit details
9. Hands begin playing

### During play

Hands play normally using the existing protocol:
- Cards are dealt via the cashier shuffle
- Actions are written to player identities
- Betting state is written to the table identity
- Chip stacks are tracked in betting state
- **No money moves on chain during hands** — all stacks are claims against the multisig pool

### Phase close (normal settlement)

1. Settlement is triggered by:
   - Table closing
   - Player joining (triggers phase rotation)
   - Player leaving (triggers phase rotation)
   - Configured time limit on the phase
2. Dealer reads the latest betting state and computes final stacks for each player
3. Dealer composes the cashout proposal:
   - JSON `payouts` list with `{id, payAddr, amount}` per player
   - Unsigned settlement TX template that spends all multisig UTXOs and creates one output per player
4. Dealer publishes `t_cashout.<phase>` to the table identity
5. Each player's backend reads the cashout proposal and runs full verification (see "Verification logic" below)
6. If verification passes, the player signs the unsigned TX using their pay address key (`signrawtransaction` partial)
7. Player publishes their signed partial as `p_cashout_sig.<phase>` on their own identity
8. Anyone monitoring (the dealer normally, but anyone can) collects the partials, combines them via `signrawtransaction`, and once threshold is reached broadcasts via `sendrawtransaction`
9. Settlement TX confirms; each player's pay address receives their payout
10. Dealer publishes `cashout_settled` to mark the phase as closed

### Phase rotation (new player joining)

1. New player publishes their `join_request` to their identity
2. Dealer detects the join during the current phase
3. Dealer pauses at the next inter-hand boundary
4. Current phase settles via the normal cashout flow
5. After settlement, dealer composes a NEW phase manifest with the expanded roster
6. Dealer publishes new `phase_open` for the next phase
7. All players (existing + new) deposit from their pay addresses (existing players use their just-received settlement UTXOs)
8. Phase begins playing

## Verification logic (the critical defensive checks)

Every player's backend MUST run all these checks before signing a cashout proposal. A correctly implemented backend never signs a proposal that fails any check.

```js
function verifyCashoutProposal(cashoutUpdate, latestBettingState, phaseManifest, myId, myPayAddr) {
  // 1. Schema and basic sanity
  if (cashoutUpdate.type !== 'cashout') return { ok: false, reason: 'wrong type' };
  if (cashoutUpdate.phase !== phaseManifest.phase) return { ok: false, reason: 'phase mismatch' };
  if (cashoutUpdate.multisigAddr !== phaseManifest.multisigAddr) return { ok: false, reason: 'multisig mismatch' };
  if (!Array.isArray(cashoutUpdate.payouts)) return { ok: false, reason: 'missing payouts' };

  // 2. ROSTER CHECK: cashout must contain exactly the manifest's signers, no more, no less
  const manifestIds = new Set(phaseManifest.signers.map(s => s.id));
  const payoutIds = new Set(cashoutUpdate.payouts.map(p => p.id));

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
  if (cashoutUpdate.payouts.length !== phaseManifest.signers.length) {
    return { ok: false, reason: 'duplicate or extra entries' };
  }

  // 3. ADDRESS CHECK: each payout's payAddr must match the manifest's recorded payAddr for that id
  for (const payout of cashoutUpdate.payouts) {
    const manifestEntry = phaseManifest.signers.find(s => s.id === payout.id);
    if (payout.payAddr !== manifestEntry.payAddr) {
      return { ok: false, reason: `${payout.id}: payAddr mismatch (manifest=${manifestEntry.payAddr}, cashout=${payout.payAddr})` };
    }
  }

  // 4. AMOUNT CHECK: each payout amount must equal the player's stack in the latest betting state
  for (const payout of cashoutUpdate.payouts) {
    const bsPlayer = latestBettingState.players.find(p => p.id === payout.id);
    if (!bsPlayer) {
      return { ok: false, reason: `${payout.id} not in betting state` };
    }
    if (Math.abs(payout.amount - bsPlayer.stack) > 0.00000001) {
      return { ok: false, reason: `${payout.id}: expected ${bsPlayer.stack}, got ${payout.amount}` };
    }
  }

  // 5. SUM INVARIANT: total payouts + fee = multisig balance
  const totalPayout = cashoutUpdate.payouts.reduce((s, p) => s + p.amount, 0);
  const expectedTotal = totalPayout + cashoutUpdate.fee;
  if (Math.abs(expectedTotal - cashoutUpdate.multisigBalance) > 0.00000001) {
    return { ok: false, reason: `sum mismatch: payouts=${totalPayout} + fee=${cashoutUpdate.fee} != balance=${cashoutUpdate.multisigBalance}` };
  }

  // 6. UNSIGNED TX MUST MATCH JSON: decode the unsigned tx hex and verify outputs match the payouts
  const decodedTx = decodeRawTransaction(cashoutUpdate.unsignedTxHex);
  if (decodedTx.vout.length !== cashoutUpdate.payouts.length) {
    return { ok: false, reason: `tx output count mismatch` };
  }
  for (const vout of decodedTx.vout) {
    const addr = vout.scriptPubKey.addresses[0];
    const matchingPayout = cashoutUpdate.payouts.find(p => p.payAddr === addr);
    if (!matchingPayout) {
      return { ok: false, reason: `unknown output address ${addr}` };
    }
    if (Math.abs(vout.value - matchingPayout.amount) > 0.00000001) {
      return { ok: false, reason: `output amount mismatch for ${addr}` };
    }
  }

  // 7. INPUTS MUST MATCH: the unsigned TX must spend exactly the multisig UTXOs
  // (verify each input txid+vout exists at the multisig address)
  const msUtxos = getaddressutxos(cashoutUpdate.multisigAddr);
  for (const vin of decodedTx.vin) {
    const matching = msUtxos.find(u => u.txid === vin.txid && u.outputIndex === vin.vout);
    if (!matching) {
      return { ok: false, reason: `input ${vin.txid}:${vin.vout} not found at multisig` };
    }
  }

  // 8. SELF-VERIFICATION: my own entry must match what I expect
  const myPayout = cashoutUpdate.payouts.find(p => p.id === myId);
  if (!myPayout) {
    return { ok: false, reason: 'I am not in the payouts' };
  }
  if (myPayout.payAddr !== myPayAddr) {
    return { ok: false, reason: `my payAddr in cashout (${myPayout.payAddr}) does not match my actual (${myPayAddr})` };
  }

  return { ok: true };
}
```

This verification is the heart of the defense. It runs in every player's backend before signing. If the dealer is malicious, this catches it. If the dealer is honest, this is a no-op.

## What this design prevents and what it doesn't

### Prevents

| Attack | How it's prevented |
|---|---|
| Dealer pays themselves from the multisig | Roster check rejects unauthorized recipients |
| Dealer pays a player a wrong amount | Amount check rejects mismatch with betting state |
| Dealer redirects a player's funds to a different address | Address check rejects mismatch with manifest |
| Dealer drops a player from the cashout (paying them 0 silently) | Missing-signers check rejects incomplete payouts |
| Dealer creates "ghost" payouts that drain the multisig | Sum invariant check rejects amount mismatch |
| Dealer publishes a fraudulent unsigned TX hex | TX-vs-JSON check rejects mismatched outputs |
| Dealer composes a TX with inputs not from the multisig | Input check rejects unknown UTXOs |
| Single player AFK | Threshold tolerance handles single dropouts (3+ player tables) |
| Dealer disappears mid-settlement | Settlement progresses asynchronously; anyone can broadcast complete TX |

### Does NOT prevent

| Attack | Why not | Mitigation |
|---|---|---|
| ALL active players colluding with dealer to cheat absent player | Verification only catches dishonest signers; if everyone signs the bad cashout, it passes | Audit trail catches it post-hoc; reputation; this is a social trust layer issue |
| 2+ players AFK in a 3-player table | Threshold of (N-1) is not reached | "Wait for them to come back" — no automatic recovery |
| Heads-up dropout | 2-of-2 has no threshold tolerance | "Wait for them to come back" |
| Player runs a buggy or malicious backend that doesn't verify | Verification depends on correct client | Use open-source backends, audit your own |

## Recovery story

1. **Single dropout in 3+ player table**: handled by threshold tolerance. The remaining players sign, the absent player still receives their payout via the TX outputs.

2. **Multiple dropouts or heads-up dropout**: the cashout proposal sits on the table identity. Players who weren't online see it via the lobby feature when they reconnect, sign, publish their partial. Once threshold is reached, anyone broadcasts. Funds are safe but temporarily inaccessible.

3. **Dealer crashes after publishing cashout**: settlement progresses without the dealer. Players sign asynchronously, anyone broadcasts.

4. **Dealer crashes BEFORE publishing cashout**: any player (or a new dealer) can compose the cashout from the on-chain betting state and publish it themselves. Settlement proceeds normally.

5. **Player permanently disappears**: their funds in active multisigs are stuck. The other players cannot recover their own portions without the missing player's signature (in 2-of-2 heads-up). For 3+ player tables, the (N-1) threshold tolerates one permanent loss.

## The lobby feature

When a player launches their poker GUI, the backend:

1. Scans the player's identity history for tables they've joined
2. For each table, reads the latest `t_cashout.<phase>` records
3. For each cashout, checks if the player's id is in the signers list and they haven't yet published a `p_cashout_sig` for it
4. Surfaces these as "Pending Payouts" notifications in the UI

```
PENDING PAYOUTS:
  ─ Table mytable.CHIPS@: 6.0 CHIPS waiting for your signature [Sign]
  ─ Table fridaygame.CHIPS@: 4.0 CHIPS waiting for your signature [Sign]
```

The player clicks Sign, the backend runs the full verification, and if it passes, signs and publishes. The player can act on each pending payout independently.

## Implementation steps

### Step 1: Multisig primitives in p2p-layer.mjs

Add these functions (no changes to existing functionality, only additions):

- `computeMultisigAddress(pubkeys, threshold)` — wraps `createmultisig`
- `addMultisigToWallet(pubkeys, threshold)` — wraps `addmultisigaddress`
- `getMultisigBalance(addr)` — uses `getaddressutxos`, returns total
- `getMultisigUtxos(addr)` — uses `getaddressutxos`, returns the UTXO list
- `composeSettlementTx(msAddr, payouts, fee)` — builds the unsigned TX with one input per UTXO and one output per payout
- `signSettlementTx(unsignedHex)` — wraps `signrawtransaction`, returns `{hex, complete}`
- `combineSignedTxs(hexes)` — wraps `signrawtransaction` with multiple partial inputs to combine them
- `broadcastSettlement(signedHex)` — wraps `sendrawtransaction`
- `lockUtxo(txid, vout)` — wraps `lockunspent`
- `unlockUtxo(txid, vout)` — wraps `lockunspent`
- `decodeUnsignedTx(hex)` — wraps `decoderawtransaction`

Test with `test-p2p-multisig-helpers.mjs` that does a full cycle using only the new helpers.

### Step 2: Phase manifest publishing in dealer

- Add `openPhase(roster, threshold)` to p2p-dealer.mjs
- Composes the manifest with each player's id, payAddr, expected deposit
- Publishes to table identity as `t_phase_open.<phase>`
- Returns the multisig address and waits for deposits
- Polls `getaddressutxos` until all deposits are visible
- Publishes `t_phase_confirmed.<phase>` with the deposit details

Test by manually running the dealer and verifying the chain records are correct.

### Step 3: Player deposit flow in player-backend.mjs

- Add `joinTable(tableId, payAddr, buyIn)` that publishes a join request
- Add `verifyManifest(manifest)` that runs the manifest checks
- Add `depositToMultisig(msAddr, amount, payAddr)` that uses explicit input selection from pay address (not wallet pool)
- Use `lockunspent` to protect the player's UTXOs from being raided by the wallet
- Wait for the dealer's `phase_confirmed` before treating the phase as active

Test with 2 players manually depositing and the dealer confirming.

### Step 4: Hand play (mostly unchanged)

The existing hand-play code already tracks chip stacks in betting state. No changes needed except:
- Stacks are now claims against the multisig pool
- The multisig balance must equal the sum of stacks at all times (sum invariant)

Test by playing 1 hand and verifying the betting state still works.

### Step 5: Cashout proposal in dealer

- Add `composeCashout(phase)` to p2p-dealer.mjs
- Reads the latest betting state, computes payouts
- Composes the unsigned settlement TX
- Publishes `t_cashout.<phase>` with the JSON payouts and the unsigned hex

Test by triggering settlement and verifying the cashout is correctly published.

### Step 6: Cashout verification + signing in player-backend.mjs

- Add `handleCashoutProposal(cashoutUpdate)` that runs the full verification
- If verification passes, sign with `signrawtransaction` (using the player's pay address key)
- Publish the partial as `p_cashout_sig.<phase>` on the player's own identity
- Refuse to sign if verification fails, raise an alert

Test with a 1-hand session that ends in settlement; verify all players sign correctly.

### Step 7: Settlement assembly + broadcast

- Dealer (or any party) reads all `p_cashout_sig.<phase>` from each player's identity
- Combines partials via `signrawtransaction` until threshold is reached
- Broadcasts the complete TX
- Publishes `t_cashout_settled.<phase>` with the final txid

Test the broadcast happens correctly and players receive their payouts.

### Step 8: Phase rotation on join

- Detect a new join during an active phase
- At next inter-hand pause, trigger settlement of current phase
- Wait for current phase to fully settle
- Open new phase with expanded roster
- Players (existing + new) deposit
- New phase begins playing

Test the 2-player → join → 3-player rotation flow.

### Step 9: Lobby feature in player GUI

- Backend scans known tables for pending cashouts
- GUI shows pending payouts with [Sign] buttons
- Click sign → run verification → publish partial

Test by simulating a dropout and recovery.

### Step 10: End-to-end test

- 2 players form a phase
- Play 5 hands
- 3rd player joins
- Phase rotation triggers
- 3-player phase begins
- Play more hands
- Final settlement

This is the headline test that validates the full integration.

## Estimated effort

- Step 1: ~half day (multisig primitives + tests)
- Step 2: ~half day (phase manifest publishing)
- Step 3: ~half day (deposit flow)
- Step 4: minimal (hand play already works)
- Step 5: ~half day (cashout composition)
- Step 6: ~1 day (verification logic + signing flow)
- Step 7: ~half day (assembly + broadcast)
- Step 8: ~1 day (rotation logic)
- Step 9: ~half day (lobby feature)
- Step 10: ~1 day (testing + bug fixes)

**Total: ~6 days of focused work** for the full integration including testing.

## What we're NOT building (explicit non-goals)

- Dealer or shuffler in the multisig (collusion vector)
- Pre-signed fallback TXs at session start (overengineering)
- Per-hand published partial signatures (overengineering)
- Recovery authority or arbitration identity (introduces trust)
- Custom Bitcoin script with conditional spending paths (complexity)
- CLTV-based timed recovery (complexity)
- Mid-phase partial withdrawals (complexity, the carry-forward via rotation handles this)

These can all be added LATER if real-world usage shows the simpler design is insufficient.
