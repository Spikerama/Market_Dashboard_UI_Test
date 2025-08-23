// netlify/functions/gold.js
// Returns { price, pct, source, timestamp } or { error, _debug, timestamp }
// Tries TwelveData (XAU/USD) → FMP (GC=F) → FRED PM → FRED AM

const FRED_KEY   = process.env.FRED_KEY;
const TWELVE_KEY = process.env.TWELVE_KEY;
const FMP_KEY    = process.env.FMP_KEY;

async function tdGold() {
  if (!TWELVE_KEY) throw new Error('TWELVE_KEY missing');
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent('XAU/USD')}&apikey=${TWELVE_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TwelveData HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === 'error') throw new Error(json.message || 'TwelveData error');
  const price = Number(json.close);
  const pct   = Number(json.percent_change);
  if (!Number.isFinite(price)) throw new Error('TwelveData: bad price');
  return { price, pct: Number.isFinite(pct) ? pct : null, source: 'TwelveData XAU/USD' };
}

async function fmpGold() {
  if (!FMP_KEY) throw new Error('FMP_KEY missing');
  const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent('GC=F')}?apikey=${FMP_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FMP HTTP ${res.status}`);
  const json = await res.json();
  if (!Array.isArray(json) || !json[0]) throw new Error('FMP: bad payload');
  const price = Number(json[0].price);
  const pct   = Number(json[0].changesPercentage);
  if (!Number.isFinite(price)) throw new Error('FMP: bad price');
  return { price, pct: Number.isFinite(pct) ? pct : null, source: 'FMP GC=F' };
}

async function fredLatestPair(seriesId) {
  if (!FRED_KEY) throw new Error('FRED_KEY missing');
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${FRED_KEY}&file_type=json`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`FRED HTTP ${res.status} (${seriesId})${body ? ' - ' + body : ''}`);
  }
  const json = await res.json();
  const obs = Array.isArray(json.observations) ? json.observations : [];
  const clean = obs
    .filter(o => o && o.value !== '.' && o.value != null && !Number.isNaN(Number(o.value)))
    .map(o => ({ date: o.date, value: Number(o.value) }));
  if (clean.length === 0) throw new Error(`FRED ${seriesId}: no observations`);

  const latest = clean[clean.length - 1];
  const prior  = clean[clean.length - 2];
  const price = latest.value;
  let pct = null;
  if (prior && Number.isFinite(prior.value) && prior.value !== 0) {
    pct = Number((((price - prior.value) / prior.value) * 100).toFixed(2));
  }
  return { price, pct, source: `FRED ${seriesId}` };
}

exports.handler = async () => {
  const tried = [];
  const attempts = [
    () => tdGold(),
    () => fmpGold(),
    () => fredLatestPair('GOLDPMGBD228NLBM'), // PM fix
    () => fredLatestPair('GOLDAMGBD228NLBM'), // AM fix
  ];

  for (const fn of attempts) {
    try {
      const { price, pct, source } = await fn();
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ price, pct, source, timestamp: new Date().toISOString() })
      };
    } catch (e) {
      tried.push(e.message || String(e));
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ error: 'All gold sources failed', _debug: { tried }, timestamp: new Date().toISOString() })
  };
};
