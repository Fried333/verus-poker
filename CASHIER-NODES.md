# Cashier Nodes

## cashier1
- **Identity**: cashier1.CHIPS@
- **i-address**: iL9nCQD6z9ApdQeVGXjUFBpMHefJ5eJR2r
- **R-address**: RTQbNQwyC8YsBtnds4cLy2xyU7tBRXqpGm
- **Private key**: Uuu14MnivVHaeFTxLk2eK4mUsHtNKet5iRo2usw8SiJjnBNnSKBf
- **Server**: 89.125.50.59 (.59)
- **Registered TX**: 0001f4a12fadbed03c25941a5d03f99af4e3eb2d2df6db18f095dac71736c0a8

## cashier2
- **Identity**: cashier2.CHIPS@
- **i-address**: i5wbQhWV4A5kDHGxiuNCzzoHjuegAPC69L
- **R-address**: RTKEj8aE7D87Aqdc83XGMF5NHzbDm7esUK
- **Private key**: UxZfmR8BEb4NHZhcNV9WUUF9hnXCg1VLMyLMuRHBEGCvgN1XazRq
- **Server**: 89.125.50.59 (.59)
- **Registered TX**: 700fb53a061acb3de88b18afef8fd7968335c4c93d5074b19b67b4c1a0bfabce

## Architecture
- Both cashier nodes run on .59 (independent from dealer on .28)
- Each does Stage III shuffle independently
- 2-of-2 consensus required for settlement payouts
- Wallet keys are in the .59 CHIPS daemon
