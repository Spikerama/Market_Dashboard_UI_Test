// netlify/functions/buffett.js

export const handler = async () => {
  try {
    const FRED_KEY = process.env.FRED_KEY;
    if (!FRED_KEY) {
      throw new Error('FRED_KEY is missing in environment.');
    }

    // --- FRED: Market Value of Equities Outstanding (NCBEILQ027S) ---
    async function getFREDMarketCapMap() {
      const params = new URLSearchParams({
        series_id: 'NCBEILQ027S',
        api_key: FRED_KEY,
        file_type: 'json',
        observation_start: '1980-01-01',
        frequency: 'q'
      });
      const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.observations)) throw new Error('Bad FRED payload for market cap');
      const map = new Map();
      for (const o of json.observations) {
        const d = o.date;
        const y = parseInt(d.slice(0, 4), 10);
        const v = o.value === '.' ? null : Number(o.value); // FRED market cap is in **millions**
        if (!Number.isNaN(y)) {
          if (!map.has(y)) map.set(y, []);
          if (v !== null) map.get(y).push(v);
        }
      }
      const avgMap = new Map();
      for (const [y, arr] of map.entries()) {
        if (arr.length > 0) {
          const avgInBillions = (arr.reduce((a, b) => a + b, 0) / arr.length) / 1e3; // convert to billions
          avgMap.set(y, avgInBillions);
        }
      }
      return avgMap;
    }

    // --- FRED: GDP (annual, billions USD, nominal) ---
    async function getFREDGDPAnnualMap() {
      const params = new URLSearchParams({
        series_id: 'GDP',
        api_key: FRED_KEY,
        file_type: 'json',
        observation_start: '1980-01-01'
      });
      const url = `https://api.stlouisfed.org/fred/series/observations?${params.toString()}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`FRED HTTP ${res.status}`);
      const json = await res.json();
      if (!json || !Array.isArray(json.observations)) throw new Error('Bad FRED payload for GDP');
      const map = new Map();
      for (const o of json.observations) {
        const d = o.date;
        const y = parseInt(d.slice(0, 4), 10);
        const v = o.value === '.' ? null : Number(o.value); // already in billions
        if (!Number.isNaN(y) && v !== null) map.set(y, v);
      }
      return map;
    }

    const [mcapMap, gdpMap] = await Promise.all([
      getFREDMarketCapMap(),
      getFREDGDPAnnualMap()
    ]);

    const years = [...mcapMap.keys()].filter(y => gdpMap.has(y)).sort((a, b) => b - a);
    if (years.length === 0) throw new Error('No overlapping year found');

    const latestYear = years[0];
    const mcap = mcapMap.get(latestYear); // in billions (converted above)
    const gdp = gdpMap.get(latestYear);   // in billions
    const ratio = (mcap / gdp) * 100;

    console.log({
      debug: 'Buffett Indicator Inputs',
      year: latestYear,
      marketCap_billion_usd: mcap,
      gdp_billion_usd: gdp,
      calculated_ratio_percent: ratio
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        source: {
          numerator: 'FRED NCBEILQ027S (avg of quarterly values)',
          denominator: 'FRED GDP (annual nominal)'
        },
        vintage: 'latest revised',
        year: latestYear,
        ratio,
        market_cap_billion_usd: mcap,
        gdp_billion_usd: gdp,
        note: 'All values in billions of USD. Market cap was converted from millions.'
      })
    };
  } catch (err) {
    console.error('buffett.js error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
