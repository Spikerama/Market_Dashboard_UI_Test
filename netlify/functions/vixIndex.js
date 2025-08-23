// netlify/functions/vixIndex.js
// Robust VIX (^VIX) fetcher with layered fallbacks and caching.
// Order: FRED (VIXCLS) → FMP → CBOE CSV → Stooq CSV → recent in-memory cache.

let cached = {
  price: null,
  changePercent: null,
  source: '',
  timestamp: 0,
};

const FMP_KEY = process.env.FMP_KEY || '';

/** Small helpers */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetry(url, attempts = 3, delay = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NetlifyFunction/1.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delay * (i + 1));
    }
  }
  throw lastErr || new Error('fetchJsonWithRetry: unknown error');
}

async function fetchTextWithRetry(url, attempts = 3, delay = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NetlifyFunction/1.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(delay * (i + 1));
    }
  }
  throw lastErr || new Error('fetchTextWithRetry: unknown error');
}

/** 1) FRED — daily close series VIXCLS (rock-solid fallback) */
async function fromFRED() {
  const key = process.env.FRED_KEY;
  if (!key) throw new Error('FRED_KEY missing');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${key}&file_type=json&sort_order=desc&limit=15`;
  const json = await fetchJsonWithRetry(url, 3, 300);
  const obs = (json?.observations || [])
    .filter((o) => o.value !== '.')
    .map((o) => ({ date: o.date, val: Number(o.value) }))
    .filter((o) => Number.isFinite(o.val));

  if (obs.length < 1) throw new Error('FRED VIXCLS: no numeric observations');
  const latest = obs[0];
  const prev = obs.find((x, idx) => idx > 0); // next valid numeric
  const change =
    prev && prev.val !== 0
      ? Number((((latest.val - prev.val) / prev.val) * 100).toFixed(2))
      : null;

  return {
    price: Number(latest.val.toFixed(2)),
    changePercent: change,
    source: 'FRED VIXCLS (daily close)',
  };
}

/** 2) FinancialModelingPrep — intraday quote (may rate-limit) */
async function fromFMP() {
  if (!FMP_KEY) throw new Error('FMP_KEY missing');
  const url = `https://financialmodelingprep.com/api/v3/quote/%5EVIX?apikey=${FMP_KEY}`;
  const arr = await fetchJsonWithRetry(url, 2, 400);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('FMP: empty response');
  const q = arr[0] || {};
  const price = Number(q.price ?? q.previousClose ?? q.dayHigh ?? q.dayLow);
  const changePercent = Number(q.changesPercentage ?? q.changePercent ?? q.change);
  if (!Number.isFinite(price)) throw new Error('FMP: no usable price');
  const pct = Number.isFinite(changePercent)
    ? Number(changePercent.toFixed(2))
    : null;
  return { price: Number(price.toFixed(2)), changePercent: pct, source: 'FMP ^VIX' };
}

/** 3) CBOE CSV — official daily history */
async function fromCBOE() {
  const csv = await fetchTextWithRetry(
    'https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv',
    2,
    400
  );
  const lines = csv.trim().split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('CBOE: no data rows');
  // header: DATE,OPEN,HIGH,LOW,CLOSE
  // Take last two data lines:
  const last = lines[lines.length - 1].split(',');
  if (last.length < 5) throw new Error('CBOE: malformed row');
  const close = Number(last[4]);
  if (!Number.isFinite(close)) throw new Error('CBOE: bad close');

  let change = null;
  if (lines.length >= 3) {
    const prev = lines[lines.length - 2].split(',');
    if (prev.length >= 5) {
      const pClose = Number(prev[4]);
      if (Number.isFinite(pClose) && pClose !== 0) {
        change = Number((((close - pClose) / pClose) * 100).toFixed(2));
      }
    }
  }
  return { price: Number(close.toFixed(2)), changePercent: change, source: 'CBOE CSV' };
}

/** 4) Stooq CSV — community mirror */
async function fromStooq() {
  const csv = await fetchTextWithRetry('https://stooq.com/q/d/l/?s=%5Evix&i=d', 2, 400);
  const trimmed = csv.trim();
  if (!trimmed || trimmed === 'NO DATA') throw new Error('Stooq: NO DATA');
  const lines = trimmed.split('\n').filter(Boolean);
  if (lines.length < 2) throw new Error('Stooq: no rows');
  const last = lines[lines.length - 1].split(',');
  if (last.length < 5) throw new Error('Stooq: malformed row');
  const close = Number(last[4]);
  if (!Number.isFinite(close)) throw new Error('Stooq: bad close');
  let change = null;
  if (lines.length >= 3) {
    const prev = lines[lines.length - 2].split(',');
    const pClose = Number(prev[4]);
    if (Number.isFinite(pClose) && pClose !== 0) {
      change = Number((((close - pClose) / pClose) * 100).toFixed(2));
    }
  }
  return { price: Number(close.toFixed(2)), changePercent: change, source: 'Stooq CSV' };
}

/** Main handler */
exports.handler = async function () {
  const tried = [];
  try {
    // 1) Prefer FRED (stable, no rate limits)
    try {
      const r = await fromFRED();
      tried.push({ src: 'FRED', ok: true });
      cached = { ...r, timestamp: Date.now() };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, must-revalidate',
        },
        body: JSON.stringify({ ...r, timestamp: new Date().toISOString() }),
      };
    } catch (e) {
      tried.push({ src: 'FRED', ok: false, err: e.message });
    }

    // 2) FMP (intraday, but can 429)
    try {
      const r = await fromFMP();
      tried.push({ src: 'FMP', ok: true });
      cached = { ...r, timestamp: Date.now() };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, must-revalidate',
        },
        body: JSON.stringify({ ...r, timestamp: new Date().toISOString() }),
      };
    } catch (e) {
      tried.push({ src: 'FMP', ok: false, err: e.message });
    }

    // 3) CBOE CSV
    try {
      const r = await fromCBOE();
      tried.push({ src: 'CBOE', ok: true });
      cached = { ...r, timestamp: Date.now() };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, must-revalidate',
        },
        body: JSON.stringify({ ...r, timestamp: new Date().toISOString() }),
      };
    } catch (e) {
      tried.push({ src: 'CBOE', ok: false, err: e.message });
    }

    // 4) Stooq CSV
    try {
      const r = await fromStooq();
      tried.push({ src: 'Stooq', ok: true });
      cached = { ...r, timestamp: Date.now() };
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, must-revalidate',
        },
        body: JSON.stringify({ ...r, timestamp: new Date().toISOString() }),
      };
    } catch (e) {
      tried.push({ src: 'Stooq', ok: false, err: e.message });
    }

    // 5) Recent cache (<= 2h)
    const ageMs = Date.now() - cached.timestamp;
    if (cached.price != null && ageMs < 2 * 60 * 60 * 1000) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store, must-revalidate',
        },
        body: JSON.stringify({
          price: cached.price,
          changePercent: cached.changePercent,
          source: cached.source + ' (cached)',
          timestamp: new Date().toISOString(),
          _debug: { tried },
        }),
      };
    }

    // All failed
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, must-revalidate',
      },
      body: JSON.stringify({
        error: 'All sources failed and no fresh cache',
        _debug: { tried },
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    // Unexpected crash
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store, must-revalidate',
      },
      body: JSON.stringify({
        error: err.message || 'Unhandled error',
        _debug: { tried },
        timestamp: new Date().toISOString(),
      }),
    };
  }
};
