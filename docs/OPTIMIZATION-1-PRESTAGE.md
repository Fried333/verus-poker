# Optimization 1: Pre-stage hand N+1 during hand N

## Summary

Move all of hand N+1's setup work (player init, dealer shuffle request, cashier Stage III, dealer init batch composition) onto **hand N's idle time**. By the time hand N ends, hand N+1's chain artifacts are already published and the dealer can start dealing immediately with no additional waiting.

**Estimated savings**: ~10-15 seconds per hand for hands 2 through N. The first hand of a session still pays the full ~25s cold-start cost because there's no previous hand to overlap with.

**Implementation complexity**: moderate. Requires coordinated work across all roles (players, dealer, cashier) and careful handling of the case where the pre-staged data becomes stale due to roster changes.

## What pre-staging actually means

It is NOT "the cashier shuffles a generic deck". Stage III requires player input (the blinded decks), so the cashier cannot pre-shuffle without first having something to shuffle.

Pre-staging means **moving the entire setup pipeline forward in time** so that when hand N ends, the hand N+1 artifacts are already on chain and the dealer can read them instantly:

- **Players** generate their hand N+1 nonces and blinded decks while waiting for their turn in hand N
- **Players** write their hand N+1 blinded decks to chain during hand N (different VDXF keys, no conflict with hand N's writes)
- **Dealer** composes hand N+1's shuffle request and writes it during hand N
- **Cashier** detects the request, runs Stage III, and publishes the result during hand N
- **Dealer** reads the cashier's hand N+1 result and pre-composes the init batch payload during hand N

When hand N ends (settlement complete, ready to start next hand), the dealer just issues one final write — the init batch — using the already-prepared payload, and players see hand N+1 begin almost immediately.

## What we already do that helps

The cashier is **already** "all reveals upfront" — when Stage III runs, the cashier publishes the entire deck of blindings (all 11 cards for Texas Hold'em) in one batched write. The dealer reads this once and decodes hole cards, flop, turn, and river from the same pre-published data. There is no per-street cashier round trip.

This means **the cashier has nothing more to do for a hand once Stage III is published**. Pre-staging the cashier's work covers all of its responsibility for that hand. There is no "what if a card needs to be revealed later" question — the reveal data is already on chain.

## The current critical path (hand N+1 setup)

Without pre-staging, hand N+1 starts after hand N ends and runs through this sequence:

```
T=0     Players generate nonces + blinded decks  (~1s compute)
T=1     Players write blinded decks to chain     (~3s each, parallel across players)
T=4     Dealer reads all player decks             (~5s cross-daemon propagation)
T=9     Dealer writes shuffle request             (~3s chain write)
T=12    Cashier reads shuffle request             (~5s cross-daemon propagation)
T=17    Cashier runs Stage III                    (~2s compute)
T=19    Cashier writes result                     (~3s chain write)
T=22    Dealer reads cashier result               (~5s cross-daemon propagation)
T=27    Dealer decodes hole cards, composes init  (~1s)
T=28    Dealer writes init batch                  (~3s chain write)
T=31    Players see hand N+1 init                 (~5s cross-daemon propagation)
T=36    Hand N+1 begins
```

Roughly 25-35 seconds end to end.

## With pre-staging

Move steps T=0 through T=28 onto hand N's idle time. The only operation that has to happen AFTER hand N ends is the final init batch write — and even that can be pre-composed and just needs to be issued.

Hand N's actual end-of-hand work is minimal: write the settlement (or final BS), then issue the pre-composed init batch for hand N+1.

```
[During hand N betting]
T=N-15   Players generate nonces for hand N+1    (compute, no chain)
T=N-14   Players write hand N+1 blinded decks    (~3s each, parallel)
T=N-11   Dealer reads decks (parallel reads)     (~5s cross-daemon)
T=N-6    Dealer writes shuffle request           (~3s)
T=N-3    Cashier reads request                   (~5s)
T=N+2    Cashier runs Stage III                  (~2s)
T=N+4    Cashier writes result                   (~3s)
T=N+7    Dealer reads result                     (~5s)
T=N+12   Dealer pre-composes init batch          (~1s)

[Hand N ends]
T=N      Hand N settlement broadcast
T=N+1    Dealer issues pre-composed init batch  (~3s)
T=N+4    Players see hand N+1 init              (~5s)
T=N+9    Hand N+1 begins
```

Where `T=N` is the moment hand N's last action concludes. The pre-staging happens during the ~30-90 seconds that hand N is in betting (typical hand duration with human players).

**Result**: hand N+1 starts ~9 seconds after hand N ends, vs ~36 seconds without pre-staging. Savings: ~25 seconds per hand for the average case.

## Coordinated pre-work, broken down by role

### Players
1. **Detect hand N is in mid/late stage** (after the flop, say) and start preparing hand N+1
2. **Generate fresh nonces and blinded deck** for hand N+1 (compute, no chain)
3. **Write hand N+1 blinded deck** to a per-hand VDXF key on the player's identity (`t_shuffle_deck.<handN+1>.p<i>`)
4. **Continue playing hand N normally** — the pre-staging happens in the background
5. **When hand N ends and hand N+1 begins**, the player's blinded deck for N+1 is already on chain, so the player just reads the dealer's init batch as normal

### Dealer
1. **Decide hand N+1 is happening** (no roster change pending) at some point during hand N
2. **Compose hand N+1's handId and pubkey set** (deterministic from current roster)
3. **Wait for all players to publish their hand N+1 blinded decks**
4. **Compose shuffle request for hand N+1** (with the pre-published decks)
5. **Write shuffle request** to the cashier's identity (or to the table identity in a hand-N+1-specific key)
6. **Wait for cashier's response**
7. **Read cashier's result, decode hole cards, pre-compose init batch payload**
8. **When hand N ends**, issue the pre-composed init batch immediately
9. **Hand N+1 begins** with no additional waiting

### Cashier
1. **Continue polling chain** as normal
2. **Detect a hand N+1 shuffle request** (different handId from the current hand)
3. **Read the player blinded decks** from chain
4. **Run Stage III** as normal
5. **Write result** to chain (cashier identity, per-hand key)
6. **Done** — no more work for hand N+1 until something changes

## Critical edge cases

### Roster change between hand N and hand N+1

**Problem**: pre-staging assumes hand N+1's roster matches hand N's. If a player joins or leaves at the rotation point between hands, the pre-staged data is wrong (wrong number of players, wrong pubkeys, wrong multisig address).

**Solutions**:

**Option A: Cancel and restart pre-staging on roster change.**
The dealer detects the roster change, marks any in-flight pre-staging as stale, and either restarts pre-staging with the new roster (if there's still time before hand N ends) or falls back to the cold-start path for hand N+1.

Cost: the wasted pre-stage work (cashier's ~2s of Stage III compute, plus the chain writes that are now garbage but harmlessly sit on chain).

**Option B: Detect mid-pre-stage and pivot.**
Same as A but more proactive — the dealer broadcasts a "rotation pending" signal as soon as a player requests to join or leave, and the players + cashier hold off on their pre-staging until the new roster is finalized.

**Recommendation**: Option A is simpler and the cost (wasted Stage III) is small. The dealer detects rotation events at hand boundaries anyway, so adding a "discard pre-stage if roster changed" check is straightforward.

### Players don't pre-stage in time

**Problem**: a slow player doesn't generate or write their hand N+1 blinded deck until hand N is already done. The cashier can't run Stage III without all players' input. Pre-staging fails for this hand.

**Mitigation**: the dealer falls back to the cold-start path for hand N+1, paying the full 25s setup cost. No protocol failure, just no pre-staging benefit.

This is "best effort" pre-staging: when it works, hand N+1 is fast; when it doesn't, hand N+1 is the same as today.

### A player goes offline mid-hand

**Problem**: a player is in hand N's roster but goes offline before pre-staging starts. Their hand N+1 blinded deck never arrives. Pre-staging stalls waiting for them.

**Mitigation**: pre-staging has a timeout. If hand N+1 player decks aren't all visible by 5 seconds before hand N's expected end, the dealer cancels pre-staging for hand N+1 and proceeds with cold start.

### Hand N has settlement issues

**Problem**: hand N's settlement (peer-to-peer payments or multisig spend) takes longer than expected, or fails. Hand N+1 is pre-staged and ready, but hand N is dragging.

**Mitigation**: hand N+1 is gated on hand N's clean completion. The pre-stage just sits there until hand N is fully settled. No protocol issue — just no immediate benefit from the pre-stage work.

### What if pre-staged data is wrong?

**Problem**: a bug or race condition causes the pre-staged data to not match what hand N+1 actually needs.

**Mitigation**: the dealer validates the pre-staged data before issuing the init batch. Specifically:
- Check that the cashier's result matches the published player decks
- Check that the handId in the pre-staged data matches the upcoming handId
- Check that the player roster matches

If validation fails, fall back to cold start.

## What we actually need to build

### 1. Per-hand VDXF keys for player decks
Players already write their blinded decks to per-hand keys (the existing protocol uses `t_shuffle_deck.<handId>.p<i>`). The pre-staging just uses the next handId. **No protocol change** — we just write to a different key earlier.

### 2. Player backend: pre-stage trigger
Player backend gets a new state: "pre-staging hand N+1". Triggered when:
- Hand N is in flop or later
- Hand N+1's handId is known (deterministic — dealer publishes it)
- Roster is stable (no pending join/leave)

In this state, the player generates and writes their hand N+1 blinded deck.

### 3. Dealer: pre-stage coordinator
Dealer logic that:
- Decides when to start pre-staging (e.g., after the turn of hand N)
- Computes hand N+1's handId
- Polls for player hand N+1 decks
- Issues hand N+1 shuffle request to cashier
- Waits for cashier response
- Pre-composes hand N+1 init batch
- Triggers actual hand N+1 start when hand N ends

### 4. Cashier: support multiple in-flight hands
Cashier currently processes one hand at a time. It needs to handle hand N+1 requests arriving while hand N is "still its current hand" (which it already is, since it's done with hand N as soon as Stage III is published — no further per-hand work for the cashier).

Actually since the cashier is "all reveals upfront", once Stage III is done, the cashier has no more work for that hand. So the cashier just needs to detect and process a NEW hand request whenever it arrives, regardless of whether the previous hand is "done" from anyone else's perspective. No state machine change.

### 5. Validation + fallback
Before issuing the pre-composed init batch, the dealer validates:
- Pre-staged handId matches the upcoming handId
- Player roster matches
- Cashier result is consistent with published decks

If anything fails, fall back to the cold-start path.

## Estimated savings

For a typical hand (assuming pre-staging completes during hand N):

| Step | Cold start | Pre-staged | Savings |
|---|---|---|---|
| Player blinded decks visible | ~5s | 0s (already on chain) | 5s |
| Dealer reads decks | ~5s | 0s | 5s |
| Dealer writes shuffle request | ~3s | 0s | 3s |
| Cashier reads, computes, writes | ~10s | 0s | 10s |
| Dealer reads cashier result | ~5s | 0s | 5s |
| Dealer decodes + composes init | ~1s | 0s | 1s |
| Dealer writes init batch | ~3s | ~3s | 0 |
| Players see init batch | ~5s | ~5s | 0 |
| **Total** | **~37s** | **~8s** | **~29s** |

Real-world savings probably 15-25 seconds per hand once you account for partial pre-staging completing, validation overhead, etc.

## Things to test before implementation

1. **Players writing future-hand decks while in current hand**: validated by Test E in `test-parallelism.mjs`. Player can write to multiple identity keys without conflict.

2. **Cashier handling a new hand request while still in "current hand" state**: needs verification. The cashier's existing state machine assumes one hand at a time. Should test this with a quick standalone script.

3. **Dealer reading multiple hand IDs in parallel**: validated by Test C — parallel reads work.

4. **Pre-staging cancellation cost**: when a roster change forces a restart, how much chain writing was wasted? Need to measure.

5. **Worst-case latency**: what happens when hand N is fast (everyone insta-acts) and pre-staging hasn't had time to complete? The fallback to cold start should be tested.

## Implementation order

If we build this:

1. **Extend the dealer to compute and publish "next hand ID"** during hand N. Players + cashier can detect it and start pre-staging.
2. **Modify player backend to pre-write blinded decks** when next-hand-ID is detected and hand is mid/late.
3. **Modify dealer to pre-issue cashier requests** when player decks are visible.
4. **Modify cashier to handle multi-hand requests** (or verify it already can).
5. **Add the validation + fallback path** in the dealer.
6. **Test end-to-end** with the 3-player setup we already have.

Estimated work: 1-2 weeks of focused implementation, plus thorough testing.

## What to validate next

Before building, the unknowns to test:

1. Can the cashier process two shuffle requests back-to-back without state confusion? Test by writing two shuffle requests with different handIds and verifying the cashier handles them correctly.
2. Does the player's identity allow writing to multiple per-hand VDXF keys in parallel? (Probably yes — different keys, different content. Just need to verify the wallet's writeBatch handles it.)
3. What's the realistic pre-stage completion time when player decisions are slow? If hand N takes 60 seconds because players are thinking, pre-staging has plenty of time. If hand N is fast (10 seconds), pre-staging may not complete before hand N ends. Need to characterize this.

## Open question

**Is pre-staging worth the complexity?** It's a ~2x speedup for hands 2 through N at the cost of significant added code and edge cases. For a hobby game with 25-second hand setups, going to 10-second hand setups is nice but not transformative. For a more serious deployment, it would matter more.

The simpler alternative is to NOT pre-stage and accept the 25-second cold start per hand. This keeps the protocol simple and the codebase maintainable.

**My recommendation**: don't build this until the basic phase-multisig flow is integrated and stable. Pre-staging is a layer on top that should be added when the foundation is solid, not before.
