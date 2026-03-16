const https = require("https");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const market = req.body?.market;
    const instruments = req.body?.instruments;
    const events = req.body?.events || {};
    const confluence = req.body?.confluence || null;

    if (!market || !instruments) {
      return res.status(400).json({ error: "Kein market/instruments", body: req.body });
    }

    const marketNames = { nasdaq: "Nasdaq / US Tech 100", oil: "US Rohöl", gold: "Gold Spot" };
    const summary = instruments.map(i => `${i.name}: ${(i.change??0).toFixed(2)}%`).join(", ");

    // Events als Text
    let eventText = "";
    if (events.fearGreed) {
      eventText += `\nFear & Greed Index: ${events.fearGreed.value} (${events.fearGreed.label})`;
    }
    if (events.moo?.nqLabel) {
      eventText += `\nMOO Nasdaq: ${events.moo.nqLabel}`;
    }
    if (events.moo?.spLabel) {
      eventText += `\nMOO S&P 500: ${events.moo.spLabel}`;
    }
    if (events.eia) {
      eventText += `\nEIA Ölvorräte: ${events.eia.label} (${events.eia.period})`;
    }
    if (confluence) {
      eventText += `\nConfluence: ${confluence.bullish} bullish vs ${confluence.bearish} bearish Signale von ${confluence.total} gesamt`;
    }

    const prompt = `CFD-Intraday-Trader Analyse für ${marketNames[market]||market}.

Korrelationsdaten: ${summary}
${eventText ? `\nZusätzliche Marktdaten:${eventText}` : ""}

Regeln:
- USD ↑ → Nasdaq ↓, Gold ↓, Öl ↓
- Treasury ↑ → Nasdaq ↓, Gold ↓  
- NVIDIA/AMD stärker als Nasdaq → Move hat Substanz
- MOO positiv (+500M) → bullisch bei Eröffnung
- Fear & Greed extrem → Kontraindikator
- EIA Lagerabbau → Öl bullisch
- Ziel: 50-150 Punkte in nächster Stunde

Antworte NUR als JSON:
{"signal":"LONG oder SHORT oder NEUTRAL","strength":1-5,"reason":"max 2 Sätze Deutsch, erwähne Confluence falls stark"}`;

    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 250,
      messages: [{ role: "user", content: prompt }],
    });

    const apiRes = await new Promise((resolve, reject) => {
      const r = https.request({
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (resp) => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => resolve({ status: resp.statusCode, body: d }));
      });
      r.on("error", reject);
      r.write(payload);
      r.end();
    });

    if (apiRes.status !== 200) {
      return res.status(500).json({ error: "Anthropic Fehler", detail: apiRes.body });
    }

    const data = JSON.parse(apiRes.body);
    const text = data.content.map(b => b.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    res.status(200).json(JSON.parse(clean));

  } catch (e) {
    console.error("Signal error:", e.message);
    res.status(500).json({ error: e.message });
  }
};
