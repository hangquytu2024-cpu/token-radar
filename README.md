# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/hangquytu2024-cpu/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/hangquytu2024-cpu/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A dashboard that ranks DeFi protocols whose DefiLlama record shows no token, by what a token might be worth if they launched one. It reads a frozen DefiLlama snapshot, scores every protocol with one formula, and writes a ranked board, a static dashboard and a farm plan for each row.

The value is an estimate and nothing more. It comes only from numbers in the snapshot, and both models are tested on protocols they never saw:

- **Value if a token launches.** `learnValue` fits ln(market cap / TVL) on the 92 priced comps. A term stays only if it lowers the held-out miss in both leave-one-out and walk-forward (fit on protocols listed earlier, price those listed later). On this snapshot only the size curve stays: typical miss x3.27 leave-one-out and x2.43 walk-forward, against x4.65 and x4.46 for one flat multiple.
- **Token odds.** `learnOdds` fits the chance that a peer records a token (age, size, kin, category, 7 day growth), scored by Brier: 0.165 ten-fold against 0.248 for the base rate. Growth and age enter here, because they do not price a token better but they do tell which peers record one. The odds are the peers' record, not a forecast.
- **Implied value** is value if it launches x odds, with two stated rules: x0.5 for curators and allocators (their TVL is counted twice) and x0.5 for off-list protocols (DefiLlama records a parent). The printed range is the P25 to P75 of the held-out errors, and the page shows how often real caps land inside it.
- **Rank ranges.** Both models are refitted on 200 seeded bootstrap resamples and the board is ranked again each time, so every row shows a 5th to 95th percentile rank range, and its detail view lists the three traded tokens closest to it in size.
- **Accounting.** All 758 protocols land in exactly one group (198 ranked, 92 priced comps, 324 with a token recorded but no usable cap, 144 set aside as bridged, staked, exchange, versioned or wrapped), and the page recomputes the checks from its own rows.
- **Farm economics.** Each plan is a deposit held for some weeks. Expected drop = drop share x implied value x deposit / (TVL + deposit), less gas and friction, compared with a T-bill on the same money. Verdict FARM, MARGINAL or SKIP. Deposit, drop share and weeks can be changed on the page. Gas costs come from a small fixed table, not a live feed.

No protocol name is special cased. The page says a protocol "records no token", because the record can be wrong or incomplete.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Needs Node 22.18 or newer and nothing else. It works offline and gives the same bytes on every run. Open `out/dashboard/index.html` to see the page. The snapshot is not stored here: take it from the make.fun kit for the bounty.

## Files

- `main.ts` reads the snapshot, writes `board.json`, `data.js`, the dashboard, the screenshots and `dossier.json`.
- `lib/model.ts` classifies every protocol, scores the board and checks it against the gate.
- `lib/learn.ts` fits the value and odds models and runs the held-out tests; `lib/fit.ts` holds the ridge and logistic solvers.
- `lib/farm.ts` works out the money of each farm plan and writes its steps.
- `dashboard/` is the static page: plain HTML, CSS and JS, no framework.
- `vendor/makefun-board.ts` is make.fun's own helper for the dossier.

The screenshots in `screenshots/` come from this dashboard, rendered in headless Chrome.

---

<sub>Entered on [make.fun](https://make.fun/?ref=x2mfc4pb&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
