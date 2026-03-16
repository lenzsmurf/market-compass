const https = require("https");

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
  });
}

// Fear & Greed Index (CNN)
async function getFearGreed() {
  try {
    const data = await fetchUrl("https://production.dataviz.cnn.io/index/fearandgreed/graphdata/");
    if (!data?.fear_and_greed) return null;
    const val = Math.round(data.fear_and_greed.score);
    const label = val <= 25 ? "Extreme Fear" : val <= 45 ? "Fear" : val <= 55 ? "Neutral" : val <= 75 ? "Greed" : "Extreme Greed";
    return { value: val, label, signal: val <= 45 ? "bearish" : val >= 55 ? "bullish" : "neutral" };
  } catch { return null; }
}

// EIA Ölvorräte
async function getEIA() {
  try {
    const key = process.env.EIA_API_KEY;
    if (!key) return null;
    const data = await fetchUrl(
      `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${key}&frequency=weekly&data[0]=value&facets[series][]=WCRSTUS1&sort[0][column]=period&sort[0][direction]=desc&length=2`
    );
    if (!data?.response?.data || data.response.data.length < 2) return null;
    const latest = data.response.data[0];
    const prev   = data.response.data[1];
    const change = latest.value - prev.value;
    const changeMB = (change / 1000).toFixed(1);
    return {
      period: latest.period,
      value: latest.value,
      change: changeMB,
      signal: change < 0 ? "bullish" : "bearish",
      label: `${change < 0 ? "↓" : "↑"} ${Math.abs(changeMB)}M Barrel vs. Vorwoche`
    };
  } catch { return null; }
}

// FinancialJuice MOO Scraper
async function getMOO() {
  try {
    const data = await fetchUrl("https://financialjuice.com/home/GetTweetsFeed?symbols=MOO&count=5&ts=0");
    if (!data || !Array.isArray(data)) return null;

    // Suche nach aktuellstem MOO Eintrag
    for (const item of data) {
      const text = item.body || item.text || "";
      // Pattern: "NQ MOO: +1234M" oder "S&P MOO: -567M"
      const nqMatch  = text.match(/NQ.*?MOO[:\s]+([+-]?\d+[\.,]?\d*)M?/i);
      const spMatch  = text.match(/S&P.*?MOO[:\s]+([+-]?\d+[\.,]?\d*)M?/i) ||
                       text.match(/SP.*?MOO[:\s]+([+-]?\d+[\.,]?\d*)M?/i);
      if (nqMatch || spMatch) {
        const nq = nqMatch ? parseFloat(nqMatch[1].replace(",", ".")) : null;
        const sp = spMatch ? parseFloat(spMatch[1].replace(",", ".")) : null;
        return {
          nq, sp,
          nqSignal: nq === null ? "unknown" : nq > 200 ? "bullish" : nq < -200 ? "bearish" : "neutral",
          spSignal: sp === null ? "unknown" : sp > 200 ? "bullish" : sp < -200 ? "bearish" : "neutral",
          nqLabel: nq !== null ? `${nq > 0 ? "+" : ""}${nq}M` : null,
          spLabel: sp !== null ? `${sp > 0 ? "+" : ""}${sp}M` : null,
          raw: text.substring(0, 100),
        };
      }
    }
    return null;
  } catch { return null; }
}

// Confluence Score berechnen
function calcConfluence(market, instruments, events) {
  let bullish = 0, bearish = 0, total = 0;

  // Instrumente
  for (const inst of instruments) {
    const c = inst.change ?? 0;
    if (Math.abs(c) < 0.05) continue;
    total++;
    if (market === "nasdaq") {
      if (["US100","US500","NVDA","AMD"].includes(inst.id)) {
        c > 0 ? bullish++ : bearish++;
      } else if (inst.id === "USD") {
        c > 0 ? bearish++ : bullish++; // USD invers
      } else if (inst.id === "T10Y") {
        c > 0 ? bearish++ : bullish++; // Zinsen invers
      }
    } else if (market === "oil") {
      if (inst.id === "OIL" || inst.id === "CVX") {
        c > 0 ? bullish++ : bearish++;
      } else if (inst.id === "USD") {
        c > 0 ? bearish++ : bullish++;
      }
    } else if (market === "gold") {
      if (inst.id === "GOLD" || inst.id === "SILVER") {
        c > 0 ? bullish++ : bearish++;
      } else if (inst.id === "USD" || inst.id === "T10Y") {
        c > 0 ? bearish++ : bullish++;
      }
    }
  }

  // Events
  if (events.fearGreed) {
    total++;
    events.fearGreed.signal === "bullish" ? bullish++ : events.fearGreed.signal === "bearish" ? bearish++ : null;
  }
  if (market === "nasdaq" && events.moo?.nqSignal) {
    total++;
    events.moo.nqSignal === "bullish" ? bullish++ : events.moo.nqSignal === "bearish" ? bearish++ : null;
  }
  if (market === "nasdaq" && events.moo?.spSignal) {
    total++;
    events.moo.spSignal === "bullish" ? bullish++ : events.moo.spSignal === "bearish" ? bearish++ : null;
  }
  if (market === "oil" && events.eia) {
    total++;
    events.eia.signal === "bullish" ? bullish++ : bearish++;
  }

  const score = total === 0 ? 0 : Math.round(((bullish - bearish) / total) * 5);
  const direction = bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral";
  return { bullish, bearish, total, score, direction };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const body = req.body || {};
    const { market, instruments } = body;

    const [fearGreed, eia, moo] = await Promise.all([
      getFearGreed(),
      getEIA(),
      getMOO(),
    ]);

    const events = { fearGreed, eia, moo };
    const confluence = instruments ? calcConfluence(market, instruments, events) : null;

    res.status(200).json({ events, confluence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
