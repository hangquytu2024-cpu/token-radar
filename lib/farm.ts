// Farm plans with the money worked out. A plan is a deposit held for some weeks; its worth is the expected
// share of a token drop, less the fees it costs to get in, stay and get out.
//
//   expected drop = drop share x implied value x deposit / (TVL + deposit)
//   fees          = gas per transaction x (weeks + 6 transactions) + 0.1% of the deposit in swap friction
//   net           = expected drop - fees                    (the verdict is made on this)
//   T-bill        = deposit x 4% a year x weeks / 52        (what the same money earns doing nothing)
//   FARM when net beats the T-bill, MARGINAL when net is positive but does not, SKIP when net is zero or less
//
// The implied value already carries the token odds, so the expected drop is a probability-weighted figure.
// Gas is a fixed table, not a feed. Nothing here says a token or an airdrop will come.

import type { SnapshotProtocol } from './model.ts';

export const ECON = {
  drop_share: 0.07,
  weeks: 12,
  tbill: 0.04,
  friction: 0.001,
  fixed_txs: 6,
  plan_share: 0.0002,
  plan_min: 250,
  plan_max: 5000,
  hours_fixed: 0.75,
  hours_per_week: 1 / 6,
};

/** Rough cost of one transaction in US dollars, by chain. A fixed table, not a price feed. */
export const GAS_USD: Record<string, number> = {
  Ethereum: 6, Solana: 0.02, Binance: 0.2, Base: 0.15, Arbitrum: 0.2, Optimism: 0.15, Polygon: 0.05, Avalanche: 0.3,
  Linea: 0.2, Scroll: 0.2, Blast: 0.15, Mantle: 0.1, Unichain: 0.1, Sonic: 0.05, 'Hyperliquid L1': 0.05, Sui: 0.05, Aptos: 0.05, Tron: 0.5, Ton: 0.05,
  Bitcoin: 3, Monad: 0.05, 'Robinhood Chain': 0.1, Plasma: 0.05, Ripple: 0.01, Fantom: 0.05, Berachain: 0.05, xDai: 0.01, Arc: 0.05, Celo: 0.02, 'zkSync Era': 0.2, Cardano: 0.2,
};
const GAS_UNKNOWN_USD = 1;

export type Verdict = 'FARM' | 'MARGINAL' | 'SKIP';

export interface Money {
  drop: number;
  fees: number;
  net: number;
  tbill: number;
  hours: number;
  verdict: Verdict;
}

/** The deposit a plan uses by default: 0.02% of the pool, so it never moves it, between $250 and $5,000. */
export function planSize(tvl: number): number {
  const raw = Math.round((tvl * ECON.plan_share) / 50) * 50;
  return Math.min(ECON.plan_max, Math.max(ECON.plan_min, raw));
}

/** The chain to use and what one transaction costs there: the cheapest of the first three chains, if under half the first's gas. */
export function chainFor(p: SnapshotProtocol): { chain: string; gasTx: number; first: string } {
  const gasOn = (c: string): number => GAS_USD[c] ?? GAS_UNKNOWN_USD;
  const first = p.chains[0] ?? 'its main chain';
  const cheapest = p.chains.slice(0, 3).filter((c) => c in GAS_USD).reduce((best, c) => (gasOn(c) < gasOn(best) ? c : best), first);
  const chain = gasOn(cheapest) < gasOn(first) / 2 ? cheapest : first;
  return { chain, gasTx: gasOn(chain), first };
}

/** The money of one plan. The dashboard runs this same arithmetic when a reader changes the deposit, drop share or weeks. */
export function economics(deposit: number, tvl: number, implied: number, gasTx: number, weeks: number, dropShare: number): Money {
  const drop = (dropShare * implied * deposit) / (tvl + deposit);
  const fees = gasTx * (weeks + ECON.fixed_txs) + ECON.friction * deposit;
  const net = drop - fees;
  const tbill = (deposit * ECON.tbill * weeks) / 52;
  const hours = ECON.hours_fixed + weeks * ECON.hours_per_week;
  return { drop, fees, net, tbill, hours, verdict: net <= 0 ? 'SKIP' : net > tbill ? 'FARM' : 'MARGINAL' };
}

/** The money in a step: cents under a dollar, whole dollars above. */
const usd = (n: number): string => {
  const a = Math.abs(n);
  const s = a < 1 ? a.toFixed(2) : a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : String(Math.round(a)).replace(/\B(?=(\d{3})+$)/g, ',');
  return `${n < 0 ? '-' : ''}$${s}`;
};

/** What a category's position looks like: the deposit step and the weekly step. */
interface Action {
  re: RegExp;
  deposit: (name: string, chain: string, k: number) => string;
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

export interface Plan {
  chain: string;
  gas_tx_usd: number;
  deposit_usd: number;
  weeks: number;
  txs: number;
  drop_usd: number;
  fees_usd: number;
  net_usd: number;
  tbill_usd: number;
  hours: number;
  verdict: Verdict;
}

/** A protocol's plan at the default settings: the figures and seven steps, each an action with its cost and time. */
export function farmPlan(p: SnapshotProtocol, implied: number, odds: number, change7d: number | null): { plan: Plan; steps: string[] } {
  const { chain, gasTx, first } = chainFor(p);
  const deposit = planSize(p.tvl_usd);
  const weeks = ECON.weeks;
  const m = economics(deposit, p.tvl_usd, implied, gasTx, weeks, ECON.drop_share);
  const txs = weeks + ECON.fixed_txs;
  const action = ACTIONS.find((a) => a.re.test(p.category ?? '')) ?? GENERIC;
  const choice = chain !== first ? ` The record lists ${chain} among its first chains and its gas is under half of ${first}'s, so confirm the app runs there before you send funds.` : '';
  const move = change7d === null ? '' : change7d >= 10 ? ` Its TVL rose ${change7d.toFixed(0)}% in the last 7 days, so expect busier pages and higher fees.` : change7d <= -10 ? ` Its TVL fell ${Math.abs(change7d).toFixed(0)}% in the last 7 days: find out why before you deposit.` : '';
  const entryGas = gasTx * 3;
  const steps = [
    `Open a fresh wallet that holds only the farm funds, send it ${usd(deposit + m.fees)} on ${chain} (the ${usd(deposit)} deposit plus ${usd(m.fees)} of fees), and keep the seed phrase offline. Cost: about ${usd(gasTx)} to move the funds in. Time: 10 minutes.${choice}`,
    `Read ${p.name}'s own docs and app for a points, rewards or season page before you deposit, and leave the app if it asks for a seed phrase. Cost: free. Time: 10 minutes.${move}`,
    `${action.deposit(p.name, chain, deposit)} Cost: ${usd(deposit)} of capital (returned when you exit, less friction) and about ${usd(entryGas)} of gas for approve, deposit and one check. Time: 15 minutes.`,
    `Every week, repeat one action. ${action.weekly} Cost: about ${usd(gasTx)} of gas a week, ${usd(gasTx * weeks)} over ${weeks} weeks. Time: 10 minutes a week.`,
    `Keep the position open for ${weeks * 7} days, so it is counted in more than one snapshot. Cost: the ${usd(deposit)} stays locked in the position and misses ${usd(m.tbill)} that a T-bill would pay. Time: ${weeks * 7} days.`,
    `Before you withdraw, claim anything only from the link the app itself publishes, then revoke the token approvals you gave it. Cost: about ${usd(gasTx * 3)} of gas. Time: 15 minutes.`,
    `Economics: expected drop ${usd(m.drop)} (${Math.round(ECON.drop_share * 1000) / 10}% of the ${usd(implied)} implied value, which already holds the ${Math.round(odds * 100)}% token odds, times your share of the pool) against ${usd(m.fees)} of fees, so ${usd(m.net)} net, ${usd(m.net / m.hours)} an hour over ${m.hours.toFixed(1)} hours. Verdict ${m.verdict}. These are estimates from the snapshot, and no token or airdrop is promised.`,
  ];
  return {
    plan: {
      chain,
      gas_tx_usd: gasTx,
      deposit_usd: deposit,
      weeks,
      txs,
      drop_usd: round2(m.drop),
      fees_usd: round2(m.fees),
      net_usd: round2(m.net),
      tbill_usd: round2(m.tbill),
      hours: round2(m.hours),
      verdict: m.verdict,
    },
    steps,
  };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
