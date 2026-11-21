// Token launch radar dashboard. Reads window.RADAR (written by main.ts from the same board.json) and draws the
// headline figures, the accounting of every protocol, the held-out evidence, the board, the filters and the
// detail panel. No network, no framework, no storage. The farm money is worked out here by econ(), the same
// arithmetic as economics() in lib/farm.ts, so a reader can change the deposit, the drop share and the weeks.
(function () {
  'use strict';
  const R = window.RADAR;
  const $ = (id) => document.getElementById(id);
  if (!R || !Array.isArray(R.rows)) {
    $('board').textContent = 'No data: data.js did not load, so there is nothing to draw.';
    return;
  }
  const E = R.econ;

  // ---- helpers -------------------------------------------------------------------------------------
  /** Build an element: attributes as an object, children as strings or nodes. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in attrs || {}) {
      if (attrs[k] === false || attrs[k] == null) continue;
      if (k === 'class') el.className = attrs[k];
      else el.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const money = (n) => {
    if (n == null) return 'n/a';
    if (n < 0) return '-' + money(-n);
    return n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : n >= 1e4 ? '$' + Math.round(n / 1e3) + 'K' : n >= 100 ? '$' + Math.round(n).toLocaleString('en-US') : '$' + n.toFixed(2);
  };
  const pct = (n) => (n == null ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  const share = (n) => Math.round(n * 100) + '%';
  const pp = (n) => String(Math.round(n * 1000) / 10) + '%';
  const age = (d) => (d == null ? 'n/a' : d >= 730 ? (d / 365).toFixed(1) + ' y' : d >= 60 ? Math.round(d / 30.4) + ' mo' : d + ' d');
  const times = (n) => '×' + n.toFixed(2);
  const fnv = (s) => {
    let x = 0x811c9dc5;
    for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    return x.toString(16).padStart(8, '0');
  };
  const LABEL = Object.fromEntries(R.groups.map((g) => [g.id, g.label]));

  // ---- state, kept in the URL hash so a view can be shared and reopened -----------------------------
  const P = new URLSearchParams(location.hash.slice(1));
  const S = {
    view: P.get('view') || 'radar', q: P.get('q') || '', cat: P.get('cat') || '', chain: P.get('chain') || '', tier: P.get('tier') || '', verdict: P.get('verdict') || '',
    dep: P.get('dep') || 'plan', drop: Number(P.get('drop')) || E.drop_share, weeks: Number(P.get('weeks')) || E.weeks, tbill: P.get('tbill') === null ? E.tbill : Number(P.get('tbill')),
    sort: P.get('sort') || 'rank', dir: P.get('dir') === 'desc' ? -1 : 1, sel: P.get('sel') || '', hide: P.get('hide') === 'true',
  };
  function save() {
    const p = new URLSearchParams();
    const def = { view: 'radar', q: '', cat: '', chain: '', tier: '', verdict: '', dep: 'plan', drop: E.drop_share, weeks: E.weeks, tbill: E.tbill, sel: '', hide: false };
    for (const k in def) if (S[k] !== def[k]) p.set(k, S[k]);
    if (S.sort !== 'rank' || S.dir !== 1) { p.set('sort', S.sort); if (S.dir === -1) p.set('dir', 'desc'); }
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---- the farm money: the same arithmetic as economics() in lib/farm.ts ----------------------------
  function econ(r) {
    const dep = S.dep === 'plan' ? r.plan.deposit_usd : Number(S.dep);
    const drop = (S.drop * r.implied_value_usd * dep) / (r.tvl_usd + dep);
    const fees = r.plan.gas_tx_usd * (S.weeks + E.fixed_txs) + E.friction * dep;
    const net = drop - fees;
    const tbill = (dep * S.tbill * S.weeks) / 52;
    const hours = E.hours_fixed + S.weeks * E.hours_per_week;
    return { dep, drop, fees, net, tbill, hours, perHour: net / hours, verdict: net <= 0 ? 'SKIP' : net > tbill ? 'FARM' : 'MARGINAL' };
  }
  const refresh = () => R.rows.forEach((r) => { r.e = econ(r); });

  // ---- the views -----------------------------------------------------------------------------------
  const sub = (r) => (r.category || 'No category') + (r.chains && r.chains.length ? ' · ' + r.chains[0] + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : '') : '');
  const nameCell = (r) => h('td', { class: 'name', title: r.name }, r.name, r.tier === 'watchlist' ? h('span', { class: 'tag' }, 'Watchlist') : r.tier === 'off-list' ? h('span', { class: 'tag off' }, 'Off-list') : null, h('small', null, sub(r)));
  const num = (v, cls) => h('td', { class: 'num ' + (cls || '') }, v);
  const chg = (r) => num(pct(r.change_7d), r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : '');
  const missOf = (r) => Math.max(r.fit_usd / r.mcap_usd, r.mcap_usd / r.fit_usd);
  const lows = R.rows.map((r) => Math.max(r.implied_low_usd, 1)), highs = R.rows.map((r) => Math.max(r.implied_high_usd, 1));
  const lMin = Math.log10(Math.min(...lows)), lMax = Math.log10(Math.max(...highs));
  const pos = (v) => (100 * (Math.log10(Math.max(v, 1)) - lMin)) / (lMax - lMin || 1);
  const VIEWS = {
    radar: { label: 'No token recorded', rows: R.rows, note: 'Protocols whose record carries no token, ranked by implied value = value if it launches x token odds.' },
    trades: { label: 'Token trades', rows: R.comps, note: 'Priced comps: the tokens that trade. Each model value is held-out (the fit never saw that protocol). Never ranked.' },
    recorded: { label: 'Token recorded, no usable cap', rows: R.recorded, note: `The ${R.recorded.length} largest of ${R.recorded_n} that record a ticker or CoinGecko id but no usable comp. Not ranked.` },
    ledger: { label: 'All ' + R.total, rows: R.ledger.map((l) => ({ slug: l[0], name: l[1], category: l[2], tvl_usd: l[3], group: l[4] })), note: 'Every protocol in the snapshot, and the one group it is accounted in.' },
  };
  const COLS = {
    radar: [
      { k: 'rank', t: '#', num: 1, v: (r) => r.rank, c: (r) => h('td', { class: 'num rank', title: `5th to 95th percentile rank over ${R.boot} refits` }, String(r.rank), h('small', null, r.rank_range[0] + '-' + r.rank_range[1])) },
      { k: 'name', t: 'Protocol', v: (r) => r.name, c: nameCell },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd, c: (r) => num(money(r.tvl_usd)) },
      { k: 'change', t: '7d', num: 1, v: (r) => (r.change_7d == null ? -1e9 : r.change_7d), c: chg },
      { k: 'age', t: 'Age', num: 1, v: (r) => (r.age_days == null ? -1 : r.age_days), c: (r) => num(age(r.age_days)) },
      { k: 'odds', t: 'Token odds', num: 1, v: (r) => r.odds, c: (r) => h('td', { class: 'num' }, h('span', { class: 'mini' }, h('i', { style: `width:${r.odds * 100}%` })), share(r.odds)) },
      { k: 'launch', t: 'If launched', num: 1, v: (r) => r.launch_value_usd, c: (r) => num(money(r.launch_value_usd)) },
      { k: 'implied', t: 'Implied value', num: 1, v: (r) => r.implied_value_usd, c: (r) => h('td', { class: 'num val' }, money(r.implied_value_usd), h('span', { class: 'range', title: `P25 to P75: ${money(r.implied_low_usd)} to ${money(r.implied_high_usd)}` }, h('i', { style: `left:${pos(r.implied_low_usd).toFixed(1)}%;width:${Math.max(2, pos(r.implied_high_usd) - pos(r.implied_low_usd)).toFixed(1)}%` }), h('b', { style: `left:${pos(r.implied_value_usd).toFixed(1)}%` }))) },
      { k: 'verdict', t: 'Verdict, net', v: (r) => r.e.net, c: (r) => h('td', { class: 'verdict' }, h('span', { class: 'v ' + r.e.verdict }, r.e.verdict), h('small', { class: r.e.net > 0 ? 'up' : 'down' }, money(r.e.net) + ' on ' + money(r.e.dep)), h('small', { class: 'sub' }, money(r.e.fees) + ' fees, ' + S.weeks + ' wk')) },
      { k: 'hour', t: 'Net / hour', num: 1, v: (r) => r.e.perHour, c: (r) => num(money(r.e.perHour), r.e.perHour > 0 ? 'up' : 'down') },
    ],
    trades: [
      { k: 'name', t: 'Protocol', v: (r) => r.name, c: nameCell },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd, c: (r) => num(money(r.tvl_usd)) },
      { k: 'change', t: '7d', num: 1, v: (r) => (r.change_7d == null ? -1e9 : r.change_7d), c: chg },
      { k: 'mcap', t: 'Market cap', num: 1, v: (r) => r.mcap_usd, c: (r) => num(money(r.mcap_usd)) },
      { k: 'fit', t: 'Model, held-out', num: 1, v: (r) => r.fit_usd, c: (r) => num(money(r.fit_usd)) },
      { k: 'miss', t: 'Miss', num: 1, v: missOf, c: (r) => num(times(missOf(r)), missOf(r) <= 3 ? 'up' : 'down') },
    ],
    recorded: [
      { k: 'name', t: 'Protocol', v: (r) => r.name, c: nameCell },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd, c: (r) => num(money(r.tvl_usd)) },
      { k: 'mcap', t: 'Market cap', num: 1, v: (r) => r.mcap_usd || 0, c: (r) => num(money(r.mcap_usd)) },
      { k: 'symbol', t: 'Ticker', v: (r) => r.symbol || '', c: (r) => h('td', null, r.symbol || 'n/a') },
      { k: 'why', t: 'Why not a comp', v: (r) => r.why, c: (r) => h('td', { class: 'muted' }, r.why) },
    ],
    ledger: [
      { k: 'name', t: 'Protocol', v: (r) => r.name, c: (r) => h('td', { class: 'name' }, r.name) },
      { k: 'category', t: 'Category', v: (r) => r.category || '', c: (r) => h('td', { class: 'muted' }, r.category || 'n/a') },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd, c: (r) => num(money(r.tvl_usd)) },
      { k: 'group', t: 'Group', v: (r) => LABEL[r.group], c: (r) => h('td', { class: 'g-' + r.group }, h('span', { class: 'legend' }, h('span', null, LABEL[r.group]))) },
    ],
  };
  const cols = () => COLS[S.view];
  const defaultSort = () => (S.view === 'radar' ? ['rank', 1] : [S.view === 'trades' ? 'mcap' : 'tvl', -1]);

  function visible() {
    const q = S.q.trim().toLowerCase();
    const list = VIEWS[S.view].rows.filter((r) =>
      (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
      (!S.cat || r.category === S.cat) &&
      (!S.chain || (r.chains || []).includes(S.chain)) &&
      (S.view !== 'radar' || ((!S.tier || r.tier === S.tier) && (!S.verdict || r.e.verdict === S.verdict))));
    const col = cols().find((c) => c.k === S.sort) || cols()[0];
    return list.slice().sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return c * S.dir || a.slug.localeCompare(b.slug);
    });
  }

  // ---- headline figures, accounting, evidence ------------------------------------------------------
  function drawHeader() {
    $('sub').textContent = `DefiLlama snapshot ${R.as_of}, model ${R.model_version}, ${R.total} protocols read, no network and no hand-picked names. A protocol that records no token is not one that has none: the record can be incomplete. Not advice.`;
    $('tabs').replaceChildren(...Object.keys(VIEWS).map((k) => h('button', { type: 'button', 'aria-pressed': String(S.view === k), 'data-view': k }, `${VIEWS[k].label} (${VIEWS[k].rows.length})`)));
  }

  /** The headline and the one formula every row is priced by, with its fitted numbers. */
  function drawFormula() {
    const V = R.value, c = V.coef;
    const launch = c.length > 1 ? `${money(Math.exp(c[0].value) * 1e8)} x (TVL / $100M)^${(1 + c[1].value).toFixed(2)}` : `TVL x ${V.base_mult_at_100m}`;
    $('formula').replaceChildren(
      h('p', { class: 'lede' }, `${R.rows.length} protocols record no token. Here is what each launch would be worth, and how to farm it.`),
      h('p', null, h('code', null, `implied value = ${launch} x token odds x adjustments`), `. The first term is fitted on the ${V.n} tokens that trade and tested held-out; the odds are fitted on ${R.odds.n} peers; every row and its farm plan come from this one formula. ${R.boot} refits give each row its rank range.`),
    );
  }

  function drawKpis() {
    const V = R.value, O = R.odds;
    const n = (v) => R.rows.filter((r) => r.e.verdict === v).length;
    const best = R.rows.slice().sort((a, b) => b.e.perHour - a.e.perHour)[0];
    const total = R.rows.reduce((s, r) => s + r.implied_value_usd, 0);
    const wl = R.rows.filter((r) => r.tier === 'watchlist').length;
    const kpi = (t, big, sm, note) => h('div', { class: 'kpi' }, h('small', null, t), h('strong', null, big, sm ? h('i', null, ' ' + sm) : null), h('span', null, note));
    $('kpis').replaceChildren(
      kpi('Ranked', String(R.rows.length), `of ${R.total}`, `record no token: ${wl} of ${R.groups[0].n} on the watchlist, ${R.groups[2].n} off-list, ${R.groups[1].n} below the ${money(R.floor_usd)} floor`),
      kpi('Implied value', money(total), '', `summed over the board; rank 1 is ${R.rows[0].name} at ${money(R.rows[0].implied_value_usd)}`),
      kpi('Held-out miss, value', times(V.loo.miss), `vs ${times(V.table[0].loo)} flat`, `leave-one-out over ${V.loo.n} traded tokens; walk-forward ${times(V.wf.miss)} on the ${V.wf.n} newest`),
      kpi('Range holds', share(V.loo.cover50), `· ${share(V.wf.cover50)}`, `of held-out caps fall inside the printed P25-P75 range (stated 50%), leave-one-out · walk-forward`),
      kpi('Odds, Brier', O.tenfold.brier.toFixed(3), `vs ${O.tenfold.base_brier.toFixed(3)}`, `ten-fold over ${O.n} peers; called right ${share(O.tenfold.right)} vs ${share(O.tenfold.base_right)} for the base rate`),
      kpi('Worth farming', `${n('FARM')} FARM`, '', `${n('MARGINAL')} marginal, ${n('SKIP')} skip at these settings. Best per hour: ${best.name}, ${money(best.e.perHour)}`),
    );
  }

  function checks() {
    const rows = R.rows;
    const hash = fnv(rows.map((r) => r.rank + ':' + r.slug + ':' + r.implied_value_usd).join('|'));
    const inOrder = rows.every((r, i) => r.rank === i + 1);
    const noRise = rows.every((r, i) => i === 0 || r.implied_value_usd <= rows[i - 1].implied_value_usd);
    const sum = rows.reduce((s, r) => s + r.implied_value_usd, 0);
    const groupN = R.groups.reduce((s, g) => s + g.n, 0);
    const wl = rows.filter((r) => r.tier === 'watchlist').length;
    const known = new Set(R.ledger.map((l) => l[0]));
    return [
      [hash === R.check.hash && rows.length === R.check.rows, `this table = board.json: ${rows.length} rows, checksum ${hash}`],
      [inOrder, `ranks 1 to ${rows.length} in order`],
      [noRise, 'values never rise down the board'],
      [sum === R.check.sum, `totals equal: ${money(sum)}`],
      [wl === R.groups[0].n, `watchlist ${wl} of ${R.groups[0].n} ranked`],
      [groupN === R.total && R.ledger.length === R.total && rows.every((r) => known.has(r.slug)), `ledger ${groupN} of ${R.total} protocols`],
    ];
  }

  function drawAccounting() {
    $('acct').replaceChildren(
      h('h3', null, `${R.total} protocols read, each accounted for in exactly one group`),
      h('div', { class: 'stack', role: 'img', 'aria-label': 'Share of protocols by group' }, R.groups.map((g) => h('i', { class: 'g-' + g.id, style: `flex:${g.n}`, title: `${g.label}: ${g.n}` }))),
      h('div', { class: 'legend' }, R.groups.map((g) => h('span', { class: 'g-' + g.id }, g.label + ' ', h('b', null, String(g.n))))),
      h('div', { class: 'chips' }, checks().map(([ok, t]) => h('span', { class: 'chip' + (ok ? '' : ' fail') }, (ok ? '✓ ' : '✗ ') + t))),
    );
  }

  /** A held-out term table: each row is a model with the term added in order, scored in two tests. */
  function termTable(lines, fmt, heads) {
    return h('table', { class: 'ev' }, h('thead', null, h('tr', null, h('th', null, 'Term, added in order'), heads.map((t) => h('th', null, t)), h('th', null, ''))),
      h('tbody', null, lines.map((l, i) => h('tr', { class: l.kept ? 'kept' : 'drop' }, h('td', null, l.term), h('td', null, fmt(l.loo)), h('td', null, fmt(l.wf)), h('td', null, h('em', null, i === 0 ? 'baseline' : l.kept ? 'kept' : 'not kept'))))));
  }

  function drawEvidence() {
    const V = R.value, O = R.odds;
    const lost = V.table.filter((l, i) => i > 0 && !l.kept).map((l) => l.term);
    const won = V.table.filter((l, i) => i > 0 && l.kept).map((l) => l.term);
    const oddsWon = O.table.filter((l, i) => i > 0 && l.kept).map((l) => l.term);
    const row = (t, a, b) => h('tr', null, h('td', null, t), h('td', null, share(a)), h('td', null, share(b)));
    const coef = (c) => `${c.label} ${c.value >= 0 ? '+' : ''}${c.value.toFixed(2)} ± ${c.se.toFixed(2)}`;
    $('evidence').replaceChildren(
      h('div', null, h('h3', null, `Value if a token launches: typical miss, ${V.n} traded tokens`), termTable(V.table, times, ['Leave-one-out', 'Walk-forward']),
        h('p', { class: 'muted' }, `A term is kept only if it lowers the held-out miss in both tests. Kept: ${won.join(', ') || 'none'}. Not kept: ${lost.join(', ')}. Growth and age do not price a token better, so they enter through the odds, where they do help.`)),
      h('div', null, h('h3', null, `Token odds: Brier score, ${O.n} peers (${O.recorded} record a token)`), termTable(O.table, (x) => x.toFixed(3), ['Ten-fold', 'Walk-forward']),
        h('p', { class: 'muted' }, `Called right at 50%: ${share(O.tenfold.right)} ten-fold and ${share(O.wf.right)} walk-forward, against ${share(O.tenfold.base_right)} and ${share(O.wf.base_right)} for the base rate. The odds are the peers' record (a protocol that looks like this one records a token this often), not a forecast. Kept: ${oddsWon.join(', ')}.`)),
      h('div', null, h('h3', null, 'Is the printed range honest?'),
        h('table', { class: 'ev' }, h('thead', null, h('tr', null, h('th', null, 'Share of real caps'), h('th', null, 'Leave-one-out'), h('th', null, 'Walk-forward'))),
          h('tbody', null, row('within x3 of the model', V.loo.within3, V.wf.within3), row('inside P25-P75, stated 50%', V.loo.cover50, V.wf.cover50), row('inside P10-P90, stated 80%', V.loo.cover80, V.wf.cover80))),
        h('p', { class: 'muted' }, 'Each range is the one its own training rows would print, so none of these is in-sample. The walk-forward column fits protocols listed earlier and prices those listed later.'),
        h('p', { class: 'muted' }, `Fitted, ± bootstrap s.e. (200 refits): multiple at $100M TVL ${times(V.base_mult_at_100m)}; ${V.coef.slice(1).map(coef).join('; ')}. Odds in logits: ${O.coef.map(coef).join('; ')}.`),
        h('div', { class: 'scatter', id: 'scatter' }),
        h('p', { class: 'muted' }, `Market cap on TVL, log scales. Amber: the ${R.comps.length} tokens that trade. Green line: the fitted size curve, with its P25-P75 band. Green dots: each board row's value if it launches.`)),
    );
    drawScatter();
  }

  // ---- controls, filters ---------------------------------------------------------------------------
  function drawControls() {
    const on = S.view === 'radar';
    const opt = (v, t, cur) => h('option', { value: v, selected: String(v) === String(cur) }, t);
    $('controls').hidden = !on;
    $('controls').replaceChildren(
      h('label', null, 'Deposit', h('select', { id: 'dep' }, opt('plan', 'plan size, 0.02% of TVL', S.dep), opt('1000', '$1,000', S.dep), opt('10000', '$10,000', S.dep))),
      h('label', null, 'Drop share', h('select', { id: 'drop' }, [0.035, 0.07, 0.14].map((d) => opt(d, pp(d) + ' of value', S.drop)))),
      h('label', null, 'T-bill yield', h('select', { id: 'tbill' }, [0, 0.04, 0.08].map((d) => opt(d, pp(d) + ' a year', S.tbill)))),
      h('label', null, h('span', null, 'Horizon: ', h('output', { id: 'wk' }, S.weeks + ' wk')), h('input', { id: 'weeks', type: 'range', min: '4', max: '26', step: '1', value: String(S.weeks) })),
    );
  }

  function drawFilters() {
    const rows = VIEWS[S.view].rows;
    const uniq = (f) => [...new Set(rows.flatMap(f).filter(Boolean))].sort();
    const sel = (id, label, opts, val, all) => h('label', null, label, h('select', { id }, h('option', { value: '' }, all), opts.map((o) => h('option', { value: o[0], selected: o[0] === val }, o[1]))));
    const two = (l) => l.map((x) => [x, x]);
    const radar = S.view === 'radar';
    $('filters').replaceChildren(...[
      h('label', null, 'Search', h('input', { id: 'q', type: 'search', placeholder: 'Name, chain, category', value: S.q })),
      sel('cat', 'Category', two(uniq((r) => [r.category])), S.cat, 'All categories'),
      S.view === 'ledger' ? null : sel('chain', 'Chain', two(uniq((r) => r.chains || [])), S.chain, 'All chains'),
      radar ? sel('tier', 'Tier', [['watchlist', 'Watchlist'], ['early', 'Early, below the floor'], ['off-list', 'Off-list']], S.tier, 'All tiers') : null,
      radar ? sel('verdict', 'Verdict', two(['FARM', 'MARGINAL', 'SKIP']), S.verdict, 'Any verdict') : null,
      h('button', { type: 'button', id: 'reset' }, 'Reset'),
      radar ? h('button', { type: 'button', id: 'csv' }, 'CSV') : null,
      h('button', { type: 'button', id: 'hide' }, S.hide ? 'Show summary' : 'Hide summary'),
    ].filter(Boolean));
    $('acct').hidden = $('evidence').hidden = S.hide;
  }

  /** Market cap on TVL, log scales: the traded tokens, and the board's value if it launches on the fitted curve. */
  function drawScatter() {
    const pts = [...R.comps.map((c) => [c.tvl_usd, c.mcap_usd, 0]), ...R.rows.map((r) => [r.tvl_usd, r.launch_value_usd, 1])];
    const lx = pts.map((p) => Math.log10(p[0])), ly = pts.map((p) => Math.log10(p[1]));
    const x0 = Math.floor(Math.min(...lx)), x1 = Math.ceil(Math.max(...lx)), y0 = Math.floor(Math.min(...ly)), y1 = Math.ceil(Math.max(...ly));
    const W = 300, H = 160;
    const sx = (v) => 36 + ((v - x0) / (x1 - x0)) * (W - 42), sy = (v) => H - 16 - ((v - y0) / (y1 - y0)) * (H - 24);
    const V = R.value, k = V.coef.length > 1 ? V.coef[1].value : 0, L = Math.LN10;
    const fit = (lx, q) => lx + (V.coef[0].value + k * (lx * L - Math.log(1e8)) + q) / L;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Market cap against TVL, log scales"><clipPath id="cp"><rect x="36" y="8" width="${W - 42}" height="${H - 24}"/></clipPath>`;
    const xy = (lx, q) => `${sx(lx).toFixed(1)},${sy(fit(lx, q)).toFixed(1)}`;
    s += `<g clip-path="url(#cp)"><polygon fill="#5cf2a8" opacity="0.13" points="${xy(x0, V.q.p25)} ${xy(x1, V.q.p25)} ${xy(x1, V.q.p75)} ${xy(x0, V.q.p75)}"/><polyline fill="none" stroke="#5cf2a8" stroke-width="1.4" points="${xy(x0, 0)} ${xy(x1, 0)}"/></g>`;
    for (let d = x0; d <= x1; d++) s += `<line x1="${sx(d).toFixed(1)}" x2="${sx(d).toFixed(1)}" y1="8" y2="${H - 16}" stroke="#1b3329"/><text x="${sx(d).toFixed(1)}" y="${H - 4}" text-anchor="middle">${money(Math.pow(10, d))}</text>`;
    for (let d = y0; d <= y1; d++) s += `<line y1="${sy(d).toFixed(1)}" y2="${sy(d).toFixed(1)}" x1="36" x2="${W - 6}" stroke="#1b3329"/><text x="32" y="${(sy(d) + 3).toFixed(1)}" text-anchor="end">${money(Math.pow(10, d))}</text>`;
    for (const p of pts) s += `<circle cx="${sx(Math.log10(p[0])).toFixed(1)}" cy="${sy(Math.log10(p[1])).toFixed(1)}" r="${p[2] ? 1.5 : 2.4}" fill="${p[2] ? '#5cf2a8' : '#f2c14e'}" opacity="${p[2] ? 0.75 : 0.8}"/>`;
    $('scatter').innerHTML = s + '</svg>';
  }

  // ---- the board and the detail panel --------------------------------------------------------------
  function drawBoard(list) {
    const cs = cols();
    $('count').textContent = `${list.length} of ${VIEWS[S.view].rows.length} rows. ${VIEWS[S.view].note}`;
    if (!list.length) {
      $('board').replaceChildren(h('div', { class: 'empty' }, h('strong', null, 'No protocol matches these filters.'), 'Clear the search or press Reset to see the whole board again.'));
      return;
    }
    const head = h('tr', null, cs.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '', 'aria-sort': S.sort === c.k ? (S.dir === 1 ? 'ascending' : 'descending') : 'none' }, h('button', { type: 'button', 'data-sort': c.k }, c.t + (S.sort === c.k ? (S.dir === 1 ? ' ▲' : ' ▼') : '')))));
    const body = list.map((r) => h('tr', { tabindex: '0', 'data-slug': r.slug, 'aria-selected': String(r.slug === S.sel) }, cs.map((c) => c.c(r))));
    $('board').replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  const line = (label, why, val, total) => h('tr', { class: total ? 'total' : '' }, h('td', null, label, why ? h('small', null, why) : null), h('td', null, val));

  function drawDetail(r) {
    const d = $('detail');
    if (!r) { d.replaceChildren(h('div', { class: 'empty' }, h('strong', null, 'Nothing selected.'), 'Pick a row to see how its value is built and what the plan nets.')); return; }
    if (S.view !== 'radar') {
      const text = S.view === 'trades' ? `Its token trades at ${money(r.mcap_usd)}. A model that never saw it prices it at ${money(r.fit_usd)}, a miss of ${times(missOf(r))}. It is a comp for the board, never ranked.`
        : S.view === 'recorded' ? `The record shows ${r.symbol ? 'the ticker ' + r.symbol : 'a CoinGecko id'} but no usable market cap (${r.why}). It is not a comp and not a launch to wait for.`
        : `Group: ${LABEL[r.group]}.`;
      d.replaceChildren(h('h2', null, r.name), h('p', { class: 'status' }, `${r.category || 'No category'}. TVL ${money(r.tvl_usd)}.`), h('p', null, text));
      return;
    }
    const e = r.e, m = r.multiplier;
    d.replaceChildren(...[
      h('h2', null, r.name),
      h('p', { class: 'status' }, `Records no token in the snapshot. ${sub(r)}. Rank ${r.rank} of ${R.rows.length}${r.tier === 'watchlist' ? ', on the watchlist' : r.tier === 'off-list' ? ', off the watchlist (a parent is recorded)' : ', below the floor'}.`),
      h('div', { class: 'big' }, h('strong', null, money(r.implied_value_usd)), h('span', null, `implied, P25-P75 ${money(r.implied_low_usd)} to ${money(r.implied_high_usd)}`)),
      h('h3', null, 'How the value is built'),
      h('table', { class: 'calc' }, h('tbody', null,
        line('TVL', 'DefiLlama, snapshot date', money(r.tvl_usd)),
        line('Fitted multiple at this size', 'market cap / TVL of the priced comps, size curve', times(m.launch_multiple)),
        line('Value if a token launches', null, money(r.launch_value_usd)),
        line('Token odds', 'peers like this record a token this often', share(r.odds)),
        m.double_count !== 1 ? line('Double counting', 'its TVL sits in other protocols too', times(m.double_count)) : null,
        m.off_list !== 1 ? line('Off-list, parent recorded', 'a child product of another protocol', times(m.off_list)) : null,
        line('Implied value', `rank ${r.rank}, 5th to 95th percentile ${r.rank_range[0]} to ${r.rank_range[1]} over ${R.boot} refits`, money(r.implied_value_usd), true))),
      h('h3', null, 'Closest traded tokens by size'),
      h('table', { class: 'calc' }, h('tbody', null, r.near.map((n) => line(n.name, `TVL ${money(n.tvl_usd)}, market cap ${times(n.mcap_usd / n.tvl_usd)} TVL`, money(n.mcap_usd))))),
      r.flags.length ? h('ul', { class: 'flags' }, r.flags.map((t) => h('li', null, t))) : null,
      h('h3', null, `Farm economics: ${money(e.dep)} for ${S.weeks} weeks, ${pp(S.drop)} drop`),
      h('table', { class: 'calc' }, h('tbody', null,
        line('Expected drop', `${pp(S.drop)} of implied value, times your share of the pool`, money(e.drop)),
        line('Fees', `${money(r.plan.gas_tx_usd)} gas x ${S.weeks + E.fixed_txs} transactions on ${r.plan.chain}, plus 0.1% friction`, money(e.fees)),
        line('Net of fees', `${money(e.perHour)} an hour over ${e.hours.toFixed(1)} hours`, money(e.net), true),
        line('A T-bill on the same money', `${pp(S.tbill)} a year`, money(e.tbill)),
        line('Verdict', 'FARM beats the T-bill, MARGINAL is positive but does not, SKIP is zero or less', h('span', { class: 'v ' + e.verdict }, e.verdict)))),
      h('h3', null, 'How to farm it'),
      h('p', { class: 'muted' }, `The steps use the default plan: ${money(r.plan.deposit_usd)} held ${r.plan.weeks} weeks, about ${money(r.plan.fees_usd)} of fees and ${r.plan.hours.toFixed(1)} hours in all. The ${pp(E.drop_share)} drop share is an assumption, not a figure from the snapshot.`),
      h('ol', { class: 'steps' }, r.farm_steps.map((t) => h('li', null, t))),
    ].filter(Boolean));
  }

  function drawMethod() {
    const V = R.value;
    $('method').replaceChildren(
      h('div', null, h('h3', null, 'How a row is priced'),
        h('p', null, h('code', null, 'implied = TVL x multiple(TVL) x odds x adjustments')),
        h('p', null, `learnValue() fits ln(market cap / TVL) of the ${V.n} priced comps and keeps a term only if it lowers the held-out miss in leave-one-out and in walk-forward. learnOdds() fits P(a peer records a token) the same way, scored by Brier. Both are ridge fits on this snapshot, seeded where they resample, so a rerun gives the same bytes.`),
        h('p', null, `Adjustments are stated rules, not fits: x${R.rows.find((r) => r.multiplier.off_list !== 1) ? R.rows.find((r) => r.multiplier.off_list !== 1).multiplier.off_list : 0.5} for curators and allocators (their TVL is counted in the protocols they use) and for off-list protocols (DefiLlama records a parent). No protocol name is special cased.`)),
      h('div', null, h('h3', null, 'How a plan is judged'),
        h('p', null, h('code', null, 'net = drop share x implied x deposit / (TVL + deposit) - fees')),
        h('p', null, `economics() in lib/farm.ts and econ() on this page run the same arithmetic. Fees are gas per transaction (a fixed table, not a feed) x (weeks + ${E.fixed_txs}) plus ${E.friction * 100}% of the deposit. The implied value already carries the odds, so the drop is probability-weighted. FARM when net beats ${E.tbill * 100}% a year on the deposit, MARGINAL when net is positive but does not, SKIP otherwise.`)),
      h('div', null, h('h3', null, 'What this is not'),
        h('p', null, `The page says a protocol records no token, never that it has none. Data: ${R.source}. The drop share, the T-bill rate and the gas table are assumptions, printed here and changeable above. No token or airdrop is promised by any row.`),
        h('p', null, 'The watchlist is a floor: every one of its protocols is on the board, with the protocols below the floor and the off-list children the radar found beside them.')),
    );
  }

  function csv(list) {
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const head = ['rank', 'slug', 'name', 'category', 'tvl_usd', 'odds', 'launch_value_usd', 'implied_value_usd', 'implied_low_usd', 'implied_high_usd', 'verdict', 'net_usd'];
    const lines = list.map((r) => [r.rank, r.slug, q(r.name), q(r.category || ''), r.tvl_usd, r.odds, r.launch_value_usd, r.implied_value_usd, r.implied_low_usd, r.implied_high_usd, r.e.verdict, r.e.net.toFixed(2)].join(','));
    const a = h('a', { href: URL.createObjectURL(new Blob([[head.join(','), ...lines].join('\n') + '\n'], { type: 'text/csv' })), download: 'token-radar.csv' });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function draw() {
    refresh();
    const list = visible();
    if (!list.some((r) => r.slug === S.sel)) S.sel = list.length ? list[0].slug : '';
    drawKpis();
    drawBoard(list);
    drawDetail(list.find((r) => r.slug === S.sel));
    $('board').removeAttribute('aria-busy');
    save();
  }

  // ---- events --------------------------------------------------------------------------------------
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    const [k, d] = (S.view = b.dataset.view, defaultSort());
    Object.assign(S, { q: '', cat: '', chain: '', tier: '', verdict: '', sort: k, dir: d, sel: '' });
    drawHeader(); drawControls(); drawFilters(); draw();
  });
  $('controls').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'dep') S.dep = e.target.value;
    else if (id === 'drop') S.drop = Number(e.target.value);
    else if (id === 'tbill') S.tbill = Number(e.target.value);
    else if (id === 'weeks') { S.weeks = Number(e.target.value); $('wk').textContent = S.weeks + ' wk'; }
    draw();
  });
  $('controls').addEventListener('submit', (e) => e.preventDefault());
  $('filters').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id in S) S[id] = e.target.value;
    draw();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('filters').addEventListener('click', (e) => {
    if (e.target.id === 'csv') { csv(visible()); return; }
    if (e.target.id === 'hide') { S.hide = !S.hide; e.target.textContent = S.hide ? 'Show summary' : 'Hide summary'; $('acct').hidden = $('evidence').hidden = S.hide; save(); return; }
    if (e.target.id !== 'reset') return;
    Object.assign(S, { q: '', cat: '', chain: '', tier: '', verdict: '' });
    drawFilters(); draw();
  });
  const pick = (slug, focus) => {
    S.sel = slug;
    draw();
    const row = $('board').querySelector(`tr[data-slug="${CSS.escape(slug)}"]`);
    if (row && focus) row.focus({ preventScroll: true });
  };
  $('board').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sort]');
    if (b) {
      const k = b.dataset.sort;
      S.dir = S.sort === k ? -S.dir : ['rank', 'name', 'category', 'symbol', 'group', 'why'].includes(k) ? 1 : -1;
      S.sort = k;
      draw();
      return;
    }
    const tr = e.target.closest('tr[data-slug]');
    if (tr) pick(tr.dataset.slug, true);
  });
  $('board').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); pick(tr.dataset.slug, true); }
  });

  if (!VIEWS[S.view]) S.view = 'radar';
  // A hash may name a sort the view has no column for: fall back to the view's own default.
  if (!cols().some((c) => c.k === S.sort)) [S.sort, S.dir] = defaultSort();
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); if ($('q')) $('q').focus(); return; }
    if (e.key !== 'j' && e.key !== 'k') return;
    const list = visible(), i = list.findIndex((r) => r.slug === S.sel);
    const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))];
    if (next) { pick(next.slug, false); const row = $('board').querySelector('tr[aria-selected="true"]'); if (row) row.scrollIntoView({ block: 'nearest' }); }
  });

  drawHeader(); drawFormula(); drawAccounting(); drawEvidence(); drawControls(); drawFilters(); drawMethod(); draw();
  // A shared link names a row that may sit far down the table: bring it into the table's own view.
  const first = $('board').querySelector('tr[aria-selected="true"]');
  if (first) $('board').scrollTop = Math.max(0, first.offsetTop - 120);
})();
