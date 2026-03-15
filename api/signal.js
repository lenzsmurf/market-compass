const https = require("https");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const market = req.body?.market;
    const instruments = req.body?.instruments;

    if (!market || !instruments) {
      return res.status(400).json({ error: "Kein market/instruments", body: req.body });
    }

    const marketNames = { nasdaq: "Nasdaq / US Tech 100", oil: "US Rohöl", gold: "Gold Spot" };
    const summary = instruments.map(i => `${i.name}: ${(i.change??0).toFixed(2)}%`).join(", ");
    const prompt = `CFD-Trader: Analysiere für ${marketNames[market]||market}: ${summary}. Nur JSON: {"signal":"LONG oder SHORT oder NEUTRAL","strength":3,"reason":"Ein Satz Deutsch."}`;

    const payload = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
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

    console.log("Anthropic status:", apiRes.status, "body:", apiRes.body.substring(0, 200));

    if (apiRes.status !== 200) {
      return res.status(500).json({ error: "Anthropic Fehler", status: apiRes.status, detail: apiRes.body });
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
