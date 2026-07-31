// flight-price-radar 每日掃描器
// 查詢台北出發 → 日本/義大利各城市的「直飛、來回、全服務航空」最低票價,寫入 Google Sheet。
// 由 GitHub Actions 每天執行(.github/workflows/daily-scan.yml),也可本機執行:
//   AMADEUS_API_KEY=... AMADEUS_API_SECRET=... GOOGLE_SERVICE_ACCOUNT='{"...":"..."}' SHEET_ID=... node scripts/scan.mjs

import { readFile } from "node:fs/promises";
import { google } from "googleapis";

const cfg = JSON.parse(
  await readFile(new URL("../config/routes.json", import.meta.url), "utf8")
);

const {
  AMADEUS_API_KEY,
  AMADEUS_API_SECRET,
  AMADEUS_ENV = "test",
  GOOGLE_SERVICE_ACCOUNT,
  SHEET_ID,
} = process.env;

for (const [k, v] of Object.entries({
  AMADEUS_API_KEY,
  AMADEUS_API_SECRET,
  GOOGLE_SERVICE_ACCOUNT,
  SHEET_ID,
})) {
  if (!v) {
    console.error(`缺少環境變數 ${k}`);
    process.exit(1);
  }
}

const AMADEUS_BASE =
  AMADEUS_ENV === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";

const WHITELIST = new Set(cfg.airlineWhitelist);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 日期(以台灣時間為準) ----
const twNow = new Date(Date.now() + 8 * 3600 * 1000);
const todayTw = twNow.toISOString().slice(0, 10);
const addDays = (isoDate, n) => {
  const d = new Date(isoDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ---- Amadeus ----
let token = null;
let callsUsed = 0;
const errors = [];

async function getToken() {
  const res = await fetch(`${AMADEUS_BASE}/v1/security/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: AMADEUS_API_KEY,
      client_secret: AMADEUS_API_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Amadeus 取 token 失敗 HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function searchOffers(destCode, departDate, returnDate) {
  const url = new URL(`${AMADEUS_BASE}/v2/shopping/flight-offers`);
  url.search = new URLSearchParams({
    originLocationCode: cfg.origin,
    destinationLocationCode: destCode,
    departureDate: departDate,
    returnDate: returnDate,
    adults: "1",
    nonStop: "true",
    currencyCode: cfg.currency,
    includedAirlineCodes: cfg.airlineWhitelist.join(","),
    max: String(cfg.scan.maxOffersPerCall),
  });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    callsUsed++;
    if (res.status === 429) {
      await sleep(2000 * attempt);
      continue;
    }
    if (res.status === 401) {
      token = await getToken();
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error("重試 3 次仍失敗(429/401)");
}

// 從回傳的報價中挑出最便宜且「兩段都直飛、都在白名單」的一筆
function pickBest(payload) {
  const offers = (payload.data || []).filter((o) =>
    (o.itineraries || []).every(
      (it) =>
        it.segments?.length === 1 &&
        WHITELIST.has(it.segments[0].carrierCode)
    )
  );
  if (offers.length === 0) return null;
  offers.sort(
    (a, b) => parseFloat(a.price.grandTotal) - parseFloat(b.price.grandTotal)
  );
  const best = offers[0];
  const legs = best.itineraries.map((it) => {
    const s = it.segments[0];
    return `${s.carrierCode}${s.number}`;
  });
  const carriers = [
    ...new Set(best.itineraries.map((it) => it.segments[0].carrierCode)),
  ];
  return {
    price: Math.round(parseFloat(best.price.grandTotal)),
    flights: legs.join(" / "),
    carriers: carriers.join("/"),
    offerCount: offers.length,
  };
}

// ---- 今天要掃哪些城市:Tier A 每天掃,Tier B 輪流掃 ----
function citiesForToday() {
  const list = [];
  for (const country of cfg.countries) {
    const tierA = country.cities.filter((c) => c.tier === "A");
    const tierB = country.cities.filter((c) => c.tier === "B");
    list.push(...tierA.map((c) => ({ ...c, country })));
    if (tierB.length > 0) {
      const per = cfg.scan.tierBPerDay;
      const numChunks = Math.ceil(tierB.length / per);
      const idx = Math.floor(Date.now() / 86400000) % numChunks;
      list.push(
        ...tierB
          .slice(idx * per, idx * per + per)
          .map((c) => ({ ...c, country }))
      );
    }
  }
  return list;
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

// ---- Google Sheets ----
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(GOOGLE_SERVICE_ACCOUNT),
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const HEADERS = {
  prices: [
    "掃描日", "國家", "城市", "城市代碼", "出發日", "回程日",
    "航班", "航空公司", "價格TWD", "報價數",
  ],
  targets: ["城市代碼", "城市", "目標價TWD"],
  log: ["時間", "API呼叫數", "寫入筆數", "錯誤數", "備註"],
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
    for (const title of missing) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${title}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: [HEADERS[title]] },
      });
    }
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
token = await getToken();

const rows = [];
const offsets = sampleOffsets();
const todays = citiesForToday();
console.log(
  `掃描 ${todays.length} 個城市 × ${offsets.length} 個出發日取樣(${todayTw})`
);

for (const city of todays) {
  for (const offset of offsets) {
    const dep = addDays(todayTw, offset);
    const ret = addDays(dep, city.country.tripDays);
    try {
      const payload = await searchOffers(city.code, dep, ret);
      const best = pickBest(payload);
      if (best) {
        rows.push([
          todayTw, city.country.name, city.zh, city.code, dep, ret,
          best.flights,
          best.carriers
            .split("/")
            .map((cc) => cfg.airlineNames[cc] || cc)
            .join("/"),
          best.price, best.offerCount,
        ]);
        console.log(`  ${city.zh} ${dep}→${ret}  NT$${best.price} (${best.flights})`);
      } else {
        console.log(`  ${city.zh} ${dep}→${ret}  無直飛報價`);
      }
    } catch (err) {
      errors.push(`${city.code} ${dep}: ${err.message}`);
      console.error(`  ${city.zh} ${dep} 失敗: ${err.message}`);
    }
    await sleep(cfg.scan.throttleMs);
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

await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: "log!A1",
  valueInputOption: "RAW",
  requestBody: {
    values: [[
      new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " (台灣時間)",
      callsUsed, rows.length, errors.length,
      errors.slice(0, 5).join(" | "),
    ]],
  },
});

console.log(`完成:API 呼叫 ${callsUsed} 次,寫入 ${rows.length} 筆,錯誤 ${errors.length} 筆`);
if (errors.length > 0 && rows.length === 0) process.exit(1);
