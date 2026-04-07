#!/bin/bash
cd /root/bet
pkill -9 -f "node gui-server" 2>/dev/null
sleep 1
nohup node gui-server.mjs --id=pdealer2 --table=ptable2 --port=3001 > /tmp/pdealer2.log 2>&1 &
echo "STARTED PID=$!"
disown
