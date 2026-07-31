# DEVELOPMENT_LOG

## 2026-07-31 專案建立

### 對話過程

使用者提出:「還記得股票監測那個專案嗎?我現在想做類似專案,是監測機票。」

需求(使用者原話整理):
- 監測各國機票,目前要**每天監測日本+義大利**
- 只看**直飛**,**不要廉價航空**
- 做成**網頁版本**,可以隨時監看
- 目標是「達到很好的價格就要買」
- 限制只看**來回**,不要單程
- 專案上 GitHub,取一個機票價格監控類的英文名字

追問後補充:
- 日本跟義大利「**全部地方**」的機票,目的地全部列出來,介面上要有國家分類
- 因為**還沒規劃行程**(所以採滾動掃描找最低價,而不是盯固定日期)

### 命名

`flight-price-radar`(機票價格雷達)——「雷達」呼應持續掃描+好價警示,
與 stock-tracker 同樣的直白命名風格。

### 技術決策

| 決策 | 選擇 | 原因 |
|---|---|---|
| 票價資料來源 | Amadeus Self-Service API(test 環境) | 免費、官方、支援 nonStop 過濾與來回報價;Skyscanner/Kiwi API 已不開放申請,爬 Google Flights 太脆弱 |
| 排程 | GitHub Actions cron(22:30 UTC = 台灣 06:30) | 免費、可手動觸發,沿用熟悉的模式 |
| 資料儲存 | Google Sheet(prices/targets/log 分頁) | 沿用既有專案的 Google 服務帳號;歷史資料可以直接開 Sheet 看 |
| 網頁 | 純 HTML + Vercel serverless functions(無框架) | 跟 website-qa-checker/bento-shop 同模式,好維護 |
| 廉航過濾 | 航空公司**白名單**(BR/CI/JL/NH/JX/AE/AZ/7G) | 白名單比黑名單保險,新廉航不會漏進來;直接用 Amadeus `includedAirlineCodes` 參數,程式內再驗一次 |
| 直飛過濾 | API `nonStop=true` + 程式驗證每段行程只有 1 個航段 | 雙重保險 |
| 日期策略 | 滾動掃描:未來 14~110 天每 21 天取樣,日本 5 天行程、義大利 10 天行程 | 使用者還沒規劃行程,目標是「看到好價就飛」;天數在 config 可調 |
| API 額度 | Tier A(六大日本航點+羅馬米蘭)每天掃,Tier B(日本二線)每天輪 3 個 | 每天約 55 次呼叫 ≈ 月 1,650 次,壓在 test 免費額度內;log 分頁記錄每日用量 |
| 好價提示 | 網頁紅標(status red + ▼ 圖示 + 文字),目標價存 Sheet 可線上改 | 使用者要「隨時監看」,先不做推播;日本預設目標 NT$9,000、義大利 NT$32,000 |
| 介面 | 國家分類分區 + 城市卡片(現價/航班/sparkline)+ 明細彈窗(走勢圖+各出發日比價表) | 使用者指定要國家分類;「哪天出發最便宜」表格幫助還沒定行程的人挑日期 |
| 示範模式 | `?demo=1` 或 API 失敗時顯示示範資料 | 還沒接好金鑰前就能預覽介面 |

### 直飛航點查證(2026-07-31)

- 義大利:長榮直飛米蘭(週四班)、華航 A350 直飛羅馬——兩個城市都列入。
  來源:[長榮米蘭航線頁](https://europe.evaair.com/milan/)、
  [東南旅遊華航直飛羅馬行程](https://tour.settour.com.tw/product/GFG0000027396)
- 日本:主要航點(東京/大阪/福岡/札幌/沖繩/名古屋/仙台/熊本等)全服務航空皆有直飛;
  二線航點(高松/廣島/鹿兒島/函館/松山/小松/青森/北九州)多為華航/長榮/星宇飛,列入 Tier B 輪掃。
  來源:[樂吃購日本機場指南](https://www.letsgojp.com/archives/329180/)、
  [台灣直飛日本航線懶人包](https://travelcontentsapp.com/news/events/n20260331/)
- 查無直飛的期間(停飛/季節性)介面顯示「目前查無直飛報價」,不會誤抓轉機班次。

### 品質檢查

- 圖表色彩通過 dataviz 調色驗證(淺/深色模式皆 PASS)
- 本機 demo 模式實測:卡片、紅標邏輯、走勢圖 crosshair tooltip、表格切換、
  目標價編輯皆正常,console 無錯誤
- `node --check` 通過(scan.mjs / api/*.js)

### 待辦(使用者)

1. 到 developers.amadeus.com 註冊拿 API Key/Secret(金鑰進私人憑證庫)
2. 建 Google Sheet、分享給服務帳號、記 Sheet ID
3. 設 GitHub Actions Secrets 四個值
4. Actions 手動跑一次 daily-scan 驗證
5. Vercel import repo + 設兩個環境變數
