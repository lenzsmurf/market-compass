// Vercel Serverless Function – IG API Proxy
const https = require("https");

const IG_BASE = "api.ig.com";

const EPICS = {
  nasdaq: [
    { id: "US100",  name: "US Tech 100",      epic: "IX.D.NASDAQ.IFD.IP",    main: true  },
    { id: "US500",  name: "S&P 500",           epic: "IX.D.SPTRD.IFD.IP",    main: false },
    { id: "T10Y",   name: "Treasury 10Y ETF",  epic: "UD.D.UTENUS.CASH.IP", main: false },
    { id: "USD",    name: "USD Basket",        epic: "CC.D.DX.UME.IP",       main: false },
    { id: "NVDA",   name: "NVIDIA",            epic: "UC.D.NVDA.CASH.IP",    main: false },
    { id: "AMD",    name: "AMD",               epic: "SA.D.AMD.CASH.IP",     main: false },
  ],
  oil: [
    { id: "OIL",    name: "US Rohöl",          epic: "CC.D.CL.USS.IP",       main: true  },
    { id: "USD",    name: "USD Basket",        epic: "CC.D.DX.UME.IP",       main: false },
    { id: "T10Y",   name: "Treasury 10Y ETF",  epic: "UD.D.UTENUS.CASH.IP", main: false },
    { id: "CVX",    name: "Chevron",           epic: "SB.D.CVX.CASH.IP",     main: false },
  ],
  gold: [
    { id: "GOLD",   name: "Gold Spot",         epic: "CS.D.CFEGOLD.CAE.IP",  main: true  },
    { id: "SILVER", name: "Silber",            epic: "CS.D.CFDSILVER.CFDSI.IP", main: false },
    { id: "USD",    name: "USD Basket",        epic: "CC.D.DX.UME.IP",       main: false },
    { id: "T10Y",   name: "Treasury 10Y ETF",  epic: "UD.D.UTENUS.CASH.IP", main: false },
  ],
};

function igRequest(method, endpoint, body, tokens) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json; charset=UTF-8",
      "X-IG-API-KEY": process.env.IG_API_KEY,
      "Version": "1",
    };
    if (tokens) {
      headers["CST"] = tokens.cst;
      headers["X-SECURITY-TOKEN"] = tokens.token;
    }
    if (payload) headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request({
      hostname: IG_BASE,
      path: "/gateway/deal" + endpoint,
      method,
      headers,
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function login() {
  const res = await igRequest("POST", "/session", {
    identifier: process.env.IG_USERNAME,
    password: process.env.IG_PASSWORD,
  });
  if (res.status !== 200) throw new Error("IG Login fehlgeschlagen: " + JSON.stringify(res.body));
  return { cst: res.headers["cst"], token: res.headers["x-security-token"] };
}

async function getPrice(epic, session) {
  const res = await igRequest("GET", `/markets/${epic}`, null, session);
  if (res.status !== 200) return null;
  const snap = res.body.snapshot;
  if (!snap) return null;
  const mid = snap.bid && snap.offer ? (snap.bid + snap.offer) / 2 : snap.bid || snap.offer;
  return {
    price: mid,
    change: snap.percentageChange ?? 0,
    changeNet: snap.netChange ?? 0,
    high: snap.high ?? mid,
    low: snap.low ?? mid,
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    const session = await login();
    const result = {};

    for (const [market, instruments] of Object.entries(EPICS)) {
      result[market] = await Promise.all(
        instruments.map(async (inst) => {
          try {
            const p = await getPrice(inst.epic, session);
            return { ...inst, ...(p || { price: null, change: 0, high: null, low: null }) };
          } catch {
            return { ...inst, price: null, change: 0, high: null, low: null };
          }
        })
      );
    }

    res.status(200).json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
