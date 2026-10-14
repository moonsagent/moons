# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-10-14

### Added

- The website is now the product: [moonscli.com](https://moonscli.com) opens with a working tool above the fold. Paste a token address (or a pump.fun, DexScreener or explorer link), pick the chain and get the full ecosystem report live from DexScreener in the browser: health ring with the six key numbers, estimated flow into the quote token, interactive pair network graph, health breakdown, flow leaders with the GeckoTerminal quote price line, new pairs and a sortable table. Download the report as JSON or the graph as a standalone HTML file.
- Shareable links: `?token=<address>&chain=<chain>` runs the report on load (`?mint=` works too).
- "try with an example" for USD1 (bonk.fun quote token), Bert (memecoin) and USDC.
- Loading skeleton, plus human messages for a bad address, a token DexScreener does not know, a token that is never the quote side, rate limits and network errors.
- `docs/lib/` holds copies of the pure `src/` modules so the site runs the same code as the CLI; `test/site.test.js` checks they stay identical.
- `scripts/dev-site.mjs` (`npm run site`): serves `docs/` like Vercel, routes `/api/*` to `api/*.js` handlers, and with `--mock` starts the mock API.
- Tests for the browser logic against the mock API, and an end to end browser test (`test/site.e2e.test.js`, runs when Playwright is available).

### Changed

- The mock API sends CORS headers like the real APIs, so the website can use it from the browser.
- The landing content (CLI, features, score, MCP, FAQ) moved below the tool. The static example graph is replaced by the live one.

## [1.0.0] - 2026-10-14

Released as Moons: npm package `moons-cli`, command `moons`, ticker $MOONS, env vars prefixed `MOONS_`.

### Added

- Ecosystem report as the default command: estimated flow into the quote token (`volume.h24 x buys / (buys + sells)`, summed and labelled as an estimate), flow as a share of the quote token's market cap, buys and sells, top 3 concentration, Herfindahl index, new pairs in 24h and 7d, deep and active pair counts.
- Pairing health score from 0 to 100 with six documented components (breadth, flow, diversification, growth, depth, buy pressure) and a grade.
- Quote token info (price, market cap, main pool) from the pools where the token is the base side.
- Via-quote routing share per paired coin, using the DexScreener batch endpoint `GET /tokens/v1/{chainId}/{addresses}` in chunks of 30. `--skip-routing` turns it off.
- `moons compare <mintA> <mintB> ...` for 2 to 5 quote tokens side by side, with the leader per metric.
- `--history <file>` snapshots in a local JSON file, deltas against the previous snapshot (also across restarts), and `moons history` with growth over time.
- Alerts for new pairs and threshold crossings (`--alert-flow`, `--alert-volume`, `--alert-health`, `--alert-pairs`) to Discord-compatible webhooks (`content` plus a `moons` JSON payload) and the Telegram Bot API `sendMessage`.
- `--graph out.html` (self-contained interactive SVG with tooltips, zoom, pan and click-through) and `--graph out.svg` (static) network graph export.
- `moons mcp`: Model Context Protocol server over stdio with the tools `scan_pairs`, `ecosystem_report`, `compare_tokens` and `new_pairs_since`.
- `moons ui`: local dashboard with a centred search, pairing health ring with the six key numbers around it, network graph, health breakdown, flow leaders, quote price line, new pairs, sortable table and auto refresh. Geist and Geist Mono ship in `src/fonts/` and are served by the dashboard itself, so it makes no external requests. JSON API at `/api/report` and `/api/health`.
- GeckoTerminal OHLCV client with a 30 requests per minute limiter, used for the quote token price line.
- `--sort flow`, `FLOW EST`, `BUYS/SELLS` and `VIA QUOTE` columns, and `flowUsd` and `routeShare` CSV fields.
- Environment variables `MOONS_GECKO_API`, `MOONS_TELEGRAM_API`, `MOONS_WEBHOOK`, `MOONS_TELEGRAM_TOKEN` and `MOONS_TELEGRAM_CHAT`.
- Brand: 3D moon app icon (`assets/icon.png`), flat mark (`assets/logo.svg`, `assets/logo-mono.svg`), coin image, banner, terminal demo and dashboard screenshot on a deep space navy palette (`#060A14`) with the ice blue `#8DB8FF` accent, Geist and Geist Mono type, pill controls and orbit ring details. `BRAND.md`, landing page in `docs/`, CI on Node 20 and 22, issue and pull request templates, security policy and code of conduct.
- Mock server now also serves the batch endpoint, GeckoTerminal OHLCV, a webhook and a Telegram endpoint, plus two more fixtures (a second quote token and a 28-pair demo ecosystem).

### Changed

- The default output is now the ecosystem report. The 0.1.0 summary fields remain in `--json` under `summary`.
- Retry-After is now parsed as seconds or as an HTTP date, and capped at 60 seconds.
- DexScreener reads are cached in memory for 15 seconds for library, dashboard and MCP use. CLI reports always fetch fresh data.
- The text table replaces the `TXNS 24H` column with `BUYS/SELLS`.
- The source moved from `src/index.js` to `src/core.js`; `src/index.js` re-exports the whole public API.

## [0.1.0] - 2026-10-14

### Added

- `moons <mint>` CLI that lists every pool where a token is the quote token, using the DexScreener `token-pairs/v1` endpoint.
- Summary block: pair count, combined 24h volume and liquidity, newest pair, biggest pair, pump.fun and PumpSwap count.
- Sorting by volume, liquidity, market cap, age or 24h change, plus `--min-liquidity` and `--limit`.
- Table, `--json` and `--csv` output. Colors on TTY only, disabled by `NO_COLOR`.
- `--watch <seconds>` mode that marks pairs which appeared since the previous poll.
- Retry with exponential backoff on HTTP 429 and 5xx, honoring `Retry-After`.
- Programmatic API: `scanPairs`, plus the helpers `filterByQuote`, `sortRows`, `summarize` and `diffPairs`.
- Offline test suite with a local mock server and fixtures.
