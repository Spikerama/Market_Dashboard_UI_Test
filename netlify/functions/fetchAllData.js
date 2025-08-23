// netlify/functions/fetchAllData.js
import fetch from 'node-fetch';

// Unified data fetch for all widgets with robust fallbacks
export async function handler(event) {
  const bust = Date.now();
  const protocol = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers.host;
  const base = `${protocol}://${host}`;

  const TWELVE_KEY = process.env.TWELVE_KEY;
  const FMP_KEY = process.env.FMP_KEY;
  const FRED_KEY = process.env.FRED_KEY;

  const results = {};

  // ---------- Helpers ----------
  async function fetchTwelve(symbol) {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.status === 'error') throw new Error(json.message || 'TwelveData error');
    return { price: Number(json.close), pct: Number(json.percent_change) };
  }

  async function fetchFMP(symbol) {
    if (!FMP_KEY) throw new Error('FMP_KEY missing');
    const url = `https://financialmodelingprep.com/api/v3/quote/${encodeURIComponent(symbol)}?apikey=${FMP_KEY}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json) || !json[0]) throw new Error('Bad FMP data');
    return { price: Number(json[0].price), pct: Number(json[0].changesPercentage) };
  }

  // Try TwelveData; on ANY failure, fall back to FMP if available.
  async function tdWithFmpFallback(symbol) {
    try {
      return await fetchTwelve(symbol);
    } catch (_e) {
      try {
        if (FMP_KEY) return await fetchFMP(symbol);
        throw _e;
      } catch (e2) {
        return { error: e2.message || String(e2) };
      }
    }
  }

  // FRED: fetch full (ascending) series, then use the last two valid points.
  async function fredLatestPair(series_id) {
    if (!FRED_KEY) throw new Error('FRED_KEY missing');
    const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series_id}&api_key=${FRED_KEY}&file_type=json`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`FRED HTTP ${res.status} (${series_id})${body ? ' - ' + body : ''}`);
    }
    const json = await res.json();
    const arr = Array.isArray(json.observations) ? json.observations : [];
    const clean = arr
      .filter(o => o && o.value !== '.' && o.value != null && !Number.isNaN(Number(o.value)))
      .map(o => ({ date: o.date, value: Number(o.value) }));

    const n = clean.length;
    if (n === 0) throw new Error(`No observations (${series_id})`);

    const latest = clean[n - 1];
    const prior  = clean[n - 2]; // may be undefined
    const price = latest.value;
    let pct = null;
    if (prior && prior.value) pct = Number((((price - prior.value) / prior.value) * 100).toFixed(2));
    return { price, pct };
  }

  // ---------- Equities / ETFs (with fallback) ----------
  results.spy  = await tdWithFmpFallback('SPY');
  // results.vixy = await tdWithFmpFallback('VIXY'); // (disabled)
  results.tsla = await tdWithFmpFallback('TSLA');
  results.lit  = await tdWithFmpFallback('LIT');

  // ---------- Internal lambdas ----------
  try {
    const r = await fetch(`${base}/.netlify/functions/yieldSpread?bust=${bust}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.yieldCurve = await r.json();
  } catch (err) {
    results.yieldCurve = { error: err.message };
  }

  // Estimated Buffett removed
  // try {
  //   const r = await fetch(`${base}/.netlify/functions/estimatedBuffett?bust=${bust}`);
  //   if (!r.ok) throw new Error(`HTTP ${r.status}`);
  //   results.estimatedBuffett = await r.json();
  // } catch (err) {
  //   results.estimatedBuffett = { error: err.message };
  // }

  try {
    const r = await fetch(`${base}/.netlify/functions/buffett?bust=${bust}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    results.buffett = await r.json();
  } catch (err) {
    results.buffett = { error: err.message };
  }

  // ---------- Gold & USD index direct from FRED ----------
  try {
    // LBMA PM Gold price in USD/oz
    results.gold = await fredLatestPair('GOLDPMGBD228NLBM');
  } catch (err) {
    results.gold = { error: err.message };
  }

  try {
    // Broad USD index
    results.dxy = await fredLatestPair('DTWEXBGS');
  } catch (err) {
    results.dxy = { error: err.message };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(results)
  };
}
