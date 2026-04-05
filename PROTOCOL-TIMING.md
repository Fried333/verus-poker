# Protocol Timing Analysis

## End-to-End Hand Lifecycle

Based on testing with 3 players across 3 servers (.28 dealer, .59 cashier, local player).
All times measured from 20-hand cashier reliability test (19/20 pass, zero artificial delays).

---

## Stage I+II: Player Init + Dealer Shuffle (LOCAL)

**Time: ~5ms**

```
Player 1 → playerInit(52 cards) → blinded deck (52 BigInts)
Player 2 → playerInit(52 cards) → blinded deck (52 BigInts)
Dealer   → dealerShuffle(player decks) → blindedDecks + e[] + d
```

- Pure JS computation, no chain I/O
- Uses curve25519 field multiply (fmul_donna)
- Each player deck: 52 × 32-byte field elements
- Dealer generates per-player blinding factors e_i
- Result: `dd.blindedDecks[numPlayers][52]` — ready for cashier

**Data sizes:**
- Per-player blinded deck: 52 BigInts → ~3.5KB JSON → ~7KB hex
- Dealer blinding factors: ~256 bytes per player

---

## Stage III: Cashier Shuffle (ON-CHAIN ROUND-TRIP)

**Time: ~23s total (12ms compute, rest is chain I/O)**

### Step 1: Dealer writes shuffle request to table identity

**Time: ~7s (5 sequential TXs)**

```
TX 1: t_shuffle_request (base key)     — 120 bytes — handId, numPlayers, numCards, threshold
TX 2: t_shuffle_request.{handId}       — 120 bytes — per-hand key (prevents overwrite)
TX 3: t_table_info                     — 200 bytes — currentHandId for cashier fallback
TX 4: t_shuffle_deck.{handId}.p0       — 3.5KB     — player 0 blinded deck
TX 5: t_shuffle_deck.{handId}.p1       — 3.5KB     — player 1 blinded deck
```

- Each TX requires previous TX's UTXO to be spendable (~1-2s per TX)
- `writeToIdentity` resolves VDXF key, builds updateidentity, broadcasts
- UTXO conflicts handled with 5 retries + increasing delays
- For N players: 3 + N TXs

### Step 2: Cashier reads decks from table identity

**Time: ~1-2s**

```
Cashier polls t_shuffle_request every 1s
→ Detects new handId
→ Reads t_shuffle_deck.{handId}.p0 (retry up to 50s for cross-node propagation)
→ Reads t_shuffle_deck.{handId}.p1
```

- Uses `getidentitycontent` with `heightend=-1` (includes mempool)
- Cross-node propagation: 0.5-2s from .28 mempool to .59 node
- Stale requests (>60s old) are skipped

### Step 3: Cashier computes Stage III

**Time: ~12ms**

```
cashierShuffle(blindedDecks, numPlayers=2, numCards=52, threshold=2)
→ Generate cashier permutation (sigma_Cashier)
→ Apply permutation to each player's deck
→ Blind each card with unique b_ij values
→ Split b_ij into Shamir secret shares
→ Compute commitment hash
```

- Pure JS computation
- Result: finalDecks[2][52], b[2][52], sigma_Cashier[52], commitment

### Step 4: Cashier writes results to own identity

**Time: ~8s (5 sequential TXs)**

```
TX 1: c_shuffle_result.{handId}           — 250 bytes — meta: sigma, commitment, numPlayers
TX 2: c_shuffle_result.{handId}.deck.0    — 3.5KB     — player 0 final deck
TX 3: c_shuffle_result.{handId}.b.0       — 3.5KB     — player 0 blinding values
TX 4: c_shuffle_result.{handId}.deck.1    — 3.5KB     — player 1 final deck
TX 5: c_shuffle_result.{handId}.b.1       — 3.5KB     — player 1 blinding values
```

- Same UTXO sequential write pattern as dealer
- For N players: 1 + 2N TXs

### Step 5: Dealer reads cashier results

**Time: ~10s**

```
Dealer polls c_shuffle_result.{handId} on cashier identity every 0.5s
→ Detects meta key (sigma + commitment)
→ Reads deck.0, b.0, deck.1, b.1 (retry up to 50s for propagation)
```

- Cross-node propagation from .59 to .28: 0.5-10s
- Retry polling adds latency (each retry = 500ms)
- BigInt deserialization: hex string → BigInt (verified working)

---

## Card Dealing + Betting (EXISTING FLOW)

**Time: ~15-30s per hand (depends on player action speed)**

### Deal hole cards

```
decodeCard(finalDeck[pos], b[pos], e_i, d, sessionKey, initialDeck) → card index
cardToString(index) → "Ah", "Ks", etc.
```

- 2 cards per player decoded locally
- Card reveal per player written to chain: ~100 bytes each
- Blinds betting state written: ~500 bytes

### Betting rounds (preflop → flop → turn → river)

```
Per action:
  Dealer writes BS to table (turn, validActions, pot, players) — ~500 bytes
  Player reads BS, shows action buttons
  Player writes action to own identity — ~100 bytes
  Dealer reads player action, updates game state
```

- ~2-5s per player action (write + cross-node read)
- 3 players × 4 streets × 1-2 actions each = 12-24 actions per full hand
- Player timeout: 30s (sit out after 1 timeout)

### Settlement

```
Dealer writes settlement to table: winners, payouts, allHoleCards, bestHands, board
  → ~500 bytes
Players read settlement, update chips, show winner banner
```

---

## Total Hand Time

| Scenario | Time | Notes |
|----------|------|-------|
| With cashier, fast fold | ~25s | Cashier 23s + fold 2s |
| With cashier, full hand | ~45-60s | Cashier 23s + 4 streets betting |
| Without cashier (local Stage III) | ~15-30s | No chain round-trip for shuffle |
| Cashier compute only | 12ms | Everything else is chain I/O |

---

## TX Count Per Hand

| Who | What | TXs | Size |
|-----|------|-----|------|
| Dealer | Shuffle request | 5 | ~10KB |
| Cashier | Shuffle result | 5 | ~18KB |
| Dealer | Card reveals (2 players) | 1 batch | ~200 bytes |
| Dealer | Blinds BS | 1 | ~500 bytes |
| Dealer | Per-action BS | 4-12 | ~500 bytes each |
| Players | Actions | 4-12 | ~100 bytes each |
| Dealer | Board cards | 1-3 | ~200 bytes each |
| Dealer | Settlement | 1 | ~500 bytes |
| **Total** | | **~20-40 TXs** | **~35KB** |

---

## Bottlenecks Identified

### 1. UTXO Sequential Writes (~70% of time)
Each `updateidentity` TX requires the previous TX's output to be spendable.
This creates a sequential bottleneck: 5 TXs × ~1.5s UTXO wait = ~7.5s.
**Cannot be parallelized** — each TX spends the identity's UTXO.

### 2. Cross-Node Propagation (~25% of time)
Mempool data takes 0.5-10s to propagate between .28 and .59.
`getidentitycontent` with `heightend=-1` reads from mempool but cross-node.
**Varies** — same-node reads are instant, cross-node adds latency.

### 3. Retry Polling (~5% of time)
When data hasn't propagated yet, the reader polls every 500ms.
Multiple retries add up: 10 retries × 500ms = 5s.

### 4. Data Size
Per-player deck: 52 BigInts → 3.5KB JSON → 7KB hex on chain.
VDXF contentmultimap limit: ~5KB per key (7KB hex is right at the edge).
Batch writes of 2+ decks exceed the limit → must use separate TXs.

---

## Optimization Opportunities

### A. Reduce TX Count
- Batch the 3 small dealer writes (request + per-hand + table_config) into 1 TX: saves ~3s
- Batch cashier meta + first deck/b pair: saves ~1.5s
- **Potential saving: ~4.5s per hand**

### B. Compress Data
- BigInt hex encoding is wasteful: "0x1a2b3c..." → 70 chars per 32-byte value
- Base64 encoding: 44 chars per 32 bytes (37% smaller)
- Binary/Buffer encoding: 32 bytes raw (78% smaller)
- Smaller data → might fit 2 decks in one TX batch
- **Potential saving: ~3s from fewer TXs**

### C. Pre-compute Next Hand
- While players bet on hand N, dealer + cashier prepare hand N+1's shuffle
- Overlaps 23s cashier time with 30-60s player betting time
- **Potential saving: 23s fully hidden behind betting**

### D. Hybrid WebSocket + Chain
- Shuffle data exchanged via WebSocket (instant, ~7KB + 14KB)
- Only commitment hashes written to chain (2 TXs × 32 bytes)
- Full data written to chain post-hand for audit trail
- **Potential saving: 23s → ~4s**

### E. Same-Node Optimization
- If cashier runs on same server as dealer: no cross-node delay
- Reads are instant (same mempool)
- **Potential saving: ~10s from eliminated propagation delay**

---

## Test Results Summary

| Test | Hands | Pass | Avg Time | Notes |
|------|-------|------|----------|-------|
| Cashier standalone (no delay) | 20 | 19/20 | 23s | Last hand race condition |
| Cashier standalone (10s delay) | 20 | 20/20 | 29s | Delay hides write overlap |
| GUI 3-player (no cashier) | 190 | 190/190 | ~15s | Local Stage III |
| GUI 3-player (with cashier) | 5 | 4/5 | ~35s | First hand slow from startup |

---

## Architecture

```
LOCAL PC (.this)                    .28 SERVER                     .59 SERVER
┌─────────────────┐    ┌──────────────────────┐    ┌─────────────────────┐
│ gui-server.mjs  │    │ poker-server.mjs     │    │ gui-server.mjs      │
│ (pc-player)     │    │ (dealer + pplayer2)   │    │ (pdealer2)          │
│ port 3000       │    │ ports 3000 + 3001     │    │ port 3001           │
│                 │    │                      │    │ (nginx: verus.cx/   │
│ player-backend  │    │ p2p-dealer.mjs       │    │  poker/)            │
│ ↕ chain poll    │    │ ↕ chain write        │    │                     │
└────────┬────────┘    └──────────┬───────────┘    │ cashier-runner.mjs  │
         │                       │                 │ (cashier1)          │
         │         CHIPS BLOCKCHAIN                │ ↕ chain read/write  │
         └───────────────┴───────────────┐         └──────────┬──────────┘
                                         │                    │
                    ┌────────────────────┴────────────────────┘
                    │          CHIPS PBaaS Chain
                    │   ┌─────────────────────────────┐
                    │   │ ptable2 (table identity)     │
                    │   │   t_shuffle_request           │
                    │   │   t_shuffle_deck.{hand}.p0    │
                    │   │   t_betting_state.{hand}.s0   │
                    │   │   t_settlement_info.{hand}    │
                    │   ├─────────────────────────────┤
                    │   │ cashier1 (cashier identity)   │
                    │   │   c_shuffle_result.{hand}     │
                    │   │   c_shuffle_result.{hand}.d.0 │
                    │   ├─────────────────────────────┤
                    │   │ pc-player (player identity)   │
                    │   │   p_join_request              │
                    │   │   p_betting_action            │
                    │   ├─────────────────────────────┤
                    │   │ pplayer2, pdealer2 (players)  │
                    │   └─────────────────────────────┘
                    │
```
