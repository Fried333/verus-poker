#!/bin/bash
# Wait for 10 new "HAND TOTAL" completions from a baseline.
LOG=/tmp/dealer.log
BASELINE_LINE=$1
TARGET=10
START_T=$(date +%s)

echo "Watching for $TARGET completions from line $BASELINE_LINE..."
echo ""

while true; do
  COMPLETED=$(tail -n +$((BASELINE_LINE+1)) $LOG | grep -c "HAND TOTAL")
  ERRORS=$(tail -n +$((BASELINE_LINE+1)) $LOG | grep -c "Hand error")
  GARBAGE=$(tail -n +$((BASELINE_LINE+1)) $LOG | grep -c "undefined")
  ELAPSED=$(($(date +%s) - START_T))
  printf "\r[%4ds] completed=%d/%d errors=%d garbage=%d  " $ELAPSED $COMPLETED $TARGET $ERRORS $GARBAGE
  if [ $COMPLETED -ge $TARGET ]; then
    echo ""
    echo ""
    echo "=== DONE: $TARGET hands completed in ${ELAPSED}s ==="
    echo "Errors: $ERRORS"
    echo "Garbage decodes: $GARBAGE"
    echo ""
    echo "=== Last 10 completions ==="
    tail -n +$((BASELINE_LINE+1)) $LOG | grep "HAND TOTAL" | tail -10
    exit 0
  fi
  if [ $ELAPSED -gt 3600 ]; then
    echo ""
    echo "TIMEOUT after 1h"
    exit 1
  fi
  sleep 5
done
