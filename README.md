# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hangquytu2024-cpu/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hangquytu2024-cpu/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A dashboard that ranks DeFi protocols whose DefiLlama record shows no token, by what a token might be worth if they launched one. It reads a frozen DefiLlama snapshot, scores every protocol with one formula, and writes a ranked board, a static dashboard and a farm plan for each row.

The value is an estimate and nothing more. It comes only from numbers in the snapshot:

- **Peer ratio.** The median market cap to TVL of other protocols in the same category whose token trades. Only peers with at least $5M of TVL count, and the ratio is kept between 0.05 and 5. A category with fewer than 3 priced peers uses the median of all categories, and one with fewer than 5 is pulled toward it. Wrapped, staked, bridged and exchange products are left out of the peer set.
- **Growth.** The 7 day TVL change, capped at -30% to +60%, at half weight.
- **Time without a token.** Up to x1.3 for a protocol listed for a year or more.
- **Chains.** 3% for each extra chain, up to 5 extra.
- **Curators and allocators** are halved, because their TVL is also counted in the protocols they deposit into.

Each row also carries a low and high value, a confidence label, and a 7 step farm plan with costs and times. Gas costs come from a small fixed table, not a live feed. No protocol name is special cased. The page says a protocol "records no token", because the record can be wrong or incomplete.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Needs Node 22.18 or newer and nothing else. It works offline and gives the same bytes on every run. Open `out/dashboard/index.html` to see the page. The snapshot is not stored here: take it from the make.fun kit for the bounty.

## Files

- `main.ts` reads the snapshot, writes `board.json`, `data.js`, the dashboard, the screenshots and `dossier.json`.
- `lib/model.ts` is the scoring model and the farm plans.
- `dashboard/` is the static page: plain HTML, CSS and JS, no framework.
- `vendor/makefun-board.ts` is make.fun's own helper for the dossier.

The screenshots in `screenshots/` come from this dashboard, rendered in headless Chrome.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x2mfc4pb&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
