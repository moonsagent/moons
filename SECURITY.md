# Security

moons reads public market data. It never touches wallets or private keys, so the things worth protecting are the alert secrets you give it and the local dashboard.

**Found something?** Report it privately at https://github.com/OWNER/moons/security/advisories/new with a way to reproduce it. Please skip public issues for this. Expect an answer within 7 days. Fixes land in the latest 1.x release.

Things to know:

1. Webhook URLs and Telegram bot tokens are secrets. Put them in `MOONS_WEBHOOK` and `MOONS_TELEGRAM_TOKEN` instead of flags so they stay out of shell history. Error output redacts bot tokens.
2. `moons ui` listens on 127.0.0.1 with no login. Keep it there; do not put it behind a public port.
