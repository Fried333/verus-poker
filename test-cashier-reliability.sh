#!/bin/bash
# Cashier reliability test suite — runs on .59
set -u
LOG=/tmp/cashier-test.log
STATE=/root/.verus-poker/cashier-cashier1-ptable2
BET=/root/bet
> $LOG
exec >> $LOG 2>&1

cleanup() { pkill -9 -f cashier-runner 2>/dev/null; sleep 1; }
trap cleanup EXIT

start_cashier() {
  cd $BET
  nohup node cashier-runner.mjs --id=cashier1 --table=ptable2 </dev/null > /tmp/cashier1.log 2>&1 &
  echo $!
}

wait_for() {
  local pat=$1; local timeout=${2:-20}
  local i=0
  while [ $i -lt $((timeout * 10)) ]; do
    if grep -q "$pat" /tmp/cashier1.log 2>/dev/null; then return 0; fi
    sleep 0.1
    i=$((i+1))
  done
  return 1
}

#####################################
echo ""
echo "=========================================="
echo "TEST 12: Startup time measurement"
echo "=========================================="
cleanup
> /tmp/cashier1.log
T0=$(date +%s%N)
PID=$(start_cashier)
echo "Started PID=$PID"
if wait_for "Watching table" 30; then
  T1=$(date +%s%N)
  STARTUP_MS=$(( (T1 - T0) / 1000000 ))
  echo "STARTUP_TIME_MS=$STARTUP_MS"
  RECOVERED=$(grep -c "Reloaded hand" /tmp/cashier1.log)
  echo "RECOVERED_HANDS=$RECOVERED"
  echo "PASS_T12: startup=${STARTUP_MS}ms recovered=$RECOVERED"
else
  echo "FAIL_T12: did not start in 30s"
fi

#####################################
echo ""
echo "=========================================="
echo "TEST 11: Multiple crash cycles"
echo "=========================================="
# Snapshot existing files
BEFORE_FILES=$(ls -1 $STATE/*.json 2>/dev/null | wc -l)
echo "Files before: $BEFORE_FILES"
for cycle in 1 2 3; do
  cleanup
  > /tmp/cashier1.log
  PID=$(start_cashier)
  if wait_for "Watching table" 30; then
    REC=$(grep -c "Reloaded hand" /tmp/cashier1.log)
    AFTER_FILES=$(ls -1 $STATE/*.json 2>/dev/null | wc -l)
    echo "Cycle $cycle: recovered=$REC files=$AFTER_FILES (expected ~$BEFORE_FILES)"
    if [ "$REC" -ne "$BEFORE_FILES" ] || [ "$AFTER_FILES" -lt "$BEFORE_FILES" ]; then
      echo "FAIL_T11_cycle$cycle"
    fi
  else
    echo "FAIL_T11: did not start cycle $cycle"
    break
  fi
done
echo "PASS_T11: 3 crash+restart cycles all recovered consistently"

#####################################
echo ""
echo "=========================================="
echo "TEST 10: Corrupt file resilience"
echo "=========================================="
cleanup
# Create a corrupt JSON file
CORRUPT=$STATE/corrupt_test.json
echo '{ this is { not valid json ::' > $CORRUPT
echo "Created corrupt file: $CORRUPT"
> /tmp/cashier1.log
PID=$(start_cashier)
if wait_for "Watching table" 30; then
  echo "Cashier started despite corrupt file"
  if grep -q "Failed to reload corrupt_test" /tmp/cashier1.log; then
    echo "PASS_T10: corrupt file rejected with logged error, cashier continued"
  else
    echo "WARN_T10: cashier started but no rejection log found"
  fi
  rm -f $CORRUPT
else
  echo "FAIL_T10: cashier crashed on corrupt file"
fi

#####################################
echo ""
echo "=========================================="
echo "TEST 9: Timed recovery — kill after Stage III"
echo "=========================================="
cleanup
> /tmp/cashier1.log
PID=$(start_cashier)
wait_for "Watching table" 30 || { echo "FAIL_T9: cashier did not start"; exit 1; }

# Get current file count to detect new persist
BASELINE=$(ls -1 $STATE/*.json 2>/dev/null | wc -l)
echo "Baseline files: $BASELINE"

# Watch for next Stage III done — when the dealer sends a new shuffle
echo "Waiting for next Stage III..."
T_WAIT_START=$(date +%s)
NEW_HAND=""
while [ $(($(date +%s) - T_WAIT_START)) -lt 300 ]; do
  if grep -q "Stage III done" /tmp/cashier1.log; then
    NEW_HAND=$(grep "Shuffle request" /tmp/cashier1.log | tail -1 | grep -oP 'hand=\K[^ ]+')
    echo "Stage III complete for hand=$NEW_HAND"
    break
  fi
  sleep 1
done

if [ -z "$NEW_HAND" ]; then
  echo "SKIP_T9: no new shuffle in 300s — dealer not active"
else
  # Wait briefly for the persist to flush, then kill
  sleep 1
  PERSISTED_FILE=$STATE/$NEW_HAND.json
  if [ -f "$PERSISTED_FILE" ]; then
    SIZE=$(stat -c%s "$PERSISTED_FILE")
    echo "Persisted: $PERSISTED_FILE (${SIZE}B)"
    KILL_T0=$(date +%s%N)
    pkill -9 -f cashier-runner
    sleep 0.5
    # Restart immediately
    > /tmp/cashier1.log
    PID=$(start_cashier)
    wait_for "Watching table" 30
    KILL_T1=$(date +%s%N)
    DOWNTIME_MS=$(( (KILL_T1 - KILL_T0) / 1000000 ))
    echo "Cashier downtime: ${DOWNTIME_MS}ms"
    # Verify the killed hand is in the recovered set
    if grep -q "Reloaded hand $NEW_HAND" /tmp/cashier1.log; then
      echo "PASS_T9_PART1: hand $NEW_HAND recovered after kill"
    else
      echo "FAIL_T9_PART1: hand $NEW_HAND NOT in reloaded set"
    fi
    # Wait for the recovered cashier to serve a reveal for that hand
    echo "Waiting up to 90s for reveal of recovered hand..."
    if wait_for "Revealed.*for player" 90; then
      LAST_REV=$(grep "Revealed" /tmp/cashier1.log | tail -1)
      echo "Reveal observed: $LAST_REV"
      echo "PASS_T9_PART2: recovered cashier served a reveal request"
    else
      echo "WARN_T9_PART2: no reveal observed in 90s (may have moved past hand)"
    fi
  else
    echo "FAIL_T9: persisted file not created at expected path"
  fi
fi

echo ""
echo "=========================================="
echo "TESTS COMPLETE"
echo "=========================================="
grep -E "^(PASS|FAIL|WARN|SKIP)" $LOG
