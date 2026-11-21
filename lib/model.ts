// The token radar (radar-3): one snapshot in, one ranked board out. No network, no clock, no randomness
// beyond a fixed seed, and no protocol name is ever special-cased: one function scores every row.
//
// A protocol is ranked when DefiLlama's record for it carries no token (no CoinGecko id, no ticker, no
// market cap). The radar says "records no token", never "has no token": the record can be incomplete.
//
//   implied value = value if a token launches x token odds x adjustments
//
//   value if it launches   TVL x multiple, the multiple fitted on the priced comps (lib/learn.ts learnValue)
//   token odds             P(a protocol like this records a token), fitted on every peer (learnOdds)
//   adjustments            x0.5 for curators and allocators (their TVL is counted in the protocols they use)
//                          x0.5 for an off-list protocol (DefiLlama records a parent for it, so it is a child)
//
// Both models are fitted on this snapshot and tested held-out: a term stays only if it lowers the held-out
// error in both leave-one-out (or ten-fold) and walk-forward. What the tests say is printed on the page.

import { bootFits, learnOdds, learnValue, oddsOf, valueOf, type Feat, type OddsModel, type Row, type ValueModel } from './learn.ts';
import { quantile } from './fit.ts';
import { ECON, farmPlan, type Plan } from './farm.ts';

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

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';
/** Off-list protocols and curators are cut by this factor, a stated rule and not a fit. */
export const HAIRCUT = 0.5;
/** How many bootstrap refits stand behind each row's rank range. */
export const BOOT = 200;
/** How many protocols the token-recorded view lists. */
export const RECORDED_ROWS = 40;

export type Confidence = 'high' | 'medium' | 'low';
export type Tier = 'watchlist' | 'early' | 'off-list';

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
  tier: Tier;
  launch_value_usd: number;
  odds: number;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  confidence: Confidence;
  multiplier: { launch_multiple: number; double_count: number; off_list: number };
  rank_range: [number, number]; // 5th to 95th percentile of the rank over the bootstrap refits
  near: { name: string; tvl_usd: number; mcap_usd: number }[]; // the three priced comps closest in size
  flags: string[];
  plan: Plan;
  farm_steps: string[];
}

/** A protocol that is not ranked, shown with what the record says. */
export interface SideRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  symbol: string | null;
  change_7d: number | null;
  fit_usd: number | null; // a priced comp: the model's held-out value for it
  why: string;
}

export interface Group {
  id: string;
  label: string;
  n: number;
}

/** Everything the dashboard needs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  boot: number;
  econ: typeof ECON;
  groups: Group[];
  total: number;
  value: Omit<ValueModel, 'fit' | 'res'>;
  odds: Omit<OddsModel, 'fit'>;
  check: { rows: number; sum: number; hash: string };
  rows: BoardRow[];
  comps: SideRow[];
  recorded: SideRow[];
  recorded_n: number;
  ledger: [string, string, string | null, number, string][];
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

/** Whole days from the listing date to the snapshot date, or null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---------------------------------------------------------------------------------------------------
// What a protocol is: every one of the snapshot's protocols lands in exactly one group.
// ---------------------------------------------------------------------------------------------------

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const BRIDGES = new Set(['Bridge', 'Canonical Bridge']);
const STAKING = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);
const WRAPPED_WORDS = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)/;
/** Curators and allocators run vaults on other protocols, so their TVL is also counted in those protocols. */
const DOUBLE_COUNTED = /curator|allocator/i;

/** Whether a protocol's record shows no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The house's own reason to set a protocol aside, or null: bridged, staked, exchange, versioned or wrapped products. */
function setAsideReason(p: SnapshotProtocol): 'bridge' | 'staking' | 'exchange' | 'versioned' | 'wrapped' | null {
  if (p.category !== null && BRIDGES.has(p.category)) return 'bridge';
  if (p.category !== null && STAKING.has(p.category)) return 'staking';
  if (p.category === 'CEX' || EXCHANGE_PREFIX.test(p.name)) return 'exchange';
  if (VERSIONED.test(p.name)) return 'versioned';
  if (WRAPPED_WORDS.test(p.name)) return 'wrapped';
  return null;
}

/** A peer is a protocol that is no bridged, staked, exchange, versioned or wrapped product: its token is its own. */
const isPeer = (p: SnapshotProtocol): boolean => setAsideReason(p) === null;

const GROUPS: [string, string][] = [
  ['watch', 'Ranked: watchlist'],
  ['early', 'Ranked: early, below the floor'],
  ['off', 'Ranked: off-list, parent recorded'],
  ['comp', 'Token trades: priced comp'],
  ['rec', 'Token recorded: no usable comp'],
  ['bridge', 'Set aside: bridge'],
  ['staking', 'Set aside: liquid staking'],
  ['exchange', 'Set aside: exchange'],
  ['versioned', 'Set aside: versioned or wrapped'],
];

/** The one group a protocol belongs to. A token on record comes first, then the house's set-aside reasons, then the ranked tiers. */
function groupOf(p: SnapshotProtocol, snapshot: Snapshot, listed: Set<string>): string {
  if (!isPreToken(p)) return isPeer(p) && p.mcap_usd !== null && p.mcap_usd > 0 ? 'comp' : 'rec';
  if (listed.has(p.slug)) return 'watch';
  const reason = setAsideReason(p);
  if (reason !== null) return reason === 'wrapped' ? 'versioned' : reason;
  return p.tvl_usd >= snapshot.floor_usd ? 'off' : 'early';
}

// ---------------------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------------------

/** The name's first word, lower case: protocols sharing it are one family. Short stems say nothing. */
const stemOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ')[0] ?? '';

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const listed = new Set(snapshot.watchlist);
  const group = new Map<string, string>();
  for (const p of snapshot.protocols) group.set(p.slug, groupOf(p, snapshot, listed));

  // Kin: another protocol with the same name stem records a token.
  const stems = new Map<string, number>();
  for (const p of snapshot.protocols) if (!isPreToken(p)) stems.set(stemOf(p.name), (stems.get(stemOf(p.name)) ?? 0) + 1);
  const ages = snapshot.protocols.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null).sort((a, b) => a - b);
  const medianYears = ages.length === 0 ? 1 : ages[Math.floor(ages.length / 2)]! / 365;
  const feat = (p: SnapshotProtocol): Feat => {
    const a = ageDays(snapshot.as_of, p.listed_at);
    const stem = stemOf(p.name);
    const others = (stems.get(stem) ?? 0) - (isPreToken(p) ? 0 : 1);
    return {
      slug: p.slug,
      lnTvl: Math.log(p.tvl_usd / 1e8),
      growth: Math.max(-30, Math.min(60, p.change_7d ?? 0)) / 100,
      ageYears: a === null ? medianYears : Math.min(a, 1825) / 365,
      lnChains: Math.log(Math.max(1, p.chains.length)),
      cat: p.category ?? '',
      kin: stem.length >= 4 && others > 0 ? 1 : 0,
      listed: p.listed_at,
    };
  };

  const compProtocols = snapshot.protocols.filter((p) => group.get(p.slug) === 'comp');
  const peerProtocols = snapshot.protocols.filter(isPeer);
  const compRows: Row[] = compProtocols.map((p) => ({ ...feat(p), y: Math.log(p.mcap_usd! / p.tvl_usd) }));
  const peerRows: Row[] = peerProtocols.map((p) => ({ ...feat(p), y: isPreToken(p) ? 0 : 1 }));
  const value = learnValue(compRows);
  const odds = learnOdds(peerRows);

  const compsInCategory = new Map<string, number>();
  for (const p of compProtocols) compsInCategory.set(p.category ?? '', (compsInCategory.get(p.category ?? '') ?? 0) + 1);

  const ranked = snapshot.protocols.filter((p) => ['watch', 'early', 'off'].includes(group.get(p.slug)!));
  const scored = ranked.map((p) => {
    const f = feat(p);
    const tier: Tier = group.get(p.slug) === 'watch' ? 'watchlist' : group.get(p.slug) === 'off' ? 'off-list' : 'early';
    const multiple = valueOf(value, f);
    const launch = p.tvl_usd * multiple;
    // Kin lifts the odds that a token is recorded because a sibling's token may cover the protocol, which is no
    // launch to wait for: such a protocol is priced as if it had no kin, and flagged.
    const o = oddsOf(odds, { ...f, kin: 0 });
    const doubleCount = DOUBLE_COUNTED.test(p.category ?? '') ? HAIRCUT : 1;
    const offList = tier === 'off-list' ? HAIRCUT : 1;
    const adj = doubleCount * offList;
    const implied = Math.max(1, Math.round(launch * o * adj));
    const low = Math.max(1, Math.min(implied, Math.round(launch * Math.exp(value.q.p25) * o * adj)));
    const high = Math.max(implied, Math.round(launch * Math.exp(value.q.p75) * o * adj));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const flags: string[] = [];
    if (p.listed_at === null) flags.push(`No listing date in the record, so its age is taken as the snapshot's median (${medianYears.toFixed(1)} years).`);
    if (p.change_7d === null) flags.push('No 7 day TVL change in the record, so growth is taken as 0.');
    if (doubleCount !== 1) flags.push(`Its TVL is largely deposits in other protocols, so the value is cut by x${HAIRCUT} to avoid counting it twice.`);
    if (tier === 'off-list') flags.push(`DefiLlama records a parent for it, so it is a child product and the value is cut by x${HAIRCUT}.`);
    if (f.kin === 1) flags.push(`Its name stem "${stemOf(p.name)}" carries a token on record elsewhere, so a token may already cover it. Its odds are priced as if it had no kin, and its confidence is low.`);
    if (p.category === 'Chain') flags.push('A network entry: its native token may exist outside DefiLlama\'s record, so treat the value with care.');
    const evidence = (p.listed_at !== null ? 1 : 0) + (p.change_7d !== null ? 1 : 0) + ((compsInCategory.get(p.category ?? '') ?? 0) >= 3 ? 1 : 0);
    const confidence: Confidence = p.category === 'Chain' || f.kin === 1 ? 'low' : evidence === 3 ? 'high' : evidence === 2 ? 'medium' : 'low';
    return { p, tier, multiple, launch, o, doubleCount, offList, implied, low, high, age, flags, confidence };
  });
  scored.sort((a, b) => b.implied - a.implied || byText(a.p.slug, b.p.slug));

  // How firm each rank is: refit both models on resampled rows and rank the board again, BOOT times.
  const boots = bootFits(value, odds, compRows, peerRows, BOOT);
  const feats = scored.map((s) => feat(s.p));
  const ranksOf: number[][] = scored.map(() => []);
  for (const bf of boots) {
    const vals = scored.map((s, i) => s.p.tvl_usd * valueOf({ fit: bf.value }, feats[i]!) * oddsOf({ fit: bf.odds }, { ...feats[i]!, kin: 0 }) * s.doubleCount * s.offList);
    const order = vals.map((v, i) => i).sort((a, b) => vals[b]! - vals[a]! || a - b);
    order.forEach((idx, pos) => ranksOf[idx]!.push(pos + 1));
  }
  const compNear = compProtocols.map((p) => ({ name: p.name, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, ln: Math.log(p.tvl_usd) }));

  const board = scored.map((s, i): BoardRow => {
    const { plan, steps } = farmPlan(s.p, s.implied, s.o, s.p.change_7d);
    const near = compNear
      .map((c) => ({ c, d: Math.abs(c.ln - Math.log(s.p.tvl_usd)) }))
      .sort((a, b) => a.d - b.d || byText(a.c.name, b.c.name))
      .slice(0, 3)
      .map(({ c }) => ({ name: c.name, tvl_usd: c.tvl_usd, mcap_usd: c.mcap_usd }));
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      listed_at: s.p.listed_at,
      age_days: s.age,
      token_status: 'records no token',
      in_watchlist: s.tier === 'watchlist',
      tier: s.tier,
      launch_value_usd: Math.max(1, Math.round(s.launch)),
      odds: round4(s.o),
      implied_value_usd: s.implied,
      implied_low_usd: s.low,
      implied_high_usd: s.high,
      confidence: s.confidence,
      multiplier: { launch_multiple: round4(s.multiple), double_count: s.doubleCount, off_list: s.offList },
      rank_range: [Math.round(quantile(ranksOf[i]!, 0.05)), Math.round(quantile(ranksOf[i]!, 0.95))],
      near,
      flags: s.flags,
      plan,
      farm_steps: steps,
    };
  });

  const side = (p: SnapshotProtocol, fit: number | null, why: string): SideRow => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, symbol: p.symbol, change_7d: p.change_7d, fit_usd: fit, why });
  const comps = compProtocols
    .map((p, i) => side(p, Math.round(p.mcap_usd! / Math.exp(value.res[i]!)), 'priced comp'))
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || byText(a.slug, b.slug));
  const recordedAll = snapshot.protocols.filter((p) => group.get(p.slug) === 'rec');
  const recorded = recordedAll
    .sort((a, b) => b.tvl_usd - a.tvl_usd || byText(a.slug, b.slug))
    .slice(0, RECORDED_ROWS)
    .map((p) => side(p, null, setAsideReason(p) !== null ? `a ${setAsideReason(p)} product` : p.mcap_usd === null ? 'ticker or CoinGecko id, no market cap' : 'market cap of zero'));

  const counts = new Map<string, number>();
  for (const g of group.values()) counts.set(g, (counts.get(g) ?? 0) + 1);
  const groups: Group[] = GROUPS.map(([id, label]) => ({ id, label, n: counts.get(id) ?? 0 }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    boot: BOOT,
    econ: ECON,
    groups,
    total: snapshot.protocols.length,
    value: (({ fit: _f, res: _r, ...rest }) => rest)(value),
    odds: (({ fit: _f, ...rest }) => rest)(odds),
    check: boardCheck(board),
    rows: board,
    comps,
    recorded,
    recorded_n: recordedAll.length,
    ledger: snapshot.protocols.map((p) => [p.slug, p.name, p.category, p.tvl_usd, group.get(p.slug)!]),
  };
  return { board, radar };
}

/** FNV-1a over the board's rank, slug and value: the page recomputes it from its own rows and compares. */
export function boardHash(rows: { rank: number; slug: string; implied_value_usd: number }[]): string {
  let h = 0x811c9dc5;
  for (const ch of rows.map((r) => `${r.rank}:${r.slug}:${r.implied_value_usd}`).join('|')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}
function boardCheck(board: BoardRow[]): RadarData['check'] {
  return { rows: board.length, sum: board.reduce((s, r) => s + r.implied_value_usd, 0), hash: boardHash(board) };
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
