// Small numeric toolkit for the radar's fitted models: ridge regression, ridge logistic regression, a seeded
// random generator and the quantile helper. Standard library only, no randomness except the seeded one, so a
// run gives the same bytes every time.

/** Solve A x = b by Gaussian elimination with partial pivoting. A is square and is not kept. */
export function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    [M[c], M[p]] = [M[p]!, M[c]!];
    const d = M[c]![c]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / d;
      if (f !== 0) for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = Math.abs(M[r]![r]!) < 1e-12 ? 0 : s / M[r]![r]!;
  }
  return x;
}

/** Ridge regression: minimise |y - Xb|^2 + sum pen[j] b[j]^2. Column 0 is the intercept and carries pen 0. */
export function ridge(X: number[][], y: number[], pen: number[]): number[] {
  const p = pen.length;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const row = X[i]!;
    for (let j = 0; j < p; j++) {
      const xj = row[j]!;
      if (xj === 0) continue;
      b[j]! += xj * y[i]!;
      for (let k = j; k < p; k++) A[j]![k]! += xj * row[k]!;
    }
  }
  for (let j = 0; j < p; j++) {
    for (let k = 0; k < j; k++) A[j]![k] = A[k]![j]!;
    A[j]![j]! += pen[j]!;
  }
  return solve(A, b);
}

/** Ridge logistic regression by Newton steps. Returns the coefficients; column 0 is the intercept. */
export function logistic(X: number[][], y: number[], pen: number[], steps = 30): number[] {
  const p = pen.length;
  let beta = new Array<number>(p).fill(0);
  for (let it = 0; it < steps; it++) {
    const g = pen.map((q, j) => -q * beta[j]!);
    const H = Array.from({ length: p }, () => new Array<number>(p).fill(0));
    for (let i = 0; i < X.length; i++) {
      const row = X[i]!;
      let z = 0;
      for (let j = 0; j < p; j++) z += row[j]! * beta[j]!;
      const mu = 1 / (1 + Math.exp(-z));
      const w = Math.max(mu * (1 - mu), 1e-6);
      for (let j = 0; j < p; j++) {
        const xj = row[j]!;
        if (xj === 0) continue;
        g[j]! += xj * (y[i]! - mu);
        for (let k = j; k < p; k++) H[j]![k]! += w * xj * row[k]!;
      }
    }
    for (let j = 0; j < p; j++) {
      for (let k = 0; k < j; k++) H[j]![k] = H[k]![j]!;
      H[j]![j]! += pen[j]!;
    }
    const step = solve(H, g);
    let size = 0;
    beta = beta.map((v, j) => {
      size = Math.max(size, Math.abs(step[j]!));
      return v + step[j]!;
    });
    if (size < 1e-8) break;
  }
  return beta;
}

export const dot = (a: number[], b: number[]): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};
export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));

/** Quantile p (0..1) of a list, by linear interpolation. The list need not be sorted. */
export function quantile(list: number[], p: number): number {
  if (list.length === 0) return 0;
  const s = [...list].sort((a, b) => a - b);
  const at = (s.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return s[lo]! + (s[hi]! - s[lo]!) * (at - lo);
}

/** A seeded generator (mulberry32): the same seed gives the same numbers on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
