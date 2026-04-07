#!/bin/bash
# Start a fresh dealer + the gui-servers needed
# Run on .28
cd /root/bet
pkill -9 -f "node " 2>/dev/null
sleep 2

# Dealer (DCV)
nohup node poker-server.mjs --local --role=dealer --table=ptable2 \
  --players=pplayer2,pdealer2,pc-player --cashiers=cashier1 --port=3000 \
  > /tmp/dealer.log 2>&1 &
echo "DEALER PID=$!"

sleep 4

# pplayer2 gui-server
nohup node gui-server.mjs --id=pplayer2 --table=ptable2 --port=3001 \
  > /tmp/pplayer2.log 2>&1 &
echo "PPLAYER2 PID=$!"

# pc-player gui-server
nohup node gui-server.mjs --id=pc-player --table=ptable2 --port=3002 \
  > /tmp/pc-player.log 2>&1 &
echo "PC-PLAYER PID=$!"

disown -a
echo "ALL STARTED"
