# Verus Poker

Decentralized mental-poker on the CHIPS PBaaS chain. Implements the BCRA 2026 mental-poker shuffle protocol on top of Verus identities, with the chain itself acting as the consensus layer for game state. **No central poker server.** All game messages — player actions, deck shuffles, betting state, settlement — flow through Verus identity content-multimap updates. Anyone running a CHIPS daemon can host a table or join one.

## Table of contents

- [What you get](#what-you-get)
- [What you provide](#what-you-provide)
- [How it works](#how-it-works)
  - [Roles](#roles)
  - [Crypto protocol](#crypto-protocol-summary)
  - [Optimizations](#optimizations)
- [Quick start](#quick-start)
  - [Creating the VerusIDs](#creating-the-verusids-youll-need)
  - [Running a table](#running-a-table)
- [Architecture overview](#architecture-overview)
- [CHIPS chain characteristics](#known-characteristics-of-chips-for-game-design)
- [Test scripts](#test-scripts)
- [Operating in production](#operating-in-production)
- [License](#license)
- [Disclaimer](#disclaimer)

## What you get

- A fully decentralized Texas Hold'em poker table — no central server, no operator who can see hole cards
- Cryptographic shuffle proof — at hand-end, the dealer publishes all blindings + permutations; any observer can verify the hand was honest
- Identity-based seats — each player owns their own VerusID and controls their own actions
- Multi-machine, multi-jurisdiction by design — dealer/cashier/players can be on separate boxes anywhere in the world
- One-block read latency for actions (~4-9 s end-to-end) via mempool-aware reads

## What you provide

- A running **Verus daemon** with the CHIPS PBaaS chain enabled
- One **VerusID per role** (dealer / player / cashier), funded with a small amount of CHIPS for TX fees
- **Node.js 18+** (uses ES modules)
- Each daemon controls the private key for the identity its process represents
- A modest amount of patience for CHIPS chain stalls (see [chain characteristics](#known-characteristics-of-chips-for-game-design))

## How it works

### Roles

- **Dealer (DCV)** — *Dealer / Computer / Verifier*. Pure orchestrator: deals cards, advances betting rounds, validates the cryptographic proofs at hand-end. The dealer **never plays** and **never sees private cards before showdown**.
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

At hand-end the dealer publishes the full proof (all blindings + permutations) so any observer can verify the hand was honest.

### Optimizations

- **11-card slice** — Texas Hold'em uses at most `2N + 5` cards. The dealer slices each player's blinded deck to that size before sending it to the cashier, cutting bandwidth ~5×.
- **Batched chain writes** — Initial dealer state (table info, hole cards, blinds, opening BS) goes in one `updateidentity` TX. Cashier output (meta + per-player decks) also batched.
- **Mempool-aware reads** — `getidentitycontent` with `heightend=-1` reads pending TXs from mempool before they're mined. Average read latency: 4-9 seconds across un-peered daemons.
- **Per-identity write mutex** — Prevents UTXO chain races when multiple writes target the same identity in parallel.

Result: ~25 second hand setup (was ~70 seconds), ~2-8 second action latency.

## Quick start

```bash
git clone https://github.com/Fried333/verus-poker
cd verus-poker
npm install
```

CHIPS chain config — the code checks (in order):
- `~/.verus/pbaas/f315367528394674d45277e369629605a1c3ce9f/f315367528394674d45277e369629605a1c3ce9f.conf`
- `~/.komodo/CHIPS/CHIPS.conf`

If your chain config is elsewhere, edit the `findRPC()` function in `poker-server.mjs`, `cashier-runner.mjs`, and `gui-server.mjs`.

### Creating the VerusIDs you'll need

Every role in the game needs its own VerusID on the CHIPS chain:

| Role | What it does | Where the wallet must live |
|---|---|---|
| **Table** | Holds public game state (table info, hands, betting state, settlement) | Dealer machine |
| **Dealer** | Owns the table, orchestrates hands. *(In some setups the dealer does not need its own player identity.)* | Dealer machine |
| **Cashier** | Performs final shuffle stage and serves card reveals | Cashier machine |
| **Player** (one per seat) | Submits actions (call/raise/fold) to its own identity | That player's machine |

A VerusID can only be updated by the wallet holding its primary spending key. So whichever machine will be writing to a given identity must be the one that registers it (or you must transfer it there).

**Step 1 — Get a CHIPS wallet address with funds**

```bash
# On each machine
verus -chain=CHIPS getnewaddress
# Send a small amount of CHIPS to this address (a few coins is enough for many hands)
```

**Step 2 — Register an identity**

```bash
verus -chain=CHIPS registeridentity '{
  "name": "myplayer1",
  "primaryaddresses": ["<your CHIPS R-address from step 1>"],
  "minimumsignatures": 1,
  "privateaddress": ""
}' 100
```

The trailing `100` is a fee paid in CHIPS. Wait one block, then verify:

```bash
verus -chain=CHIPS getidentity myplayer1.CHIPS@
```

Repeat on each machine for each role you need. For a 3-player table running on three different boxes you'd register:

- `mytable.CHIPS@` on the dealer machine
- `mycashier.CHIPS@` on the cashier machine
- `myplayer1.CHIPS@`, `myplayer2.CHIPS@`, `myplayer3.CHIPS@` — one per player machine

Substitute these names everywhere `--id`, `--table`, `--players`, or `--cashiers` appears in the commands below.

> **Recovery / backup**: VerusIDs are controlled by their primary signing keys. If you lose the wallet that registered an identity, you lose the ability to update it — unless you set a separate **revocation/recovery authority** at registration time (an existing identity that can revoke or recover yours). For test play this isn't critical; for serious use, always set a recovery identity and `backupwallet` after registration. Restoring `wallet.dat` to a fresh daemon restores full control.

### Running a table

A full game requires three processes (or more, depending on how many players you want):

**1. Dealer**

```bash
node poker-server.mjs --local --role=dealer \
  --table=mytable \
  --players=myplayer1,myplayer2,myplayer3 \
  --cashiers=mycashier \
  --port=3000
```

| Flag | What |
|---|---|
| `--local` | Use the local CHIPS daemon for chain RPC |
| `--role=dealer` | Run as dealer (DCV), no betting participation |
| `--table=<id>` | VerusID of the poker table |
| `--players=<csv>` | Pre-known player identities (auto-joined when seen on chain) |
| `--cashiers=<csv>` | Cashier identities the dealer requests shuffles from |
| `--port=3000` | HTTP/WS port |

The dealer writes a `t_table_info` record to the table identity, opens a session, and waits for joins.

**2. Cashier**

```bash
node cashier-runner.mjs --id=mycashier --table=mytable
```

Polls the table identity for shuffle requests, runs Stage III, writes the result back, and serves card-reveal blindings on demand. Persists in-flight state to disk in `~/.verus-poker/cashier-<id>-<table>/` so it can recover from crashes mid-hand.

**3. Player GUI** (one per player)

```bash
node gui-server.mjs --id=myplayer1 --table=mytable --port=3001
# … and on the other player machines with --id=myplayer2 etc.
```

Open the URL printed by each GUI server in a browser. Click an empty seat to sit in; the dealer picks up the join from chain and starts a hand once it has enough players.

**Convenience start scripts** — `start-cashier.sh`, `start-pdealer2.sh`, `start-gui-28.sh`, `start-all.sh` wrap the above commands for the dev setup. Adjust them for your own identity names and SSH targets.

### Playing

The GUI is a single-page felt-style interface. The current player's UI shows:

- The table with all seated players
- Your hole cards
- The community board
- Action buttons (fold / check / call / bet / raise / all-in) when it's your turn
- Countdown timer (default 60s for player display, 90s dealer hard timeout)
- Action log with last 10 events
- Sit Out / Sit In toggle

Between hands you can sit out without leaving the table. After several consecutive timeouts the dealer will auto-kick a sat-out player; they can sit back in any time by clicking the seat.

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

Each box runs on its own machine with its own CHIPS daemon.
Communication is via on-chain identity content-multimap updates only.
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

## Known characteristics of CHIPS for game design

The CHIPS chain is hybrid PoW + PoS (Verus PoP) but currently runs at ~76% of nominal block rate, with one PoW miner producing ~87% of work blocks and a small staker pool. This means:

- **Average action round-trip**: 4-9 seconds via mempool reads (no waiting for confirmation)
- **Block intervals**: ~13s mean, but P99 is 50+ seconds
- **Multi-minute stalls** happen roughly once every ~80 minutes, when both PoW and PoS go quiet at the same time

The dealer's hard timeout should be set well above the chain's worst-case stall (current default: 90s; recommended: 180-240s). Player display timer is independent of dealer timeout.

## Test scripts

A handful of utilities for benchmarking + reliability testing:

### Mempool propagation

```bash
node test-mempool-read.mjs --id=mycashier                            # single-daemon round trip

# Cross-daemon — run write on one host, read on another
node test-mempool-cross.mjs --mode=write --id=myplayer1
# (copy the printed nonce, then on another host:)
node test-mempool-cross.mjs --mode=read --id=myplayer1 --nonce=<n>

./run-mempool-matrix.sh                                              # 3-host matrix (edit hosts at top)
```

Used to characterise CHIPS mempool propagation under fully un-peered conditions. Typical end-to-end latency: 4-9 s. Long tail driven by chain block-stall events, not by P2P propagation.

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

## Operating in production

### Logs

Each process logs to stdout. Run under `systemd` or `tmux` per role:
```bash
journalctl -u verus-poker-dealer -f
journalctl -u verus-poker-cashier -f
```

### Common errors

| Symptom | Likely cause | Fix |
|---|---|---|
| `findRPC failed` | CHIPS conf in non-standard location | Edit `findRPC()` in the affected `*.mjs` file |
| Dealer waiting indefinitely for cashier | Cashier process not running or wrong `--table` | Check cashier logs; ensure `--table` matches dealer's |
| `wallet does not contain valid signing keys for <id>@` | Identity's primary R-address WIF not in the daemon's wallet | `verus -chain=CHIPS importprivkey "<wif>" "" false` |
| Players stuck at "waiting for hand to start" | Dealer hasn't seen the join; chain stall | Wait — usually recovers within 1-2 blocks |
| Cashier in `~/.verus-poker/.../` has stale state | Killed mid-hand and never resumed cleanly | Delete the cashier state dir before next start; new hand will reinit |
| `nLockTime`-related signing failures | Daemon clock skewed | `chronyc tracking` or `timedatectl status` on the affected box |

### Backup considerations

- **`wallet.dat`** on every daemon — losing it = losing identity control (unless revoke/recovery is set on the identity). Back up wallet.dat per-machine.
- **`~/.verus-poker/cashier-<id>-<table>/`** on the cashier machine — contains in-flight shuffle state. Safe to delete between hands; **must NOT** be deleted mid-hand or the hand is unrecoverable (players can't reveal cards).
- **No central audit log** — every hand's full proof is written to the table VerusID's content-multimap and is recoverable from chain.

### Upgrading

```bash
cd verus-poker
git pull
npm install        # if deps changed
# Restart dealer/cashier/players (in any order; new hand picks up new code)
```

No on-chain schema migrations — the protocol is fixed by the code that signs hand proofs. Mixing versions across roles will fail at proof-verify time, so coordinate restarts during a sit-out.

## License

MIT — see [LICENSE](./LICENSE) if present, or the standard MIT terms.

## Disclaimer

This software is provided **"AS IS"**, without warranty of any kind, express or implied. In no event shall the authors or copyright holders be liable for any claim, damages, or other liability arising from the use of this software.

Mental-poker cryptography is subtle and the implementation has not undergone an independent audit. The shuffle proof published at hand-end is verifiable by any observer, but **do not play this for funds you can't afford to lose** until you've satisfied yourself with the cryptographic implementation. Treat this as a working reference for the BCRA mental-poker pattern on Verus, not a production gambling platform.

Stakes-play also exposes you to **off-chain coercion and collusion risks** that no protocol can solve — two players whispering on the same Discord channel can sandwich the rest of the table. Run with people whose game integrity you trust, or only at amounts where collusion isn't worth the effort.
