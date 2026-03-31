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
| Primitive | Role |
|-----------|------|
| Curve25519 scalar multiplication | Hides scalars p_i, d, e_i, b_ij in blinding |
| Shamir Secret Sharing (SSS) | Distributes b_ij shares, ensures threshold security |
| SHA-256 Hash | Binds secrets in commitments, prevents tampering |
| ECIES | Encrypts SSS shares for secure distribution |
| M_C-of-N_C Multisig | Secures all funds in escrow, gates settlement |

### Three-Stage Shuffle and Blind

**Why 3 parties?**
- 2-party (SRA) fails if any player disconnects — deck is permanently locked
- 3-party with SSS allows card reveals even if a minority of players disconnect
- Player-specific blinding factor (e_i) prevents Dealer+Cashier collusion
- Requires Player+Dealer+Cashier collusion to cheat (all 3 parties)

**Stage I — Player (P_i → Dealer):**
1. Player generates random nonce r_ik for each card k
2. Computes scalar h_ik = H(r_ik || "card_k_string")
3. Computes point P_ik = h_ik · G (public deck point)
4. Generates secret permutation σ_i
5. Permutes and blinds deck: D_1,i = {p_i · P_i,σ_i^(-1)(j) | j=1..Z}
6. Commits H(p_i || σ_i) to Verus ID
7. Sends (D_1,i, P_i) to Dealer

**Stage II — Dealer (Dealer → Cashier):**
8. Receives all player decks, verifies senders
9. Generates global scalar d, global permutation σ_Dealer
10. For each player i: generates secret player-specific scalar e_i
11. Permutes: D'_1,i = {D_1,i[σ_Dealer(j)] | j=1..Z}
12. Blinds with d: D''_1,i = {d · P' | P' ∈ D'_1,i}
13. Blinds with e_i: D_2,i = {e_i · P'' | P'' ∈ D''_1,i}
14. Commits H(d || σ_Dealer || e_1 || ... || e_N) to Verus ID
15. Publishes {E_1, ..., E_N} where E_i = e_i · G
16. Sends {D_2,1, ..., D_2,N} to Cashier committee

**Stage III — Cashier Committee (Cashier → P_i):**
17. Receives dealer-blinded decks
18. Generates global permutation σ_Cashier
19. For each player i, each card position j:
    - Generates secret blinding scalar b_ij
    - Blinds: C_ij = b_ij · D'_2,i (after permuting)
    - Computes (M,N) SSS shares {s_ijk} of b_ij
    - Encrypts s_ijk for each player P_k using ECIES
20. Commits H(σ_Cashier || {b_ij}) to Verus ID
21. Sends final deck D_3,i = {C_i1, ..., C_iZ} to each player

**Result:** Player i holds deck D_3,i where each card C_ij = (b_ij · e_i · d · p_i) · P_i,k with k = σ_i^(-1)(σ_Dealer^(-1)(σ_Cashier^(-1)(j))). No single party knows the final card-to-position mapping.

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

### Deposit
Before playing, each player sends:
- V_deposit (buy-in amount) to Cashier committee's M_C-of-N_C multisig address
- V_stake (good-behavior bond) to the same multisig
- Must retain CHIPS in wallet for TX fees (~0.025 CHIPS per 50 hands)

### Virtual Betting
During the game, bets are NOT actual transactions. A player commits a "bet" (e.g., "bet 2 CHIPS") as data to their Verus ID contentmultimap under the `poker.player.action` VDXF key.

The Dealer (and other players) validate virtual bets by checking the player's committed data against their available deposit balance held by the Cashier.

### Gated Settlement
The Cashier committee will NOT sign any settlement transaction until:
1. The game (hand) is finished
2. Post-game verification (Algorithm 4) has been completed by M_C nodes
3. Verification passed — no cheating detected

---

## Post-Game Verification and Settlement

This is the core of the protocol's security. After each hand:

### Phase 1: Secret Reveal
ALL parties MUST reveal their full secret parameters:
- Players reveal: {r_ik}, p_i, σ_i
- Dealer reveals: d, {e_i}, σ_Dealer
- Cashier reveals: {b_ij}, σ_Cashier

### Phase 2: Distributed Replay Verification
Each Cashier node independently performs full-trace replay:
1. Verify each player's nonces and initial deck D_0,i
2. Re-compute D_1,i from Algorithm Stage I — check it matches published D_1,i
3. Re-compute D_2,i from Algorithm Stage II — check it matches published D_2,i
4. Re-compute D_3,i from Algorithm Stage III — check it matches published D_3,i
5. If any check fails or any party failed to reveal secrets → VOTE_SLASH(CheaterParty)
6. If all checks pass → VOTE_PAY(Winner, Amount)

### Phase 3: Gated Settlement (Multisig)
Collect all Cashier node votes:
- If ≥ M_C nodes vote SLASH:
  - **Void Game**: discard the virtual pot
  - **Refund**: return V_deposit to all honest players
  - **Slash**: seize V_stake from the Cheater
- If ≥ M_C nodes vote PAY:
  - **Settle**: transfer V_deposit funds to Winner(s) per virtual pot
  - **Pay rake**: dealer commission + cashier commission deducted from winner's payout
  - **Return Stakes**: return V_stake to all honest parties
- If no consensus: funds locked pending manual resolution

### Why This Makes Cheating Unprofitable
A rational adversary:
- Cannot achieve M_C signatures to steal the pot (needs majority of cashier committee)
- Is guaranteed to lose V_stake if caught cheating (full replay catches everything)
- Gains zero from cheating (game is voided, deposits refunded)
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

### Built and Tested (JavaScript, zero dependencies)
- `mental-poker.mjs` — sg777 field multiply protocol (32 tests pass)
- `mental-poker-sra.mjs` — SRA alternative (14 tests pass, kept as option)
- `hand-eval.mjs` — Texas Hold'em hand evaluator
- `game.mjs` — Game state machine (26 tests pass)
- `poker-engine.mjs` — Game orchestrator (7 tests pass)
- `provably-fair.mjs` — Seed commit/reveal/verify (14 tests pass)
- `verus-rpc.mjs` — Verus daemon RPC client (5 live tests pass)
- `poker-crypto.c` — Standalone C crypto for WASM compilation (7 tests pass)
- `session.mjs` — Multi-hand session manager (10 tests pass)
- Full game simulation — 9 automated tests, 100 hands, chips conserved

### Still Needed
- Shamir secret sharing in JS (port from C gfshare.c)
- Player-specific blinding factor (e_i) implementation
- Post-game full-trace replay verification (Algorithm 4 from paper)
- Cashier committee integration (multisig, voting, slashing)
- V_stake staking mechanism
- UTXO chaining for mempool-speed ordering (v2)
- Proper contentmultimap communication layer (replacing z-memo prototype)
- Web UI for players
