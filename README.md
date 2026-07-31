# ✈️ flight-price-radar 機票價格雷達

每天自動監測「台北出發 → 日本/義大利各城市」的**直飛、來回、全服務航空**最低票價,
寫入 Google Sheet 留歷史,網頁隨時監看;低於目標價就亮紅標,看到好價直接下手訂票。

## 需求起因

想飛日本和義大利,但還沒規劃行程——不確定去哪個城市、哪天出發。
與其每天手動查票價,不如仿照 stock-tracker 的模式做一個「機票版」:

- 只看**直飛**(不轉機)、只看**來回票**(不看單程)、**不含廉價航空**(長榮/華航/星宇/日航/全日空等全服務航空)
- 日本、義大利**所有有直飛的城市全部列出來**,介面上按國家分類,方便比較「去哪裡最划算」
- 每天自動掃描未來 2 週~3.5 個月的出發日,找出每條航線最便宜的來回組合
- 網頁隨時看,**低於自設目標價亮紅標**,達到好價就買

## 架構

```
GitHub Actions(每天台灣時間 06:30)
  └─ scripts/scan.mjs
       ├─ Amadeus Flight Offers Search API(直飛+來回+航空白名單)
       └─ 寫入 Google Sheet(prices / targets / log 三個分頁,自動建立)

Vercel
  ├─ public/index.html   網頁介面(國家分類卡片、走勢圖、目標價紅標)
  ├─ api/prices.js       讀 Sheet → 整理成前端資料
  └─ api/target.js       網頁上修改目標價 → 寫回 Sheet
```

## 監測航點

| 國家 | 城市 | 說明 |
|---|---|---|
| 日本(5 天行程) | 東京、大阪、名古屋、福岡、札幌、沖繩 | Tier A:每天掃描 |
| 日本(5 天行程) | 仙台、熊本、廣島、高松、鹿兒島、函館、松山、小松、青森、北九州 | Tier B:每天輪掃 3 個(省 API 額度) |
| 義大利(10 天行程) | 羅馬(華航直飛)、米蘭(長榮直飛) | Tier A:每天掃描 |

查無直飛班次的城市會顯示「目前查無直飛報價」(例如季節性航線停飛期間)。

航空白名單:長榮 BR、華航 CI、日航 JL、全日空 NH、星宇 JX、華信 AE、ITA義航 AZ、星悅 7G。
酷航/樂桃/虎航/捷星等廉航直接排除。

## 設定步驟(第一次)

1. **Amadeus API**:到 <https://developers.amadeus.com> 註冊 → My Self-Service Workspace
   → Create New App → 拿到 `API Key` 和 `API Secret`(用免費的 test 環境即可)。
   金鑰正本照慣例存進私人憑證庫。
2. **Google Sheet**:建一個新的空白 Sheet,把既有的 Google 服務帳號加為**編輯者**,
   記下網址中的 Sheet ID。分頁不用建,掃描器會自動建立。
3. **GitHub Secrets**(repo → Settings → Secrets and variables → Actions):
   - `AMADEUS_API_KEY`、`AMADEUS_API_SECRET`
   - `GOOGLE_SERVICE_ACCOUNT`(服務帳號 JSON 整份貼上)
   - `SHEET_ID`
4. **手動測試**:repo → Actions → daily-scan → Run workflow,跑完看 Sheet 有沒有資料。
5. **Vercel**:Import 這個 repo,環境變數設 `GOOGLE_SERVICE_ACCOUNT` 和 `SHEET_ID`
   (Vercel 只需要這兩個,不用 Amadeus 金鑰)。
6. 部署完成後開網址即可。還沒設定好之前,網址加 `?demo=1` 可以看示範資料預覽介面。

## 掃描策略與 API 額度

- 出發日取樣:未來第 14~110 天,每 21 天取一個樣(每條航線每天 5 個出發日)
- 每天約 55 次 API 呼叫 ≈ 每月 1,650 次,控制在 Amadeus test 環境免費額度(約 2,000 次/月)內
- 想掃更密(例如每 7 天取樣)就改 `config/routes.json` 的 `scan` 區塊,
  但要注意額度;`log` 分頁每天記錄 API 用量,可以先觀察再調
- Tier B 城市每天輪 3 個,想升級成每天掃就把該城市的 `tier` 改成 `"A"`

## 注意事項

- 顯示的是 Amadeus 查詢當下的報價,**訂票前請以航空公司官網為準**
- Amadeus test 環境資料偶爾不完整,部分二線航點可能查不到報價;
  之後想換 production 環境,把 GitHub repo 變數 `AMADEUS_ENV` 設成 `production` 即可(額度計費不同,先確認方案)
- 目標價在網頁上就能改(存回 Sheet 的 `targets` 分頁),不用動程式碼
