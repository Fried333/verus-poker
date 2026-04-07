#!/usr/bin/env bash
# Cross-daemon mempool propagation matrix.
# 3 writers × 2 readers each = 6 measurements per round.
set -u

LOCAL_DIR="/home/dev/Desktop/chips/verus-poker"
R28="ssh -p 2400 -o ConnectTimeout=10 root@46.225.132.28"
R59="ssh -p 2400 -o ConnectTimeout=10 root@89.125.50.59"

run_writer() {
  local host=$1 id=$2
  local cmd="cd /root/bet && node test-mempool-matrix.mjs --mode=write --id=$id"
  if [ "$host" = "local" ]; then
    cd "$LOCAL_DIR" && node test-mempool-matrix.mjs --mode=write --id="$id"
  elif [ "$host" = ".28" ]; then
    $R28 "$cmd"
  else
    $R59 "$cmd"
  fi
}

run_reader() {
  local host=$1 id=$2 nonce=$3 t0=$4
  local cmd="cd /root/bet && node test-mempool-matrix.mjs --mode=read --id=$id --nonce=$nonce --t0=$t0 --timeout=120000"
  if [ "$host" = "local" ]; then
    cd "$LOCAL_DIR" && node test-mempool-matrix.mjs --mode=read --id="$id" --nonce="$nonce" --t0="$t0" --timeout=120000
  elif [ "$host" = ".28" ]; then
    $R28 "$cmd"
  else
    $R59 "$cmd"
  fi
}

round() {
  local writer_host=$1 writer_id=$2 r1_host=$3 r2_host=$4
  echo
  echo "════════════════════════════════════════════════════════"
  echo "ROUND: writer=$writer_host id=$writer_id readers=$r1_host,$r2_host"
  echo "════════════════════════════════════════════════════════"
  local out
  out=$(run_writer "$writer_host" "$writer_id")
  echo "$out"
  local NONCE=$(echo "$out" | grep '^NONCE=' | cut -d= -f2)
  local T0=$(echo "$out" | grep '^T0=' | cut -d= -f2)
  if [ -z "$NONCE" ] || [ -z "$T0" ]; then
    echo "WRITER FAILED"
    return 1
  fi

  # Kick off both readers in parallel
  local tmp1=$(mktemp) tmp2=$(mktemp)
  run_reader "$r1_host" "$writer_id" "$NONCE" "$T0" > "$tmp1" 2>&1 &
  local p1=$!
  run_reader "$r2_host" "$writer_id" "$NONCE" "$T0" > "$tmp2" 2>&1 &
  local p2=$!
  wait $p1 $p2
  echo "  reader[$r1_host]: $(cat "$tmp1")"
  echo "  reader[$r2_host]: $(cat "$tmp2")"
  rm -f "$tmp1" "$tmp2"
}

echo "Mempool propagation matrix ($(date -u +%H:%M:%S)Z)"

round "local" "pc-player" ".28" ".59"
round ".28"   "pplayer2"  "local" ".59"
round ".59"   "pdealer2"  "local" ".28"

echo
echo "════════════════════════════════════════════════════════"
echo "ROUND 2 (back-to-back to test consistency)"
echo "════════════════════════════════════════════════════════"

round "local" "pc-player" ".28" ".59"
round ".28"   "pplayer2"  "local" ".59"
round ".59"   "pdealer2"  "local" ".28"
