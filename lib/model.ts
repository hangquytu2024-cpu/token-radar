// The token radar's model (radar-2): one snapshot in, one ranked board out. No network, no clock, no
// randomness, and no protocol name is ever special-cased: one function scores every row.
//
// A protocol is ranked when DefiLlama's record for it carries no token (no CoinGecko id, no ticker, no
// market cap). The radar says "records no token", never "has no token": the record can be incomplete.
//
// Implied value is the entry's own claim, built only from the snapshot's figures:
//
//   peer ratio  = median(mcap / TVL) of OTHER protocols in the same category whose token trades
//                 (wrapped, staked, bridged and exchange products are no peers; under 3 peers the
//                 all-category median is used, under 5 the ratio is pulled toward it)
//   growth      = 1 + 0.5 x clamp(change_7d, -30, +60) / 100          (unknown change: x1)
//   age         = 1 + 0.3 x min(days listed, 365) / 365                (unknown listing date: x1)
//   breadth     = 1 + 0.03 x min(chains - 1, 5)
//   double count = x0.5 for curators and allocators, whose TVL is also counted in the protocols they use
//   implied     = round(TVL x peer ratio x growth x age x breadth x double count)
//
// The age term rewards time spent without a token (pent-up demand) up to a year and then stays flat.
// A low and a high value use the 25th and 75th percentile of the same peer ratios.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  shrink_k: number;
  min_peers: number;
  double_count_factor: number;
  ratio_min: number;
  ratio_max: number;
  peer_min_tvl_usd: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  age_gain: number;
  age_full_days: number;
  breadth_step: number;
  breadth_max: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 5,
  min_peers: 3,
  double_count_factor: 0.5,
  ratio_min: 0.05,
  ratio_max: 5,
  peer_min_tvl_usd: 5_000_000,
  growth_weight: 0.5,
  growth_floor: -30,
  growth_cap: 60,
  age_gain: 0.3,
  age_full_days: 365,
  breadth_step: 0.03,
  breadth_max: 5,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the board carries, by implied value. */
export const EARLY_ROWS = 160;
/** How many protocols the Live token and Token unclear views carry. */
export const LIVE_ROWS = 24;
export const UNCLEAR_ROWS = 30;

export type Confidence = 'high' | 'medium' | 'low';
export type PeerGroup = 'category' | 'blend' | 'global';

/** One row of board.json. Extra keys are allowed by the gate; rank, slug, name, value and steps are required. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'records no token';
  in_watchlist: boolean;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  confidence: Confidence;
  model: {
    peer_ratio: number;
    peer_ratio_low: number;
    peer_ratio_high: number;
    peer_count: number;
    peer_group: PeerGroup;
    growth_multiplier: number;
    age_multiplier: number;
    breadth_multiplier: number;
    double_count_multiplier: number;
  };
  flags: string[];
  plan: { capital_usd: number; gas_usd: number; days: number };
  farm_steps: string[];
}

/** A protocol whose token trades (shown at the market's own value) or whose token status is unclear. */
export interface SideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  symbol: string | null;
  change_7d: number | null;
}

/** One line of the peer table the dashboard prints: how the anchor was built. */
export interface PeerLine {
  category: string;
  n: number;
  median_ratio: number;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  global_ratio: number;
  peers: PeerLine[];
  rows: BoardRow[];
  live: SideRow[];
  unclear: SideRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** Whole days from the listing date to the snapshot date, or null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Percentile p (0..1) of an ascending list, by linear interpolation; the median of an even list is the mean of the middle two. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const DERIVED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const DERIVED_WORDS = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;

/** Whether a protocol's record shows no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol may be ranked: pre-token, and not a versioned, wrapped, staked, bridged or exchange product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !VERSIONED.test(p.name) && !isDerivedProduct(p);
}

/** A wrapped, staked, bridged or exchange product: its value is another token's, so it is no peer and no launch. */
function isDerivedProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && DERIVED_CATEGORIES.has(p.category)) return true;
  return DERIVED_WORDS.test(p.name) || EXCHANGE_PREFIX.test(p.name);
}

/** Curators and allocators run vaults on other protocols, so their TVL is also counted in those protocols. */
const DOUBLE_COUNTED = /curator|allocator/i;

/** A protocol whose token trades, by DefiLlama's record: it has a CoinGecko id or a market cap. */
function isLive(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.mcap_usd !== null;
}

/** The mcap / TVL ratios of the protocols whose token trades, by category and in all. Sorted ascending. */
export interface PeerStats {
  byCategory: Map<string, number[]>;
  all: number[];
}

export function peerStats(snapshot: Snapshot, model: ModelConstants): PeerStats {
  const byCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isDerivedProduct(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd < model.peer_min_tvl_usd) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? '';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [ratio]);
    else list.push(ratio);
  }
  all.sort((a, b) => a - b);
  for (const list of byCategory.values()) list.sort((a, b) => a - b);
  return { byCategory, all };
}

/** The anchor ratio (mid, low, high) for a category: its own peers, pulled toward all peers when few. */
export function anchorFor(category: string | null, stats: PeerStats, model: ModelConstants): { mid: number; low: number; high: number; n: number; group: PeerGroup } {
  const own = category === null ? [] : (stats.byCategory.get(category) ?? []);
  const n = own.length;
  // Under min_peers priced peers a category says too little (one outlier moves the median): use all peers.
  const w = n < model.min_peers ? 0 : n / (n + model.shrink_k);
  const blend = (p: number): number => clamp(w * percentile(own, p) + (1 - w) * percentile(stats.all, p), model.ratio_min, model.ratio_max);
  const group: PeerGroup = n >= model.shrink_k ? 'category' : n >= model.min_peers ? 'blend' : 'global';
  return { mid: blend(0.5), low: blend(0.25), high: blend(0.75), n, group };
}

/** The scored figures for one protocol. */
export function scoreProtocol(p: SnapshotProtocol, asOf: string, stats: PeerStats, model: ModelConstants) {
  const age = ageDays(asOf, p.listed_at);
  const anchor = anchorFor(p.category, stats, model);
  const growthPct = clamp(p.change_7d ?? 0, model.growth_floor, model.growth_cap);
  const growth = 1 + (growthPct / 100) * model.growth_weight;
  const ageMult = 1 + model.age_gain * (Math.min(age ?? 0, model.age_full_days) / model.age_full_days);
  const breadth = 1 + model.breadth_step * Math.min(Math.max(p.chains.length - 1, 0), model.breadth_max);
  const doubleCounted = DOUBLE_COUNTED.test(p.category ?? '');
  const adjust = doubleCounted ? model.double_count_factor : 1;
  const scale = p.tvl_usd * growth * ageMult * breadth * adjust;
  const implied = Math.max(1, Math.round(scale * anchor.mid));
  const low = Math.max(1, Math.min(implied, Math.round(scale * anchor.low)));
  const high = Math.max(implied, Math.round(scale * anchor.high));
  const flags: string[] = [];
  if (p.listed_at === null) flags.push('No listing date in the record, so the age multiplier is left at 1.');
  if (p.change_7d === null) flags.push('No 7 day TVL change in the record, so the growth multiplier is left at 1.');
  if (doubleCounted) flags.push(`Its TVL is largely deposits in other protocols, so the value is cut by x${model.double_count_factor} to avoid counting it twice.`);
  if (anchor.group === 'global') flags.push(`Fewer than ${model.min_peers} priced peers in this category (${anchor.n}), so the all-category median is used.`);
  else if (anchor.group === 'blend') flags.push(`Only ${anchor.n} priced peers in this category, so the ratio is pulled toward the all-category median.`);
  // A network's own entry: its native token may exist outside DefiLlama's record, so never better than low.
  const isNetwork = p.category === 'Chain';
  if (isNetwork) flags.push('A network entry: its native token may exist outside DefiLlama\'s record, so treat the value with care.');
  const evidence = (anchor.n >= model.shrink_k ? 1 : 0) + (p.listed_at !== null ? 1 : 0) + (p.change_7d !== null ? 1 : 0);
  const confidence: Confidence = isNetwork ? 'low' : evidence === 3 ? 'high' : evidence === 2 ? 'medium' : 'low';
  return { age, anchor, growth, ageMult, breadth, adjust, implied, low, high, flags, confidence };
}

// ---------------------------------------------------------------------------------------------------
// Farm plans: category decides the actions, the chain decides the gas, the age decides the hold.
// ---------------------------------------------------------------------------------------------------

/** Rough cost of one transaction in US dollars, by chain. A fixed table, not a price feed. */
const GAS_USD: Record<string, number> = {
  Ethereum: 6, Solana: 0.02, Binance: 0.2, Base: 0.15, Arbitrum: 0.2, Optimism: 0.15, Polygon: 0.05, Avalanche: 0.3,
  Linea: 0.2, Scroll: 0.2, Blast: 0.15, Mantle: 0.1, Unichain: 0.1, Sonic: 0.05, 'Hyperliquid L1': 0.05, Sui: 0.05, Aptos: 0.05, Tron: 0.5, Ton: 0.05,
  Bitcoin: 3, Monad: 0.05, 'Robinhood Chain': 0.1, Plasma: 0.05, Ripple: 0.01, Fantom: 0.05, Berachain: 0.05, xDai: 0.01, Arc: 0.05, Celo: 0.02, 'zkSync Era': 0.2, Cardano: 0.2,
};
/** What a chain missing from the table is assumed to cost per transaction. */
const GAS_UNKNOWN_USD = 1;

/** Capital for one position, from the protocol's own TVL: bigger pools take a bigger position without moving. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 500;
  if (tvl >= 300_000_000) return 300;
  if (tvl >= 100_000_000) return 200;
  if (tvl >= 30_000_000) return 150;
  return 100;
}

/** Days to hold, from the protocol's age: a longer window covers more of the snapshots a points program may take. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The money in a step: cents under a dollar, whole dollars above. */
function usd(n: number): string {
  return n < 1 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

/** What a category's position looks like: the deposit step and the weekly step. */
interface Action {
  re: RegExp;
  deposit: (name: string, chain: string, capital: number) => string;
  weekly: string;
}

const ACTIONS: Action[] = [
  { re: /perp|derivative|option/i, deposit: (n, c, k) => `Deposit ${usd(k)} of USDC as margin on ${n} (${c}) and open one small position at 1x leverage.`, weekly: 'Open and close one small trade, so the account shows real trading volume.' },
  { re: /uncollateral|credit/i, deposit: (n, c, k) => `Supply ${usd(k)} of USDC to a ${n} lending pool on ${c} and keep the receipt token.`, weekly: 'Check the pool\'s health and top up or rebalance if the rate changes.' },
  { re: /lend|borrow|cdp|collateral/i, deposit: (n, c, k) => `Supply ${usd(k)} of USDC to ${n} on ${c}, then borrow a small stable amount against it.`, weekly: 'Repay and re-borrow a small amount, so both supply and borrow activity are counted.' },
  { re: /leveraged|yield|aggregator|farm/i, deposit: (n, c, k) => `Deposit ${usd(k)} of the vault's base asset into ${n} on ${c} and keep the vault shares.`, weekly: 'Compound or rebalance once, as the vault allows.' },
  { re: /dex|amm|liquidity/i, deposit: (n, c, k) => `Add ${usd(k)} of liquidity to ${n}'s deepest stable pool on ${c} and keep the LP token.`, weekly: 'Make one swap through the pool and re-center the range if it drifted.' },
  { re: /curator|allocator|vault/i, deposit: (n, c, k) => `Deposit ${usd(k)} of USDC into a ${n} vault on ${c} and keep the vault shares.`, weekly: 'Check the vault allocation page and add a small top-up.' },
  { re: /rwa|treasury|real/i, deposit: (n, c, k) => `Mint ${usd(k)} of ${n}'s yield asset on ${c}; check whether the app asks for identity checks first.`, weekly: 'Check the yield accrual and the redemption window.' },
  { re: /stable|payment/i, deposit: (n, c, k) => `Mint or deposit ${usd(k)} through ${n} on ${c} and hold the resulting stable asset.`, weekly: 'Move a small amount through the protocol\'s own transfer or savings feature.' },
  { re: /predict|bet|gam/i, deposit: (n, c, k) => `Fund ${usd(k)} on ${n} (${c}) and place one small position in an open market.`, weekly: 'Place one more small position in a new market.' },
  { re: /insur|cover/i, deposit: (n, c, k) => `Buy ${usd(k)} of cover from ${n} on ${c} for the cheapest listed risk.`, weekly: 'Renew or extend the cover if it is about to lapse.' },
  { re: /launch|nft|social|wallet/i, deposit: (n, c, k) => `Use ${n} on ${c} for one real action sized around ${usd(k)}, such as a mint, a purchase or a stake.`, weekly: 'Repeat one small action in the app.' },
];

const GENERIC: Action = {
  re: /./,
  deposit: (n, c, k) => `Deposit ${usd(k)} of USDC into ${n} on ${c} through its main app page and keep the receipt.`,
  weekly: 'Make one more small qualifying action in the app, such as a deposit, a swap or a vote.',
};

/** A protocol's plan: seven steps, each an action with its cost and time, plus the totals. */
export function farmPlan(p: SnapshotProtocol, age: number | null): { steps: string[]; capital: number; gas: number; days: number } {
  // The snapshot carries no TVL per chain, so only the first three chains the record lists are weighed (they
  // are the likeliest to hold real liquidity), and only ones with a known gas cost. Ties keep the first listed.
  const gasOn = (c: string): number => GAS_USD[c] ?? GAS_UNKNOWN_USD;
  const first = p.chains[0] ?? 'its main chain';
  const cheapest = p.chains.slice(0, 3).filter((c) => c in GAS_USD).reduce((best, c) => (gasOn(c) < gasOn(best) ? c : best), first);
  // Switch only for a real saving (under half the gas), never for a few cents.
  const chain = gasOn(cheapest) < gasOn(first) / 2 ? cheapest : first;
  const gasTx = gasOn(chain);
  const choice = chain !== first ? ` The record lists ${chain} among its first chains and its gas is under half of ${first}'s, so confirm the app runs there before you send funds.` : '';
  const capital = capitalFor(p.tvl_usd);
  const days = holdDaysFor(age);
  const weeks = Math.ceil(days / 7);
  const action = ACTIONS.find((a) => a.re.test(p.category ?? '')) ?? GENERIC;
  const gasTotal = gasTx * (1 + 2 + 2 * weeks + 2);
  const move = p.change_7d === null ? '' : p.change_7d >= 10 ? ` Its TVL rose ${p.change_7d.toFixed(0)}% in the last 7 days, so expect busier pages and higher fees.` : p.change_7d <= -10 ? ` Its TVL fell ${Math.abs(p.change_7d).toFixed(0)}% in the last 7 days: find out why before you deposit.` : '';
  const steps = [
    `Open a fresh wallet that holds only the farm funds, send it ${usd(capital + gasTotal)} on ${chain}, and keep the seed phrase offline. Cost: about ${usd(gasTx)} to move the funds in. Time: 10 minutes.${choice}`,
    `Read ${p.name}'s own docs and app for a points, rewards or season page before you deposit, and leave the app if it asks for a seed phrase. Cost: free. Time: 10 minutes.${move}`,
    `${action.deposit(p.name, chain, capital)} Cost: ${usd(capital)} of capital (returned when you exit, less fees) and about ${usd(gasTx * 2)} of gas. Time: 15 minutes.`,
    `Every week, repeat one action. ${action.weekly} Cost: about ${usd(gasTx * 2)} of gas a week, ${usd(gasTx * 2 * weeks)} over the hold. Time: 10 minutes a week for ${weeks} weeks.`,
    `Keep the position open for ${days} days, so it is counted in more than one snapshot. Cost: the ${usd(capital)} stays locked in the position. Time: ${days} days.`,
    `Before you withdraw, claim anything only from the link the app itself publishes, then revoke the token approvals you gave it. Cost: about ${usd(gasTx * 2)} of gas. Time: 15 minutes.`,
    `Plan total: about ${usd(capital)} of capital and about ${usd(gasTotal)} of gas over ${days} days. These are estimates from the snapshot, and no token or airdrop is promised.`,
  ];
  return { steps, capital, gas: Math.round(gasTotal * 100) / 100, days };
}

// ---------------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------------

/** The ranked board: the whole watchlist plus the best-valued pre-token protocols below the floor. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; stats: PeerStats } {
  const stats = peerStats(snapshot, model);
  const listed = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (listed.has(p.slug)) chosen.set(p.slug, p);
  // Below the floor only: a pre-token protocol above it that the watchlist left out is a child of another
  // protocol (DefiLlama's parent field is not in the file), so it is not a launch of its own.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => ({ p, implied: scoreProtocol(p, snapshot.as_of, stats, model).implied }))
    .sort((a, b) => b.implied - a.implied || byText(a.p.slug, b.p.slug))
    .slice(0, EARLY_ROWS);
  for (const e of early) chosen.set(e.p.slug, e.p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of, stats, model) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || byText(a.p.slug, b.p.slug));
  const board = scored.map(({ p, s }, i): BoardRow => {
    const plan = farmPlan(p, s.age);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      listed_at: p.listed_at,
      age_days: s.age,
      token_status: 'records no token',
      in_watchlist: listed.has(p.slug),
      implied_value_usd: s.implied,
      implied_low_usd: s.low,
      implied_high_usd: s.high,
      confidence: s.confidence,
      model: {
        peer_ratio: round4(s.anchor.mid),
        peer_ratio_low: round4(s.anchor.low),
        peer_ratio_high: round4(s.anchor.high),
        peer_count: s.anchor.n,
        peer_group: s.anchor.group,
        growth_multiplier: round4(s.growth),
        age_multiplier: round4(s.ageMult),
        breadth_multiplier: round4(s.breadth),
        double_count_multiplier: s.adjust,
      },
      flags: s.flags,
      plan: { capital_usd: plan.capital, gas_usd: plan.gas, days: plan.days },
      farm_steps: plan.steps,
    };
  });
  return { board, stats };
}

const side = (p: SnapshotProtocol): SideRow => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, symbol: p.symbol, change_7d: p.change_7d });

/** Protocols whose token trades, by market cap: shown at the market's own value, never ranked by the model. */
export function liveRows(snapshot: Snapshot): SideRow[] {
  return snapshot.protocols
    .filter((p) => isLive(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || byText(a.slug, b.slug))
    .slice(0, LIVE_ROWS)
    .map(side);
}

/** Protocols with a ticker but no CoinGecko id and no market cap: the record cannot say, so the board does not rank them. */
export function unclearRows(snapshot: Snapshot): SideRow[] {
  return snapshot.protocols
    .filter((p) => !isLive(p) && p.symbol !== null && p.category !== 'CEX')
    .sort((a, b) => b.tvl_usd - a.tvl_usd || byText(a.slug, b.slug))
    .slice(0, UNCLEAR_ROWS)
    .map(side);
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, stats } = buildBoard(snapshot, model);
  const peers = [...stats.byCategory.entries()]
    .map(([category, list]) => ({ category: category === '' ? 'No category' : category, n: list.length, median_ratio: round4(percentile(list, 0.5)) }))
    .sort((a, b) => b.n - a.n || byText(a.category, b.category))
    .slice(0, 15);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.in_watchlist).length,
    global_ratio: round4(percentile(stats.all, 0.5)),
    peers,
    rows: board,
    live: liveRows(snapshot),
    unclear: unclearRows(snapshot),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const protocols = o.protocols.map((v, i): SnapshotProtocol => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    const tvl = num(p.tvl_usd);
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || tvl === null) throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: tvl,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, size, ranks, order, one shared value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `the board has ${board.length} rows, the gate wants at least 100`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return `all ${board.length} rows share one implied value: a board that ranks nothing by value is not a ranking`;
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
