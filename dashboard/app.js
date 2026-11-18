// Token launch radar dashboard. Reads window.RADAR (written by main.ts from the same board.json) and draws
// the board, the filters, the detail panel and the method note. No network, no framework, no storage.
(function () {
  'use strict';
  const R = window.RADAR;
  const $ = (id) => document.getElementById(id);
  if (!R || !Array.isArray(R.rows)) {
    $('board').textContent = 'No data: data.js did not load, so there is nothing to draw.';
    return;
  }

  // ---- small helpers -------------------------------------------------------------------------------
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
  const money = (n) => (n == null ? 'n/a' : n >= 1e9 ? '$' + (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? '$' + (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + 'M' : n >= 1e3 ? '$' + Math.round(n / 1e3) + 'K' : n < 10 ? '$' + n.toFixed(2) : '$' + Math.round(n));
  const pct = (n) => (n == null ? 'n/a' : (n > 0 ? '+' : '') + n.toFixed(1) + '%');
  const age = (d) => (d == null ? 'unknown' : d >= 730 ? (d / 365).toFixed(1) + ' y' : d >= 60 ? Math.round(d / 30.4) + ' mo' : d + ' d');
  const mult = (n) => 'x' + n.toFixed(2);
  const CONF = { high: 3, medium: 2, low: 1 };

  // ---- state, kept in the URL hash so a view can be shared and reopened ------------------------------
  const params = new URLSearchParams(location.hash.slice(1));
  const S = {
    view: params.get('view') || 'radar',
    q: params.get('q') || '',
    cat: params.get('cat') || '',
    chain: params.get('chain') || '',
    conf: params.get('conf') || '',
    wl: params.get('wl') === '1',
    sort: params.get('sort') || 'rank',
    dir: params.get('dir') === 'desc' ? -1 : 1,
    sel: params.get('sel') || '',
  };
  function save() {
    const p = new URLSearchParams();
    if (S.view !== 'radar') p.set('view', S.view);
    if (S.q) p.set('q', S.q);
    if (S.cat) p.set('cat', S.cat);
    if (S.chain) p.set('chain', S.chain);
    if (S.conf) p.set('conf', S.conf);
    if (S.wl) p.set('wl', '1');
    if (S.sort !== 'rank' || S.dir !== 1) { p.set('sort', S.sort); if (S.dir === -1) p.set('dir', 'desc'); }
    if (S.sel) p.set('sel', S.sel);
    history.replaceState(null, '', '#' + p.toString());
  }

  // ---- the three views -----------------------------------------------------------------------------
  const lows = R.rows.map((r) => Math.max(r.implied_low_usd || 1, 1));
  const highs = R.rows.map((r) => Math.max(r.implied_high_usd || 1, 1));
  const lMin = Math.log10(Math.min(...lows));
  const lMax = Math.log10(Math.max(...highs));
  const pos = (v) => (100 * (Math.log10(Math.max(v, 1)) - lMin)) / (lMax - lMin || 1);

  const VIEWS = {
    radar: { label: 'Radar', rows: R.rows, note: 'Protocols whose record carries no token, ranked by implied value.' },
    live: { label: 'Live token', rows: R.live, note: 'Protocols whose token already trades. Shown at the market cap, never ranked by the model.' },
    unclear: { label: 'Token unclear', rows: R.unclear, note: 'A ticker is recorded but no CoinGecko id or market cap, so the record cannot say. Not ranked.' },
  };
  const COLS = {
    radar: [
      { k: 'rank', t: 'Rank', num: 1, v: (r) => r.rank },
      { k: 'name', t: 'Protocol', v: (r) => r.name },
      { k: 'category', t: 'Category', v: (r) => r.category || '' },
      { k: 'chain', t: 'Chain', v: (r) => r.chains[0] || '' },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd },
      { k: 'change', t: '7d TVL', num: 1, v: (r) => (r.change_7d == null ? -1e9 : r.change_7d) },
      { k: 'age', t: 'Age', num: 1, v: (r) => (r.age_days == null ? -1 : r.age_days) },
      { k: 'implied', t: 'Implied value', num: 1, v: (r) => r.implied_value_usd },
      { k: 'conf', t: 'Confidence', v: (r) => CONF[r.confidence] || 0 },
    ],
    side: [
      { k: 'name', t: 'Protocol', v: (r) => r.name },
      { k: 'category', t: 'Category', v: (r) => r.category || '' },
      { k: 'chain', t: 'Chain', v: (r) => r.chains[0] || '' },
      { k: 'tvl', t: 'TVL', num: 1, v: (r) => r.tvl_usd },
      { k: 'mcap', t: 'Market cap', num: 1, v: (r) => r.mcap_usd || 0 },
      { k: 'symbol', t: 'Ticker', v: (r) => r.symbol || '' },
      { k: 'change', t: '7d TVL', num: 1, v: (r) => (r.change_7d == null ? -1e9 : r.change_7d) },
    ],
  };
  const cols = () => (S.view === 'radar' ? COLS.radar : COLS.side);

  /** The rows the filters keep, sorted. */
  function visible() {
    const q = S.q.trim().toLowerCase();
    const list = VIEWS[S.view].rows.filter((r) =>
      (!q || r.name.toLowerCase().includes(q) || r.slug.includes(q)) &&
      (!S.cat || r.category === S.cat) &&
      (!S.chain || r.chains.includes(S.chain)) &&
      (S.view !== 'radar' || ((!S.conf || r.confidence === S.conf) && (!S.wl || r.in_watchlist))));
    const col = cols().find((c) => c.k === S.sort) || cols()[0];
    return list.slice().sort((a, b) => {
      const x = col.v(a), y = col.v(b);
      const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return c * S.dir || a.slug.localeCompare(b.slug);
    });
  }

  // ---- drawing -------------------------------------------------------------------------------------
  function drawHeader() {
    $('sub').textContent = `${R.board_size} protocols ranked from the snapshot of ${R.as_of} (${R.watchlist_size} on the watchlist, ${R.early_size} below its floor of ${money(R.floor_usd)}). The implied value is this entry's own estimate (model ${R.model_version}), built from TVL, 7 day growth and time listed without a token. It is not advice.`;
    const tabs = $('tabs');
    tabs.replaceChildren(...Object.keys(VIEWS).map((k) => h('button', { type: 'button', 'aria-pressed': String(S.view === k), 'data-view': k }, `${VIEWS[k].label} (${VIEWS[k].rows.length})`)));
  }

  function drawFilters() {
    const rows = VIEWS[S.view].rows;
    const uniq = (f) => [...new Set(rows.flatMap(f).filter(Boolean))].sort();
    const sel = (id, label, opts, val, all) => h('label', null, label, h('select', { id }, h('option', { value: '' }, all), opts.map((o) => h('option', { value: o, selected: o === val }, o))));
    const f = $('filters');
    f.replaceChildren(...[
      h('label', null, 'Search', h('input', { id: 'q', type: 'search', placeholder: 'Protocol name', value: S.q })),
      sel('cat', 'Category', uniq((r) => [r.category]), S.cat, 'All categories'),
      sel('chain', 'Chain', uniq((r) => r.chains), S.chain, 'All chains'),
      S.view === 'radar' ? sel('conf', 'Confidence', ['high', 'medium', 'low'], S.conf, 'Any confidence') : null,
      S.view === 'radar' ? h('label', { class: 'check' }, h('input', { id: 'wl', type: 'checkbox', checked: S.wl }), 'Watchlist only') : null,
      h('button', { type: 'button', id: 'reset' }, 'Reset'),
    ].filter(Boolean));
  }

  function cell(c, r) {
    switch (c.k) {
      case 'rank': return h('td', { class: 'num rank' }, String(r.rank));
      case 'name': return h('td', { class: 'name', title: r.name }, r.name, r.in_watchlist ? h('span', { class: 'tag' }, 'Watchlist') : null);
      case 'category': return h('td', { class: 'cat', title: r.category || '' }, r.category || 'n/a');
      case 'chain': return h('td', { class: 'chain' }, (r.chains[0] || 'n/a') + (r.chains.length > 1 ? ' +' + (r.chains.length - 1) : ''));
      case 'tvl': return h('td', { class: 'num' }, money(r.tvl_usd));
      case 'change': return h('td', { class: 'num ' + (r.change_7d > 0 ? 'up' : r.change_7d < 0 ? 'down' : '') }, pct(r.change_7d));
      case 'age': return h('td', { class: 'num' }, age(r.age_days));
      case 'implied': return h('td', { class: 'num' }, money(r.implied_value_usd), h('span', { class: 'range', title: `${money(r.implied_low_usd)} to ${money(r.implied_high_usd)}` }, h('i', { style: `left:${pos(r.implied_low_usd).toFixed(1)}%;width:${Math.max(2, pos(r.implied_high_usd) - pos(r.implied_low_usd)).toFixed(1)}%` }), h('b', { style: `left:${pos(r.implied_value_usd).toFixed(1)}%` })));
      case 'conf': return h('td', null, h('span', { class: 'conf ' + r.confidence }, r.confidence));
      case 'mcap': return h('td', { class: 'num' }, money(r.mcap_usd));
      case 'symbol': return h('td', null, r.symbol || 'n/a');
      default: return h('td');
    }
  }

  function drawBoard(list) {
    const cs = cols();
    $('count').textContent = `Showing ${list.length} of ${VIEWS[S.view].rows.length}. ${VIEWS[S.view].note}`;
    if (!list.length) {
      $('board').replaceChildren(h('div', { class: 'empty' }, h('strong', null, 'No protocol matches these filters.'), 'Clear the search or press Reset to see the whole board again.'));
      return;
    }
    const head = h('tr', null, cs.map((c) => h('th', { scope: 'col', class: c.num ? 'num' : '', 'aria-sort': S.sort === c.k ? (S.dir === 1 ? 'ascending' : 'descending') : 'none' }, h('button', { type: 'button', 'data-sort': c.k }, c.t + (S.sort === c.k ? (S.dir === 1 ? ' ▲' : ' ▼') : '')))));
    const body = list.map((r) => h('tr', { tabindex: '0', 'data-slug': r.slug, 'aria-selected': String(r.slug === S.sel) }, cs.map((c) => cell(c, r))));
    $('board').replaceChildren(h('table', null, h('thead', null, head), h('tbody', null, body)));
  }

  /** One line of the value breakdown: the factor, its figure, and where the figure comes from. */
  const line = (label, why, val, total) => h('tr', { class: total ? 'total' : '' }, h('td', null, label, why ? h('div', { class: 'muted' }, why) : null), h('td', null, val));

  function drawDetail(r) {
    const d = $('detail');
    if (!r) { d.replaceChildren(h('div', { class: 'empty' }, h('strong', null, 'Nothing selected.'), 'Pick a row to see how its value is built and how to farm it.')); return; }
    if (S.view !== 'radar') {
      d.replaceChildren(
        h('h2', null, r.name),
        h('p', { class: 'status' }, `${r.category || 'No category'} on ${r.chains.join(', ') || 'unknown chain'}. TVL ${money(r.tvl_usd)}.`),
        S.view === 'live'
          ? h('p', null, `Its token already trades: ${r.symbol || 'ticker unknown'} at a market cap of ${money(r.mcap_usd)}. A token that exists is not a launch to wait for, so the model gives it no implied value.`)
          : h('p', null, `The record shows the ticker ${r.symbol} but no CoinGecko id and no market cap. It may be a product of a protocol whose token trades, so the board does not rank it.`),
      );
      return;
    }
    const m = r.model;
    const where = m.peer_group === 'category' ? `${m.peer_count} priced peers in ${r.category}` : m.peer_group === 'blend' ? `${m.peer_count} priced peers in ${r.category}, pulled toward all categories` : `all categories (only ${m.peer_count} priced in ${r.category || 'its category'})`;
    d.replaceChildren(...[
      h('h2', null, r.name),
      h('p', { class: 'status' }, `Records no token in the snapshot. ${r.category || 'No category'} on ${r.chains.join(', ') || 'unknown chain'}. Rank ${r.rank} of ${R.board_size}${r.in_watchlist ? ', on the watchlist' : ''}.`),
      h('div', { class: 'value' }, h('strong', null, money(r.implied_value_usd)), h('span', null, `implied value, range ${money(r.implied_low_usd)} to ${money(r.implied_high_usd)}`)),
      h('p', { class: 'muted' }, 'Confidence: ', h('span', { class: 'conf ' + r.confidence }, r.confidence), '. It rises with priced peers, a known listing date and a known 7 day change.'),
      h('h3', null, 'How the value is built'),
      h('table', { class: 'calc' }, h('tbody', null,
        line('TVL', 'DefiLlama, snapshot date', money(r.tvl_usd)),
        line('Peer market cap to TVL', where, mult(m.peer_ratio)),
        line('7 day growth', r.change_7d == null ? 'not recorded, left at 1' : `TVL change ${pct(r.change_7d)}, capped at -30% to +60%`, mult(m.growth_multiplier)),
        line('Time listed without a token', r.age_days == null ? 'not recorded, left at 1' : `${age(r.age_days)}, full credit at 12 months`, mult(m.age_multiplier)),
        line('Chains', `${r.chains.length} chain${r.chains.length === 1 ? '' : 's'}`, mult(m.breadth_multiplier)),
        m.double_count_multiplier !== 1 ? line('Double counting', 'its TVL sits in other protocols too', mult(m.double_count_multiplier)) : null,
        line('Implied value', null, money(r.implied_value_usd), true))),
      r.flags.length ? h('ul', { class: 'flags' }, r.flags.map((t) => h('li', null, t))) : null,
      h('h3', null, 'How to farm it'),
      h('p', { class: 'totals' }, h('span', null, 'Capital ', h('b', null, money(r.plan.capital_usd))), h('span', null, 'Gas ', h('b', null, money(r.plan.gas_usd))), h('span', null, 'Hold ', h('b', null, r.plan.days + ' days'))),
      h('ol', { class: 'steps' }, r.farm_steps.map((t) => h('li', null, t))),
    ].filter(Boolean));
  }

  function drawMethod() {
    const M = R.model;
    $('method').replaceChildren(
      h('div', null,
        h('h2', null, 'How the implied value is built'),
        h('p', null, h('code', null, 'implied = TVL x peer ratio x growth x age x chains x double count')),
        h('p', null, `Peer ratio: the median market cap to TVL of other protocols in the same category whose token trades (all categories together: ${R.global_ratio.toFixed(2)}). Wrapped, staked, bridged and exchange products are no peers. Under ${M.min_peers} priced peers the all category median is used, under ${M.shrink_k} the ratio is pulled toward it.`),
        h('p', null, `Growth: 1 + ${M.growth_weight} x the 7 day TVL change, capped at ${M.growth_floor}% to +${M.growth_cap}%. Age: up to x${(1 + M.age_gain).toFixed(1)} for time listed without a token, full credit at ${M.age_full_days} days, then flat. Chains: +${M.breadth_step * 100}% per extra chain, up to ${M.breadth_max}. Curators and allocators run vaults on other protocols, so their value is cut by x${M.double_count_factor}.`),
        h('p', null, 'The range uses the 25th and 75th percentile of the same peers. No protocol name is special cased: one function scores every row.'),
        h('p', { class: 'muted' }, `Data: ${R.source}. The page says a protocol records no token, never that it has none: DefiLlama's record can be incomplete. Every watchlist protocol is on the board; the rest are protocols below the floor of ${money(R.floor_usd)} that record no token.`),
      ),
      h('div', null,
        h('h2', null, 'Peer market cap to TVL, by category'),
        h('table', { class: 'peer' }, h('thead', null, h('tr', null, h('th', null, 'Category'), h('th', null, 'Priced peers'), h('th', null, 'Median'))),
          h('tbody', null, R.peers.map((p) => h('tr', null, h('td', null, p.category), h('td', null, String(p.n)), h('td', null, p.median_ratio.toFixed(2)))))),
      ),
    );
  }

  function draw() {
    const list = visible();
    if (!list.some((r) => r.slug === S.sel)) S.sel = list.length ? list[0].slug : '';
    drawBoard(list);
    drawDetail(list.find((r) => r.slug === S.sel));
    $('board').removeAttribute('aria-busy');
    save();
  }

  // ---- events --------------------------------------------------------------------------------------
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (!b) return;
    Object.assign(S, { view: b.dataset.view, q: '', cat: '', chain: '', conf: '', wl: false, sort: b.dataset.view === 'radar' ? 'rank' : 'tvl', dir: b.dataset.view === 'radar' ? 1 : -1, sel: '' });
    drawHeader(); drawFilters(); draw();
  });
  $('filters').addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'q') S.q = e.target.value;
    else if (id === 'wl') S.wl = e.target.checked;
    else if (id === 'cat' || id === 'chain' || id === 'conf') S[id] = e.target.value;
    draw();
  });
  $('filters').addEventListener('submit', (e) => e.preventDefault());
  $('filters').addEventListener('click', (e) => {
    if (e.target.id !== 'reset') return;
    Object.assign(S, { q: '', cat: '', chain: '', conf: '', wl: false });
    drawFilters(); draw();
  });
  $('board').addEventListener('click', (e) => {
    const sortBtn = e.target.closest('button[data-sort]');
    if (sortBtn) {
      const k = sortBtn.dataset.sort;
      S.dir = S.sort === k ? -S.dir : (k === 'rank' || k === 'name' || k === 'category' || k === 'chain' || k === 'symbol' ? 1 : -1);
      S.sort = k;
      draw();
      return;
    }
    const tr = e.target.closest('tr[data-slug]');
    if (tr) {
      S.sel = tr.dataset.slug;
      draw();
      const again = $('board').querySelector(`tr[data-slug="${CSS.escape(S.sel)}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  });
  $('board').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-slug]');
    if (tr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); S.sel = tr.dataset.slug; draw(); const again = $('board').querySelector(`tr[data-slug="${CSS.escape(S.sel)}"]`); if (again) again.focus(); }
  });

  if (!VIEWS[S.view]) S.view = 'radar';
  // A hash may name a sort the view has no column for: fall back to the view's own default.
  if (!cols().some((c) => c.k === S.sort)) { S.sort = S.view === 'radar' ? 'rank' : 'tvl'; S.dir = S.view === 'radar' ? 1 : -1; }
  drawHeader(); drawFilters(); drawMethod(); draw();
})();
