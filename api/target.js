// POST /api/target { code, target } — 更新某城市的目標價(寫回 targets 分頁)
import { google } from "googleapis";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }
  try {
    const { code, target } = req.body || {};
    const value = Number(target);
    if (!code || !/^[A-Z]{3}$/.test(code) || !Number.isFinite(value) || value < 1000 || value > 500000) {
      return res.status(400).json({ error: "參數不正確" });
    }
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const existing = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.SHEET_ID,
      range: "targets!A2:C",
    });
    const rows = existing.data.values || [];
    const idx = rows.findIndex((r) => r[0] === code);
    if (idx === -1) return res.status(404).json({ error: "找不到城市" });
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.SHEET_ID,
      range: `targets!C${idx + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [[value]] },
    });
    res.status(200).json({ ok: true, code, target: value });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
}
