# 3-Player Cross-Daemon Multisig Test Results

## Summary

Real end-to-end test on three un-peered CHIPS daemons (local, .28, .59) representing three players (pc-player, pplayer2, pdealer2). Validates the entire phase-multisig funding flow including cross-daemon partial signing.

**Result: full pass**. Every step worked. All three players received their settlement payouts on their respective daemons.

Test script: `test-multisig-3player.mjs` in the project root.

## Setup

Three test players, each on a separate machine, with their wallets controlled by their local CHIPS daemons:

| Player | Daemon | Primary R-address | Test Balance |
|---|---|---|---|
| `pc-player.CHIPS@` | local | `RNAzVUUfe5UrDFQNj3b9soJZ8ZJoLzqArD` | 30.4 CHIPS |
| `pplayer2.CHIPS@` | .28 | `RAwyMMAYjs4gM2QQPHEPrT87M1BBHGYsuc` | 333.3 CHIPS |
| `pdealer2.CHIPS@` | .59 | `RKhh2r14ejZdEi9WUBirGdZgSQtbZnMYHD` | 110.6 CHIPS |

The three daemons are **fully un-peered** — not direct CHIPS network peers — to simulate realistic distributed conditions. Cross-daemon mempool propagation goes through the public CHIPS network.

## What was tested

### 1. Cross-daemon multisig creation
- Each daemon's RPC was queried for the player's primary R-address pubkey
- A 2-of-3 multisig was computed from the three pubkeys
- The multisig address was added to all three wallets via `addmultisigaddress`

**Result**: address computed in 4ms. `addmultisigaddress` succeeded on all three daemons. Adding to wallets took ~10s due to SSH overhead, not chain time.

### 2. Three parallel deposits across un-peered daemons
- Each daemon issued a 10-CHIPS deposit to the multisig address simultaneously
- Each deposit was a regular `sendtoaddress` from the player's daemon

**Result**: all three deposits broadcast within 22.5 seconds total (~7s each, dominated by daemon RPC speed). All three landed in mempool successfully.

### 3. Cross-daemon mempool visibility
- After deposits broadcast, each daemon was polled for the deposit visibility at the multisig address using `getaddressutxos`

**Result**:
- local saw all 3 deposits in 4ms (it had its own deposit + the others propagated quickly)
- .28 saw all 3 deposits in 4.2s
- .59 saw all 3 deposits in 4.8s

Cross-daemon mempool propagation: under 5 seconds despite the daemons being un-peered. The public CHIPS network handles relay.

### 4. Cross-daemon partial signing (the critical test)
- Settlement TX was composed on local: 3 inputs from the multisig, 3 outputs paying back to each player's primary R-address based on simulated final stacks
- local signed first (1 of 3 sigs collected)
- The partially-signed TX was passed to .28 via SSH for the second signature
- After .28 signed, the TX had 2 of 3 sigs (threshold reached)
- pdealer2 (on .59) was deliberately not asked to sign — testing the threshold-tolerance case where one player is "absent"

**Result**: cross-daemon partial signing works flawlessly. local signed in 3ms, .28 signed in 4.6s, the TX was complete with 2 of 3 sigs. No issues with the unsigned-tx-passing-between-daemons flow.

### 5. Settlement broadcast and confirmation
- The fully-signed settlement TX was broadcast from local
- All three player daemons were monitored for the recipient outputs at their primary R-addresses

**Result**:
- Broadcast: 5ms
- pc-player (local) received their payout in 11.2s
- pplayer2 (.28) received their payout in 4.3s
- pdealer2 (.59) received their payout in 5.5s — **even though they didn't sign** — proving the threshold tolerance works in production

## Headline numbers

| Phase | Time |
|---|---|
| Discovery (pubkeys via SSH) | ~19s (mostly SSH overhead) |
| Multisig creation + add to wallets | ~10s |
| Three parallel deposits broadcast | 22.5s |
| Cross-daemon mempool visibility | <5s |
| Settlement composition | 2ms |
| Local signing | 3ms |
| Cross-daemon partial signing | 4.6s |
| Settlement broadcast | 5ms |
| All recipients see payout (worst case) | 11.2s |
| **Total settlement latency** (decision → all paid) | **~21 seconds** |

## What this validates

| Design assumption | Validated? |
|---|---|
| CHIPS multisig works on real chain | ✓ |
| Cross-daemon multisig with un-peered daemons | ✓ |
| Cross-daemon partial signing flow | ✓ |
| Threshold tolerance: absent signer still gets paid | ✓ |
| Cross-daemon mempool propagation is fast | ✓ (<5s) |
| Settlement TX with multiple inputs/outputs | ✓ |
| Real-world settlement timing acceptable | ✓ (~20s) |
| Address index reads (`getaddressutxos`) for non-wallet addresses | ✓ |

## Critical implementation note

**Use `getaddressutxos` not `listunspent`** for querying multisig deposits. `listunspent` is wallet-scoped and only returns UTXOs at addresses the wallet is actively watching. The address index RPCs (`getaddressutxos`, `getaddressbalance`, `getaddressmempool`) work for any address regardless of wallet state. This is a critical correction from the design — production code should use the address index throughout for any address that isn't explicitly being watched.

## Open question raised by this test

When the dealer composes a settlement TX, it needs to know **all the deposit UTXOs at the multisig**. The dealer reads these via `getaddressutxos`. The dealer also needs to verify that **each deposit was attributable to the correct player** so the settlement output amounts are correct. Attribution by walking the input chain works (we tested this in the single-daemon test suite), but it requires per-deposit RPC calls. For high-frequency play this could be optimized by having each player publish their deposit TXID to their identity at deposit time, so the dealer just reads each player's identity for the canonical "this is my deposit TXID" message instead of inferring from chain history.

## Conclusion

The phase-multisig funding model works on real CHIPS in real cross-daemon conditions. Settlement latency of ~20 seconds end-to-end is acceptable for a hobby/home-game model. Threshold tolerance handles absent signers gracefully. The model is buildable as designed.
