// The radar's two fitted models and the tests they must pass held-out.
//
//   value model  ln(market cap / TVL) of the priced comps (protocols whose token trades), by ridge regression
//   odds model   P(a protocol records a token) over every peer-type protocol, by ridge logistic regression
//
// Every term is added in a fixed order and kept only if it lowers the held-out error in BOTH tests:
//   leave-one-out / ten-fold   each protocol (or tenth) is predicted by a fit that never saw it
//   walk-forward               a protocol listed later is predicted by a fit on protocols listed earlier only
// Nothing here is tuned by hand after seeing the board: the constants below are fixed before the fit.

import { dot, logistic, quantile, ridge, seeded, sigmoid } from './fit.ts';

/** What the models read about one protocol. */
export interface Feat {
  slug: string;
  lnTvl: number; // ln(TVL / $100M)
  growth: number; // 7 day change, capped at -30% to +60%, as a fraction; 0 when unknown
  ageYears: number; // years listed, capped at 5; the population median when unknown
  lnChains: number; // ln(number of chains)
  cat: string;
  kin: number; // 1 when another protocol with the same name stem records a token
  listed: string | null; // listing date, for walk-forward order
}

export const LAMBDA_SLOPE = 1;
export const LAMBDA_CATEGORY = 16;

type Term = 'size' | 'category' | 'growth' | 'age' | 'chains' | 'kin';
export const TERM_LABEL: Record<Term, string> = {
  size: 'size curve, ln TVL',
  category: 'category effect, ridge 16',
  growth: '7-day TVL growth',
  age: 'age, years listed',
  chains: 'chain count, ln',
  kin: 'kin of a token',
};
const VALUE_ORDER: Term[] = ['size', 'category', 'growth', 'age', 'chains'];
const ODDS_ORDER: Term[] = ['age', 'size', 'kin', 'category', 'growth', 'chains'];

/** One line of a term table: the score with this term added, in each test, and whether it was kept. */
export interface TermLine {
  term: string;
  loo: number;
  wf: number;
  kept: boolean;
}

/** Held-out figures of a final value model. */
export interface ValueTest {
  miss: number; // typical miss as a multiple (median |ln error|, exponentiated)
  within3: number; // share of real caps within x3 of the model
  cover50: number; // share inside the printed P25-P75 range
  cover80: number; // share inside the printed P10-P90 range
  n: number;
}
export interface OddsTest {
  brier: number;
  base_brier: number;
  right: number; // share called right at 50%
  base_right: number;
  n: number;
}

export interface Fit {
  terms: Term[];
  cats: string[];
  beta: number[];
}

// ---- design ------------------------------------------------------------------------------------------

function row(f: Feat, terms: Term[], cats: string[]): number[] {
  const r = [1];
  for (const t of terms) {
    if (t === 'size') r.push(f.lnTvl);
    else if (t === 'growth') r.push(f.growth);
    else if (t === 'age') r.push(f.ageYears);
    else if (t === 'chains') r.push(f.lnChains);
    else if (t === 'kin') r.push(f.kin);
    else for (const c of cats) r.push(f.cat === c ? 1 : 0);
  }
  return r;
}
function penalties(terms: Term[], cats: string[]): number[] {
  const p = [0];
  for (const t of terms) {
    if (t === 'category') for (let i = 0; i < cats.length; i++) p.push(LAMBDA_CATEGORY);
    else p.push(LAMBDA_SLOPE);
  }
  return p;
}

export interface Row extends Feat {
  y: number;
}

function fitValue(train: Row[], terms: Term[], cats: string[]): Fit {
  if (terms.length === 0) {
    // The flat baseline: one median multiple for everyone.
    return { terms, cats, beta: [quantile(train.map((r) => r.y), 0.5)] };
  }
  const beta = ridge(train.map((r) => row(r, terms, cats)), train.map((r) => r.y), penalties(terms, cats));
  return { terms, cats, beta };
}
const predictValue = (m: Fit, f: Feat): number => dot(row(f, m.terms, m.cats), m.beta);

function fitOdds(train: Row[], terms: Term[], cats: string[]): Fit {
  const beta = logistic(train.map((r) => row(r, terms, cats)), train.map((r) => r.y), penalties(terms, cats));
  return { terms, cats, beta };
}
const predictOdds = (m: Fit, f: Feat): number => sigmoid(dot(row(f, m.terms, m.cats), m.beta));

// ---- the two held-out splits --------------------------------------------------------------------------

/** For walk-forward: each test point with the rows it may learn from (listed strictly earlier, or undated). */
function walkForward<T extends Row>(rows: T[], minTrain: number): { test: T; train: T[] }[] {
  const dated = rows.filter((r) => r.listed !== null).sort((a, b) => (a.listed! < b.listed! ? -1 : a.listed! > b.listed! ? 1 : a.slug < b.slug ? -1 : 1));
  const out: { test: T; train: T[] }[] = [];
  for (const t of dated.slice(Math.floor(dated.length / 2))) {
    const train = rows.filter((r) => r.slug !== t.slug && (r.listed === null || r.listed < t.listed!));
    if (train.length >= minTrain) out.push({ test: t, train });
  }
  return out;
}

const median = (l: number[]): number => quantile(l, 0.5);
const mean = (l: number[]): number => (l.length === 0 ? 0 : l.reduce((a, b) => a + b, 0) / l.length);

/** Leave-one-out residuals (ln actual - ln predicted) of a value model over the rows. */
function looResiduals(rows: Row[], terms: Term[], cats: string[]): number[] {
  return rows.map((r, i) => r.y - predictValue(fitValue(rows.filter((_, j) => j !== i), terms, cats), r));
}

function valueScores(rows: Row[], terms: Term[], cats: string[]): { loo: number[]; wf: number[] } {
  const loo = looResiduals(rows, terms, cats);
  const wf = walkForward(rows, 25).map(({ test, train }) => test.y - predictValue(fitValue(train, terms, cats), test));
  return { loo, wf };
}
const missOf = (res: number[]): number => median(res.map(Math.abs));

/** Coverage of the printed ranges, nested: each held-out point gets the range its own training rows would print. */
function coverage(rows: Row[], terms: Term[], cats: string[]): { loo: [number, number]; wf: [number, number] } {
  const hit = (train: Row[], t: Row): [number, number] => {
    const res = looResiduals(train, terms, cats);
    const e = t.y - predictValue(fitValue(train, terms, cats), t);
    return [e >= quantile(res, 0.25) && e <= quantile(res, 0.75) ? 1 : 0, e >= quantile(res, 0.1) && e <= quantile(res, 0.9) ? 1 : 0];
  };
  const looHits = rows.map((r, i) => hit(rows.filter((_, j) => j !== i), r));
  const wfHits = walkForward(rows, 25).map(({ test, train }) => hit(train, test));
  const share = (h: [number, number][], k: 0 | 1): number => mean(h.map((x) => x[k]));
  return { loo: [share(looHits, 0), share(looHits, 1)], wf: [share(wfHits, 0), share(wfHits, 1)] };
}

// ---- the value model ----------------------------------------------------------------------------------

export interface ValueModel {
  fit: Fit;
  table: TermLine[];
  loo: ValueTest;
  wf: ValueTest;
  q: { p10: number; p25: number; p75: number; p90: number }; // held-out ln-error quantiles, for the printed ranges
  n: number;
  coef: { label: string; value: number; se: number }[];
  base_mult_at_100m: number;
  res: number[]; // leave-one-out ln errors, in the order of the rows given
}

export function learnValue(rows: Row[]): ValueModel {
  const cats = [...new Set(rows.map((r) => r.cat))].sort();
  const table: TermLine[] = [];
  const base = valueScores(rows, [], cats);
  table.push({ term: 'flat median multiple', loo: round(Math.exp(missOf(base.loo))), wf: round(Math.exp(missOf(base.wf))), kept: true });
  let kept: Term[] = [];
  let cur = { loo: missOf(base.loo), wf: missOf(base.wf) };
  for (const t of VALUE_ORDER) {
    const s = valueScores(rows, [...kept, t], cats);
    const now = { loo: missOf(s.loo), wf: missOf(s.wf) };
    const keep = now.loo < cur.loo && now.wf < cur.wf;
    table.push({ term: TERM_LABEL[t], loo: round(Math.exp(now.loo)), wf: round(Math.exp(now.wf)), kept: keep });
    if (keep) {
      kept = [...kept, t];
      cur = now;
    }
  }
  const fit = fitValue(rows, kept, cats);
  const res = valueScores(rows, kept, cats);
  const cov = coverage(rows, kept, cats);
  const within = (l: number[]): number => mean(l.map((e) => (Math.abs(e) <= Math.log(3) ? 1 : 0)));
  const test = (l: number[], c: [number, number]): ValueTest => ({ miss: round(Math.exp(missOf(l))), within3: round(within(l)), cover50: round(c[0]), cover80: round(c[1]), n: l.length });
  // Bootstrap: refit on resampled comps, 200 times, seeded.
  const rnd = seeded(20261114);
  const boots: number[][] = [];
  for (let b = 0; b < 200; b++) {
    const pick = rows.map(() => rows[Math.floor(rnd() * rows.length)]!);
    boots.push(fitValue(pick, kept, cats).beta);
  }
  const se = (j: number): number => {
    const v = boots.map((x) => x[j] ?? 0);
    const m = mean(v);
    return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  };
  const coef: ValueModel['coef'] = [{ label: 'ln multiple at $100M TVL', value: fit.beta[0]!, se: se(0) }];
  if (kept.includes('size')) coef.push({ label: 'size slope per ln TVL', value: fit.beta[1]!, se: se(1) });
  return {
    fit,
    table,
    loo: test(res.loo, cov.loo),
    wf: test(res.wf, cov.wf),
    q: { p10: quantile(res.loo, 0.1), p25: quantile(res.loo, 0.25), p75: quantile(res.loo, 0.75), p90: quantile(res.loo, 0.9) },
    n: rows.length,
    coef: coef.map((c) => ({ label: c.label, value: round(c.value), se: round(c.se) })),
    base_mult_at_100m: round(Math.exp(fit.beta[0]!)),
    res: res.loo,
  };
}

export const valueOf = (m: { fit: Fit }, f: Feat): number => Math.exp(predictValue(m.fit, f));

/** Both models refitted on resampled rows, `count` times, seeded: the spread of every row's value and rank comes from these. */
export function bootFits(value: ValueModel, odds: OddsModel, valueRows: Row[], oddsRows: Row[], count: number): { value: Fit; odds: Fit }[] {
  const rnd = seeded(20261116);
  const out: { value: Fit; odds: Fit }[] = [];
  for (let b = 0; b < count; b++) {
    const v = valueRows.map(() => valueRows[Math.floor(rnd() * valueRows.length)]!);
    const o = oddsRows.map(() => oddsRows[Math.floor(rnd() * oddsRows.length)]!);
    out.push({ value: fitValue(v, value.fit.terms, value.fit.cats), odds: fitOdds(o, odds.fit.terms, odds.fit.cats) });
  }
  return out;
}

// ---- the odds model -----------------------------------------------------------------------------------

export interface OddsModel {
  fit: Fit;
  table: TermLine[];
  tenfold: OddsTest;
  wf: OddsTest;
  n: number;
  recorded: number;
  coef: { label: string; value: number; se: number }[];
}

/** Held-out predictions: ten-fold first, then walk-forward, each with the base rate its own training rows give. */
function oddsRun(rows: Row[], terms: Term[], cats: string[]): { p: number; base: number; y: number }[][] {
  const a: { p: number; base: number; y: number }[] = [];
  for (let k = 0; k < 10; k++) {
    const train = rows.filter((_, i) => i % 10 !== k);
    const m = fitOdds(train, terms, cats);
    const base = mean(train.map((r) => r.y));
    for (let i = k; i < rows.length; i += 10) a.push({ p: predictOdds(m, rows[i]!), base, y: rows[i]!.y });
  }
  const b = walkForward(rows, 60).map(({ test, train }) => ({ p: predictOdds(fitOdds(train, terms, cats), test), base: mean(train.map((r) => r.y)), y: test.y }));
  return [a, b];
}
const brier = (l: { p: number; y: number }[]): number => mean(l.map((x) => (x.p - x.y) ** 2));
const baseBrier = (l: { base: number; y: number }[]): number => mean(l.map((x) => (x.base - x.y) ** 2));
const right = (l: { p: number; y: number }[]): number => mean(l.map((x) => ((x.p >= 0.5 ? 1 : 0) === x.y ? 1 : 0)));
const baseRight = (l: { base: number; y: number }[]): number => mean(l.map((x) => ((x.base >= 0.5 ? 1 : 0) === x.y ? 1 : 0)));

export function learnOdds(rows: Row[]): OddsModel {
  const cats = [...new Set(rows.map((r) => r.cat))].sort();
  const table: TermLine[] = [];
  const [a0, b0] = oddsRun(rows, [], cats);
  table.push({ term: 'base rate of peers', loo: round(brier(a0)), wf: round(brier(b0)), kept: true });
  let kept: Term[] = [];
  let cur = { loo: brier(a0), wf: brier(b0) };
  for (const t of ODDS_ORDER) {
    const [a, b] = oddsRun(rows, [...kept, t], cats);
    const now = { loo: brier(a), wf: brier(b) };
    const keep = now.loo < cur.loo && now.wf < cur.wf;
    table.push({ term: TERM_LABEL[t], loo: round(now.loo), wf: round(now.wf), kept: keep });
    if (keep) {
      kept = [...kept, t];
      cur = now;
    }
  }
  const fit = fitOdds(rows, kept, cats);
  const [a, b] = oddsRun(rows, kept, cats);
  const rnd = seeded(20261115);
  const boots: number[][] = [];
  for (let k = 0; k < 100; k++) boots.push(fitOdds(rows.map(() => rows[Math.floor(rnd() * rows.length)]!), kept, cats).beta);
  const se = (j: number): number => {
    const v = boots.map((x) => x[j] ?? 0);
    const m = mean(v);
    return Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
  };
  const coef: OddsModel['coef'] = [];
  let at = 1;
  for (const t of kept) {
    if (t === 'category') at += cats.length;
    else {
      coef.push({ label: TERM_LABEL[t], value: round(fit.beta[at]!), se: round(se(at)) });
      at += 1;
    }
  }
  const test = (l: typeof a): OddsTest => ({ brier: round(brier(l)), base_brier: round(baseBrier(l)), right: round(right(l)), base_right: round(baseRight(l)), n: l.length });
  return { fit, table, tenfold: test(a), wf: test(b), n: rows.length, recorded: rows.filter((r) => r.y === 1).length, coef };
}

export const oddsOf = (m: { fit: Fit }, f: Feat): number => predictOdds(m.fit, f);

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
