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

    let priceRows = [], targetRows = [], gfRows = [];
    try {
      const result = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: process.env.SHEET_ID,
        ranges: ["prices!A2:L", "targets!A2:C", "gf_history!A2:E"],
      });
      [priceRows, targetRows, gfRows] = result.data.valueRanges.map((v) => v.values || []);
    } catch {
      // gf_history 分頁可能還不存在(第一次新版掃描前)
      const result = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: process.env.SHEET_ID,
        ranges: ["prices!A2:L", "targets!A2:C"],
      });
      [priceRows, targetRows] = result.data.valueRanges.map((v) => v.values || []);
    }

    const targets = {};
    for (const r of targetRows) targets[r[0]] = Number(r[2]) || null;

    // rows: 掃描日,國家,城市,代碼,出發日,回程日,航空公司,價格,直達班次數,一般價低,一般價高,價格判斷
    const byCity = {};
    for (const r of priceRows) {
      const [scanDate, , , code, dep, ret, airlines, price, , low, high, judg] = r;
      if (!code || !price) continue;
      (byCity[code] ||= []).push({
        scanDate, dep, ret, airlines, price: Number(price),
        low: Number(low) || null, high: Number(high) || null, judg: judg || "",
      });
    }

    // gf_history: 城市代碼,出發日,回程日,日期,價格 — 各城市最便宜日期組合的 Google 60 天記錄
    const gfByCity = {};
    for (const r of gfRows) {
      const [code, dep, ret, date, price] = r;
      if (!code || !price) continue;
      (gfByCity[code] ||= { dep, ret, history: [] }).history.push({
        date, price: Number(price),
      });
    }

    const countries = cfg.countries.map((country) => ({
      key: country.key,
      name: country.name,
      tripDays: country.tripDays,
      cities: country.cities.map((c) => {
        const rows = byCity[c.code] || [];
        const minByDay = {};
        for (const r of rows) {
          if (!minByDay[r.scanDate] || r.price < minByDay[r.scanDate]) {
            minByDay[r.scanDate] = r.price;
          }
        }
        const history = Object.entries(minByDay)
          .map(([date, min]) => ({ date, min }))
          .sort((a, b) => a.date.localeCompare(b.date));
        const latestScan = rows.length
          ? rows.reduce((m, r) => (r.scanDate > m ? r.scanDate : m), "")
          : null;
        const latestOffers = rows
          .filter((r) => r.scanDate === latestScan)
          .sort((a, b) => a.price - b.price)
          .map(({ dep, ret, airlines, price, low, high, judg }) => ({
            dep, ret, airlines, price, low, high, judg,
          }));
        const gf = gfByCity[c.code] || null;
        if (gf) gf.history.sort((a, b) => a.date.localeCompare(b.date));
        return {
          code: c.code,
          zh: c.zh,
          en: c.en,
          target: targets[c.code] ?? country.defaultTargetTwd,
          latestScan,
          latestOffers,
          history,
          gf,
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
