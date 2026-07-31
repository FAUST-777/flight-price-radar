// GET /api/prices — 讀 Google Sheet,整理成網頁要的資料結構
import { readFile } from "node:fs/promises";
import { google } from "googleapis";

export default async function handler(req, res) {
  try {
    const cfg = JSON.parse(
      await readFile(new URL("../config/routes.json", import.meta.url), "utf8")
    );
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const result = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: process.env.SHEET_ID,
      ranges: ["prices!A2:I", "targets!A2:C"],
    });
    const priceRows = result.data.valueRanges[0].values || [];
    const targetRows = result.data.valueRanges[1].values || [];

    const targets = {};
    for (const r of targetRows) targets[r[0]] = Number(r[2]) || null;

    // rows: 掃描日,國家,城市,代碼,出發日,回程日,航空公司,價格,直達班次數
    const byCity = {};
    for (const r of priceRows) {
      const [scanDate, , , code, dep, ret, airlines, price] = r;
      if (!code || !price) continue;
      (byCity[code] ||= []).push({
        scanDate, dep, ret, airlines, price: Number(price),
      });
    }

    const countries = cfg.countries.map((country) => ({
      key: country.key,
      name: country.name,
      tripDays: country.tripDays,
      cities: country.cities.map((c) => {
        const rows = byCity[c.code] || [];
        // 每個掃描日的最低價 → 歷史走勢
        const minByDay = {};
        for (const r of rows) {
          if (!minByDay[r.scanDate] || r.price < minByDay[r.scanDate]) {
            minByDay[r.scanDate] = r.price;
          }
        }
        const history = Object.entries(minByDay)
          .map(([date, min]) => ({ date, min }))
          .sort((a, b) => a.date.localeCompare(b.date));
        // 最新一次掃描的各出發日報價
        const latestScan = rows.length
          ? rows.reduce((m, r) => (r.scanDate > m ? r.scanDate : m), "")
          : null;
        const latestOffers = rows
          .filter((r) => r.scanDate === latestScan)
          .sort((a, b) => a.price - b.price)
          .map(({ dep, ret, airlines, price }) => ({ dep, ret, airlines, price }));
        return {
          code: c.code,
          zh: c.zh,
          en: c.en,
          target: targets[c.code] ?? country.defaultTargetTwd,
          latestScan,
          latestOffers,
          history,
        };
      }),
    }));

    const updatedAt = priceRows.length
      ? priceRows.reduce((m, r) => (r[0] > m ? r[0] : m), "")
      : null;

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json({ updatedAt, origin: cfg.originLabel, countries });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
