// GET /api/bands — 日本月份價格帶(monthly_bands 分頁的最新一次掃描)
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

    let rows = [];
    try {
      const result = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SHEET_ID,
        range: "monthly_bands!A2:G",
      });
      rows = result.data.values || [];
    } catch {
      // 分頁還不存在(第一次掃描前)
    }

    const latest = rows.reduce((m, r) => (r[0] > m ? r[0] : m), "");
    const zh = {};
    for (const c of cfg.countries.find((x) => x.key === "japan").cities) zh[c.code] = c.zh;

    const byCity = {};
    for (const r of rows) {
      const [scan, code, month, dep, current, low, high] = r;
      if (scan !== latest || !code) continue;
      const sample = {
        dep,
        current: Number(current) || null,
        low: Number(low) || null,
        high: Number(high) || null,
      };
      ((byCity[code] ||= {})[month] ||= []).push(sample);
    }

    const cities = Object.entries(byCity).map(([code, months]) => ({
      code,
      zh: zh[code] || code,
      months: Object.entries(months)
        .map(([month, samples]) => {
          const currents = samples.map((s) => s.current).filter(Boolean);
          const lows = samples.map((s) => s.low).filter(Boolean);
          const highs = samples.map((s) => s.high).filter(Boolean);
          return {
            month,
            current: currents.length ? Math.min(...currents) : null,
            low: lows.length ? Math.min(...lows) : null,
            high: highs.length ? Math.max(...highs) : null,
            samples,
          };
        })
        .sort((a, b) => a.month.localeCompare(b.month)),
    }));

    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ updatedAt: latest || null, cities });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
