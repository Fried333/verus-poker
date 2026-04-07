#!/bin/bash
cd /root/bet
pkill -9 -f "auto-action.mjs" 2>/dev/null
sleep 1
nohup node auto-action.mjs ws://localhost:3001 > /tmp/auto-action.log 2>&1 &
echo "STARTED PID=$!"
disown
