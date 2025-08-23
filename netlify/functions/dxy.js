// netlify/functions/dxy.js
// USD Broad Index (Goods & Services) via FRED: DTWEXBGS (daily)
// Returns { price, changePercent, source, timestamp }

exports.handler = async () => {
  try {
    const key = process.env.FRED_KEY;
    if (!key) throw new Error('FRED_KEY missing');

    const url = `https://api.stlouisfed.org/fred/series/observations?` +
      `series_id=DTWEXBGS&api_key=${key}&file_type=json&sort_order=desc&limit=25`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
    const json = await res.json();
    const obs = (json.observations || []).filter(o => o.value !== '.');

    if (obs.length < 2) throw new Error('Not enough DXY observations');
    const latest = parseFloat(obs[0].value);
    const prior  = parseFloat(obs[1].value);
    if (!Number.isFinite(latest) || !Number.isFinite(prior)) throw new Error('DXY NaN');

    const changePercent = ((latest - prior) / prior) * 100;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        price: Number(latest.toFixed(2)),
        changePercent: Number(changePercent.toFixed(2)),
        source: 'FRED DTWEXBGS',
        timestamp: new Date().toISOString(),
      })
    };
  } catch (err) {
    console.error('dxy.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message, timestamp: new Date().toISOString() })
    };
  }
};
