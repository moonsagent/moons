# Contributing to moons

PRs are welcome. For anything bigger than a bug fix, open an issue first so we can agree on the shape before you write it.

## Get it running

```sh
git clone https://github.com/OWNER/moons.git && cd moons
npm test          # no install step, there are no dependencies
```

You need Node 18 or newer.

## Work against the mock, not the real APIs

The test suite and the demos never hit the network. `scripts/mock-server.js` stands in for DexScreener, GeckoTerminal, a webhook and the Telegram Bot API, fed by `test/fixtures/`.

```sh
npm run mock
export MOONS_API=http://127.0.0.1:8787 MOONS_GECKO_API=http://127.0.0.1:8787/gecko
node bin/moons.js MoonsQuoteMint1111111111111111111111111pump
node bin/moons.js ui   # open http://127.0.0.1:4646/?mint=HubQuoteMint333333333333333333333333333333pump
```

## What a good PR looks like

- Zero runtime dependencies stays zero. Node built-ins and global `fetch` only.
- New behaviour comes with a test in `test/` that runs offline.
- Documented endpoints only: DexScreener `token-pairs/v1` and `tokens/v1`, GeckoTerminal `ohlcv`, Telegram `sendMessage`.
- `--json`, `--csv` and the history file are read by other people's scripts. Changing a field is a breaking change.
- Flow is an estimate. Wherever it shows up, it says so.
- No em or en dashes anywhere, generated output included.
- Add a line to `CHANGELOG.md`.

If you touch the CLI output, the graph or the dashboard, run `npm run assets` to refresh `assets/terminal.svg`, `assets/graph.svg` and the demo blocks in `docs/index.html`.
