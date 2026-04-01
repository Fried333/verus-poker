# P2P Poker — Issues, Solutions & Tradeoffs

## What We've Proven Works

- **Crypto protocol**: JS BigInt `fmul` identical to C `fmul_donna` (confirmed by dev)
- **3-stage shuffle**: Player → Dealer (with e_i) → Cashier (with SSS) — all verified
- **On-chain read/write**: contentmultimap reads/writes between two separate CHIPS daemons
- **Cross-daemon propagation**: TX written on node A visible on node B within ~15-20s
- **Post-hand verification**: Algorithm 4 full replay — all shuffle stages verified
- **Full pipeline**: deposit → play → verify → settle with real CHIPS (test-full-pipeline.mjs)
- **Game logic**: 23 stress tests, 15 E2E tests, 7 scenario tests pass, chips conserved

## Problems Hit

### 1. UTXO Sequential Write Bottleneck

**Problem**: Each `updateidentity` to the same ID creates a TX that spends the previous UTXO. Two writes to the same ID before the first TX propagates = UTXO conflict (`bad-txns-inputs-spent`).

**Impact**: For 2 players, one hand requires ~15 writes to `poker-table` (table config, dealer decks, cashier decks, card reveals, betting state, board cards, settlement). Each write takes ~2s (mempool propagation). Total: ~30s just for chain writes, not counting the actual game play.

**For 9 players**: ~28 writes to `poker-table` per hand = ~56s of write time.

**Current workaround**: Wait for each TX to be spendable in mempool before next write (~1-2s gap). Works but slow.

### 2. Cross-Node Propagation Delay

**Problem**: When player writes action to `pc-player` ID on their LOCAL daemon, the dealer on the REMOTE daemon needs ~15-20s to see it via `getidentitycontent`.

**Impact**: Each player action round-trip (dealer writes turn → player reads → player writes action → dealer reads) takes ~25-30s across two nodes. A hand with 8 actions = ~4 minutes.

**Same-node**: Only ~3s round-trip (test-two-nodes.mjs). The delay is purely cross-node mempool propagation.

### 3. contentmultimap Accumulation

**Problem**: `poker-table` accumulated 4,676 entries from test sessions. `getidentitycontent` with `heightstart=0` took 4.4 seconds to read.

**Fix applied**: Use `heightstart = currentBlock - 200` to only read recent data. Reads now take 25-50ms.

**Long-term concern**: Per-hand data accumulates forever. After 1000 hands, even with heightstart, the identity grows. Cashier nodes serving multiple tables would accumulate faster.

### 4. Infrastructure Overhead for Players

**Problem**: To play fully P2P, a player needs:
- Synced CHIPS daemon (27GB+ blockchain)
- Registered VerusID (costs CHIPS)
- Our poker client software
- Funds for buy-in + TX fees

**This is too much** for a casual player who just wants to play poker.

## Proposed Solutions

### Option A: Hybrid — WebSocket Play + Chain Verification (Recommended)

```
BEFORE HAND:  Dealer writes shuffle commitment hash to chain    (1 TX)
DURING HAND:  All game play via WebSocket (real-time, <1s)      (0 TX)
AFTER HAND:   Write verification proof + secrets to chain       (1 TX)
ON CASH-OUT:  Settlement from cashier multisig                  (1 TX)
ON DISPUTE:   Full replay from chain data proves fairness
```

**Pros**:
- Fast gameplay (WebSocket speed, identical to any online poker)
- Only 2-3 TXs per hand instead of 28+
- Players just need a browser + funds (no daemon needed)
- Server handles the chain interaction
- All fairness proofs still on-chain and verifiable

**Cons**:
- Players must trust the server during play (not during settlement)
- If server goes down mid-hand, the hand is lost (but funds are safe in multisig)
- Server sees all cards (it acts as dealer + cashier)

**Security model**:
- Funds are ALWAYS in cashier multisig — server can't steal them
- Shuffle commitment written BEFORE hand — server can't change it after
- Verification proof written AFTER hand — anyone can replay and verify
- If server cheats, the commitment won't match the revealed secrets → caught → slashed
- Players verify each hand's proof client-side after it completes

**What players need**: Browser + CHIPS for buy-in. That's it.

### Option B: Fully On-Chain P2P (What We Tested)

```
EVERY ACTION: Written to VerusID contentmultimap               (~28 TX/hand)
```

**Pros**:
- No server needed — fully trustless
- Every action permanently on-chain
- Complete audit trail

**Cons**:
- ~50-80s per hand (same node), ~4+ min per hand (cross-node)
- UTXO bottleneck limits throughput
- Players need full CHIPS daemon + registered VerusID
- 9 players would be ~5+ minutes per hand
- contentmultimap accumulates thousands of entries

**Practical**: Works as proof of concept but not for real gameplay.

### Option C: Hybrid with Player Chain Verification

```
BEFORE HAND:  Dealer writes commitment to chain                (1 TX)
DURING HAND:  WebSocket for speed                              (0 TX)
AFTER HAND:   Dealer writes verification data to chain         (1 TX)
              Players independently verify from chain data
              If verification fails → player writes dispute    (1 TX)
ON CASH-OUT:  Settlement from multisig                         (1 TX)
```

**Pros**:
- Same speed as Option A
- Players can verify without trusting the server
- Disputes are on-chain and provable
- Only 2 TXs per hand normally, 3 on dispute

**Cons**:
- Players still need a way to verify (light client or API)
- Slightly more complex than Option A

**This is essentially Option A with explicit client-side verification.**

### Option D: UTXO Chaining (v2 Optimization)

The dev mentioned this: chain UTXOs for guaranteed mempool ordering. Each write explicitly spends the output from the previous write, creating a chain. The daemon accepts these as a batch because they form a valid dependency chain.

**If this works**: All 28 writes could go into mempool as a chain in ~2-3 seconds total. The UTXO bottleneck disappears.

**Questions for dev**:
- Does `updateidentity` support spending a specific UTXO (not just the latest)?
- Can we create a chain of identity updates that all enter mempool together?
- Is this what was meant by "mempool-speed via UTXO chaining"?

## Questions for sg777/Dev

1. **Was fully on-chain play ever intended?** Or was the chain always meant for deposits/verification/disputes, with real-time play over WebSocket?

2. **UTXO chaining**: Can multiple `updateidentity` TXs be chained in mempool (each spending the previous unconfirmed output)? This would solve the write bottleneck.

3. **Cashier write target**: In the C code, the cashier writes to the TABLE ID. Was this intentional? If the cashier wrote to its own ID, dealer and cashier could write in parallel (different UTXO chains).

4. **Cross-node propagation**: We see 15-20s for a TX to propagate from one CHIPS daemon to another's mempool. Is this expected? Any way to speed it up (direct peer connection, relay)?

5. **Option A (hybrid) acceptable?** Funds in multisig, shuffle commitment before hand, verification proof after hand, game play via WebSocket. All fairness guarantees preserved, just not every action on-chain.

6. **Content accumulation**: With hundreds of hands per table, the contentmultimap grows large. Is there a way to prune old data from an identity, or is heightstart-based reading the intended solution?

## Current Codebase

Repository: https://github.com/Fried333/verus-poker

| Test | Status |
|------|--------|
| Crypto shuffle (sg777 + SRA) | ✅ 46 tests pass |
| Game logic (blinds, pots, settlement) | ✅ 26 tests pass |
| Hand evaluation | ✅ All rankings |
| Chip conservation (2-9 players) | ✅ 23 stress tests |
| Full pipeline (deposit→play→verify→settle) | ✅ Real CHIPS |
| Cross-daemon P2P | ✅ Proven working |
| Browser UI | ✅ Working (WebSocket mode) |
| On-chain P2P play | ⚠️ Works but too slow for real games |
| Security audit | ✅ XSS, path traversal, rate limiting fixed |
