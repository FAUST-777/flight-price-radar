// 月份價格帶掃描器(每週跑一次,見 .github/workflows/monthly-bands.yml)
// 對日本主要航點,掃未來 ~11 個月、每月兩個樣本出發日,
// 收集 Google 的「歷史常態價格區間」與目前最低價 → Sheet 的 monthly_bands 分頁。
// 註:與 scripts/scan.mjs 少量重複(抓取/解析函式),刻意自足以免動到每日掃描器。

import { readFile } from "node:fs/promises";
import { google } from "googleapis";

const cfg = JSON.parse(
  await readFile(new URL("../config/routes.json", import.meta.url), "utf8")
);
const { GOOGLE_SERVICE_ACCOUNT, SHEET_ID } = process.env;
for (const [k, v] of Object.entries({ GOOGLE_SERVICE_ACCOUNT, SHEET_ID })) {
  if (!v) { console.error(`缺少環境變數 ${k}`); process.exit(1); }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WHITELIST_ZH = cfg.airlineWhitelist;
const BLACKLIST_ZH = cfg.airlineBlacklist;

const todayTw = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function parseOffers(html) {
  const rows = html.split('class="pIav2d"').slice(1);
  const seen = new Set();
  const offers = [];
  for (const r of rows) {
    const block = r.slice(0, 9000);
    const m = block.match(/aria-label="([0-9]+) 新台幣"/);
    if (!m) continue;
    if (!/直達/.test(block)) continue;
    if (BLACKLIST_ZH.some((x) => block.includes(x))) continue;
    const names = WHITELIST_ZH.filter((x) => block.includes(x));
    if (names.length === 0) continue;
    const key = m[1] + "|" + names.join("/");
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ price: Number(m[1]), airlines: names.join("/") });
  }
  offers.sort((a, b) => a.price - b.price);
  return offers;
}

function parseInsights(html) {
  const m = html.match(/\[null,(\d{3,7})\],\[null,(\d{3,7})\],1,null,null,null,\[\[\[1[6-9]\d{11},\d/);
  if (!m) return null;
  return { low: Number(m[1]), high: Number(m[2]) };
}

let fetchCount = 0;
async function search(destCode, dep, ret) {
  const url =
    "https://www.google.com/travel/flights?hl=zh-TW&gl=TW&curr=TWD&q=" +
    encodeURIComponent(`${cfg.origin} to ${destCode} round trip ${dep} through ${ret} nonstop`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    fetchCount++;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
    });
    if (res.status === 429 || res.status >= 500) { await sleep(8000 * attempt); continue; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { offers: parseOffers(html), insight: parseInsights(html) };
  }
  throw new Error("重試 3 次仍失敗");
}

// ---- Sheets ----
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });
const HEADER = ["掃描日", "城市代碼", "月份", "出發日", "目前最低", "通常低", "通常高"];

const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
if (!meta.data.sheets.some((s) => s.properties.title === "monthly_bands")) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: "monthly_bands" } } }] },
  });
}
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: "monthly_bands!A1",
  valueInputOption: "RAW",
  requestBody: { values: [HEADER] },
});

// ---- 主流程:未來 1~11 個月,每月 8 日與 22 日兩個樣本 ----
const japan = cfg.countries.find((c) => c.key === "japan");
const cities = japan.cities.filter((c) => cfg.bandCities.includes(c.code));
const months = [];
{
  const [y0, m0] = todayTw.split("-").map(Number);
  for (let i = 1; i <= 11; i++) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    months.push(`${y}-${String(m).padStart(2, "0")}`);
  }
}
console.log(`月份價格帶掃描:${cities.length} 城市 × ${months.length} 個月 × 2 樣本(${todayTw})`);

const rows = [];
const errors = [];
for (const city of cities) {
  for (const ym of months) {
    for (const day of ["08", "22"]) {
      const dep = `${ym}-${day}`;
      if (dep <= addDays(todayTw, 7) || dep > addDays(todayTw, 320)) continue;
      const ret = addDays(dep, japan.tripDays - 1);
      try {
        const { offers, insight } = await search(city.code, dep, ret);
        rows.push([
          todayTw, city.code, ym, dep,
          offers[0] ? offers[0].price : "",
          insight ? insight.low : "", insight ? insight.high : "",
        ]);
        console.log(`  ${city.zh} ${dep}  ${offers[0] ? "NT$" + offers[0].price : "無直飛"}${insight ? ` [通常${insight.low}~${insight.high}]` : ""}`);
      } catch (err) {
        errors.push(`${city.code} ${dep}: ${err.message}`);
      }
      await sleep(cfg.scan.throttleMs);
    }
  }
}

// 今天的舊資料先清掉(重跑冪等),歷史掃描保留 → 長期累積成自建歷年資料
const existing = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID, range: "monthly_bands!A2:G",
});
const keep = (existing.data.values || []).filter((r) => r[0] !== todayTw);
await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: "monthly_bands!A2:G" });
if (keep.length + rows.length > 0) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "monthly_bands!A1",
    valueInputOption: "RAW",
    requestBody: { values: [...keep, ...rows] },
  });
}

await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: "log!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [[
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (台灣時間)",
      fetchCount, rows.length, errors.length,
      "monthly-bands。" + errors.slice(0, 3).join(" | "),
    ]],
  },
});
console.log(`完成:抓取 ${fetchCount} 次,寫入 ${rows.length} 筆,錯誤 ${errors.length} 筆`);
if (rows.length === 0) process.exit(1);
