const https = require("https");

function anthropicRequest(prompt) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    });
    const req = https.request({
      hostname: "api.anthropic.com",
      path: "/v1/messages",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(JSON.parse(data)));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const { market, instruments } = JSON.parse(
      await new Promise((resolve) => {
        let body = "";
        req.on("data", c => body += c);
        req.on("end", () => resolve(body));
      })
    );

    const marketNames = { nasdaq: "Nasdaq / US Tech 100", oil: "US Rohöl (WTI)", gold: "Gold Spot" };
    const summary = instruments.map(i => {
      const c = i.change ?? 0;
      return `${i.name}: ${c > 0 ? "+" : ""}${c.toFixed(2)}% (${c > 0.05 ? "steigt" : c < -0.05 ? "fällt" : "seitwärts"})`;
    }).join("\n");

    const prompt = `Du bist ein erfahrener CFD-Intraday-Trader. Analysiere folgende Korrelationsdaten für eine kurzfristige Richtungsprognose (Ziel: 50-150 Punkte, nächste Stunde).

Hauptmarkt: ${marketNames[market]}
Aktuelle Indikatoren:
${summary}

Bekannte Regeln:
- USD Basket ↑ → Nasdaq ↓, Gold ↓, Öl ↓
- Treasury 10Y ↑ → Nasdaq ↓, Gold ↓
- NVIDIA/AMD: wenn stärker als Nasdaq → Move hat Substanz
- Silber läuft Gold voraus
- Chevron bestätigt Öl-Richtung

Antworte NUR als JSON ohne Markdown:
{"signal":"LONG oder SHORT oder NEUTRAL","strength":1-5,"reason":"max 2 kurze Sätze auf Deutsch, konkret"}`;

    const data = await anthropicRequest(prompt);
    const text = data.content.map(b => b.text || "").join("");
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
