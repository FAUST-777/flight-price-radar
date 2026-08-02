// flight-price-radar 每日掃描器(資料來源:Google 航班)
// 查詢台北出發 → 日本/義大利各城市的「直飛、來回、全服務航空」最低票價,寫入 Google Sheet。
// 由 GitHub Actions 每天執行(.github/workflows/daily-scan.yml),也可本機執行:
//   GOOGLE_SERVICE_ACCOUNT='{"...":"..."}' SHEET_ID=... node scripts/scan.mjs
//
// 2026-07-31 起改爬 Google 航班(Amadeus 免費自助 API 已於 2026-07-17 下線)。
// 不需要任何 API 金鑰;解析的是搜尋結果頁 HTML 內嵌的價格標籤(aria-label="NNNN 新台幣")。

import { readFile } from "node:fs/promises";
import { google } from "googleapis";

const cfg = JSON.parse(
  await readFile(new URL("../config/routes.json", import.meta.url), "utf8")
);

const { GOOGLE_SERVICE_ACCOUNT, SHEET_ID } = process.env;
for (const [k, v] of Object.entries({ GOOGLE_SERVICE_ACCOUNT, SHEET_ID })) {
  if (!v) {
    console.error(`缺少環境變數 ${k}`);
    process.exit(1);
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 日期(以台灣時間為準) ----
const twNow = new Date(Date.now() + 8 * 3600 * 1000);
const todayTw = twNow.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---- Google 航班抓取與解析 ----
let fetchCount = 0;
const errors = [];
let emptyPageDiag = null; // 第一個「完全沒航班列」頁面的診斷資訊

function gfUrl(destCode, departDate, returnDate) {
  const q = `${cfg.origin} to ${destCode} round trip ${departDate} through ${returnDate} nonstop`;
  return (
    "https://www.google.com/travel/flights?hl=zh-TW&gl=TW&curr=TWD&q=" +
    encodeURIComponent(q)
  );
}

// 回傳 [{price, airlines}] 由低到高;只留「直達 + 全服務航空」
function parseOffers(html) {
  const rows = html.split('class="pIav2d"').slice(1);
  const seen = new Set();
  const offers = [];
  for (const r of rows) {
    const block = r.slice(0, 9000);
    const m = block.match(/aria-label="([0-9]+) 新台幣"/);
    if (!m) continue;
    if (!/直達/.test(block)) continue;
    if (cfg.airlineBlacklist.some((x) => block.includes(x))) continue;
    const names = cfg.airlineWhitelist.filter((x) => block.includes(x));
    if (names.length === 0) continue;
    const airlines = names.join("/");
    const key = m[1] + "|" + airlines;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push({ price: Number(m[1]), airlines });
  }
  offers.sort((a, b) => a.price - b.price);
  return { offers, rowCount: rows.length, hasTwd: html.includes("新台幣") };
}

// Google 依歷史資料算的「通常價格區間」與過去 60 天票價記錄,埋在頁面資料裡:
// [null,低],[null,高],1,null,null,null,[[[時間戳,價格],[時間戳,價格],...]]
// 時間戳是台灣時區當日零點的 epoch ms。
function parseInsights(html) {
  const m = html.match(/\[null,(\d{3,7})\],\[null,(\d{3,7})\],1,null,null,null,\[\[\[1[6-9]\d{11},\d/);
  if (!m) return null;
  const low = Number(m[1]), high = Number(m[2]);
  const start = html.indexOf("[[[", m.index);
  const end = html.indexOf("]]]", start);
  if (start < 0 || end < 0) return { low, high, history: [] };
  const history = [...html.slice(start, end + 3).matchAll(/\[(1[6-9]\d{11}),(\d{2,7})\]/g)]
    .map((x) => ({
      date: new Date(Number(x[1]) + 8 * 3600 * 1000).toISOString().slice(0, 10),
      price: Number(x[2]),
    }));
  return { low, high, history };
}

function judgeVsTypical(price, insight) {
  if (!insight) return "";
  if (price > insight.high) return "偏高";
  if (price < insight.low) return "偏低";
  return "一般";
}

async function searchRoute(destCode, departDate, returnDate) {
  const url = gfUrl(destCode, departDate, returnDate);
  for (let attempt = 1; attempt <= 3; attempt++) {
    fetchCount++;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "zh-TW,zh;q=0.9" },
      redirect: "follow",
    });
    if (res.status === 429 || res.status >= 500) {
      await sleep(8000 * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (res.url.includes("consent.google.com") || html.includes("consent.google.com/m?")) {
      throw new Error("被導向 Google 同意頁,執行環境 IP 可能受限");
    }
    const parsed = parseOffers(html);
    if (parsed.offers.length === 0 && parsed.rowCount > 0 && !parsed.hasTwd) {
      throw new Error("頁面有航班但抓不到台幣價格(幣別/版面異常)");
    }
    if (parsed.rowCount === 0 && !emptyPageDiag) {
      emptyPageDiag = {
        title: (html.match(/<title>([^<]*)</) || [])[1] || "(無標題)",
        len: html.length,
      };
    }
    return { offers: parsed.offers, insight: parseInsights(html) };
  }
  throw new Error("重試 3 次仍失敗(429/5xx)");
}

function sampleOffsets() {
  const out = [];
  for (
    let d = cfg.scan.daysAheadStart;
    d <= cfg.scan.daysAheadEnd;
    d += cfg.scan.sampleIntervalDays
  ) {
    out.push(d);
  }
  return out;
}

// 該城市今天要掃的出發日:固定取樣 + 關注日期窗(focusWindows,例如 10/25 前後每天掃)
function departDatesFor(city) {
  const dates = new Set(sampleOffsets().map((off) => addDays(todayTw, off)));
  for (const w of cfg.focusWindows || []) {
    if (w.countryKey !== city.country.key) continue;
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) {
      if (d > todayTw) dates.add(d);
    }
  }
  return [...dates].sort();
}

// ---- Google Sheets ----
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const HEADERS = {
  prices: [
    "掃描日", "國家", "城市", "城市代碼", "出發日", "回程日",
    "航空公司", "價格TWD", "直達班次數",
    "一般價低", "一般價高", "價格判斷",
  ],
  targets: ["城市代碼", "城市", "目標價TWD"],
  log: ["時間", "抓取次數", "寫入筆數", "錯誤數", "備註"],
  gf_history: ["城市代碼", "出發日", "回程日", "日期", "價格TWD"],
};

async function ensureTabs() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
  const missing = Object.keys(HEADERS).filter((t) => !existing.has(t));
  if (missing.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
      },
    });
  }
  // 標題列每次校正(欄位新增時舊分頁也會補齊)
  for (const title of Object.keys(HEADERS)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${title}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS[title]] },
    });
  }
}

// targets 分頁:沒設定過的城市補上該國預設目標價(之後在網頁上改)
async function seedTargets() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "targets!A2:C",
  });
  const have = new Set((res.data.values || []).map((r) => r[0]));
  const rows = [];
  for (const country of cfg.countries) {
    for (const c of country.cities) {
      if (!have.has(c.code)) rows.push([c.code, c.zh, country.defaultTargetTwd]);
    }
  }
  if (rows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "targets!A1",
      valueInputOption: "RAW",
      requestBody: { values: rows },
    });
  }
}

// ---- 主流程 ----
await ensureTabs();
await seedTargets();

// 當日冪等:今天已經掃成功就跳過(排程一天跑三次,是為了 runner IP 被擋時自動重試)
if (process.env.FORCE_SCAN !== "true" && process.env.FORCE_SCAN !== "1") {
  const scanned = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "prices!A:A",
  });
  if ((scanned.data.values || []).some((r) => r[0] === todayTw)) {
    console.log(`今天(${todayTw})已有掃描資料,跳過本次執行`);
    process.exit(0);
  }
}

const rows = [];
const cities = cfg.countries.flatMap((country) =>
  country.cities.map((c) => ({ ...c, country }))
);
console.log(
  `掃描 ${cities.length} 個城市(${todayTw},固定取樣 ${sampleOffsets().length} 天 + 關注日期窗)`
);

const gfRows = [];

for (const city of cities) {
  let bestPair = null; // 該城市目前最便宜的日期組合 → 它的 60 天記錄寫進 gf_history
  for (const dep of departDatesFor(city)) {
    const ret = addDays(dep, city.country.tripDays);
    try {
      const { offers, insight } = await searchRoute(city.code, dep, ret);
      if (offers.length > 0) {
        const best = offers[0];
        rows.push([
          todayTw, city.country.name, city.zh, city.code, dep, ret,
          best.airlines, best.price, offers.length,
          insight ? insight.low : "", insight ? insight.high : "",
          judgeVsTypical(best.price, insight),
        ]);
        if (!bestPair || best.price < bestPair.price) {
          bestPair = { price: best.price, dep, ret, insight };
        }
        console.log(`  ${city.zh} ${dep}→${ret}  NT$${best.price} (${best.airlines})${insight ? ` [通常${insight.low}~${insight.high} ${judgeVsTypical(best.price, insight)}]` : ""}`);
      } else {
        console.log(`  ${city.zh} ${dep}→${ret}  無直飛報價`);
      }
    } catch (err) {
      errors.push(`${city.code} ${dep}: ${err.message}`);
      console.error(`  ${city.zh} ${dep} 失敗: ${err.message}`);
    }
    await sleep(cfg.scan.throttleMs);
  }
  if (bestPair && bestPair.insight && bestPair.insight.history.length > 0) {
    for (const p of bestPair.insight.history) {
      gfRows.push([city.code, bestPair.dep, bestPair.ret, p.date, p.price]);
    }
  }
}

if (rows.length > 0) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "prices!A1",
    valueInputOption: "RAW",
    requestBody: { values: rows },
  });
}

// gf_history 每次整批重寫(只保留最新的 60 天記錄)
if (gfRows.length > 0) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: "gf_history!A2:E",
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "gf_history!A1",
    valueInputOption: "RAW",
    requestBody: { values: gfRows },
  });
}

// 全部航線都拿不到任何航班列 → 極可能是這台 runner 的 IP 被 Google 降級,標記失敗讓下一班排程重試
const suspectedBlock = rows.length === 0 && emptyPageDiag !== null;

await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: "log!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [[
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (台灣時間)",
      fetchCount, rows.length, errors.length,
      (suspectedBlock
        ? `疑似被擋:頁面無航班列(title=${emptyPageDiag.title}, len=${emptyPageDiag.len})。`
        : "") + errors.slice(0, 5).join(" | "),
    ]],
  },
});

console.log(`完成:抓取 ${fetchCount} 次,寫入 ${rows.length} 筆,錯誤 ${errors.length} 筆`);
if (suspectedBlock) {
  console.error(`疑似被 Google 降級(所有頁面無航班列)。診斷:title=${emptyPageDiag.title}, len=${emptyPageDiag.len}`);
  process.exit(1);
}
if (errors.length > 0 && rows.length === 0) process.exit(1);
