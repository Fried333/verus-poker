#!/bin/bash
cd /root/bet
pkill -9 -f "node cashier-runner" 2>/dev/null
sleep 1
nohup node cashier-runner.mjs --id=cashier1 --table=ptable2 > /tmp/cashier1.log 2>&1 &
echo "STARTED PID=$!"
disown
