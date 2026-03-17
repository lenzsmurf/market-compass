const https = require("https");

// Fetch JSON URL
function fetchUrl(url) {
  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json, text/xml, */*" }
    }, (res) => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ ok: true, text: d, json: JSON.parse(d) }); }
        catch { resolve({ ok: true, text: d, json: null }); }
      });
    });
    req.on("error", () => resolve({ ok: false }));
    req.setTimeout(6000, () => { req.destroy(); resolve({ ok: false }); });
  });
}

// EIA Ölvorräte
async function getEIA() {
  try {
    const key = process.env.EIA_API_KEY;
    if (!key) return null;
    const res = await fetchUrl(
      `https://api.eia.gov/v2/petroleum/stoc/wstk/data/?api_key=${key}&frequency=weekly&data[0]=value&facets[series][]=WCRSTUS1&sort[0][column]=period&sort[0][direction]=desc&length=2`
    );
    if (!res.ok || !res.json?.response?.data || res.json.response.data.length < 2) return null;
    const latest = res.json.response.data[0];
    const prev   = res.json.response.data[1];
    const change = latest.value - prev.value;
    const changeMB = (change / 1000).toFixed(1);
    return {
      period: latest.period,
      change: changeMB,
      signal: change < 0 ? "bullish" : "bearish",
      label: `${change < 0 ? "↓" : "↑"} ${Math.abs(changeMB)}M Barrel vs. Vorwoche`
    };
  } catch { return null; }
}

// MOO via FinancialJuice RSS
async function getMOO() {
  try {
    const res = await fetchUrl("https://financialjuice.com/News/8178524/MOO-Imbalance.aspx?xy=rss");
    if (!res.ok || !res.text) return null;

    const xml = res.text;
    // RSS items aus XML extrahieren
    const items = xml.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const item of items) {
      const title = (item.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      const desc  = (item.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
      const text  = title + " " + desc;

      // Pattern: NQ +1234M oder NQ -567M oder Nasdaq +1234M
      const nqMatch = text.match(/NQ[:\s]+([+-]?\d+[\.,]?\d*)\s*M/i) ||
                      text.match(/Nasdaq[:\s]+([+-]?\d+[\.,]?\d*)\s*M/i);
      const spMatch = text.match(/S&P[:\s]+([+-]?\d+[\.,]?\d*)\s*M/i) ||
                      text.match(/SP[:\s]+([+-]?\d+[\.,]?\d*)\s*M/i) ||
                      text.match(/SPY[:\s]+([+-]?\d+[\.,]?\d*)\s*M/i);

      if (nqMatch || spMatch) {
        const nq = nqMatch ? parseFloat(nqMatch[1].replace(",", ".")) : null;
        const sp = spMatch ? parseFloat(spMatch[1].replace(",", ".")) : null;

        // Datum aus RSS
        const pubDate = (item.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";

        return {
          nq, sp,
          pubDate,
          nqSignal: nq === null ? "unknown" : nq > 200 ? "bullish" : nq < -200 ? "bearish" : "neutral",
          spSignal: sp === null ? "unknown" : sp > 200 ? "bullish" : sp < -200 ? "bearish" : "neutral",
          nqLabel: nq !== null ? `${nq > 0 ? "+" : ""}${nq}M` : null,
          spLabel: sp !== null ? `${sp > 0 ? "+" : ""}${sp}M` : null,
        };
      }
    }
    return null;
  } catch { return null; }
}

// Confluence Score
function calcConfluence(market, instruments, events) {
  let bullish = 0, bearish = 0, total = 0;

  for (const inst of instruments) {
    const c = inst.change ?? 0;
    if (Math.abs(c) < 0.05) continue;
    total++;
    if (market === "nasdaq") {
      if (["US100","US500","NVDA","AMD"].includes(inst.id)) {
        c > 0 ? bullish++ : bearish++;
      } else if (inst.id === "USD") {
        c > 0 ? bearish++ : bullish++;
      } else if (inst.id === "T10Y") {
        c > 0 ? bearish++ : bullish++;
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

  if (market === "nasdaq" && events.moo?.nqSignal && events.moo.nqSignal !== "unknown") {
    total++;
    events.moo.nqSignal === "bullish" ? bullish++ : events.moo.nqSignal === "bearish" ? bearish++ : null;
  }
  if (market === "nasdaq" && events.moo?.spSignal && events.moo.spSignal !== "unknown") {
    total++;
    events.moo.spSignal === "bullish" ? bullish++ : events.moo.spSignal === "bearish" ? bearish++ : null;
  }
  if (market === "oil" && events.eia) {
    total++;
    events.eia.signal === "bullish" ? bullish++ : bearish++;
  }

  const direction = bullish > bearish ? "bullish" : bearish > bullish ? "bearish" : "neutral";
  return { bullish, bearish, total, direction };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { market, instruments } = req.body || {};
    const [eia, moo] = await Promise.all([getEIA(), getMOO()]);
    const events = { eia, moo };
    const confluence = instruments ? calcConfluence(market, instruments, events) : null;
    res.status(200).json({ events, confluence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
