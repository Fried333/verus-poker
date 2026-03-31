#!/bin/bash
# Upload and run the RPC test on the server
scp -i ~/.ssh/id_ed25519 -P 2400 verus-rpc.mjs test-rpc-live.mjs root@46.225.132.28:/root/bet/
ssh -i ~/.ssh/id_ed25519 -p 2400 root@46.225.132.28 "cd /root/bet && sed -i \"s/46.225.132.28/127.0.0.1/\" test-rpc-live.mjs && node --test test-rpc-live.mjs"
