# Verus Poker

Decentralized mental-poker on the CHIPS PBaaS chain. Implements the BCRA 2026 mental-poker shuffle protocol on top of Verus identities, with the chain itself acting as the consensus layer for game state.

There is no central poker server. All game messages — player actions, deck shuffles, betting state, settlement — flow through Verus identity content-multimap updates. Anyone running a CHIPS daemon can host a table or join one.

---

## How it works

### Roles

- **Dealer (DCV)** — *Dealer / Computer / Verifier*. Pure orchestrator: deals cards, advances betting rounds, validates the cryptographic proofs at the end of each hand. The dealer never plays in the hand and never sees private cards before showdown.
- **Players** — Each player runs their own backend that owns a Verus identity. They submit actions (call/raise/fold/all-in) by writing to their own identity on chain.
- **Cashier** — Independent process that performs the *Stage III* shuffle (final blinding) and reveals card blinding values when asked. The cashier holds the blinding factors so it can produce reveals on demand without seeing the underlying card values.

These three roles can run on separate machines, separate networks, even separate jurisdictions. They communicate **only** through CHIPS chain identity updates.

### Crypto protocol (summary)

Based on the BCRA 2026 paper. Three-stage shuffle:

1. **Player init** — Each player generates random nonces and scalars for every card.
2. **Dealer shuffle** — Dealer applies a permutation + first blinding pass to each player's deck.
3. **Cashier shuffle** — Cashier applies a second permutation + second blinding pass. The final deck is committed via a hash.

To reveal a card:
- Dealer asks cashier for the blinding values at specific deck positions.
- Cashier returns the values without learning what cards they decode to.
- Dealer combines the player's blinding (from on-chain commit) with the cashier's blinding to recover the card index.

At hand end the dealer publishes the full proof (all blindings + permutations) so any observer can verify the hand was honest.

### Optimizations

- **11-card slice** — Texas Hold'em uses at most `2N + 5` cards. The dealer slices each player's blinded deck to that size before sending it to the cashier, cutting bandwidth ~5×.
- **Batched chain writes** — Initial dealer state (table info, hole cards, blinds, opening BS) goes in one `updateidentity` TX. Cashier output (meta + per-player decks) also batched.
- **Mempool-aware reads** — `getidentitycontent` with `heightend=-1` reads pending TXs from mempool before they're mined. Average read latency: 4-9 seconds across un-peered daemons.
- **Per-identity write mutex** — Prevents UTXO chain races when multiple writes target the same identity in parallel.

Result: ~25 second hand setup (was ~70 seconds), ~2-8 second action latency.

---

## Prerequisites

- A running **Verus daemon** with the CHIPS PBaaS chain enabled
- One **VerusID per role** (dealer/player/cashier), funded with a small amount of CHIPS for TX fees
- Node.js 18+ (uses ES modules)
- The wallet must control the private key for whichever identity each process represents

To find the CHIPS chain conf, the code checks:
- `~/.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf`
- `~/.komodo/CHIPS/CHIPS.conf`

If your chain config is elsewhere, edit the `findRPC()` function in `poker-server.mjs`, `cashier-runner.mjs` and `gui-server.mjs`.

---

## Setup

```bash
git clone https://github.com/Fried333/verus-poker
cd verus-poker
npm install
```

You also need to register the VerusIDs you'll use. On each machine that will run a process, the local Verus wallet must control the matching identity. Example identities used in development:

| Identity | Role |
|---|---|
| `ptable2.CHIPS@` | The poker table (dealer writes to this) |
| `pdealer2.CHIPS@`, `pplayer2.CHIPS@`, `pc-player.CHIPS@` | Players |
| `cashier1.CHIPS@` | Cashier |

Substitute your own identity names everywhere below.

---

## Running a table

A full game requires three processes (or more, depending on how many players you want):

### 1. Dealer

```bash
node poker-server.mjs --local --role=dealer \
  --table=ptable2 \
  --players=pplayer2,pdealer2,pc-player \
  --cashiers=cashier1 \
  --port=3000
```

Flags:
- `--local` — use the local CHIPS daemon for chain RPC
- `--role=dealer` — run as dealer (DCV), no betting participation
- `--table=<id>` — VerusID of the poker table
- `--players=<csv>` — pre-known player identities (auto-joined when seen on chain)
- `--cashiers=<csv>` — cashier identities the dealer should request shuffles from
- `--port=3000` — HTTP/WS port

The dealer writes a `t_table_info` record to the table identity, opens a session, and waits for joins.

### 2. Cashier

```bash
node cashier-runner.mjs --id=cashier1 --table=ptable2
```

Polls the table identity for shuffle requests, runs Stage III, writes the result back, and serves card-reveal blindings on demand. Persists in-flight state to disk in `~/.verus-poker/cashier-<id>-<table>/` so it can recover from crashes mid-hand.

### 3. Player GUI

Each player runs their own GUI server, owning their own identity:

```bash
# Player 1
node gui-server.mjs --id=pplayer2 --table=ptable2 --port=3001

# Player 2 (different machine, different daemon, different identity)
node gui-server.mjs --id=pdealer2 --table=ptable2 --port=3001

# Player 3
node gui-server.mjs --id=pc-player --table=ptable2 --port=3000
```

Then open the URL printed by each GUI server in a browser. Click an empty seat to sit in, the dealer will pick up the join from chain and start a hand once it has enough players.

### Convenience start scripts

`start-cashier.sh`, `start-pdealer2.sh`, `start-gui-28.sh`, `start-all.sh` are shell wrappers around the above commands for the dev setup. Adjust them for your own identity names and SSH targets.

---

## Playing

The GUI is a single-page felt-style interface. The current player's UI shows:

- The table with all seated players
- Your hole cards
- The community board
- Action buttons (fold / check / call / bet / raise / all-in) when it's your turn
- Countdown timer (default 60s for player display, 90s dealer hard timeout)
- Action log with last 10 events
- Sit Out / Sit In toggle

Between hands you can sit out without leaving the table. After several consecutive timeouts the dealer will auto-kick a sat-out player; they can sit back in any time by clicking the seat.

---

## Test scripts

A handful of utilities for benchmarking and reliability testing:

### Mempool propagation

```bash
# Single-daemon round trip
node test-mempool-read.mjs --id=cashier1

# Cross-daemon (run write on one host, read on another)
node test-mempool-cross.mjs --mode=write --id=pc-player
# copy the printed nonce, then on another host:
node test-mempool-cross.mjs --mode=read --id=pc-player --nonce=<nonce>

# Full 3-host matrix (writer × reader for all 6 directions)
./run-mempool-matrix.sh
```

These were used to characterise CHIPS mempool propagation under fully un-peered conditions. Typical end-to-end latency: 4-9 seconds. Long tail driven by chain block-stall events, not by P2P propagation.

### Crash recovery

```bash
node verify-persist.mjs           # round-trip persisted cashier state
node test-persist-roundtrip.mjs   # BigInt-safe JSON
node test-recovered-reveal.mjs    # reveal cards using persisted b[]
./timed-crash-test.sh             # kill cashier mid-hand, verify recovery
```

### Reliability runs

```bash
./test-cashier-reliability.sh     # repeat cashier shuffles, count failures
./watch-10-hands.sh               # play 10 hands and check chip totals
```

---

## Architecture overview

```
┌───────────┐         ┌─────────────┐         ┌──────────┐
│  Player 1 │         │             │         │  Player 2│
│  gui-srv  │◄────┐   │  ptable2    │   ┌────►│  gui-srv │
│           │     │   │  (VerusID)  │   │     │          │
└───────────┘     │   │             │   │     └──────────┘
                  │   │  - t_table_info │
┌───────────┐     │   │  - card_bv.*    │     ┌──────────┐
│  Player 3 │     ├──►│  - betting_state│◄──┤ │  Dealer  │
│  gui-srv  │◄────┤   │  - settlement   │   │ │ poker-srv│
└───────────┘     │   │  - shuffle_req  │   │ │          │
                  │   └─────────────┘   │   │ └──────────┘
                  │                     │   │
                  │   ┌─────────────┐   │   │
                  └───┤  cashier1   ├───┘   │
                      │ (VerusID)   │       │
                      │             │       │
                      │ - shuffle   │◄──────┘
                      │   results   │
                      └─────────────┘

Each box runs on its own machine with its own
CHIPS daemon. Communication is via on-chain
identity content-multimap updates only.
```

### Key files

| File | Purpose |
|---|---|
| `protocol.mjs` | BCRA mental-poker shuffle, blind, reveal, verify |
| `mental-poker.mjs` | curve25519 field math for the crypto |
| `game.mjs` | Texas Hold'em game state (pots, side pots, betting) |
| `hand-eval.mjs` | 5-card hand evaluator |
| `p2p-layer.mjs` | Verus identity read/write helpers, per-identity mutex |
| `p2p-dealer.mjs` | Dealer logic — orchestrates shuffles, betting rounds, settlement |
| `player-backend.mjs` | Player logic — polls chain for state, submits actions |
| `cashier-runner.mjs` | Cashier daemon — Stage III shuffles + reveal blindings |
| `poker-server.mjs` | Top-level dealer process, HTTP/WS for browser |
| `gui-server.mjs` | Top-level player process, HTTP/WS for browser |
| `public/poker-gui.html` | The poker table UI |

---

## Known characteristics of CHIPS for game design

The CHIPS chain is hybrid PoW + PoS (Verus PoP) but currently runs at ~76% of nominal block rate, with one PoW miner producing ~87% of work blocks and a small staker pool. This means:

- **Average action round-trip**: 4-9 seconds via mempool reads (no waiting for confirmation)
- **Block intervals**: ~13s mean, but P99 is 50+ seconds
- **Multi-minute stalls** happen roughly once every ~80 minutes, when both PoW and PoS go quiet at the same time

The dealer's hard timeout should be set well above the chain's worst-case stall (current default: 90s; recommended: 180-240s). Player display timer is independent of dealer timeout.

---

## License

MIT
