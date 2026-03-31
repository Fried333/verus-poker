# Verus Poker Protocol v2

## Overview

A decentralized poker protocol for the CHIPS blockchain (Verus PBaaS chain) with enhanced collusion resistance and cryptoeconomic fairness. Based on the BCRA 2026 paper "A Decentralized Poker Protocol with Enhanced Collusion Resistance and Cryptoeconomic Fairness."

The protocol uses efficient Curve25519 cryptography, Shamir secret sharing for card reveals, a decentralized Cashier committee for escrow and verification, and Verus IDs for all communication and state management.

**Key properties:**
- Cheating is mathematically detectable and economically unprofitable
- No trust required — fairness enforced by cryptography and staking
- No server required — all communication via Verus ID contentmultimap
- Full audit trail permanently indexed on-chain via VDXF keys

---

## Entities

### Players (P_i)
- Each player has a VerusID on the CHIPS chain
- Generates session keypairs for each hand
- Deposits funds (V_deposit) + good-behavior bond (V_stake) to cashier multisig
- Pays their own TX fees for identity updates (~0.0005 CHIPS per hand)
- Must have CHIPS in wallet beyond buy-in to cover TX fees

### Dealer
- A player or dedicated node that manages the table
- Generates player-specific blinding factors (e_i) to prevent Player+Cashier collusion
- Shuffles and blinds the deck (Stage II of the protocol)
- Publishes table listing on their VerusID contentmultimap
- Earns commission (dcv_commission) from each pot

### Cashier Committee
- N_C elected notary nodes with staked funds
- Acts as M_C-of-N_C multisig escrow for ALL funds
- Performs the third shuffle/blind stage (Stage III)
- Splits blinding values via Shamir secret sharing
- Performs post-game full-trace replay verification
- Only signs settlement TX after verification passes
- Earns commission (dev_fund_commission) from each pot
- Gets slashed if found to be cheating

---

## Communication Layer

### All game state via Verus ID contentmultimap
Every game action is written to a VerusID's contentmultimap using VDXF keys. Each VDXF key type represents a different kind of game data:

| VDXF Key | Writer | Data |
|----------|--------|------|
| `poker.table.config` | Dealer | Table listing (blinds, stakes, players) |
| `poker.game.state` | Dealer | Current game phase |
| `poker.deck.player` | Player | Player's initial deck (public points) |
| `poker.deck.dealer` | Dealer | Dealer-blinded deck |
| `poker.deck.cashier` | Cashier | Double-blinded deck + SSS shares |
| `poker.card.reveal` | Cashier/Dealer | Blinding values for card reveals |
| `poker.player.action` | Player | Betting actions (fold/check/call/raise) |
| `poker.board.cards` | Dealer | Community cards |
| `poker.settlement` | Dealer | Hand result + settlement request |
| `poker.secrets` | All parties | Post-game secret reveals for verification |

### VDXF Indexing
- All contentmultimap updates are permanently indexed in the blockchain DB
- Nothing is overwritten — every update to every VDXF key is stored in order
- `getidentitycontent(id, heightstart, heightend, txproofs, txproofheight, vdxfkey)` retrieves updates filtered by VDXF key and block range
- `heightend=-1` includes mempool data (unconfirmed transactions)
- Full audit trail is built into the chain — no separate storage needed
- After each hand, contentmultimap is cleared for the next hand

### Ordering Guarantees
- Identity updates spending sequential UTXOs are guaranteed to be ordered even in the mempool
- The dealer is the primary writer to the table ID — single writer = single UTXO chain = guaranteed order
- Players write to their own IDs (independent UTXO chains)
- v1: Wait for block confirmation (~10s per action, simple)
- v2: Chain UTXOs for mempool-speed ordering (~1s per action)

### Read Speed
- Confirmed data: `getidentitycontent(id, block, 0)` — always available after mining
- Mempool data: `getidentitycontent(id, 0, -1)` — available before mining (~1s)
- API added by Mike Toutonghi specifically for the poker use case

---

## Cryptographic Protocol

### Primitives
| Primitive | Implementation | Role |
|-----------|---------------|------|
| Curve25519 (`curve25519()`) | C: curve25519-donna.c | Initial keypair generation only |
| Field projection (`xoverz_donna()`) | C: curve25519-donna.c:863 | Projects EC point → 255-bit field element (one-time bridge) |
| Field multiply (`fmul_donna()`) | C: curve25519-donna.c / JS: `(a * b) % (2^255-19)` | **ALL blinding/unblinding operations** |
| Shamir Secret Sharing (SSS) | C: poker-crypto.c | Distributes b_ij shares, ensures threshold security |
| SHA-256 Hash | Standard | Binds secrets in commitments, prevents tampering |
| M_C-of-N_C Multisig | Verus native | Secures all funds in escrow, gates settlement |

### Key Insight: Field Elements, Not Curve Points (Confirmed by Dev 2026-03-31)

Cards are represented as **field elements** in the 255-bit prime field (p = 2^255 - 19), NOT as elliptic curve points. The `curve25519()` function generates an initial curve point, but `xoverz_donna()` immediately projects it down to a scalar field element. From that point on, **all blinding operations use `fmul_donna()` — simple modular multiplication.**

Why this matters:
- EC point multiplication `[k]P` is computationally heavy (~1ms per op)
- Field multiplication `a × b mod p` is fast (~0.001ms per op, ~1000× faster)
- Modular multiplication is **commutative**: `A × B mod p = B × A mod p`
- This commutativity is what makes the multi-party blinding/unblinding protocol work

**JS equivalence confirmed by dev:** `(a * b) % (2n ** 255n - 19n)` in BigInt is mathematically identical to `fmul_donna()` in C. The JS implementation in `mental-poker.mjs` is correct for all blinding operations. No WASM needed for the shuffle protocol — only for initial keypair generation.

### Three-Stage Shuffle and Blind

**Why 3 parties?**
- 2-party (SRA) fails if any player disconnects — deck is permanently locked
- 3-party with SSS allows card reveals even if a minority of players disconnect
- Player-specific blinding factor (e_i) prevents Dealer+Cashier collusion
- Requires Player+Dealer+Cashier collusion to cheat (all 3 parties)

**Stage I — Player (P_i → Dealer):**
1. Player generates random nonce r_ik for each card k
2. Computes scalar h_ik = H(r_ik || "card_k_string")
3. Computes field element via `xoverz_donna(h_ik, basepoint)` → P_ik
4. Generates secret permutation σ_i and blinding scalar p_i
5. Permutes and blinds deck: D_1,i = {`fmul(p_i, P_i[σ_i^(-1)(j)])` | j=1..Z}
6. Commits H(p_i || σ_i) to Verus ID
7. Sends (D_1,i, P_i) to Dealer

**Stage II — Dealer (Dealer → Cashier):**
8. Receives all player decks, verifies senders
9. Generates global scalar d, global permutation σ_Dealer
10. For each player i: generates secret player-specific scalar e_i
11. Permutes: D'_1,i = {D_1,i[σ_Dealer(j)] | j=1..Z}
12. Blinds with d: D''_1,i = {`fmul(d, P')` | P' ∈ D'_1,i}
13. Blinds with e_i: D_2,i = {`fmul(e_i, P'')` | P'' ∈ D''_1,i}
14. Commits H(d || σ_Dealer || e_1 || ... || e_N) to Verus ID
15. Sends {D_2,1, ..., D_2,N} to Cashier committee
    (C code: `deckgen_vendor` uses `tmp[i] = fmul_donna(..., randcards[i].priv)`)

**Stage III — Cashier Committee (Cashier → P_i):**
16. Receives dealer-blinded decks
17. Generates global permutation σ_Cashier
18. For each player i, each card position j:
    - Generates secret blinding scalar b_ij
    - Blinds: C_ij = `fmul(b_ij, D'_2,i[j])` (after permuting)
    - Computes (M,N) SSS shares {s_ijk} of b_ij
    - Encrypts s_ijk for each player P_k
19. Commits H(σ_Cashier || {b_ij}) to Verus ID
20. Sends final deck D_3,i = {C_i1, ..., C_iZ} to each player
    (C code: `p2p_bvv_init` uses `blindedcards[i] = fmul_donna(finalcards[...], blindings[i])`)

**Result:** Player i holds deck D_3,i where each card C_ij = fmul(b_ij, fmul(e_i, fmul(d, fmul(p_i, P_i,k)))) with k = σ_i^(-1)(σ_Dealer^(-1)(σ_Cashier^(-1)(j))). No single party knows the final card-to-position mapping. All operations are field multiplications.

### Card Reveal (Private — Hole Cards)

1. Player P_i broadcasts request for SSS shares for position (i,j)
2. Other players decrypt and send their shares s_ijk
3. P_i collects ≥ M shares, reconstructs b_ij via SSS
4. P_i removes cashier blinding: C'_ij = b_ij^(-1) · C_ij = (e_i · d · p_i) · P_i,k
5. P_i sends (C'_ij, j) to Dealer
6. Dealer releases e_i to P_i
7. Dealer computes: C''_ij = (e_i · d)^(-1) · C'_ij = p_i · P_i,k
8. Dealer sends C''_ij to P_i
9. P_i computes: P_i,k = p_i^(-1) · C''_ij
10. P_i identifies card k by finding k' such that P_i,k = P_i,k' from initial commitment

Only P_i learns the card. The Dealer sees intermediate values but cannot determine k without p_i.

### Card Reveal (Public — Board Cards)

For community cards, the Cashier and Dealer release b_ij and e_i publicly via Verus ID updates. All players can then independently unblind and verify the same card.

### Security Guarantees
- ECDLP ensures scalars (p_i, d, e_i, b_ij) remain secret unless explicitly revealed
- SSS ensures b_ij requires M > ⌊N/2⌋ shares — preventing minority coalition reconstruction
- The e_i factor binds Dealer operations to specific players — preventing Player+Cashier collusion
- Commitments prevent retroactive tampering with any value

---

## Betting and Fund Management

### Deposit (Once per Session)
Before playing, each player sends:
- V_deposit (buy-in amount) to Cashier committee's M_C-of-N_C multisig address
- V_stake (good-behavior bond) to the same multisig
- Must retain CHIPS in wallet for TX fees (~0.025 CHIPS per 50 hands)

Funds remain locked in multisig for the entire session. Players cannot withdraw without cashier signatures.

### Virtual Betting (During Play)
During the game, bets are NOT actual transactions. A player commits a "bet" (e.g., "bet 2 CHIPS") as data to their Verus ID contentmultimap under the `poker.player.action` VDXF key.

The session manager tracks running balances in memory. The Dealer (and other players) validate virtual bets by checking the player's committed data against their available balance.

### Session-Based Settlement
Unlike per-hand settlement, funds only move on-chain when a player cashes out or the table closes:

- **During play:** No on-chain fund transfers between hands. Only virtual balance tracking.
- **Per-hand verification:** After each hand, cashier nodes verify the hand was fair using on-chain data (see Verification section). This is cryptographic proof, not fund transfer.
- **Cash-out:** Player requests withdrawal → Cashier verifies ALL hands since deposit → Signs one payout TX for final balance.
- **Table close:** All remaining balances settled in a single batch TX.

**Why session-based is safe:**
- All funds locked in M-of-N multisig — ragequitters can't steal
- Per-hand verification catches cheating immediately (hand is voided, stake slashed)
- Fewer TX fees (one settlement vs one per hand)
- Faster gameplay (no payout confirmation delays between hands)

**Ragequit handling:**
- Loser disconnects: their remaining balance stays in multisig. They can claim it later or it's released after timeout.
- Winner disconnects: same — funds wait in multisig.
- Neither party can take money without cashier signatures.

### Gated Settlement
The Cashier committee will NOT sign any settlement transaction until:
1. ALL hands in the session have been verified via on-chain replay
2. Post-game verification (Algorithm 4) passed for every hand
3. No cheating detected in any hand

---

## Post-Hand Verification (On-Chain Replay)

This is the core of the protocol's security. After each hand, verification happens using data already on-chain.

### Data Source: contentmultimap
All verification data is read directly from the blockchain using `getidentitycontent()`. Each hand's data is stored as incremental identity updates — NOT accumulated into one blob (avoids size limits, per dev guidance).

```
getidentitycontent(tableId, handStartBlock, currentBlock, false, 0, vdxfKey)
```

The cashier tracks the starting block of each hand and reads forward incrementally.

### Phase 1: Secret Reveal
After hand completes, ALL parties publish their secrets as identity updates:
- Players reveal: {r_ik}, p_i, σ_i → written to player's VerusID
- Dealer reveals: d, {e_i}, σ_Dealer → written to table VerusID
- Cashier reveals: {b_ij}, σ_Cashier → written to cashier VerusID

### Phase 2: On-Chain Replay Verification
Each Cashier node reads the full hand from chain and replays independently:
1. Read player decks from `poker.deck.player` VDXF key on player IDs
2. Read dealer shuffle from `poker.deck.dealer` VDXF key on table ID
3. Read cashier shuffle from `poker.deck.cashier` VDXF key on cashier ID
4. Read revealed secrets from `poker.secrets` VDXF key on all IDs
5. Re-compute Stage I: `fmul(p_i, P_i[σ_i^(-1)(j)])` for each card — must match published D_1,i
6. Re-compute Stage II: `fmul(e_i, fmul(d, D'_1,i))` — must match published D_2,i
7. Re-compute Stage III: `fmul(b_ij, D'_2,i[j])` — must match published D_3,i
8. Verify betting actions match game rules (valid bets, correct turn order)
9. Verify hand evaluation matches claimed winner
10. If any check fails → mark hand as INVALID, identify cheating party

### Phase 3: Settlement (At Cash-Out or Table Close)
When a player cashes out, the Cashier checks ALL hands since their deposit:
- If ALL hands verified → sign payout TX for player's final balance (minus rake)
- If ANY hand has cheating detected:
  - **Void cheated hand**: discard that hand's virtual pot
  - **Slash**: seize V_stake from the cheater
  - **Recalculate**: settle with corrected balances
  - **Pay rake**: dealer + cashier commission from legitimate hands

### Why This Makes Cheating Unprofitable
A rational adversary:
- Cannot achieve M_C signatures to steal the pot (needs majority of cashier committee)
- Is guaranteed to lose V_stake if caught cheating (full replay catches everything — data is ON CHAIN)
- Gains zero from cheating (cheated hands are voided, balances recalculated)
- Cannot delete evidence — contentmultimap updates are permanently indexed via VDXF keys
- The Nash Equilibrium is honest participation

---

## Game Flow — Complete Hand

```
SETUP (once per table):
  1. Dealer publishes table config to VerusID contentmultimap
  2. Cashier committee registers multisig address
  3. Players discover table via explorer/wallet

JOIN (once per player per session):
  4. Player deposits V_deposit + V_stake to cashier multisig
  5. Player writes join request to their VerusID
  6. Dealer verifies deposit, seats player

HAND START:
  7. Dealer writes game state "PLAYERS_JOINED" to table ID

DECK SHUFFLE (3 stages):
  8.  Player writes shuffled/blinded deck to player ID          ~10s
  9.  Dealer reads, shuffles, blinds, writes to table ID        ~10s
  10. Cashier reads, shuffles, blinds, distributes SSS shares   ~10s
  11. Cashier writes final decks to each player                 ~10s

DEALING HOLE CARDS:
  12. For each player's card:
      - Players exchange SSS shares via their IDs               ~10s per card
      - Player reconstructs blinding value
      - Dealer releases e_i
      - Player decodes card locally

BETTING (per round — preflop, flop, turn, river):
  13. Dealer writes "your turn, player X" to table ID           ~10s
  14. Player writes action to their ID                          ~10s
  15. Dealer reads, validates, updates game state                ~10s
  16. Repeat for each player

COMMUNITY CARDS (flop/turn/river):
  17. Cashier releases b_ij publicly via ID update              ~10s
  18. Dealer releases e_i publicly via ID update                ~10s
  19. All players independently decode and verify               local

SHOWDOWN:
  20. Players reveal private blinding keys via ID updates       ~10s
  21. Anyone can verify: apply revealed keys to published deck
      → must match the cards that were played

SETTLEMENT:
  22. All parties reveal ALL secrets to their IDs               ~10s
  23. Cashier committee replays and verifies every step
  24. If verified → cashier signs payout TX (winner + rake)
  25. If cheating → void game, refund honest, slash cheater
  26. Stakes returned to honest parties

NEXT HAND:
  27. Contentmultimap cleared for fresh hand
  28. Return to step 7
```

### Timing Estimate (v1 — block confirmation)
- Deck shuffle: ~40 seconds (4 stages × 10s)
- Dealing 4 players' hole cards: ~80 seconds
- Betting round (4 players): ~80 seconds (8 actions × 10s)
- 4 betting rounds: ~320 seconds
- Community cards: ~30 seconds
- Settlement: ~20 seconds
- **Total per hand: ~8-10 minutes**

### Timing Estimate (v2 — mempool with UTXO chaining)
- Same flow but ~1s per action instead of 10s
- **Total per hand: ~1-2 minutes**

---

## Disconnection Handling

### Player Disconnects Mid-Hand
- The Shamir secret sharing scheme allows card reveals without the disconnected player
- M-of-N threshold means a minority disconnecting doesn't block the game
- Disconnected player treated as all-in for current pot at time of disconnect
- Hand continues to showdown with remaining players
- Disconnected player can still win their portion if they have the best hand

### Dealer Disconnects
- Game state is on-chain — another dealer can pick up from last state
- Or hand is voided, deposits refunded

### Cashier Node Disconnects
- M_C-of-N_C means a minority of cashier nodes going offline doesn't prevent settlement
- Remaining nodes can still verify and sign

---

## Chain Reorg Handling

If a blockchain reorg is detected (block height decreases):
1. Freeze betting — no more actions accepted
2. All active players treated as all-in for current pot
3. Deal remaining community cards
4. Evaluate hands → determine winner
5. Settle with the pot as it stood before the reorg
6. Start fresh hand after reorg stabilizes

---

## Costs

### Per Hand
| Who | Action | Cost |
|-----|--------|------|
| Dealer | ~15 identity updates | ~0.0015 CHIPS |
| Each Player | ~5 identity updates | ~0.0005 CHIPS |
| Cashier | ~3 identity updates | ~0.0003 CHIPS |

### Per 50-Hand Session (4 players)
| Item | Cost |
|------|------|
| Dealer updates | ~0.075 CHIPS |
| Player updates (4×) | ~0.10 CHIPS |
| Cashier updates | ~0.015 CHIPS |
| **Total TX fees** | **~0.19 CHIPS** |

Paid from rake (dealer + cashier commission covers their TX fees).
Players need ~0.025 CHIPS beyond buy-in for their TX fees per 50 hands.

---

## Comparison with Original Implementation

| Feature | Original C Code | This Protocol |
|---------|----------------|---------------|
| Crypto | sg777 curve25519 field multiply | Same + player-specific e_i factor |
| Collusion resistance | Dealer+Cashier can collude | Requires all 3 parties to collude |
| Card reveal | Cashier reveals directly or P2P Shamir | Shamir SSS via Verus IDs |
| Communication | Verus ID contentmultimap (~10s) | Same (v2: ~1s via mempool) |
| Settlement | Per-hand, cashier multisig | Per-hand, cashier multisig + verification |
| Verification | None (trust during play) | Full-trace replay by committee |
| Cheating penalty | None | Stake slashing |
| Staking | None | Required V_stake from all parties |
| Audit trail | Partial (contentmultimap overwritten) | Full (VDXF keys permanently indexed) |
| Max players | 2 (14-card deck) | 9 (52-card deck) |

---

## Implementation Status

### Core Protocol (JavaScript, zero dependencies)
- `mental-poker.mjs` — sg777 field multiply protocol, JS BigInt (32 tests pass). **Confirmed identical to C fmul_donna by dev.**
- `mental-poker-sra.mjs` — SRA alternative (14 tests pass, kept as option)
- `protocol.mjs` — Paper's Algorithm 2,3,4: playerInit, dealerShuffle (with e_i), cashierShuffle (with SSS), decodeCard, verifyGame (10 tests pass)
- `poker-crypto.c` — Standalone C crypto for WASM (969 lines, 7 tests pass)
- `provably-fair.mjs` — Seed commit/reveal/verify (14 tests pass)

### Game Logic
- `game.mjs` — Game state machine: blinds, betting, side pots, settlement (26 tests pass)
- `hand-eval.mjs` — Texas Hold'em hand evaluator (all rankings)
- `poker-engine.mjs` — Game orchestrator tying crypto + game + IO (7 tests pass)
- `session.mjs` — Multi-hand session manager (10 tests pass)

### Server & UI
- `poker-server.mjs` — WebSocket server with full game protocol, seat management, name-based matching
- `public/poker.html` — Vanilla HTML/JS poker client, PokerStars-style layout, SVG card sprites
- Multiview page supporting 2/6/9 player tables

### Chain Integration
- `verus-rpc.mjs` — Verus daemon RPC client (5 live tests pass)
- `chain-game.mjs` — On-chain game with identity updates per protocol phase
- `escrow.mjs` — 2-of-2 multisig escrow from cashier nodes
- `cashier-node.mjs` — Cashier node with processShuffle, verifyHand, watch
- `full-game.mjs` — Complete end-to-end: deposit → play 10 hands → verify → settle (confirmed on CHIPS chain)

### Tests
- `test-stress.mjs` — 23 tests: chip conservation across 2/3/4/6/9 players, side pots, blind posting, dealer rotation
- `test-e2e.mjs` — 15 E2E tests: join flow, check-check advancement, fold wins, all-in, timeouts, reload/sitin, multi-hand
- 7 scenario tests passing: 6P check-call, 5-fold-to-BB, 1-raiser-5-callers, 2-allin-4-fold, 6P-random, heads-up-check, heads-up-allin

### Next Steps
- Wire real sg777 crypto into poker-server.mjs (replace mock shuffle with protocol.mjs)
- contentmultimap communication layer (replacing WebSocket for on-chain play)
- WASM compilation of xoverz_donna for browser-side keypair generation
- V_stake staking mechanism
- UTXO chaining for mempool-speed ordering (v2)
