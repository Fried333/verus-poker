# Funding Model: Phase Multisig with Append-Only Reloads

## Summary

A funding model for decentralized card and dice games on CHIPS that:

- **Has no third-party custody.** Player funds are only ever held in multisigs where the players themselves are the signers.
- **Has no protocol fees, no operator skim, no platform cut.** Every CHIPS that enters the system leaves it, distributed among the participants.
- **Supports drop-in / drop-out gameplay** through phase rotations triggered by roster changes.
- **Supports reloads** (adding more chips mid-session) via unilateral on-chain deposits, no signatures required from other signers.
- **Does not support partial mid-phase withdrawals** — to take chips off the table, a player must leave the table, triggering a phase rotation that fully settles their stack.
- **Generalizes cleanly across game types** — poker (player vs player), blackjack and dice (player vs banker) all use the same underlying model with different signer compositions.
- **Has cryptographic enforcement** of payment obligations: losers cannot refuse to pay because the funds are already pooled in the multisig before play begins.

This document defines the model, walks through how it applies to each game type, and lists what would need to be validated before building it.

---

## Goals

The design aims to satisfy several constraints simultaneously:

1. **Least possible legal exposure for any party.** No participant should be in a position that requires regulatory licensing in jurisdictions where home-game-style play is legal. No party — including the protocol developer — should custody funds on behalf of others.

2. **No protocol-level fees.** The protocol does not skim any percentage of any pot. Compensation for any role (cashier, dealer-tip, etc.) happens through voluntary out-of-band transactions, not structural rake.

3. **Cryptographic enforcement of settlement.** Losers should not be able to refuse to pay. This requires that the funds at risk are already committed before play begins.

4. **Acceptable performance on CHIPS.** The CHIPS chain has ~13s mean block times, multi-minute stalls under bad luck, and no high-frequency throughput. The design must not require chain settlement on every hand.

5. **Drop-in / drop-out support.** Real cash games have players joining and leaving constantly. The model must support this without requiring upfront roster commitment or per-rotation pain.

6. **Verifiability.** Anyone reading the chain should be able to verify that the bookkeeping is consistent — sum of player stacks equals total funds in the multisig, settlement payouts match accumulated stacks, deposits are accounted for.

## Non-goals

To be explicit about what this model does **not** try to achieve:

- **Partial withdrawals during play.** A player who wants to "color up" mid-session must leave the table (triggering a phase rotation) and rejoin with a smaller stack. This is a deliberate simplification to avoid mid-phase state mutation complexity.
- **Sub-second action latency.** Phase rotations introduce ~20–40 seconds of pause; reloads ~10–15 seconds. Hands within a stable phase run at the existing ~25–50 second pace.
- **Trustless dealer**. The dealer (orchestrator) is trusted to publish accurate proposals and audit trails, but never to custody funds. Their actions are publicly verifiable, so dishonesty is detectable but not mechanically prevented.
- **Anti-collusion between players.** The protocol cannot prevent players from secretly cooperating against each other. This is a UX/social problem that no protocol can solve.
- **Compliance with high-stakes gambling licensing regimes.** This model is designed for hobby/home-game-scale use. At scale, regulatory questions change.

---

## Core concepts

### Phase

A **phase** is a contiguous period of play during which the table roster does not change. A phase has:

- A fixed set of player signers (the **roster**)
- A multisig identity (the **phase multisig**) whose signers are exactly the roster
- A signing threshold (typically `(N-1)-of-N` to tolerate one dropout)
- A starting balance (the sum of all initial deposits)
- A betting state log (who has acted, current chip stacks, hand history)

A phase begins when a roster is established and all initial deposits land. It ends when a roster change is triggered, at which point the phase multisig is fully settled and a new phase begins with the new roster.

### Phase multisig

The phase multisig is a standard CHIPS script-multisig address (not a VerusID). It is computed from the public keys of the roster and the threshold.

Key properties:

- **Deposits to the multisig are unilateral.** Anyone can send CHIPS to the multisig address from any wallet without requiring authorization from the signers. This is just sending to a public address.
- **Spending from the multisig requires the threshold of signers.** To send CHIPS out, the threshold of roster members must sign the spend transaction.
- **The multisig has no on-chain identity beyond its address.** It is not a registered VerusID. It is just a script address derived from pubkeys + threshold. This means creating a new phase multisig has no chain transaction cost — the address simply exists once you've computed it.

### Roster change

A **roster change** is an event where the set of players in the phase needs to change:

- **Join**: a new player wants to enter the table
- **Leave**: an existing player wants to exit the table
- **Bust-out**: an existing player has zero chips and is removed
- **Color-up**: an existing player wants to take some chips off the table (requires leaving and rejoining with reduced stack)

Roster changes trigger a **phase rotation**: the current phase ends, the phase multisig is settled, and a new phase begins with the new roster.

### Reload

A **reload** is a player adding more CHIPS to their stack during an active phase, without changing the roster. Reloads are:

- **Unilateral**: the reloading player just sends CHIPS from their pay address to the phase multisig address. No signatures from other signers required.
- **Detected by the dealer**: the dealer (orchestrator) reads the chain, sees the deposit TX, identifies the sender, and updates the betting state's chip stack tracking.
- **Verifiable by all players**: the deposit TX is on chain. Anyone can verify the sender, amount, and timing.
- **Optionally restricted**: the protocol can enforce reload caps, minimum/maximum reload amounts, or require dealer approval before adding to the stack — these are policy decisions, not protocol limitations.

### Pay address

Each player has a **pay address**, which is a regular CHIPS R-address (not a VerusID). Their playing bankroll lives in this address. Deposits to the multisig come from here. Settlement payouts go back here.

The pay address is declared by the player as part of their join state. It is recorded on-chain in the player's join request. Other players and the dealer use this to know where to direct payouts.

The pay address is **separate from the player's game-state VerusID**. The VerusID is used only for game state writes (actions, betting state, sit-out flags) via contentmultimap. The pay address is used only for payments. Keeping them separate avoids the per-identity write mutex bottleneck and lets payments and game state run independently.

### Settlement

A **settlement** is a transaction that spends the entire balance of the phase multisig, distributing it to player pay addresses according to their final chip stacks. Settlement happens once per phase, at the moment of phase rotation (or when the table breaks entirely).

A settlement transaction has:

- **One input**: the entire phase multisig balance
- **N outputs**: one per player, sized to match each player's current chip stack
- **A data output** (OP_RETURN or similar) referencing the phase ID for audit trail
- **Threshold signatures** from the roster — typically `(N-1)-of-N`

The dealer composes the unsigned settlement TX, publishes it as a settlement proposal to the table identity, players verify it against their own betting state history, sign their portion, and the assembled TX is broadcast.

---

## State invariants

The model relies on a single key invariant that must always hold:

> **At any moment within a phase, the sum of all player chip stacks equals the total balance of the phase multisig.**

```
sum(player_stacks) == phase_multisig_balance
```

This invariant is maintained by:

- **Initial deposits** add to both sides equally (each player's deposit becomes their stack AND part of the multisig balance).
- **Hands played** redistribute chips between players within the phase. The sum stays constant; the multisig balance is unchanged.
- **Reloads** add to both sides equally (reload amount becomes part of the depositing player's stack AND adds to the multisig balance).
- **Settlement** drains the multisig completely while paying out exactly the sum of stacks. After settlement, both sides are zero.

The invariant is **publicly verifiable** at any time:

- The phase multisig balance is on chain (anyone can query it)
- Each player's stack is in the betting state (also on chain)
- Anyone reading both can verify they sum correctly

If the invariant ever fails, the bookkeeping is corrupt and no further play should proceed. The dealer must catch this before publishing any settlement proposal.

---

## The funding lifecycle

A complete table session looks like this:

```
[Table opens]
1. Dealer creates a table identity, publishes the table_info record.

[First players join]
2. Player A clicks "sit down at table".
3. Player A's GUI publishes a join_request to A's identity, including A's pay address.
4. Dealer reads the join request, adds A to the pending roster.
5. Player B does the same.
6. Once two players are pending, the dealer:
   - Computes the phase multisig address from A and B's pubkeys
   - Publishes a phase_open record with the multisig address and required deposits
7. A and B each send their initial buy-in to the phase multisig from their pay addresses.
8. Dealer waits for both deposits to land in mempool.
9. Phase 1 begins. First hand starts.

[Hands play]
10. Hands run normally. Cards via cashier shuffle. Actions on chain.
    Chip stacks tracked in betting state. No money moves on chain during hands.

[Mid-phase reload]
11. Player B is low on chips. B clicks "reload 100".
12. B's GUI signs and broadcasts a TX from B's pay address to the phase multisig.
13. The TX includes an OP_RETURN reference: "reload phase=1 player=B amount=100".
14. Dealer detects the deposit, verifies amount, updates B's chip stack in next BS write.
15. Hands continue with B's new stack.

[New player wants to join]
16. Player C clicks "sit down at table" (during phase 1).
17. C's join_request is published, including C's pay address.
18. Dealer queues C for the next phase rotation.
19. At next inter-hand pause, dealer triggers phase rotation:
    - Reads current chip stacks from BS history
    - Verifies sum(stacks) == multisig_balance
    - Publishes settlement_proposal: { phase: 1, payouts: {A: 250, B: 150} }
    - A and B sign the settlement TX (one input from M1, two outputs)
    - Settlement TX broadcast, M1 drains
    - Publishes phase_open: { phase: 2, multisig: M2_addr, signers: [A, B, C] }
    - A, B, C each deposit fresh to M2 from their pay addresses
    - Once all deposits land, phase 2 begins

[Player wants to leave]
20. Player A clicks "leave table" (during phase 2).
21. Same as above: phase rotation triggered, M2 settled, M3 starts with [B, C].
22. A's payout from M2 settlement goes to A's pay address. A is gone.

[Table ends]
23. Last player leaves (or dealer closes the table).
24. Final phase rotation: M3 fully settles to remaining players' pay addresses.
25. No new phase is opened. Table is closed.
```

Total chain transactions per phase:
- 1 settlement TX at phase end (+ 1 at table close)
- 1 deposit TX per player at phase start
- 1 deposit TX per reload during the phase
- 0 chain TXs per hand (just BS identity updates, which we already do)

For a typical session of 30 hands with 1 join and 1 leave, this is roughly:
- 3 phases × N deposits + 3 settlement TXs + ~5 reloads
- For 4 players average: ~12 deposit TXs + 3 settlement TXs + 5 reloads = ~20 chain payment TXs total
- Compared to ~120 chain TXs if every hand settled separately

---

## Application to poker (player vs player)

Poker is the simplest case for this model because all players are peers — there is no banker. The phase multisig signers are exactly the players at the table.

### Phase multisig

- **Signers**: all players currently at the table
- **Threshold**: `(N-1)-of-N` (tolerates one dropout)
- For 2-player heads-up: `2-of-2` (both must agree, with optional recovery authority for stuck case)

### Initial deposit

Each player deposits their buy-in. The buy-in amount is their starting stack for the phase.

### During play

- Hands deal cards via cashier shuffle (existing protocol)
- Actions written to player identities via contentmultimap (existing protocol)
- Betting state updated on table identity to track running pot and stacks (existing protocol)
- **No money moves on chain during hands**

### Settlement at phase end

Each player's final stack is paid to their pay address. The settlement TX has N outputs (one per player) summing to the multisig balance.

### Special considerations for poker

- **Bust-outs**: a player who reaches zero chips can choose to leave (triggering rotation, but their payout output is zero) or sit out without leaving (their seat stays in the roster, they just don't play hands). Sitting out keeps them in the multisig but inactive.
- **All-ins**: existing protocol handles side pots within the chip stack tracking; no impact on the multisig.

---

## Application to vs-house games (dice, blackjack, roulette)

The interesting generalization: vs-house games use the same phase multisig model, with **the banker as one of the signers**. The banker plays a structurally different role in the game (taking the other side of bets) but is mechanically just another roster member.

### Phase multisig

- **Signers**: the banker plus all current players
- **Threshold**: `(N+1)-1 of (N+1)` — i.e., (banker + all players − 1)
- The banker is not privileged; they have one signature like any other signer.

### Initial deposit

- **Players** deposit their playing bankroll for the phase
- **Banker** deposits collateral covering maximum possible payouts

For example, for a dice game where each player can bet up to 10 CHIPS at 35:1 odds, the banker must deposit at least `35 * 10 * num_players` to cover the worst case where every player wins big. In practice, banker deposits a session bankroll significantly larger than expected losses.

The phase multisig balance after initial deposits is `sum(player_bankrolls) + banker_collateral`.

### During play

- Each round/hand, players place bets (chip stacks decrease, banker's stack would not yet change)
- Game resolves (cards dealt by cashier for BJ, RNG via commit-reveal for dice)
- Stacks update to reflect outcomes:
  - Player wins: player's stack increases, banker's stack decreases by same amount
  - Player loses: player's stack decreases, banker's stack increases by same amount
- Sum invariant always holds (it's just chips moving between two players within the multisig)
- No chain TXs during hands

### Reloads

Both players AND the banker can reload mid-phase:
- A player whose stack is low can deposit more from their pay address to top up
- The banker whose collateral is depleted (because players have been winning) can also deposit more from their pay address

Both are unilateral deposits that grow the multisig and update the depositor's stack.

### Settlement at phase end

When the roster changes (new player joins, existing player leaves, banker leaves and is replaced) or the table ends, the multisig settles. Each signer (banker and players) receives their current stack to their pay address.

The banker's final stack might be more or less than their initial collateral depending on how the game went. If they had a winning session, their final stack is greater than their initial deposit. If a losing session, it's less. Either way, settlement just maps current stacks to outputs.

### Special considerations for vs-house games

#### Banker selection and rotation

The protocol does not enforce who the banker is. It is a property of the table:

- A player who wants to bank a session declares themselves as banker when the table opens
- Other players join knowing who the banker is and what odds they offer
- If multiple players want to bank, they can run separate tables, or rotate banker each phase
- Players choose which table (and which banker) they want to play at
- The protocol provides no preference or default — any player with the collateral can bank

This is a critical design property for legal posture: **the banker is a player who chose a different role**, not an operator. The protocol does not pick the banker. The banker rotates naturally as different players prefer different roles in different games.

#### Posted odds

Each table publishes its game-specific configuration as part of the phase_open record:

- **Dice**: odds offered for each bet type, payout multipliers, max bet
- **Blackjack**: rule variants (dealer hits soft 17, blackjack pays 3:2 vs 6:5, number of decks, double after split, etc.), max bet
- **Roulette**: wheel type (single zero / double zero), max bet per number, max bet per outside

Players see these before joining. The posted odds determine the structural house edge of the game, which the banker is taking the other side of.

The protocol does not constrain the odds — bankers can offer whatever they want, and players choose whether to play. This creates a market: bankers who offer too much edge get no players, bankers who offer too little go broke. Each table is its own market.

#### Banker leaving

If the banker wants to leave mid-session, the same phase rotation flow applies: settle the current multisig, open a new phase. The new phase needs a new banker (or the table closes if no one wants to bank).

If a player wants to take over the banker role, the new phase has them as banker with their own collateral. The previous banker walks away with whatever they have at settlement time.

#### Banker collateral depletion

If during play the banker's stack reaches zero (extreme losing streak), no more bets can be accepted until the banker reloads. The dealer pauses play and prompts the banker to add collateral. If the banker declines, the table either ends (settlement) or waits for the banker to return.

A protocol-level check should prevent any bet that would cause the banker's stack to go negative (i.e., a bet that the banker cannot fully cover from current collateral). This is enforced by the dealer when accepting bets, similar to how a casino would refuse a bet that exceeds table limits.

---

## Failure modes

### Player goes silent during the phase

The phase continues. Their seat is sat-out, their stack is preserved in the multisig, no settlement is needed yet. When the next phase rotation happens, they receive their current stack to their pay address. They didn't need to sign anything because settlement only requires the threshold (`(N-1)-of-N`) of signers, which the others can achieve without them.

### Player goes silent at phase rotation

If exactly one player is silent, the remaining players can still meet the `(N-1)-of-N` threshold and complete the settlement. The silent player's payout output goes to their pay address regardless. They were paid even though they didn't sign.

### Multiple players go silent at phase rotation

If two or more players are silent in an N-player phase with `(N-1)-of-N` threshold, the threshold cannot be reached. The settlement TX cannot be assembled.

Mitigations:
- **Wait**: silent players might come back. The funds are safely in the multisig.
- **Recovery authority**: optional. The phase multisig can be created with a designated recovery key (a separate identity, possibly community-elected) that can sign on behalf of silent players after a long timeout (e.g., 24 hours), based on the on-chain BS audit trail.
- **Threshold tuning**: for tables with high churn risk, use lower thresholds (e.g., `(N-2)-of-N`) at the cost of more individual signing power.

### Dealer goes silent

The dealer is an orchestrator, not a custodian. If the dealer crashes:
- The current multisig is unaffected (it's controlled by the players, not the dealer)
- The current betting state is on chain and recoverable
- Any other dealer-capable node can take over orchestration by reading the chain state
- Players can collaboratively reconstruct the game state and continue with a new dealer

For poker, this is straightforward — the BS history fully describes the game. For BJ/dice, the cashier needs to also be alive (it holds the shuffle state), or the current hand is forfeit and a fresh hand starts.

### Cashier goes silent

For poker, the cashier holds shuffle data needed to reveal cards. If it crashes mid-hand, the current hand is unrecoverable. Existing recovery code handles this by persisting cashier state to disk; on restart it can resume.

For BJ, similar: the cashier holds the deck state for the current shoe. Persisted to disk and restartable.

For dice with a commit-reveal RNG, the cashier just needs to publish the reveal at the right time. If it crashes before reveal, the round is voided and players' bets are returned (no chip stack changes).

### Reload TX is in mempool when a hand starts

The dealer should wait for reload TXs to be visible in mempool before treating the new chip stack as authoritative for play. If a player reloads and immediately wants to play, there is a brief window (~1-5 seconds via mempool reads) before the reload is visible. The dealer enforces "deposits must be visible before the next hand begins" to prevent playing with unconfirmed stacks.

### Reload arrives but is for the wrong amount

The dealer reads the deposit TX and verifies it matches the expected reload (player, amount, phase). If there's a mismatch, the dealer ignores the deposit and the player's stack is not updated. The funds are still in the multisig and will be paid out at settlement, just attributed correctly.

This is a self-correcting case: a "wrong" reload still ends up being paid back to the depositor at settlement, so no funds are lost.

### Settlement proposal disagreement

If the dealer publishes a settlement proposal that a player disagrees with (their stack is wrong), the player refuses to sign. The dealer can investigate, fix the proposal, and republish. If the dispute is genuine, the players collectively work it out by re-reading the BS history. The on-chain audit trail is the source of truth.

In the worst case, the threshold of players can sign a settlement that excludes one player who disagrees, paying that player based on the dealer's calculation (which is verifiable). The disputing player can challenge later via the audit trail if they believe they were shorted.

### Dealer publishes a fraudulent settlement

The dealer cannot actually steal funds because they don't sign the settlement TX. They can only publish a *proposal*. The players must verify and sign it. If the proposal is fraudulent, no honest player will sign, and the threshold cannot be reached.

A dishonest dealer's only recourse would be to collude with the threshold of players to sign a fraudulent proposal that pays them less than they're owed. This is detectable by the affected players, who would refuse to sign. Collusion that affects only non-signers (e.g., the dealer and N-1 players collude to short the Nth player) is the worst case. Mitigations:
- All players verify their own stack before signing
- The audit trail makes any discrepancy visible after the fact
- Reputation: dealers caught colluding lose all future business

This is the same trust model as a real cardroom: the casino can't actually steal your chips because you're holding them, but they could in theory miscount the pot. Verifiability makes this hard.

---

## What's deliberately not supported

To keep the model clean, the following features are explicitly out of scope:

### Partial mid-phase withdrawals

A player cannot take some chips off the table while continuing to play. To lock in profit, they must leave the table (triggering a phase rotation that pays them in full) and rejoin in the next phase with whatever amount they want.

Justification: partial withdrawals require mid-phase multisig spends, which create race conditions with reloads, complicate the sum invariant, and require coordinated signature gathering during play. The UX cost of "leave and rejoin to color up" is acceptable for a hobby/home-game model.

### Mid-phase signer changes

The roster of signers in a phase multisig is fixed for the duration of the phase. To add or remove a signer, you must end the phase (settlement) and start a new one. There is no "add a signer to the existing multisig" operation.

Justification: rotation of signers requires the existing threshold to sign an `updateidentity` (or equivalent), which is itself a multisig spend. This creates the same coordination problems as partial withdrawals. Phase rotation is the simpler answer.

### Cross-phase fund continuity

Funds do not roll over from one phase to the next. At every phase rotation, every player receives their full current stack to their pay address. To continue playing, they must deposit fresh from their pay address into the new phase multisig.

Justification: this avoids the bookkeeping complexity of tracking "rolled-over funds" that are partially in one multisig and partially in another. Each phase is fully self-contained.

### Operator-style fees

The protocol takes no percentage of any pot, charges no fees, and has no central address that accumulates value. Compensation for any role is voluntary and out-of-band:
- **Dealer tips**: post-hand or post-session, voluntary, default zero, paid wallet-to-wallet
- **Cashier service fees**: paid by mutual agreement between dealer and cashier, completely outside the game flow
- **Banker compensation**: comes from the structural game edge in vs-house games, which is a property of the game rules, not a protocol fee

Justification: any structural fee in the protocol changes the legal posture from "tool" to "service" and creates regulatory exposure. The model is explicitly designed to keep the protocol fee-free.

### Anonymity / privacy from regulators

The protocol does not attempt to hide player identities, fund flows, or game outcomes. Everything is on a public chain. The legal posture relies on the activity being **legal where the players are**, not on the activity being undetectable.

### Mass-market scale

The model is designed for hobby play, friend groups, and small communities. It is not designed for thousands of concurrent tables, high-frequency cash flows, or commercial casino-scale operation. At sufficient scale, all of the legal-posture arguments here would need to be revisited.

---

## Open questions to validate

Before building this, the following should be tested on CHIPS:

### 1. Multisig script address creation

Verify that CHIPS supports standard multisig script addresses without VerusID registration:
- Compute a 2-of-2 multisig address from two pubkeys
- Send CHIPS to the address from a regular wallet
- Spend from the address with both signatures
- Confirm everything works on chain

### 2. Multi-input / multi-output settlement TX

Verify that a single transaction can:
- Spend the entire balance of a multisig (one input)
- Distribute it to N different outputs (one per recipient)
- Be signed by the threshold of signers
- Land on chain in one TX

### 3. Settlement timing

Measure end-to-end:
- Time from "let's settle" to "TX in mempool"
- Time for signatures to be collected from N players
- Time for the TX to confirm

### 4. Reload detection latency

Measure: from "reload TX broadcast" to "dealer can see the deposit on chain", how long? This determines how quickly a player can reload mid-game.

### 5. Threshold tolerance

Verify that a `(N-1)-of-N` multisig can be settled with one signer absent. Test with N=2, N=3, N=4.

### 6. Phase rotation end-to-end

Full sequence:
- Open phase 1 with 2 players, deposit, play hands
- Trigger rotation (add player C)
- Settle phase 1
- Open phase 2 with 3 players, deposit, play hands
- Settle phase 2
- Measure total time and chain TX count

### 7. Sum invariant enforcement

Compose a settlement where the outputs don't sum to the multisig balance. Verify that the dealer's pre-broadcast check rejects it.

### 8. Reload during active play

Simulate a reload TX landing while a hand is in progress. Verify the dealer correctly defers the stack update until the next hand.

### 9. Cross-game compatibility

Test the multisig model with a banker as one of the signers (vs-house games). Verify that the banker's stack can grow and shrink during play just like a player's stack, and that settlement correctly pays the banker their final balance.

### 10. Recovery authority

If using a recovery authority for stuck-multisig cases, validate the recovery flow: register a multisig with a recovery key, simulate all signers being silent, verify the recovery key can complete a settlement after a timeout.

---

## Implementation sketch

If validation succeeds, the implementation work is roughly:

### Phase 1 — Foundational primitives

- Multisig address computation utility
- Multi-input/multi-output TX construction utility
- PSBT-style signature gathering across multiple wallets
- Reload detection (chain reader for deposits to a given address)

### Phase 2 — Phase lifecycle

- `phase_open` record on table identity
- Deposit waiting and verification flow
- `settlement_proposal` record with pre-broadcast verification
- Settlement TX broadcast and confirmation tracking

### Phase 3 — Roster change handling

- Join request queueing
- Leave request handling
- Phase rotation orchestration (settle old, open new)

### Phase 4 — Reload handling

- Reload TX detection and BS update
- Per-phase reload caps (policy)
- UI flow for "reload N chips"

### Phase 5 — Game-specific integration

- Poker: integrate phase lifecycle with existing hand flow
- Dice: build new game logic on top of phase multisig + banker role
- Blackjack: build new game logic on top of phase multisig + banker role + cashier shuffle

Each phase is roughly 1-2 weeks of work. Total estimated effort: 2-3 months for full implementation across all three games.

---

## Summary of trade-offs

| Property | This model | Alternative: per-hand multisig | Alternative: pay-address only |
|---|---|---|---|
| Per-hand chain overhead | None | High (full setup + settle) | Medium (settlement TX per hand) |
| Per-rotation overhead | Medium (~20-40s) | None | None |
| Cryptographic enforcement | Yes | Yes | No (reputation only) |
| Drop-in/drop-out | Yes (at rotation points) | Trivial | Trivial |
| Custody | None (players are signers) | None (per hand) | None |
| Roster flexibility | Good (change at rotations) | Trivial | Trivial |
| Bookkeeping complexity | Low | Low | Low |
| Implementation complexity | Medium | High | Low |
| Match to real cash game UX | Good | Medium | Medium |

The phase multisig model provides cryptographic enforcement (which the pay-address-only model lacks) without the per-hand overhead of the per-hand multisig model, at the cost of moderate complexity around phase rotations.

---

## Conclusion

This model is designed to satisfy the constraints of:
- No third-party custody
- No protocol fees
- Cryptographic enforcement of payment
- Acceptable performance on a slow hybrid PoW/PoS chain
- Drop-in / drop-out support
- Generalization across poker, blackjack, and dice
- Minimal legal exposure under home-game framing

It does so by treating the **phase** as the unit of state, with **multisigs that grow during a phase** (via reloads) **and drain at phase boundaries** (via settlement). Roster changes trigger phase rotations. Hands within a phase run with no per-hand chain settlement overhead. The protocol takes no fees and custodies no funds.

Open questions are about chain-level behavior (multisig support on CHIPS, settlement TX timing, threshold tolerance) and require standalone testing before commitment to the design. None of the open questions are believed to be blockers based on Komodo/Bitcoin precedent, but should be validated.

This model can be applied uniformly to:
- **Poker** (player-vs-player, all signers are players)
- **Dice** (player-vs-banker, signers are players + banker)
- **Blackjack** (player-vs-banker, same as dice with cashier shuffle)
- **Roulette** (player-vs-banker, same as dice)
- Any other game where a fixed roster of participants need to pool funds for a session

The protocol developer's role is purely as software author. Compensation for the developer (if desired) comes from running cashier services, premium tooling, tournament organization, or voluntary donations — never from a structural cut of any game.
