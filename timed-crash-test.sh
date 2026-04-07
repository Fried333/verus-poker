#!/bin/bash
# Wait for next Stage III on the live cashier, kill immediately after persist,
# restart, and verify the cashier serves a real reveal request for THAT hand.
LOG=/tmp/cashier1.log
STATE=/root/.verus-poker/cashier-cashier1-ptable2

# Mark current log position so we only look at events from now on
MARK_LINES=$(wc -l < $LOG 2>/dev/null || echo 0)
echo "Log mark: line $MARK_LINES"

# Wait for next "Persisted b[] to disk (pre-chain-write)" line after the mark
echo "Waiting for next Stage III + persist..."
NEW_HAND=""
TIMEOUT_S=300
T0=$(date +%s)
while [ $(($(date +%s) - T0)) -lt $TIMEOUT_S ]; do
  PERSIST_LINE=$(tail -n +$((MARK_LINES + 1)) $LOG 2>/dev/null | grep "Persisted b\[\] to disk" | head -1)
  if [ -n "$PERSIST_LINE" ]; then
    # Find the most recent shuffle request before this persist
    NEW_HAND=$(tail -n +$((MARK_LINES + 1)) $LOG | grep "Shuffle request" | tail -1 | grep -oP 'hand=\K[^ ]+')
    echo "Found persist for hand=$NEW_HAND"
    break
  fi
  sleep 0.5
done

if [ -z "$NEW_HAND" ]; then
  echo "FAIL: no Stage III persist seen in ${TIMEOUT_S}s"
  exit 1
fi

# Verify the file exists
PERSIST_FILE=$STATE/$NEW_HAND.json
if [ ! -f "$PERSIST_FILE" ]; then
  echo "FAIL: persist file $PERSIST_FILE missing!"
  exit 1
fi
SIZE=$(stat -c%s "$PERSIST_FILE")
echo "Persisted: $PERSIST_FILE ($SIZE bytes)"

# KILL the cashier
KILL_T0=$(date +%s%N)
pkill -9 -f "node cashier-runner"
sleep 0.2
echo "Killed cashier"

# Verify file survives
if [ ! -f "$PERSIST_FILE" ]; then
  echo "FAIL: persist file disappeared after kill!"
  exit 1
fi
echo "File survives after kill"

# Restart cashier
> $LOG
bash /root/start-cashier.sh
echo "Cashier restart issued"

# Wait for restart to be ready AND for it to serve a reveal for our hand
RESTART_OK=0
REVEAL_OK=0
DEADLINE=$(($(date +%s) + 90))
while [ $(date +%s) -lt $DEADLINE ]; do
  if [ $RESTART_OK -eq 0 ] && grep -q "Recovered.*in-flight" $LOG 2>/dev/null; then
    KILL_T1=$(date +%s%N)
    DOWNTIME_MS=$(( (KILL_T1 - KILL_T0) / 1000000 ))
    echo "Cashier recovered in ${DOWNTIME_MS}ms"
    if grep -q "Reloaded hand $NEW_HAND" $LOG; then
      echo "PASS_PART1: hand $NEW_HAND recovered from disk"
      RESTART_OK=1
    else
      echo "FAIL_PART1: hand $NEW_HAND NOT in reloaded set"
      grep "Reloaded" $LOG
      exit 1
    fi
  fi
  if [ $RESTART_OK -eq 1 ] && [ $REVEAL_OK -eq 0 ]; then
    if grep -q "Revealed .* cards for player" $LOG; then
      LAST_REV=$(grep "Revealed" $LOG | tail -1)
      echo "$LAST_REV"
      echo "PASS_PART2: recovered cashier served a reveal"
      REVEAL_OK=1
      break
    fi
  fi
  sleep 0.5
done

if [ $REVEAL_OK -eq 0 ]; then
  echo "WARN: did not see reveal in 90s"
  echo "--- last 30 log lines ---"
  tail -30 $LOG
  exit 2
fi

echo ""
echo "==========================================="
echo "END-TO-END LIVE RECOVERY TEST: PASS"
echo "Hand $NEW_HAND killed mid-flight, recovered from disk, served real reveal"
echo "==========================================="
