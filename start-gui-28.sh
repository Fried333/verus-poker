#!/bin/bash
cd /root/bet
nohup node gui-server.mjs --id=pplayer2 --table=ptable2 --port=3001 > /tmp/pplayer2.log 2>&1 &
P1=$!
disown
nohup node gui-server.mjs --id=pc-player --table=ptable2 --port=3002 > /tmp/pc-player.log 2>&1 &
P2=$!
disown
echo "PPLAYER2_PID=$P1 PCPLAYER_PID=$P2"
