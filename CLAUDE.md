# GNO Flow Monitor

GNO token transfer indexer and dashboard tracking flows across Ethereum (chain 1) and Gnosis (chain 100).

Live at: https://daveai.github.io/gno-flow/

## Architecture

**Envio HyperIndex** indexes every GNO ERC-20 Transfer event from block 0 on both chains into a local Postgres/Hasura instance. A TypeScript export script queries the indexed data and writes a static JSON file consumed by the dashboard.

```
config.yaml + schema.graphql + src/EventHandlers.ts  →  Envio indexer (Docker)
                                                          ↓
                                                     Hasura GraphQL (localhost:8080)
                                                          ↓
scripts/export-summary.ts  →  docs/summary.json  →  docs/index.html (GitHub Pages)
```

## Key Files

- `config.yaml` — Envio config: two networks (Ethereum + Gnosis), GNO contract addresses, Transfer event
- `schema.graphql` — Transfer and Account entities. Account tracks running balance per chain per address
- `src/EventHandlers.ts` — Transfer handler: stores transfer, updates sender/receiver Account balances
- `scripts/export-summary.ts` — Queries Hasura for 30d transfers, computes 7d/30d inflow/outflow/net per address, classifies buy/sell activity, fetches balances, merges labels, writes `docs/summary.json`
- `docs/index.html` — Static single-file dashboard (no build step). Fetches `summary.json`, renders tables with tabs and sortable columns
- `data/labels.json` — Address labels (exchanges, protocols, DAOs, solvers). Keys are lowercase hex addresses, sorted alphabetically

## GNO Token Addresses

- Ethereum: `0x6810e776880C02933D47DB1b9fc05908e5386b96`
- Gnosis: `0x9C58BAcC331c9aa871AFD802DB6379a98e80CEdb`
- Both use 18 decimals. Values stored as raw BigInt in the indexer, converted to decimal strings in export

## Prerequisites

- **Node.js v20+** required (`tsx` and Envio need modern Node). Use `nvm use 20` if you have multiple versions. The system default may be too old — always check with `node -v` first.
- **pnpm** as package manager
- **Docker** for running the Envio indexer locally

## Commands

```bash
pnpm codegen          # Generate types from schema + config (run after schema changes)
pnpm dev              # Start indexer + Hasura (requires Docker)
pnpm stop             # Stop indexer containers
pnpm export           # Query Hasura, write docs/summary.json
```

## Environment Variables (for export script)

- `GRAPHQL_URL` — Hasura endpoint (default: `http://localhost:8080/v1/graphql`)
- `HASURA_ADMIN_SECRET` — Hasura admin secret (default: `testing`)

## Updating the Dashboard

1. Make sure the indexer is running and synced (`pnpm dev`)
2. `pnpm export` to regenerate `docs/summary.json`
3. `git add docs/summary.json && git commit -m "data: update flows" && git push`
4. GitHub Pages auto-deploys from `docs/` folder on main branch

## Data Model Notes

- Account IDs are `{chainId}_{address}` — balances are tracked per chain, summed in the export script
- Transfer IDs are `{chainId}_{blockNumber}_{logIndex}` — globally unique
- Zero address (`0x000...`) transfers represent mints/burns and are excluded from Account tracking
- The export script sorts by absolute net flow (biggest movers first), capped at top 50
- Buy/sell classification: addresses are categorized as `market` (exchanges, DEXes, aggregators, solvers), `infra` (bridges, staking, lending), or `regular` (users). Sending to market = sell, receiving from market = buy. Only regular addresses appear in the buyers & sellers tab.
- CoW Protocol TWAP orders show as standard Transfer events from GPv2Settlement (`0x9008d19f...`)

## Dashboard Details

- Static HTML, no framework, no build step — just `index.html` + `summary.json` + `favicon.png`
- Four tabs: 7-Day Flows, 30-Day Flows, Top Holders, Buyers & Sellers
- Buyers & Sellers tab has a 7d/30d period toggle (both datasets are in summary.json)
- All table columns are sortable by clicking headers (uses `data-sort` attributes for numeric/string sorting)
- Shows top 35 rows by default with "show more" button for the full 50
- Flow tabs columns: rank, address (linked to Etherscan/GnosisScan), label, balance, inflow, outflow, net, transfer count, chain
- Holders tab columns: rank, address, label, balance, transfer count, chain
- Buyers & Sellers columns: rank, address, label, balance, buy, sell, net, transfer count, chain
- ARIA tab pattern with proper `role="tablist"`, `role="tab"`, `role="tabpanel"`, and `aria-selected` attributes
- `html { overflow-y: scroll; color-scheme: dark }` prevents layout shift and enables native dark controls
- Table has horizontal scroll wrapper for mobile (`overflow-x: auto` with `min-width: 780px`)
- Fonts: Inter (UI) + JetBrains Mono (addresses/numbers) loaded from Google Fonts
- Shared helper functions (`resolveLabel`, `labelHtml`, `rowPrefix`, `rowSuffix`, `flowCells`, `finishTable`) reduce duplication across table builders
