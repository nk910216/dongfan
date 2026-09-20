# 寶寶事件記錄 App - 規格書

> 「技術決策」章節的內容已經拍板，實作時直接遵循即可，不需要重新討論。

---

# 1. 目標

- 製作一款寶寶紀錄 app，單純給自己跟家人使用，需要帳號登入
- 可以多人一起更新寶寶事件（主要情境：夫妻兩人共同記錄）
- 同時有 iPhone / Android / Web 需求，三個平台都要能用
- 介面乾淨好懂好用
- 目前只需要繁體中文，不做多語系
- 參考市面上的寶寶 app，做出功能較陽春但適合個人使用的版本
- 有在外使用需求，資料存在 server 上
- 目前不需要照片功能
- 需要圖表查看每日成長趨勢與每日變化

核心概念：**這個 app 本質上是一個寶寶行為事件記錄器**。除了記錄事件，也提供總結、行事曆、統計、趨勢等檢視方式。

---

# 2. 技術決策

## 2.1 平台策略：PWA（Progressive Web App）

**決定：做一個 PWA，不做原生 app。**

理由：
- iOS 要把原生 app 裝到自己手機上，需要 Apple Developer 帳號（US$99/年）。免費簽章 7 天就失效，無法長期使用。為了兩個人用的 app 付這筆錢並走送審流程不划算。
- 本 app 不需要相機、藍牙、背景定位等只有原生才有的能力。
- PWA 在 Android（Chrome）支援完整：可安裝到桌面、獨立視窗、離線快取、Web Push。
- PWA 在 iOS（Safari）需「加入主畫面」後才有 standalone 模式與 Web Push，但基本使用完全沒問題。
- 改版直接部署就生效，**不需要 App Store 審核**。
  - **注意**：這不代表沒有版本落後問題。裝了 Service Worker 的 PWA 正好相反——SW 會從快取供應舊 bundle，直到新的 SW 安裝並啟用為止。因此 M2 加入離線快取時**必須同時定義更新策略**：`registerType: 'prompt'` + 顯示「有新版本，點此更新」，並提供 `GET /api/version` 供 client 比對。
  - **提示更新不等於版本相容策略**，還需要：
    1. **重新載入不可弄丟表單草稿**——使用者可能正在填一筆事件。
    2. **舊版產生的離線 POST 必須仍能被新版 API 接受**，或至少被保留成可處理的失敗紀錄，不可靜默丟棄。API 的欄位變更必須向後相容，或為舊格式提供轉換。
    3. 後端改 schema 時尤其需要這兩條。

未來若真的需要原生能力，可用 Expo 或 Capacitor 包裝現有前端，前端程式碼大部分可沿用。**但這不在目前範圍內。**

## 2.2 Tech Stack

| 項目 | 選擇 | 備註 |
|---|---|---|
| 語言 | TypeScript（前後端統一） | 前後端共用型別與事件 config |
| 前端框架 | React + Vite | |
| 前端路由 | React Router | |
| 前端狀態/資料 | TanStack Query | 快取、重新整理、樂觀更新 |
| UI 樣式 | Tailwind CSS | |
| 圖表 | Recharts | |
| PWA | `vite-plugin-pwa` | Service Worker、manifest、離線快取 |
| 後端框架 | Hono on Cloudflare Workers | |
| 資料庫 | Cloudflare D1 | 建立時指定 location hint = APAC |
| ORM / Migration | Drizzle ORM + drizzle-kit | migration 檔案納入版控 |
| 驗證 | Zod | 前後端共用 schema |
| 測試 | Vitest、`@cloudflare/vitest-pool-workers`、Testing Library、MSW、Playwright | 詳見第 11 章 |
| Lint / Format | ESLint + Prettier | |
| 部署 | 單一 Cloudflare Worker（同時服務 API 與靜態檔） | |

### 為什麼是 TypeScript 而不是 Rust 或 Python

- **不是 Rust**：Workers 的第一語言是 JS/TS，Rust 走 `workers-rs` 編譯成 WASM，D1 binding 呼叫彆扭、編譯慢、生態系小，且無法與前端共用型別。（註：bundle 大小**不是**理由——Workers 目前上限為 64 MiB 未壓縮、無壓縮後限制，WASM 放得下。）
- **不是 Python**：Cloudflare 的 Python Workers 以 Pyodide 實作，目前仍在 beta，冷啟動慢、第三方套件支援有限。
- **是 TypeScript**：後續功能主要靠 coding agent 補齊，型別系統提供自動化的正確性回饋（`tsc` 會當場抓出 agent 的錯誤），這是 agent 驅動開發最重要的護欄。另外事件 type config 需要前後端共用，TypeScript 是唯一能讓同一份 config 同時驅動前端 UI 與後端驗證的選項。

## 2.3 替代方案評估（2026-09 查證）

此決定已評估完成，**不需要再重新討論**。

| 方案 | 免費狀態 | 對本專案的問題 |
|---|---|---|
| **Cloudflare Workers + D1** | 真正免費 | 僅密碼雜湊受 CPU 限制（見 9.3） |
| Render | 有免費方案 | **閒置 15 分鐘休眠，喚醒 30–60 秒** |
| Supabase | 有免費方案 | 7 天無活動暫停，喚醒約 30 秒 |
| Railway | 2023 年已取消免費方案 | 僅一次性 $5 試用額度 |
| Fly.io | 2026 年已無免費方案 | 僅 2 VM 小時 / 7 天試用 |

**決定性因素：Cloudflare Workers 沒有休眠也沒有冷啟動。**

寶寶 app 的使用模式是零散且間隔長的（餵奶間隔兩三小時），因此幾乎每次開啟都會撞上其他平台的冷啟動。半夜單手抱小孩要記一筆換尿布，等 30–60 秒是無法接受的。

**把兩邊痛點放在同一尺度比較**：
- Cloudflare：登入 API 受 10 ms CPU 限制 → 但登入每 90 天才發生一次，且有有效替代方案（強密碼）。
- Render：每次隔 15 分鐘再開就等 30–60 秒 → 每天發生數次，無替代方案。

**關於 Supabase**：它是唯一能解決本專案唯一痛點的方案（內建管理式 auth，無 CPU 限制）。但代價是新增「長期未使用即暫停」的失敗模式（需靠排程 ping 規避）、免費 DB 同樣只有 500 MB、需改用 RLS 權限模型（對 agent 而言比 Hono handler 更容易寫出漏洞）、鎖定更深。為了一個「使用強密碼」即可解決的問題付出這些代價，不划算。

**退路（兩者都很寬，因此現在不需過度糾結）**：
1. **Workers 付費方案 $5/月**：CPU 提升至預設 30 秒（最高 5 分鐘）、D1 10 GB、Time Travel 30 天。這是改設定，不是搬家，一年 $60 仍低於已省下的 Apple Developer $99。
2. **可攜性高**：D1 即 SQLite，`wrangler d1 export` 可匯入任何 SQLite / Turso 或轉 Postgres；Hono 設計為跨 runtime，同一份程式碼可跑在 Node / Bun / Deno / Vercel / AWS Lambda，要改的是入口檔而非商業邏輯。

## 2.4 專案結構（Monorepo）

```
babyapp/
├── packages/
│   ├── shared/          # 前後端共用：事件 type config、Zod schema、型別、日期工具
│   ├── api/             # Cloudflare Worker (Hono)
│   │   ├── src/
│   │   ├── migrations/  # drizzle-kit 產生的 SQL migration
│   │   └── wrangler.toml
│   └── web/             # React PWA
├── scripts/             # 使用者管理 CLI、備份
├── AGENTS.md            # 開發規範（agent 必讀，見 13.1）
├── CLAUDE.md            # → symlink 到 AGENTS.md
└── spec.md
```

`packages/shared` 是單一事實來源，`api` 和 `web` 都從這裡 import。

## 2.5 免費方案限制與成本

查證於 2026-09（官方文件，日後仍請自行複查）：

| 限制 | Workers Free | Workers Paid |
|---|---|---|
| 每日請求數 | 100,000 | 無限制 |
| **每次請求 CPU 時間** | **10 ms（不可調整）** | 預設 30 秒，最高 5 分鐘 |
| Worker bundle | 64 MiB 未壓縮 | 同左 |
| 記憶體 | 128 MB | 同左 |
| Subrequest | 50 / 請求 | 10,000 / 請求 |
| D1 資料庫大小 | **500 MB** | 10 GB |
| D1 帳號總儲存 | 5 GB | 1 TB |
| **D1 每次 Worker 呼叫的查詢數** | **50** | 1,000 |
| **D1 每次查詢的 bound parameters** | **100** | 100 |
| **D1 每日 rows read** | **5,000,000** | 含於方案額度 |
| **D1 每日 rows written** | **100,000** | 含於方案額度 |
| **D1 Time Travel 保留期** | **7 天** | 30 天 |

**靜態檔請求免費且不計數**——只有進到 Worker script 的請求才吃 100,000/day。因此「每日請求數」這條對本專案完全不需擔心。

**四個需要在設計上留意的**：

1. **CPU 10 ms 不可調整** —— 直接影響密碼雜湊，見 9.3。
2. **每次呼叫最多 50 次 D1 查詢，且每次查詢最多 100 個 bound parameters** —— 前者禁止 N+1，後者禁止把 id 清單逐一綁參數。兩條的正確作法都是 JOIN，見 4.2。
3. **每日 rows written 只有 100,000，且超過後當日所有 D1 查詢都會報錯直到 UTC 00:00 重置。** 這是**可用性**風險，不只是額度問題：任何會因外部流量而寫入 DB 的設計（例如把每次登入失敗寫成一列）都可能被掃描器打爆，連帶讓你連新增事件都失敗。詳見 9.4。
4. **Time Travel 只保留 7 天** —— 若資料損壞超過一週才發現就救不回來。緩解方式見 12.2。

**容量評估**：以每天 20 筆事件、每筆約 300 bytes 估算，五年約 36,500 筆、約 11 MB，遠低於 500 MB 上限。

**成本**：
- 全部功能在免費方案內可完成，無月費。
- 唯一固定成本為網域名稱（約 US$10–15/年），非必要也可先用 `*.workers.dev`。
- 走 PWA 路線省下 Apple Developer 的 US$99/年。

---

# 3. 資料模型

## 3.1 事件類型 Config

事件類型由開發者定義，寫在 `packages/shared` 的一份 config 中。新增一個事件類型 = 在 config 加一筆設定，前後端同時生效。

```ts
type Aggregation =
  | 'count'         // 每日發生次數（換尿布、洗澡）
  | 'sum'           // 每日數值加總（喝奶 ml）
  | 'last'          // 取當日最後一筆的值（體重、身高、頭圍）
  | 'avg'           // 每日平均
  | 'max'           // 每日最大值（體溫）
  | 'duration_sum'; // 每日總時長（睡眠）

type ValueSpec = {
  unit: string;      // 顯示單位，如 'ml' | 'g' | 'mm' | '°C'
  scale: number;     // 儲存值 = 顯示值 × scale（見 3.2）
  min: number;       // 顯示值的合理下限
  max: number;       // 顯示值的合理上限
  label: string;     // 輸入欄位標籤
};

type CategoryId =
  | 'food'       // 食物
  | 'activity'   // 活動
  | 'growth'     // 成長速度
  | 'health'     // 健康狀況
  | 'mood'       // 情緒
  | 'milestone'  // 重要事件
  | 'other';     // 其他

type EventTypeConfig = {
  id: string;                    // 'nursing' | 'diaper' | 'sleep' ...（永不變更）
  name: string;                  // 繁中顯示名稱
  category: CategoryId;          // 大分類，見 3.3
  icon: string;                  // lucide-react 的圖示名稱，見下方規定
  color: string;                 // 主題色（CSS 色碼）
  hasRange: boolean;             // 是否有結束時間
  timerEnabled: boolean;         // 是否支援「進行中」計時（見 3.5）
  allDay: boolean;               // 整天事件，見 3.9
  value: ValueSpec | null;       // null 代表此類型不需使用者填數值
  valueRequired: boolean;        // value 非 null 時，使用者是否必填，見 3.2
  aggregation: Aggregation;      // 統計頁如何聚合
  quickAction: boolean;          // 是否出現在主頁的事件管理快捷區（§7.2）
  order: number;                 // 同分類內的顯示順序，也決定快捷區順序
  metadataFields?: MetadataField[]; // 額外欄位，見 3.6
};
```

**圖示庫**：一律使用 **`lucide-react`**，`icon` 欄位存該圖示的名稱字串（如 `'moon'`、`'baby'`）。不可混用多套圖示庫。

**合法性約束**（config 載入時以 runtime assert 檢查，違反即拋錯）：
- `timerEnabled: true` ⇒ `hasRange: true`
- `allDay: true` ⇒ `hasRange: false` 且 `timerEnabled: false`
- `aggregation: 'duration_sum'` ⇒ `hasRange: true`
- `aggregation` 為 `'sum' | 'last' | 'avg' | 'max'` ⇒ `value !== null`
- `valueRequired: true` ⇒ `value !== null`
- 同一 `category` 內 `order` 不得重複

**Fallback 規則**：前端遇到 config 裡不存在的 `type_id` 時，必須以灰色通用圖示 + 原始 type_id 顯示，不可 crash。

### 3.1.1 v1 事件類型表

以下為 v1 要實作的完整清單。`order` 為同分類內順序。未列出的欄位（icon、color）由實作者依分類色系選定，但必須寫進 config。

| id | 名稱 | 分類 | hasRange | timer | allDay | value | 必填 | aggregation | 快捷 | metadata |
|---|---|---|---|---|---|---|---|---|---|---|
| `nursing` | 哺乳 | food | ✓ | ✓ | | — | | `duration_sum` | ✓ | `side` |
| `bottle` | 奶瓶 | food | | | | ml (1, 0–500) | ✓ | `sum` | ✓ | |
| `solid_food` | 副食品 | food | | | | — | | `count` | ✓ | `food_name` |
| `pumping` | 擠奶 | food | | | | ml (1, 0–500) | ✓ | `sum` | | `side` |
| `diaper` | 尿布 | activity | | | | — | | `count` | ✓ | `diaper_kind` |
| `sleep` | 睡眠 | activity | ✓ | ✓ | | — | | `duration_sum` | ✓ | |
| `walk` | 散步 | activity | ✓ | ✓ | | — | | `duration_sum` | | |
| `bath` | 洗澡 | activity | | | | — | | `count` | | |
| `play` | 玩耍 | activity | ✓ | ✓ | | — | | `duration_sum` | | |
| `weight` | 體重 | growth | | | | g (1, 500–30000) | ✓ | `last` | | |
| `height` | 身高 | growth | | | | mm (1, 200–1500) | ✓ | `last` | | |
| `head_circ` | 頭圍 | growth | | | | mm (1, 200–700) | ✓ | `last` | | |
| `doctor_visit` | 看醫生 | health | | | | — | | `count` | | `place`, `reason` |
| `vaccine` | 注射疫苗 | health | | | | — | | `count` | | `vaccine_name` |
| `temperature` | 體溫 | health | | | | °C (10, 34.0–42.0) | ✓ | `max` | | |
| `illness` | 所患疾病 | health | | | | — | | `count` | | `illness_name` |
| `medicine` | 服用藥物 | health | | | | — | | `count` | | `medicine_name` |
| `mood_happy` | 開朗 | mood | | | | — | | `count` | | |
| `mood_neutral` | 一般 | mood | | | | — | | `count` | | |
| `mood_sad` | 悲傷 | mood | | | | — | | `count` | | |
| `mood_crying` | 哭泣 | mood | | | | — | | `count` | | |
| `milestone` | 里程碑 | milestone | | | ✓ | — | | `count` | | `title` |
| `other` | 其他 | other | | | | — | | `count` | | `title` |

`value` 欄位格式為 `單位 (scale, 顯示值 min–max)`。

**哺乳與睡眠沒有 `value`**：它們的「量」是時長，由 `started_at`/`ended_at` 推導，`value` 一律寫 1（見 3.2）。

## 3.2 數值一律存整數

每個類型的數值以「最小單位的整數」儲存，避免浮點數誤差。`scale` 定義換算關係：

| 類型 | 顯示 | 儲存 | unit | scale |
|---|---|---|---|---|
| 喝奶 | 80 ml | 80 | ml | 1 |
| 體重 | 4000 g | 4000 | g | 1 |
| 身高 | 500 mm | 500 | mm | 1 |
| 頭圍 | 360 mm | 360 | mm | 1 |
| 體溫 | 36.5 °C | 365 | °C | 10 |
| 無數值類型 | — | 1 | — | — |

**`value` 欄位一律 `NOT NULL DEFAULT 1`**，規則如下：

- `value: null` 的類型（無數值）→ 後端一律寫入 `1`，代表發生一次。API 忽略 client 傳來的 value。
- `value !== null` 且 `valueRequired: true` → 使用者必填，未填則回 `VALIDATION_FAILED`。
- `value !== null` 且 `valueRequired: false` → 使用者可留空，留空時寫入 `1`。

因為無數值類型一律寫 1，`SUM(value)` 與 `COUNT(*)` 在這些類型上等價。**`count` 與 `sum` 請共用同一段 SQL（`SUM(value)`），不要為兩者寫兩套邏輯。**

**單位換算只發生在前端 UI 層。API 與 DB 一律只傳／只存「儲存整數」**，見 5.3。

## 3.3 大分類

`food`（食物）、`activity`（活動）、`growth`（成長速度）、`health`（健康狀況）、`mood`（情緒）、`milestone`（重要事件）、`other`（其他）

## 3.4 時間與「一天」的定義

**這是整個統計功能的地基，規則如下，不得各處自行解讀：**

1. **所有時間戳一律以 UTC epoch milliseconds 儲存**（`started_at`、`ended_at`、`created_at`、`updated_at`）。
2. **時區屬於寶寶**：寶寶表有 `timezone` 欄位，預設 `Asia/Taipei`。
   - **v1 不在 UI 開放修改**。改時區需要重算所有事件的 `local_date`，屬於 migration 等級操作。欄位先留著，未來真的需要時另寫 script 處理。
   - 絕對不可使用「裝置當下時區」來計算日期，否則出國時同一天的資料會散到兩天。
3. **`local_date`（TEXT，`YYYY-MM-DD`）在寫入時就算好並存進 DB**，依據寶寶的 `timezone` 由 `started_at` 換算。這是所有日期查詢與圖表分組的依據。
4. **跨午夜事件的歸屬**：
   - **次數 / 筆數**：歸屬於**開始時間所在的那一天**。
   - **總時長**：依實際跨日邊界**切分到各天**。例如 23:00–07:00 的睡眠，計為前一天 1 小時 + 後一天 7 小時。
   - 理由：若時長也歸開始日，圖表會出現某天睡 0 小時、隔天睡 16 小時的荒謬結果。
   - 切分在查詢時計算，DB 不另外存拆分後的資料。

### 3.4.1 查詢邊界（必讀，不照做會靜默漏資料）

`local_date` 由 `started_at` 推導，因此 **23:00–07:00 的睡眠 `local_date` 是前一天**。若查詢某日時只用 `WHERE local_date = D`，這筆事件**不會被撈出來**，D 那天就憑空少了 7 小時——正是第 4 點要避免的結果。

**規則**：

1. **唯一的長度規則：`ended_at - started_at ≤ 24 小時`**（`MAX_EVENT_DURATION_MS`）。超過即以 `VALIDATION_FAILED` 擋下。
   - 這一條規則同時蘊含「最多只跨一次午夜」，因此切分邏輯可簡化為「午夜前 / 午夜後」兩段。
   - **不要同時寫「最多跨一次午夜」和「最多 2 天」兩套說法**——它們並不等價（跨 2 天可以跨到 2 次午夜），會讓實作與測試各自解讀。以本條為唯一判定依據。
2. **凡是牽涉 duration 的查詢（`duration_sum` 聚合、行事曆頁），查詢下界必須往前推 1 天**，取出候選事件後再做切分，最後只保留落在目標區間內的片段。
   ```sql
   WHERE local_date >= date(:from, '-1 day') AND local_date <= :to
   ```
3. **進行中的事件（`ended_at IS NULL`）不計入任何 duration 統計**。理由：它的時長會隨時間變動，會讓圖表不穩定且無法測試。主頁的計時顯示是 UI 層的即時計算，與統計無關。
4. **所有 `from`/`to` 區間一律為閉區間**（含頭含尾），`local_date` 字串直接比較。
5. 切分函式放在 `packages/shared`，簽章為 `splitByLocalDate(startedAt, endedAt, timezone): { date: string; ms: number }[]`，並依 §11.1 做單元測試（至少涵蓋：不跨日、跨一次午夜、剛好結束於午夜、開始於午夜、剛好 24 小時）。

## 3.5 進行中的事件

睡眠、哺乳等類型的實際使用方式是「按開始 → 過一段時間 → 按結束」，不是事後回填兩個時間。

### 「進行中」的唯一判定是 `active = 1`

`ended_at IS NULL` **有兩種完全不同的意義**，不可混用：

| `active` | `ended_at` | 意義 |
|---|---|---|
| `1` | NULL | **進行中**：計時器正在跑，占用該類型的名額 |
| NULL | NULL | **歷史紀錄待補**：事後補登但還沒填結束時間，不占名額、不顯示計時 |
| NULL | 有值 | 已完成 |

**因此新增事件必須由 client 明確表達意圖**，兩種操作分開：

- **「開始計時」**：request 帶 `intent: "start_timer"`，server 設 `active = 1`、`ended_at = NULL`。僅 `timerEnabled: true` 的類型可用。
- **「補登紀錄」**：request 帶 `intent: "record"`，server 一律 `active = NULL`，`ended_at` 可有可無。

沒有這個欄位的話，兩種情境送出的 payload 完全相同，server 無從判斷該不該設 `active`。

- 每個寶寶每種類型同時只能有一個 `active = 1` 的事件。**這條必須由 DB 約束保證，不可只靠應用層判斷**（兩支手機同時按「開始睡眠」就會產生兩筆），見 4.1 的 partial unique index。
- 已有進行中事件時，快捷 UI 改為顯示結束按鈕。
- 進行中事件**不計入 duration 統計**，見 3.4.1。
- UI 呈現見 7.2。

## 3.6 Metadata

每個類型可有額外欄位，統一序列化為 JSON 存在 `metadata` 欄位。欄位定義寫在該類型的 config 裡，**前端據此產生輸入 UI、後端據此產生 Zod schema 做驗證**——同一份定義驅動兩邊，不可各寫一套。

```ts
type MetadataField =
  | { kind: 'enum'; id: string; label: string; required: boolean;
      options: { value: string; label: string }[] }
  | { kind: 'text'; id: string; label: string; required: boolean;
      maxLength: number }
  | { kind: 'number'; id: string; label: string; required: boolean;
      min: number; max: number; unit?: string };
```

**v1 用到的 metadata 欄位**：

| 欄位 id | kind | 用於 | 定義 |
|---|---|---|---|
| `side` | enum | 哺乳、擠奶 | 左邊 / 右邊 / 兩邊 |
| `diaper_kind` | enum | 尿布 | 尿 / 便 / 兩者 |
| `food_name` | text | 副食品 | maxLength 50 |
| `place` | text | 看醫生 | maxLength 50 |
| `reason` | text | 看醫生 | maxLength 100 |
| `vaccine_name` | text | 注射疫苗 | maxLength 50 |
| `illness_name` | text | 所患疾病 | maxLength 50 |
| `medicine_name` | text | 服用藥物 | maxLength 50 |
| `title` | text | 里程碑、其他 | maxLength 100，required |

以上 enum 的 `required` 一律為 `false`（半夜記錄時不該被必填欄位擋住），`title` 除外。

**驗證規則**：後端必須拒絕 config 未定義的 metadata key，不可原樣存入。

## 3.7 標籤

- 標籤屬於寶寶，不屬於使用者。使用者 A 在寶寶 X 建立的標籤，使用者 B 在寶寶 X 也看得到；在寶寶 Y 則看不到。
- 事件與標籤為多對多。

## 3.8 事件欄位總覽

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | TEXT | **由前端以 `newEventId()` 產生（UUID v4，見 10.1）**，兼作 idempotency key，離線重送不會產生重複資料。後端須驗證格式並拒絕非 UUID |
| `baby_id` | TEXT | |
| `type_id` | TEXT | 對應 config |
| `created_by` | TEXT | 使用者 id |
| `created_at` | INTEGER | UTC epoch ms |
| `updated_at` | INTEGER | UTC epoch ms。**僅供顯示與除錯，不是同步游標**（游標是 `rev`，見 5.4） |
| `started_at` | INTEGER | UTC epoch ms，必填 |
| `ended_at` | INTEGER NULL | 有 range 的類型才有；NULL 代表進行中或尚未填寫 |
| `local_date` | TEXT | `YYYY-MM-DD`，**一律由 server 從 `started_at` + baby.timezone 計算，client 傳來的值一律忽略**（見 5.3） |
| `value` | INTEGER NOT NULL DEFAULT 1 | 儲存整數，見 3.2 |
| `note` | TEXT | 使用者自由填寫的純文字註解 |
| `metadata` | TEXT | JSON，僅允許 config 定義的 key |
| `version` | INTEGER NOT NULL DEFAULT 1 | 樂觀鎖，每次更新 +1 |
| `rev` | INTEGER NOT NULL | **每個寶寶內單調遞增的序號，同步游標專用**。見 5.4 |
| `active` | INTEGER NULL | 進行中標記。見下方 |
| `deleted_at` | INTEGER NULL | soft delete。**刪除時必須同時 bump `updated_at` 與 `rev`**，否則墓碑不會出現在增量同步中，整個機制失效 |

**`active` 欄位（不可用 `ended_at IS NULL` 代替）**：

- 只有 `timerEnabled: true` 的類型、且事件確實進行中時，`active = 1`；其餘一律 `NULL`。
- 結束事件或 soft delete 時必須設回 `NULL`。
- **為什麼需要獨立欄位**：非區間類型（奶瓶、尿布、體重）與整天事件的 `ended_at` 本來就永遠是 NULL。若唯一索引的條件寫成 `WHERE ended_at IS NULL`，就會變成「每個寶寶每種類型只能有一筆未刪除的紀錄」——**第二筆尿布就存不進去**。
- DB 保證的是「同一 `(baby_id, type_id)` 不會有兩筆 `active = 1`」（擋住兩支手機同時按開始的競態）；`active` 只在正確的類型上被設定，則由應用層保證。
- 加上 `CHECK (active IS NULL OR (ended_at IS NULL AND deleted_at IS NULL))` 防止狀態不一致。

## 3.9 整天事件

`allDay: true` 的類型（v1 只有「里程碑」）：

- `started_at` 語意為**該日寶寶時區的 00:00**，`ended_at` 一律為 NULL。
- 新增 UI 只讓使用者選日期，不選時間。
- 在主頁與行事曆的事件列表中**排在最上面**（§7.2）。

---

# 4. DB 設計

原則：盡量少表。

| Table | 內容 |
|---|---|
| `users` | id、username（UNIQUE COLLATE NOCASE）、password_hash、created_at |
| `babies` | id、顯示名稱、性別、`birth_date`、**timezone**、created_at |
| `baby_members` | user_id × baby_id（唯一）、**`role`**、created_at |
| `events` | 核心表，欄位見 3.8 |
| `tags` | id、baby_id、name、created_by、created_at |
| `event_tags` | event_id × tag_id，**PRIMARY KEY (event_id, tag_id)** |
| `invite_codes` | id、baby_id、`code_hash`、expires_at、used_at、used_by、created_by（見 6.5） |
| `sessions` | id、user_id、`token_hash`、expires_at、created_at（見 9.2） |

**`babies.birth_date` 型別為 `TEXT 'YYYY-MM-DD'`**，是寶寶時區的日曆日，**不是時間戳**。存成 epoch ms 會讓「幾個月又幾天」的計算跟時區糾纏不清。

**`baby_members.role`**：`'owner' | 'member'`
- 建立寶寶者自動寫入 `owner`。
- 只有 `owner` 可以產生邀請碼、移除成員、編輯寶寶基本資料。
- `owner` 與 `member` 對**事件**的權限相同（新增、編輯、刪除彼此的事件）。
- **禁止移除最後一個 owner。** 成員可自行退出，但最後一個 owner 不行。
- `babies` 表不需要 `created_by` 欄位，建立者身分由 `role = 'owner'` 表達。

**沒有 `login_attempts` 表**——原因見 9.4。

## 4.1 必要索引

每個索引都對應規格中一條實際查詢。**新增索引時必須在註解寫明它服務哪一支端點**，否則無法判斷日後能不能刪。

```sql
-- events ─────────────────────────────────────────────────────────
-- §5.4 增量同步：WHERE baby_id=? AND rev>? ORDER BY rev
-- UNIQUE 不只是索引，也是防呆：擋住批次更新共用同一個 rev 的錯誤寫法（§5.4）
CREATE UNIQUE INDEX idx_events_baby_rev ON events(baby_id, rev);

-- §7.2/7.5/7.6 主頁與行事曆：依日期區間取出並按時間排序
-- 第三欄 started_at 讓排序也走索引，避免每次查詢都額外 sort
-- 不可設為 partial index：§5.7 的每日上限 COUNT 需要含已刪除的列
CREATE INDEX idx_events_baby_date ON events(baby_id, local_date, started_at);

-- §5.6 統計：WHERE baby_id=? AND type_id=? AND local_date BETWEEN ?
-- 這是最吃效能、也最接近 10ms CPU 上限的查詢，必須有專屬索引
CREATE INDEX idx_events_stats     ON events(baby_id, type_id, local_date);

-- §5.5 /events/summary：各類型最後一次發生
CREATE INDEX idx_events_baby_type ON events(baby_id, type_id, started_at DESC);

-- §3.5 保證「每個寶寶每種類型同時只有一個進行中事件」
-- 必須由 DB 保證：兩支手機同時按「開始睡眠」時，應用層判斷擋不住
CREATE UNIQUE INDEX idx_events_active ON events(baby_id, type_id) WHERE active = 1;

-- 標籤 ───────────────────────────────────────────────────────────
-- §7.9 由標籤找事件
CREATE INDEX idx_event_tags_tag ON event_tags(tag_id);
-- §4.2 由事件找標籤（JOIN 方向）；PK 的前導欄即提供此索引
--   event_tags PRIMARY KEY (event_id, tag_id)
-- §7.9 列出寶寶的標籤 + 同一寶寶內不重名
CREATE UNIQUE INDEX idx_tags_baby_name ON tags(baby_id, name);

-- 權限與 auth ────────────────────────────────────────────────────
-- §6.4 requireBabyAccess：WHERE user_id=? AND baby_id=?
-- 同時作為約束：同一使用者對同一寶寶不得有重複的成員列
CREATE UNIQUE INDEX idx_members_user_baby ON baby_members(user_id, baby_id);
-- §5.1 GET /api/babies/:id/members：由寶寶列出成員
CREATE INDEX idx_members_baby ON baby_members(baby_id);

-- §9.2 每次請求以 token hash 查 session
CREATE UNIQUE INDEX idx_sessions_hash ON sessions(token_hash);
-- §9.2 登入時清理過期 session、§9.1 script 撤銷某使用者全部 session
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- §6.5 以邀請碼查詢（原子 UPDATE 的 WHERE 條件）
CREATE UNIQUE INDEX idx_invites_hash ON invite_codes(code_hash);
```

**`users.username` 必須是唯一索引，且明確指定 `COLLATE NOCASE`**。SQLite 預設區分大小寫，不指定的話「登入時帳號要不要分大小寫」會變成看實作者心情的行為。

### 索引的寫入成本

D1 的計費規則是：**寫入含索引欄位時，每個相關索引會多算一列**（一列寫表、一列寫索引）。`events` 上有 5 個索引，因此新增一筆事件約產生 6 列寫入。

以每天 40 筆事件估算約 240 列/日，對照免費方案的 **100,000 列/日**（§2.5）完全不成問題。**但這也表示索引不是免費的——不要為了保險而濫加。** 上面每一條都對應一支實際端點，新增索引前請先確認是哪一條查詢需要它。

## 4.2 查詢規範：禁止 N+1

D1 免費方案**每次 Worker 呼叫最多 50 次查詢**。這是硬限制，超過就整個請求失敗。

- 列出事件並附帶標籤時，**必須用 JOIN 或子查詢一次撈完**，不可每筆事件各查一次標籤——否則單日超過 50 筆事件就會直接壞掉，而且是在使用量變大之後才爆，很難除錯。
- **不可用 `IN (:id1, :id2, …)` 把事件 id 逐一綁成參數**：D1 的**每次查詢最多 100 個 bound parameters**，而同步一次最多回 1000 筆，必然超限。正確作法是讓 `event_tags` 直接 JOIN 回 `events` 並套用同一組條件：
  ```sql
  SELECT et.* FROM event_tags et
    JOIN events e ON e.id = et.event_id
   WHERE e.baby_id = ? AND e.rev > ?;
  ```
  這樣參數數量固定，與筆數無關。若真的需要用 id 清單，必須依 100 個參數的預算分批。
- 同理適用於 `/events/summary`：**查詢數必須有界**，不可每個類型各查一次。但不強制用單一 `GROUP BY`——正確性優先，允許 CTE、window function 或固定次數的多次查詢，理由見 §5.5。
- Drizzle 的 relational query 要留意產生的 SQL 筆數，必要時手寫 SQL。

## 4.3 交易邊界：多步驟寫入必須全有或全無

以下情境目前都可能「只完成一半」，而且失敗後的狀態很難收拾：

| 情境 | 只做一半的後果 |
|---|---|
| 事件寫入成功、標籤關聯失敗 | 重送時 idempotency 回報成功，標籤永久遺失 |
| `PATCH` 的 version 不符，但標籤關聯已改 | 使用者看到「衝突、未儲存」，實際已被改掉 |
| 邀請碼已消耗、加入成員失敗 | 碼失效且沒加進去，使用者被鎖在外面 |
| 先刪 `event_tags`、才要據此找出要 bump `rev` 的事件 | 找不到受影響事件，其他裝置永遠同步不到 |

**規則**：

1. **事件本體、標籤關聯、`version`、`rev` 必須在同一個原子操作中完成。** 邀請碼的消耗與成員寫入同理。
2. 用 **D1 的 `batch()`** 取得交易性，所有語句一次送出。
3. **⚠️ 版本檢查必須是交易內每一條寫入的條件，不可在 batch 回傳後才檢查。**

   `D1` 的 `batch()` 只在 **SQL 語句失敗**時回滾。**條件式 UPDATE 影響零列並不是失敗**——不會拋錯，batch 中後續的語句照常執行並提交。等 `batch()` 回傳時才檢查 `meta.changes`，標籤早就被改掉了，這時回 409 只是改變 HTTP 回應，**資料已經回不去**。結果就是最糟的組合：告訴使用者「儲存失敗」，但資料其實被改了。

   **正確作法**——讓版本不符時每一條寫入都自然地打不中任何列：

   ```sql
   -- 1) 所有從屬寫入都掛上同一個 version 守衛
   DELETE FROM event_tags
    WHERE event_id = :id
      AND EXISTS (SELECT 1 FROM events WHERE id = :id AND version = :expected);

   INSERT INTO event_tags (event_id, tag_id)
   SELECT :id, :tag FROM (SELECT 1)
    WHERE EXISTS (SELECT 1 FROM events WHERE id = :id AND version = :expected);

   -- 2) 事件本體與 version/rev 的更新放在最後一條
   UPDATE events
      SET ..., version = version + 1, rev = <配號>, updated_at = :now
    WHERE id = :id AND version = :expected;
   ```

   **version 的遞增必須放在最後一條**，否則前面的守衛會比對到已被改掉的版本。

   交易結束後的 `meta.changes`（取最後一條）**只用來決定回應**：為 0 就回 409，此時資料本來就完全沒動。

4. **邀請碼同理，但守衛必須掛在「寫入前的條件」，不是寫入後的狀態。**

   下面這個寫法**會讓邀請碼可以重複使用**：

   ```sql
   -- 錯誤示範
   UPDATE invite_codes SET used_at = :now, used_by = :uid
    WHERE id = :cid AND used_at IS NULL AND expires_at > :now;
   INSERT INTO baby_members (baby_id, user_id, role)
   SELECT :bid, :uid, 'member' FROM (SELECT 1)
    WHERE (SELECT used_by FROM invite_codes WHERE id = :cid) = :uid;
   ```

   `used_by = :uid` 只證明「這個人曾經用過這組碼」，**不證明「本次請求成功消耗了它」**。於是：使用者用碼加入 → 之後被移除 → 再送一次同一組舊碼 → UPDATE 命中零列（已使用），但 `used_by` 仍是他，INSERT 照樣成功，**連過期都擋不住**。

   **正確作法**——兩條語句掛同一個「尚未使用且未過期」的前置條件，並**先寫成員、後消耗碼**：

   ```sql
   INSERT INTO baby_members (baby_id, user_id, role)
   SELECT ic.baby_id, :uid, 'member'
     FROM invite_codes ic
    WHERE ic.id = :cid AND ic.used_at IS NULL AND ic.expires_at > :now
   ON CONFLICT (user_id, baby_id) DO NOTHING;

   UPDATE invite_codes SET used_at = :now, used_by = :uid
    WHERE id = :cid AND used_at IS NULL AND expires_at > :now;
   ```

   - 順序不可顛倒：UPDATE 先跑的話會把 `used_at` 設掉，INSERT 的條件就不成立了。
   - **`baby_id` 取自邀請碼本身（`ic.baby_id`），不可取自 request**，否則可以拿寶寶 X 的有效邀請碼加入寶寶 Y。
   - `ON CONFLICT DO NOTHING` 處理「已經是成員又輸入一次碼」的情況，避免唯一索引拋錯導致整批回滾。
5. **需要先讀後寫的流程（如刪標籤前要先找出受影響事件）必須先查後寫再刪**，順序顛倒就拿不到資料了。詳見 §7.9。
6. **標籤 id 必須屬於同一個寶寶。** 寫入 `event_tags` 前必須驗證，否則可以把別的寶寶的標籤掛到自己的事件上——這是與 §5.8 同類型的權限漏洞。

## 4.4 Migration

- 一律用 drizzle-kit 產生 SQL migration 檔，納入版控。
- 禁止手動改線上 schema。

---

# 5. API 設計

所有路徑前綴 `/api`。除登入外全部需要 auth。回應一律 JSON。

## 5.1 端點

```
POST   /api/auth/login              # username + password → session token
POST   /api/auth/logout             # 撤銷目前 session token

GET    /api/me                      # 目前使用者 + 可存取的寶寶列表

POST   /api/babies                  # 建立寶寶（建立者為 owner）
GET    /api/babies/:id
PATCH  /api/babies/:id              # 暱稱、性別、出生年月日（owner only）
POST   /api/babies/:id/invite       # 產生一次性邀請碼（owner only）
POST   /api/babies/join             # 以邀請碼加入寶寶
GET    /api/babies/:id/members
DELETE /api/babies/:id/members/:uid # 移除家人（owner only，或自行退出）

GET    /api/babies/:id/events?since=<rev>&limit=      # 增量同步，含墓碑
GET    /api/babies/:id/events?from=&to=              # 區間（閉區間，含 date 單日）
GET    /api/babies/:id/events/summary                # 快捷區 + 主頁摘要（見 5.5）
POST   /api/babies/:id/events                        # 新增（id 與 intent 由 client 帶入，見 3.5）
PATCH  /api/events/:id                               # 更新，需帶 version
DELETE /api/events/:id                               # soft delete，需帶 version

GET    /api/babies/:id/stats?types=&from=&to=        # 統計聚合（見 5.6）
GET    /api/babies/:id/tags
POST   /api/babies/:id/tags
GET    /api/babies/:id/events?tags=a,b&from=&to=&sort=&limit=&offset=
                                                     # §7.9 標籤篩選（OR 邏輯）
PATCH  /api/tags/:id
DELETE /api/tags/:id
GET    /api/babies/:id/export                        # 匯出 JSON / CSV
GET    /api/version                                  # 前端版本比對（見 2.1）
```

## 5.2 錯誤契約

```json
{ "error": { "code": "VERSION_CONFLICT", "message": "這筆資料已被其他人修改",
             "details": null } }
```

| code | HTTP | 前端行為 |
|---|---|---|
| `UNAUTHENTICATED` | 401 | 清除本地 token，導向登入頁。**不彈窗** |
| `FORBIDDEN` | 403 | 彈窗 |
| `NOT_FOUND` | 404 | 彈窗 |
| `VERSION_CONFLICT` | 409 | 專用對話框「已被其他人修改，重新載入？」（見 6.3） |
| `VALIDATION_FAILED` | 422 | **不彈窗**，`details` 為 `{ field: message }`，顯示在對應表單欄位旁 |
| `RATE_LIMITED` | 429 | 彈窗並提示稍後再試 |
| `DAILY_LIMIT_EXCEEDED` | 429 | 彈窗。**離線佇列收到此碼必須永久放棄該筆，不可重試**（見 5.7） |
| `ACTIVE_TIMER_EXISTS` | 409 | 專用對話框「對方已經開始記錄睡眠」。`details` 帶既有事件的 `{ id, started_at, created_by }`。**佇列處置**：永久停止重試該筆，標記 `failed` 並保留內容，讓使用者選擇改成補登紀錄或放棄 |
| `INTERNAL` | 500 | 彈窗並提供重試 |

**只有標示「彈窗」的才走 §7.11 的全域錯誤彈窗。** `UNAUTHENTICATED` 與 `VALIDATION_FAILED` 若也彈窗，使用體驗會很糟。

## 5.3 數值與日期的契約（不照做會產生髒資料）

1. **`value` 在 API 的 request 與 response 中一律是「儲存整數」**，不是顯示值。體溫送 `365`，不是 `36.5`。`scale` 換算只發生在前端的 UI 輸入／顯示層，API client 層以下不得出現顯示值。
2. **`local_date` 一律由 server 從 `started_at` + `baby.timezone` 計算。** client 送來的 `local_date` 一律忽略，回應中一律包含 server 算出的值。理由：事件 id 由 client 產生，容易讓人順手把 local_date 也交給 client 算，結果離線重送時用到過期或錯誤的時區。
3. **時區換算一律使用 `Intl.DateTimeFormat('en-CA', { timeZone })` 取得 `YYYY-MM-DD`**（`en-CA` 的預設格式就是 ISO 日期）。Workers 內建完整 ICU。**禁止手算 UTC offset，禁止引入 moment-timezone 等大型套件。**

### 三種換算都要，不是只有一種

`Intl.DateTimeFormat` 只解決「時間戳 → 當地日期」。另外兩個方向沒定義的話，實作者會偷偷用裝置時區補上：

| 方向 | 用在哪 |
|---|---|
| 時間戳 → 當地 `YYYY-MM-DD` | 寫入時計算 `local_date` |
| **當地日期時間 → UTC 時間戳** | 表單送出、補登昨天的紀錄 |
| **當地午夜 → UTC 邊界** | 區間查詢的上下界 |

三者一律收斂到 `packages/shared` 的日期工具，**任何其他檔案都不得自行做時區換算**。

### v1 只支援 `Asia/Taipei`

- 日期工具可接受 `timezone` 參數，但 **v1 只保證 `Asia/Taipei` 正確**，並在載入時 assert。
- 理由：台北沒有日光節約時間，因此「24 小時內最多跨一次午夜」（§3.4.1）成立。**在有 DST 的時區這個前提不保證**，切分邏輯與查詢下界都要重寫。
- 另外 SQLite 的日期函式只認得 `localtime`/`utc` 修飾詞，**無法接受任意 IANA 時區名稱**。本規格之所以在寫入時就算好 `local_date`（§3.4），正是為了繞開這個限制——SQL 只做字串比較，不做時區運算。

### 其他時間驗證

- **`ended_at >= started_at`**，違反即 `VALIDATION_FAILED`。
- `started_at` 與 `ended_at` 皆不得晚於現在 +1 天（§5.7）。
- **時長一律先以毫秒加總，最後才換算並取整為分鐘。** 每筆先取整再相加會累積誤差——20 筆各差半分鐘就是 10 分鐘。
- **已完成的睡眠若與既有紀錄重疊**，儲存時提示使用者確認即可，**不自動合併也不擋下**。自用 app 做到提醒就夠了。

## 5.4 增量同步協定

**游標是 `rev`，不是時間戳。**

`rev` 是**每個寶寶內單調遞增的整數序號，在寫入時由 DB 原子配發**。

**單筆寫入**：

```sql
INSERT INTO events (..., rev)
VALUES (..., (SELECT COALESCE(MAX(rev), 0) + 1 FROM events WHERE baby_id = ?));
```

### ⚠️ 批次更新必須逐筆配號，不可共用一個 MAX(rev)+1

刪除或改名標籤會一次更新很多事件（§7.9）。**下面這個寫法會造成資料永久遺失**：

```sql
-- 錯誤示範，絕對不可使用
UPDATE events SET rev = (SELECT MAX(rev) + 1 FROM events WHERE baby_id = ?) WHERE ...;
```

子查詢不具相關性，SQLite 只會求值一次，**所有被更新的列會拿到同一個 rev**。接著分頁就會漏資料：若三筆同為 `rev = 4`，client 取回前兩筆、記下 `next_rev = 4`，下次查 `rev > 4` 時第三筆就永遠不會再出現。

**規則**：

1. **`UNIQUE(baby_id, rev)` 作為防呆約束**，讓任何共用 rev 的寫法直接寫入失敗，而不是靜默漏資料。
2. 批次更新必須逐筆配號。單一語句的作法是用 window function 產生偏移量：
   ```sql
   WITH base AS (SELECT COALESCE(MAX(rev), 0) AS m FROM events WHERE baby_id = :b),
        tgt  AS (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n
                   FROM events WHERE id IN (SELECT event_id FROM event_tags WHERE tag_id = :t))
   UPDATE events
      SET rev = (SELECT m FROM base) + (SELECT n FROM tgt WHERE tgt.id = events.id),
          updated_at = :now
    WHERE id IN (SELECT id FROM tgt);
   ```
   **不可改用「每筆事件一條 UPDATE」**——受影響事件可能超過 50 筆，會撞上 §4.2 的查詢數上限。
3. **INSERT、UPDATE、DELETE（soft delete）、批次標籤更新，全部共用同一套配號方式**，寫成 `packages/api` 的單一 helper，禁止各處自行拼 SQL。

**為什麼時間戳不能當游標**（即使加上 id 組成複合鍵）：

- client 已同步到 `(T, B)`，此時另一筆 id 較小的 A 被更新、時間戳同樣是 T。`(T, A) > (T, B)` 永遠不成立，**這筆更新就永久消失了**。
- 請求「先取得時間、較晚才提交」也會製造同樣的窗口。
- 根本原因：時間戳反映「事件發生的時刻」，但同步游標需要的是「**寫入的順序**」。`rev` 在寫入時配發，順序保證正確。
- 附帶好處：游標變成單一整數，協定簡單得多。

**請求**：`GET /api/babies/:id/events?since=<rev>&limit=<n>`

**回應**：
```json
{ "events": [...], "next_rev": 4812, "has_more": false }
```

規則：
- 查詢條件為 `WHERE baby_id = ? AND rev > :since ORDER BY rev ASC LIMIT :limit`。
- 首次同步帶 `since=0`。
- **`next_rev` 一律由 server 產生**，client 原樣存下次帶回。**絕對不可使用裝置時鐘**。
- **非空頁的 `next_rev` 必須是「本頁最後一筆的 `rev`」**，不可另外查 `MAX(rev)`。另查的話，會跳過本次查詢與該查詢之間寫入的資料。
- **空結果時 `next_rev` 回傳 client 傳來的 `since` 原值**（不是 0、不是 null），client 據此保持游標不變。
- `limit` 預設 200，上限 1000。
- 回應**包含 soft delete 的墓碑**（`deleted_at` 非 null）。client 據此**將該筆從畫面排除，但保留墓碑與其 `rev`**，不可整筆刪掉（理由見 §6.2）。
- `has_more` 為 true 時 client 必須繼續拉，直到 false 才更新已同步游標。
- **任何會影響同步結果的變更都必須 bump `rev`**，包含 soft delete 與標籤關聯變動（見 7.9）。

## 5.5 `GET /events/summary`

主頁需要的資料一次給完，避免 N+1（§4.2）：

```json
{ "types": [
    { "type_id": "sleep", "last_started_at": 1758…, "last_value": 1,
      "active_event_id": "uuid…", "active_started_at": 1758…,
      "active_version": 3 },
    { "type_id": "weight", "last_started_at": 1758…, "last_value": 4200,
      "active_event_id": null, "active_started_at": null,
      "active_version": null }
  ] }
```

這一支同時餵飽三個地方：快捷區的「上次發生時間」、主頁的身高體重（取 `last_value`）、以及進行中事件的計時顯示。

**要求是「結果正確 + 查詢數有界（≤ 3 次）」，不強制用單一 `GROUP BY`。** 允許 CTE、window function 或固定次數的多次查詢。

理由：**「最新一筆的 value」與「目前進行中的事件」不保證來自同一列**——例如補登一筆較晚的已完成睡眠時，舊的進行中紀錄仍然存在。單純 `GROUP BY type_id` 搭配裸欄位，SQLite 只在 `MIN`/`MAX` 的情況下保證取到相配的列，其他組合的取值是不確定的，會拿到錯配的 id、時間與 value。

**必須定義穩定排序**：`ORDER BY started_at DESC, id DESC`。只用 `started_at` 的話，同一時間的兩筆事件誰算「最新」會不確定，導致主頁顯示的體重與統計頁的 `last` 對不起來。

**`active_version` 是必要欄位**：結束計時要打 `PATCH`，而 `PATCH` 強制帶 `version`（§6.3）。沒有它的話，前端必須先多打一支 API 取得完整事件才能結束計時——而跨午夜時該事件根本不在今日列表裡，前端會取不到。

### 今日照顧摘要的欄位

§7.2 的摘要列所需資料**必須由這支 API 提供**，不可由前端從本地事件推導（§6.2 規定 summary 是衍生資料）：

```json
{ "types": [...],
  "today": {
    "total_bottle_ml": 420,
    "diaper": { "pee": 3, "poo": 1, "both": 1, "unknown": 2, "total": 5 }
  },
  "last_feed_at": 1758…  ← 注意：不受「今日」範圍限制 }
```

定義（這些若不寫明，兩個實作者會算出不同數字）：

- **`total_bottle_ml` 只加總 `bottle`**。`pumping`（擠奶）是擠出的量，不是寶寶喝下的量，**絕對不可計入**。
- **`last_feed_at` 合併 `nursing` 與 `bottle`** 取較晚者——使用者問的是「上次餵奶多久了」，不分餵法。
- **`last_feed_at` 不在 `today` 範圍內，必須跨日期取最近一次。** 若限制在今日，凌晨 00:30 打開 app 會顯示「沒有餵奶紀錄」，但其實 23:50 才剛餵過——而半夜正是最需要這個資訊的時候。
- **尿布分別計數**：`diaper_kind` 為「兩者」時，**同時計入 `pee` 與 `poo`**，並在 `both` 單獨列出。**未填類型的計入 `unknown`，不可併入 `pee` 或 `poo`**，否則統計會失真（§7.3）。
- **`total` 是事件筆數，不是各欄位相加**：`total = pee + poo - both + unknown`（因為 `both` 在 `pee` 和 `poo` 各算了一次）。上面範例即 `3 + 1 - 1 + 2 = 5` 筆。
- **範圍為寶寶時區的今日**（依 `local_date`）。

**離線時**顯示最後一次取得的 server 摘要並標示「未同步」；但**本機的計時草稿（§7.2）仍須覆蓋計時 UI 的顯示**，否則使用者會看到自己剛按下的結束沒有反應。

## 5.6 `GET /stats` —— 聚合在 SQL 做，不在 JS 做

**這是架構決定，不是最佳化建議。** 統計頁允許「年」區間，一年約 7,300 筆事件。若把 raw rows 撈進 Worker 用 JS 聚合再 `JSON.stringify`，**在 10 ms CPU 預算下很可能直接撞牆**，而且會等到 M4 完成才發現。

- **`GROUP BY local_date` 在 SQL 裡完成，回應最多 366 筆。**
- `duration_sum` 的跨午夜切分用 SQL 的 `UNION ALL` 拆成「午夜前 / 午夜後」兩列處理（3.4.1 已保證最多跨一次午夜）。
- 回應格式：`{ type_id, unit, aggregation, points: [{ date, value }] }`
- **`value` 一律為整數**，與 §5.3 的契約一致：
  - `duration_sum` 的單位是**分鐘**（不是毫秒，也不是秒）。`unit` 欄位回傳 `"min"`。
  - `avg` 四捨五入為該類型儲存單位的整數（例如體溫回 365 代表 36.5°C）。
  - 其餘聚合維持該類型的儲存單位。
- **M4 的驗收條件必須包含：以一年份的 seed 資料實測此端點的 CPU 用量。**

`packages/shared` 裡做單元測試的對象是**切分函式與單位換算**這類小函式（§11.1），不是整段聚合。

## 5.7 寫入防護（斷路器）

**定位要講清楚：這些是防止「失控迴圈」的斷路器，主要防的是自己的 bug，不是防攻擊者。**

自然成長不是問題（§2.5 已估算：五年約 11 MB，上限 500 MB）。真正的風險是某段程式碼在狂寫，而最可能的來源是**離線重送佇列**——重試邏輯寫錯就會自己跑起來。之所以嚴重，是因為 **D1 免費方案每日 100,000 筆寫入一旦破掉，當天所有 D1 查詢都會失敗直到 UTC 00:00**（§2.5），後果是整個 app 死掉半天。

斷路器把「app 全掛到 UTC 午夜」降級成「這隻寶寶今天的寫入被擋下」。

| 防線 | 規則 | 擋住什麼 |
|---|---|---|
| **每日事件上限** | 每個寶寶每 `local_date` 最多 **500 筆**，超過回 `DAILY_LIMIT_EXCEEDED` (429) | 失控的新增迴圈 |
| **欄位長度上限** | `note` ≤ 1000 字元；metadata 各欄位依 §3.6 的 `maxLength` | 單列膨脹（D1 單列上限 2 MB） |
| **時間合理性** | `started_at` 不得晚於現在 +1 天，不得早於 `baby.birth_date` -1 天 | 時區換算 bug、垃圾資料 |
| **重送次數上限** | 見 §6.1 | 佇列無限重試 |

**500 筆的選定理由**：正常使用一天 20–40 筆，雙胞胎加上極詳細記錄約 100 筆。500 是實際峰值的十倍以上，**正常使用永遠不會碰到**；真的碰到就代表有東西壞了，這個錯誤本身就是有用的訊號。

**計數時包含 soft delete 的列**，否則「新增→刪除→新增」的迴圈可以繞過上限。這條的代價是每次新增多一次 `COUNT` 查詢（§4.2 的 50 次預算內，可接受）。

**這個上限不需要原子性**——兩支手機同時新增而讓當日筆數變成 501 完全無所謂。它是斷路器，不是額度計費，差幾筆沒有意義。**邀請碼的一次性則必須原子**（§6.5），因為那是安全性質的約束。

## 5.8 POST 的 idempotency

`POST /api/babies/:id/events` 收到**已存在的 `id`** 時：

- 回 **200**，並回傳 DB 中既有的那一筆（不是 201，也不是 409）。
- 實作為 `INSERT ... ON CONFLICT(id) DO NOTHING` 後回讀。
- **理由**：離線佇列重送時若拿到 UNIQUE constraint 錯誤，佇列會永遠卡在重試迴圈。

**⚠️ 回讀必須同時比對 `baby_id`：**

```sql
SELECT * FROM events WHERE id = :id AND baby_id = :baby_id;
```

只依 `id` 回讀會**繞過路徑上的寶寶權限檢查**——該 id 可能屬於另一個寶寶，於是攻擊者能用 POST 讀出不屬於自己的事件。若既有紀錄的 `baby_id` 與請求不符，一律回 **409**，不可回傳該筆內容。

**檢查順序（重要）**：

1. 先做 idempotency 回讀。
2. 確認是新紀錄後，才檢查每日上限（§5.7）。

順序反過來的話，第 500 筆成功但回應在網路上遺失時，重送會撞到每日上限而被判為失敗——明明那筆已經存進去了。

---

# 6. 同步、衝突與權限

## 6.1 同步機制

- **進入頁面時自動拉取**（TanStack Query 的 refetch on focus）。
- **下拉可手動同步**（主頁、行事曆頁皆支援）。
- **增量同步**：以 **`rev`** 為游標（見 5.4），`GET /events?since=<rev>`，回傳該序號之後變更的事件，**包含 soft delete 的墓碑**。
- 兩人使用不需要 WebSocket 或即時推播。

### 離線處理：佇列只排 POST

前端以 IndexedDB 快取事件資料。半夜在房間收訊不佳是常見情境，所以離線寫入不是可有可無的功能。但**離線佇列只接受新增（POST），不接受 PATCH 與 DELETE**：

- **離線時的編輯與刪除直接擋下**，提示「需要連線才能編輯」。
- **理由**：離線做的 PATCH 帶的是離線當下的 `version`，上線後幾乎必然 409，而 409 的處理方式是跳對話框問使用者——這時使用者可能在睡覺，而佇列裡積了五筆。這條規則保留了 90% 的實際價值（半夜記一筆），砍掉 90% 的複雜度。
- POST 重送安全，因為事件 `id` 由前端產生且後端做 idempotency（§5.8）。
- **UI 必須顯示「尚有 N 筆未同步」**，離線佇列不可視為可靠儲存（見 9.6 的 iOS 限制）。

**重送規則（防止佇列變成失控迴圈，配合 §5.7）**：

- **重試時絕對不可重新產生 `id`。** `id` 在事件建立當下產生一次，之後永不改變——這是整個 idempotency 機制的前提，也是最容易寫錯的一行。
- **指數退避**，最短間隔 5 秒，最長 5 分鐘。
- **最多重試 10 次**，之後把該筆標記為 `failed` 並停止，由 UI 顯示讓使用者手動處理。**不可無限重試。**
**不同錯誤要有不同處置，不可一律「4xx 就放棄」**：

| 回應 | 處置 |
|---|---|
| 網路錯誤、5xx | 依退避重試，上限 10 次 |
| `UNAUTHENTICATED` (401) | **暫停整個佇列**，等**同一位使用者**重新登入後繼續。不可放棄——session 過期跟資料有問題是兩回事 |
| `RATE_LIMITED` (429) | 延後重試，不計入 10 次上限 |
| `VALIDATION_FAILED` (422)、`FORBIDDEN` (403)、`DAILY_LIMIT_EXCEEDED` | 永久放棄重試，**但保留資料**並標記 `failed`，由 UI 顯示讓使用者處理。不可靜默丟掉——那是使用者半夜親手記的紀錄 |

**「讓使用者處理」必須具體做出來**，否則等於沒做。未同步與失敗的紀錄需要一個檢視清單，每筆至少能：**看內容、修正後重試、手動重試、放棄**。

### ⚠️ 「修正後重試」不可沿用原 id 直接重送

idempotency（§5.8）規定「id 已存在就回傳既有紀錄」，這跟「修正後重試」會直接衝突：奶量 80 ml 其實已經存進 server、只是回應在網路上遺失，前端標記 failed；使用者改成 100 ml 後以原 id 重送，server 回傳既有的 80 ml。若前端把它當成功，**使用者的修正就靜默消失了**。

因此必須區分兩種失敗：

佇列中的每一筆必須帶一個**黏性的 `outcome_unknown` 旗標**：

- 任何一次嘗試以**網路錯誤、逾時或 5xx** 結束時，設為 true。
- **只有「以原始內容 + 原 id 重送並取得明確結果」才能清除它。**

| 狀態 | 意義 | 處置 |
|---|---|---|
| `outcome_unknown = false` 且收到 4xx | server 確定沒有這筆 | 可修正內容後以原 id 重送 |
| `outcome_unknown = true` | **不知道 server 上有沒有** | **先以「原始內容 + 原 id」重送探明結果**。若 server 已有該筆，修正必須改走帶 `version` 的 `PATCH`，不可用 POST 覆蓋 |

**⚠️ 後來收到的 4xx 不會消除既有的不確定性。** 例如：第一次 POST 其實成功但回應遺失（旗標設為 true），重試時 session 過期收到 401——server 明明已有那筆紀錄，此時**不可因為「最後收到的是 4xx」就允許改 payload 直接重送**。401 / 429 仍各自遵循暫停與退避規則（見上表），不影響旗標。

**「放棄」只代表停止本機重試，不保證 server 上沒有這筆。** UI 文案必須據實說明，不可寫成「已刪除」。

**背景重試失敗不可反覆跳全域錯誤彈窗**（§7.11）——那會在使用者根本沒在操作時不斷打斷他。背景失敗只更新「尚有 N 筆未同步」的狀態指示，只有使用者主動觸發的操作才彈窗。

**佇列必須以 `user_id` + `baby_id` 隔離**。否則換帳號後，會用新帳號把前一個帳號待同步的事件送出去。登出時不清除佇列（資料要留著），但切換使用者後只處理屬於當前使用者的項目。

## 6.2 前端的資料一致性規則

前端同時存在三種資料來源，**必須明訂誰是真相來源**，否則會出現「列表顯示睡眠已結束、快捷區還在計時」或舊請求覆蓋新資料：

| 層 | 角色 |
|---|---|
| **IndexedDB** | **唯一的持久化真相來源**。事件資料、同步游標、待送佇列都在這裡 |
| TanStack Query cache | **純畫面快取**，可隨時丟棄，不得作為唯一來源 |
| summary / stats API | **衍生資料**，一律由 server 計算，不在前端從本地事件推導 |

規則：

1. **只接受較新的 `rev`。** 套用 server 回來的事件時，若本地該筆的 `rev` 較大或相等，忽略之。這擋掉舊請求覆蓋新資料。
2. **收到刪除墓碑時保留該筆與它的 `rev`，只從畫面排除，不可整筆刪掉。**
   刪掉本地那一列等於連 `rev` 一起丟了，於是規則 1 失效——較晚抵達的舊回應（例如 `rev = 19` 的列表結果）會把已刪除的事件**重新插回來復活**。以本專案的資料量，墓碑永久保留即可，不需要清理機制。
2. **本地事件與同步游標必須一起提交**（同一個 IndexedDB transaction）。否則可能游標前進了、資料沒寫進去，那段資料就永遠不會再拉。
3. **寫入後的失效範圍**：
   - **`summary` 與 `stats` 一律失效該寶寶的全部查詢**，不要精算最小範圍。原因是最小範圍算不準：昨晚 23:00 到今早 07:00 的睡眠 `local_date` 是昨天，但結束或刪除它時**今天的統計也會變**（§3.4.1 的跨日切分）；把事件從昨天改到前天，則新舊兩天都要更新。以本專案的資料量，全部失效的成本遠低於算錯的代價。
   - **行事曆**需失效「修改前」與「修改後」涉及的日期，兩者都要。
   - **同步收到另一人的變更時，套用同一套失效規則**，不是只有自己寫入時才做。
4. **pending / failed 的紀錄要疊加顯示但視覺上可區分**，不得冒充已同步紀錄。使用者要能一眼看出哪幾筆還沒進 server。
5. **讀取快取也要依 `user_id` + `baby_id` 隔離**，不只是待送佇列。切換寶寶或帳號時不可看到前一個的殘留資料。

不需要額外引入狀態管理套件，重點是**不要讓各頁面各自維護一份事件真相**。

## 6.3 衝突處理：樂觀鎖

- `events` 表有 `version` 欄位，每次更新 +1。
- **`PATCH` 與 `DELETE` 都必須帶上讀取時拿到的 `version`**；不符則回 **409 VERSION_CONFLICT**。
- 前端收到 409 時顯示「這筆資料已被其他人修改，是否重新載入？」對話框，重新拉取後讓使用者重做。
- **不做合併介面**，兩人使用的情境不值得這個複雜度。

**樂觀鎖與 soft delete 是正交的兩件事，兩個都要**：
- 樂觀鎖防的是「覆蓋掉別人的修改」。
- soft delete 解決的是「另一支手機怎麼知道這筆被刪了」——硬刪除的那一列會直接從表裡消失，`since` 查詢不可能回傳一個不存在的東西，於是另一支手機永遠不知道該移除它。只要做增量同步就必須有墓碑。
- **soft delete 必須同時更新 `deleted_at`、`rev`、`version`、`updated_at` 四個欄位**，缺一不可：
  - **`rev`** —— 墓碑要能進入 `since > rev` 的增量同步查詢（§5.4）。漏掉這個，整個刪除同步機制就失效，這是最容易漏的一行。
  - **`version`** —— `DELETE` 本身也要帶 `version` 做樂觀鎖檢查，刪除後必須遞增，否則後續對同一筆的操作會用到過期版本。
  - `updated_at` —— 供顯示與除錯。
  - 四者必須在同一交易內完成（§4.3）。

**注意**：樂觀鎖擋不住「兩人各自記錄同一次餵奶」造成的重複事件。這個只能靠 UI 緩解——主頁快捷區必須顯示「上次餵奶：12 分鐘前」，讓人在新增前就看到。

## 6.4 權限

- 使用者只能存取有 `baby_members` 關聯的寶寶。角色定義見第 4 章。
- **成員之間對事件的權限相同**：可以編輯、刪除彼此建立的事件。`created_by` 僅供顯示。
- `owner` 專屬：產生邀請碼、移除成員、編輯寶寶基本資料。

### 權限 middleware（兩種，不可在 handler 內重複實作）

路徑裡**有** baby id 與**沒有** baby id 的端點需要不同形狀的 middleware：

| middleware | 用於 | 作法 |
|---|---|---|
| `requireBabyAccess(param)` | `/api/babies/:id/*` | 直接查 `baby_members` |
| `requireEventAccess` | `PATCH/DELETE /api/events/:id` | 先查 event → 取得 `baby_id` → 再查 `baby_members`。找不到或無權限一律回 **404**（不回 403，避免洩漏該 id 是否存在） |
| `requireTagAccess` | `PATCH/DELETE /api/tags/:id` | 同上 |
| `requireOwner(param)` | owner only 的端點 | 在 `requireBabyAccess` 之後再檢查 `role = 'owner'` |

## 6.5 邀請碼

- 在**設定頁面**產生，owner only。
- **一次性使用，一小時後過期。** 使用後或過期即失效。
- **「一次性」必須是原子的檢查加寫入**，否則兩支手機同時輸入同一組碼會雙雙成功。**完整的 SQL 與必須「先寫成員、後消耗碼」的理由見 §4.3 第 4 點**——順序寫反或把守衛掛在 `used_by` 上，都會讓碼可以重複使用。
  **依 rows-affected 判定成功與否**，不可先 `SELECT` 檢查再 `UPDATE`。
- **熵 ≥ 128 bit 隨機**，以 Base32 顯示（去掉易混淆字元）。
- **DB 存 SHA-256，不加鹽。** 這裡必須是無鹽、確定性的雜湊，才能用使用者輸入的碼直接查表。**不可沿用 9.3 的 PBKDF2 加鹽作法**——加了鹽就無法 lookup，只能掃全表。比較時使用 constant-time 比較。
- `POST /api/babies/join` 必須納入速率限制。
- 理由：邀請碼外洩等於寶寶全部資料外洩，不做無限期的碼。

---

# 7. 使用者故事與頁面

## 7.1 初次使用

- 登入畫面，帳號密碼登入。**不開放註冊**（見 9.1）。
- 登入後可建立自己的寶寶：顯示名稱、性別、出生年月日。
- 登入後也可從設定頁輸入他人分享的邀請碼，加入既有寶寶。
- 完成後進入主頁面。

## 7.2 主頁面

**上方區塊**
- 最上方中間顯示寶寶圖案與暱稱。
- 圖案下方顯示歲數（精確到幾個月幾天，依寶寶時區計算）、身高、體重。
  - 身高體重取**最新一筆該類型事件的數值**（依 `started_at DESC, id DESC` 排序，§5.5）。
  - 無資料顯示「--」。

**今日照顧摘要（身高體重之下、快捷區之上）**

身高體重一週才變一次，但**交接照顧時真正需要知道的是最近幾小時發生了什麼**。因此主頁必須有一條摘要列：

- 最近一次餵奶距今多久
- 今日累計奶量
- 今日尿布次數（**尿 / 便 / 未分類分開計**，見 7.3）
- 目前是否在睡眠中，已睡多久

這是「另一個人剛接手」時最需要的資訊，優先度高於成長數據。
- 圖案右邊為設定圖示，進入設定頁（見 7.8）。
- 圖案左邊為頁面切換圖示，點擊彈出頁面清單。

**事件管理快捷（位於事件瀏覽上方）**
- 每個常用事件類型一個區塊，含圖示、名稱、顏色。
- 顯示**該類型上次發生時間**，以相對時間呈現（「12 分鐘前」「3 小時前」「很久以前」「還沒有」）。
- 每個區塊有 `+`，點擊直接跳到該類型的新增事件頁。
- **若該類型有進行中的事件**，區塊改為顯示計時（如「睡眠中 1 小時 23 分」）與結束按鈕，點擊即結束事件並填入 `ended_at = now`。
- **超時的計時必須改走表單，不可直接填入 now**：若已進行超過 `MAX_EVENT_DURATION_MS`（24 小時，§3.4.1），結束按鈕改為開啟編輯表單，要求使用者手動修正結束時間。
  - **不做這條會死鎖**：忘記停止的計時一旦超過 24 小時，按結束會永遠驗證失敗，而它同時占著該類型唯一的「進行中」名額（§3.5），於是連新的睡眠都開不了。
  - 超時的計時在 UI 上要有明顯標示（例如變色 + 「請確認結束時間」）。
- **離線結束計時必須保住「實際按下的時間」**，見下方。

### 離線結束計時：存成待確認草稿

離線佇列只排 POST（§6.1），所以結束計時（`PATCH`）離線時送不出去。但**單純擋下來會毀掉睡眠資料的可信度**：家人 03:10 按結束時沒網路，03:40 才恢復連線——若只是擋住並要求他自己記得回填 03:10，那筆紀錄多半就錯了，而睡眠時長正是這個 app 的核心價值。

**作法**（仍不需要通用的離線 PATCH 佇列）：

1. 離線按下結束時，**在本機存下「待確認的結束時間」草稿**（即當下的真實時刻）。
2. UI 明確標示該計時「已結束，待同步」，與已同步狀態視覺上可區分。
3. 恢復連線後取得該事件的最新版本，**帶著草稿時間讓使用者確認後送出**（而非自動提交，因為期間可能已被另一人改過）。

### 兩個必須定義的狀態

- **兩人都離線開始同一種計時**：上線後第二筆會撞上 `active` 唯一索引（§4.1），回 **`ACTIVE_TIMER_EXISTS` (409)**，處置見 §5.2。不可讓它變成 500。
- **`ended_at IS NULL` 不等於進行中**，兩種狀態的定義與輸入方式見 §3.5。
- 快捷區塊可左右滑動瀏覽。

**事件瀏覽**
- 列出今日所有事件，依發生時間排序；整天的事件排在最上面。
- 每個事件顯示：
  - 類型圖示（各類型固定圖示與顏色）
  - 事件名稱（主要字級，較大）
  - 下方副資訊：發生時間或時間區段、區段總時長、該類型的額外資訊（如「哺乳 59 分，兩邊」）
- 可上下滑動瀏覽。
- 點擊事件跳到事件編輯頁。

**浮動按鈕**
- 右下角覆蓋一個 `+` 按鈕，點擊跳到事件新增頁。

**同步**
- 下拉手動同步，進入頁面自動同步。
- **必須顯示最後同步時間**（如「1 分鐘前同步」）。頁面一直開著時資料會過期，而使用者無從得知——尤其是另一個人剛記完一筆的情況。
- 頁面在前景時可低頻輪詢 `summary`（例如每 60 秒），**不需要 WebSocket**。

## 7.3 事件新增頁

- 先顯示所有可選事件類型，依大分類分區（食物 / 活動 / 成長速度 / 健康狀況 / 情緒 / 重要事件 / 其他）。
- 每個類型顯示圖示與名稱。

**最常用的兩個操作必須真的能在兩次點擊內完成**（§8 第 4 點）：

- **尿布**：類型選擇頁的尿布區塊直接提供「尿 / 便 / 兩者」三個入口，一次點擊即完成分類與記錄。若做成「點尿布 → 再開表單選類型」，半夜實務上會被跳過，最後累積一堆未分類紀錄，讓統計失去意義。**未分類的尿布在今日摘要中必須單獨計數**，不可混入尿或便。
- **奶瓶**：數值欄位**預填上一次的奶量**，但仍須使用者確認後送出（不可自動沿用），避免每次重新輸入。

- 選擇後進入該類型的新增表單，欄位依 config 決定：
  - **數值欄位**：僅 `value !== null` 的類型顯示，標籤與單位取自 config，並做 min/max 驗證。無數值類型後端寫入 1。
  - **開始時間**：必填。預設為現在，**但從行事曆頁新增時，預設為該頁正在檢視的日期**（時間仍為現在的時刻）。儲存後回到原本檢視的日期，不跳回今天。
    - 沒有這條的話，「補登昨天的紀錄」會變成：選到昨天 → 按新增 → 表單卻預設今天 → 存完還跳回今天。這是補登流程最容易讓人記錯日期的地方。
  - **結束時間**：`hasRange: true` 的類型才顯示，可留空（代表進行中或待補）。
  - **Metadata 欄位**：依 config 的 `metadataFields` 產生對應 UI。
  - **註解**：純文字，選填。
  - **標籤**：點擊顯示既有標籤供選擇，也可當場新增。
- 儲存後回到**進入新增頁之前的畫面**：從主頁進來就回主頁，從行事曆進來就回該頁並維持原本檢視的日期。

## 7.4 事件編輯頁

- 與新增頁相同，差別在於載入既有資料並更新。
- **必須有刪除按鈕**，刪除為 soft delete，需二次確認。
- 更新時帶 `version`，409 的處理見 6.3。

## 7.5 單日行事曆頁

- 版面如 Google 日曆的單日檢視。
- 預設顯示當天。
- 最上方顯示日期，點擊可滑動選擇年/月/日，並有「回到今天」按鈕。
- 顯示當日所有事件，事件 UI 同主頁面。
- 右下角同樣有新增事件的浮動按鈕。

## 7.6 雙日行事曆頁

- 同單日行事曆，但同時顯示兩天。
- 預設顯示「當天 + 前一天」。選擇日期後顯示「該日 + 前一日」。

## 7.7 統計頁

- 最上方可選擇要查看的事件類型。
- 一律以「日」為單位分組（依 `local_date`）。
- 可選擇區間：週 / 月 / 6 個月 / 年，並可指定起始日期。
- 可選擇長條圖或折線圖。
- **聚合方式由該類型 config 的 `aggregation` 決定**，不可一律加總：
  - `count` → 每日次數圖
  - `sum` → 每日數值加總圖（如每日總奶量）
  - `last` → 每日最後一筆的值（體重、身高、頭圍**絕對不可加總**）
  - `duration_sum` → 每日總時長圖（跨午夜依 3.4 切分）
  - `max` / `avg` → 每日最大值 / 平均值
- **空白日的處理**：
  - `count` / `sum` → 補 0（那天確實沒發生）
  - `last` / `avg` / `max`（體重、體溫，一週或偶爾才量一次）→ **不補 0，直接連接前後資料點**。補 0 會讓體重曲線掉到地上。
  - `duration_sum` → 補 0
- **進行中的事件不計入時長**（§3.4.1），因此圖表必須標註「**僅含已完成的紀錄**」。否則使用者會覺得今天的睡眠時數莫名其妙少算了。
- 若有未同步的本地紀錄，圖表也要標示，避免使用者根據不完整的資料下判斷。
- 橫軸為日期，縱軸為數值。橫軸標籤密度依區間調整：
  - 週：顯示完整日期
  - 月：顯示幾號，間隔顯示（1, 5, 10 …）
  - 6 個月 / 年：只顯示月份

## 7.8 設定頁

- 寶寶資料：暱稱、出生年月日、性別
- 產生邀請碼（一次性，一小時過期）
- 家庭成員列表與移除成員
- **登出**
- 資料匯出（見第 12 章里程碑，優先度低）
- 未來所有可設定項目都放這裡

## 7.9 標籤頁

- 可新增、刪除標籤。
- 刪除使用中的標籤時，跳出提示說明該標籤正在使用，確認後會一併移除事件上的該標籤。

**⚠️ 標籤關聯的變動必須 bump 受影響事件的 `rev` 與 `updated_at`**：

增量同步只看 `events` 的 `rev`（§5.4）。刪除標籤時若只刪 `event_tags` 的列，其他裝置永遠同步不到這個變化，會一直顯示已經不存在的標籤。

因此以下操作都必須連帶更新受影響事件的 `rev`：
- 刪除標籤（連帶刪除的所有 `event_tags`）
- 重新命名標籤
- 在事件上新增或移除標籤

**順序必須是「先 bump、後刪關聯」，且全部在同一交易內**（§4.3）：

1. 先 bump 所有受影響事件的 `rev` / `updated_at`——**此時 `event_tags` 還在**，§5.4 的配號 SQL 正是靠它找出受影響的事件。
2. 再刪 `event_tags`。
3. 最後刪 `tags`。

順序顛倒的話，第 1 步會找不到任何事件（關聯已經沒了），其他裝置就永遠同步不到這次變更。標籤操作不頻繁，這個成本可以接受。
- 點擊標籤顯示所有相關事件：
  - 可多選標籤，為 OR 邏輯（列出含其中任一標籤的事件）
  - 可指定時間區間
  - 可選擇排序方式，預設由近到遠

**對應的 API 參數**（`GET /api/babies/:id/events`）：

| 參數 | 說明 |
|---|---|
| `tags` | 逗號分隔的 tag id，OR 邏輯。**必須用 JOIN + `DISTINCT`**，不可逐一綁參數（§4.2 的 100 參數上限） |
| `from` / `to` | `local_date` 閉區間 |
| `sort` | `recent`（預設，`started_at DESC, id DESC`）或 `oldest`（`started_at ASC, id ASC`）。務必帶 id 做穩定排序 |
| `limit` / `offset` | 分頁，`limit` 預設 50、上限 200 |

標籤頁的結果**可能很多，必須分頁**，不可一次全撈。

## 7.10 頁面切換

- 點擊主頁面寶寶圖左邊的圖示，彈出所有頁面清單，並標示目前所在頁面。
- 頁面清單：主頁面、單日行事曆、雙日行事曆、統計頁、標籤頁、設定頁。
- 若使用者有多個寶寶，**點擊寶寶暱稱可切換寶寶**。

## 7.11 全域狀態處理

- **載入中**：顯示 skeleton 或 loading 指示。
- **網路失敗 / API 錯誤**：跳出錯誤彈窗顯示錯誤訊息，提供重試。
- **空資料**：各列表需有明確的空狀態文案，不可只留白。

---

# 8. UI 設計原則

這些不是加分項，是這個 app 的核心需求：

1. **深色主題優先**。半夜餵奶時在黑暗房間看手機，淺色底會刺眼到睜不開。深色為預設且 v1 唯一主題。
2. **單手可操作**。主要操作按鈕（新增事件、快捷區、結束計時）放在畫面下半部，拇指可及範圍內。
3. **大點擊區域**。使用者另一隻手抱著小孩，最小觸控目標 44×44 px。
4. **最少步驟**。記錄一次換尿布應該在 2 次點擊內完成。
5. 色彩以事件類型的顏色作為辨識主軸，讓使用者掃一眼就能分辨事件。

---

# 9. 後端 Auth

## 9.1 不開放註冊

- 頁面**不提供註冊功能**。
- 提供 CLI script（`scripts/`）直接操作 DB 管理使用者：
  - 建立使用者（**內建密碼產生器並預設使用**，見 9.3）
  - 更新使用者密碼
  - **撤銷某使用者的所有 session**（刪除其 `sessions` 全部列）
  - **停用使用者**（見下方）
  - **指派使用者為某寶寶的成員**（讓 M1 不必等邀請碼 UI 就能兩人共用）

**v1 不提供「刪除使用者」，只提供「停用」。** 刪除會留下兩個沒定義的問題：既有事件的 `created_by` 指向不存在的使用者，以及被刪的若是最後一個 `owner`，該寶寶就沒人能管理了。停用（標記 `disabled_at` + 撤銷所有 session）達到相同的實際效果，且不破壞既有資料的參照。

**「撤銷所有 session」是密碼外洩時的實際對策。** 改密碼本身不會讓既有的 session token 失效——它們有 90 天效期且獨立於密碼存在。所以外洩時的正確處置是兩步：改密碼**並且**撤銷所有 session。這兩件事都必須能從 script 做到。

注意：每日事件上限（§5.7）對密碼外洩幫助有限——攻擊者最主要的傷害是**讀取**寶寶的全部紀錄，寫入上限對此毫無作用。真正的防線是 9.3 的強密碼，以及這裡的 session 撤銷。
- script 接受帳號密碼與 DB 連線資訊參數，支援互動式輸入密碼（不從命令列參數讀密碼，避免留在 shell history）。
- 需同時支援本地 D1 與遠端 D1。

## 9.2 Token 機制：單一不透明 session token

**採用最簡設計，不使用 JWT，不做 refresh token 輪替。**

- 登入成功後發一個 **32 bytes 的隨機不透明字串**（`crypto.getRandomValues`），以 `Authorization: Bearer <token>` 傳送。
- DB 的 `sessions` 表存 **SHA-256（無鹽，才能 lookup）**、`user_id`、`expires_at`、`created_at`。
- 有效期 **90 天**，不輪替。登出 = 刪除該列。
- 每次請求以 token hash 查一次 `sessions`（1 次 D1 查詢，已計入 §4.2 的預算）。
- 前端存 `localStorage`。**這是權衡，不是平台限制**——因為 API 與前端同源（§10.2），其實可以改用 `HttpOnly` cookie，能防住 XSS 讀取 token。選 `localStorage` 是因為它讓 token 處理較單純（不需處理 CSRF 與 cookie 的 SameSite 設定），對兩人自用的 app 可接受。若日後要提高安全性，改用 HttpOnly cookie 是可行的升級路徑。

**為什麼不用 JWT + refresh 輪替**：對兩個使用者而言安全性幾乎等價（都是可撤銷的 90 天憑證），但程式碼少一半，而且避開了輪替式 refresh 最常見的兩個坑——**兩個分頁同時 refresh 造成互相登出的競態**，以及 401 → refresh → retry 攔截器寫錯導致的無限迴圈。不透明 token 每次都直接查 DB，沒有這些狀態問題。

**過期 session 的清理**：登入時順手刪除該使用者所有 `expires_at < now` 的列即可，不需要排程。

## 9.3 密碼雜湊

- 使用 Workers 原生的 **`crypto.subtle` PBKDF2-HMAC-SHA256**。原生實作速度快，也不需打包第三方套件（bcrypt 的純 JS 版本在 Workers 上太慢）。
- 每個使用者獨立 16 bytes 隨機 salt。
- 儲存格式：`pbkdf2$sha256$<iterations>$<salt_b64>$<hash_b64>`，迭代次數寫進字串，方便日後調整而不影響舊密碼。
### 迭代次數

**兩個平台硬限制（查證於 2026-09）：**

1. **Workers 的 WebCrypto 把 PBKDF2 迭代數上限鎖在 100,000**，要求更高會直接拋錯。
2. **免費方案每次請求 CPU 上限 10 ms 且不可調整。** 實務上 10 ms 大約只跑得動 **20,000–80,000** 次迭代。

**結論：OWASP 建議的 600,000 次在 Cloudflare Workers 上無論付不付費都做不到**，因為第 1 點是平台寫死的上限。因此本專案不把安全性押在迭代數上。

**決定：迭代數定為 `50_000`**，寫成 `packages/shared` 的具名常數。格式字串已含迭代數，日後調高不影響既有密碼。

**不要「先寫 100,000 再實測調降」。** 已知 10 ms 只跑得動 20,000–80,000，從上限起跳等於交付一支在生產環境必定 500 的登入 API。

**⚠️ 本機開發不會重現這個問題**：`wrangler dev` / Miniflare **不套用生產的 CPU 限制**，所以測試會全綠、線上登入卻壞掉——這是最難除錯的一類 bug。

因此：**「部署到 `*.workers.dev` 實測登入 API 的 CPU 用量」是 M1 的驗收條件**，不是「之後再說」。實測數字記錄回本節。

**為什麼這樣可以接受**

迭代次數只在單一情境下有意義：**資料庫外洩後的離線暴力破解**，作用是讓每次猜測變貴。

但密碼強度的效果高出好幾個量級——迭代數從 2 萬提到 10 萬只讓破解貴 5 倍，而密碼從常見的 8 字密碼換成隨機 20 字，搜尋空間大上天文數字等級。**迭代次數本質上是在保護人類自己想的弱密碼。**既然平台限制讓迭代數這條路走不遠，密碼強度就是唯一有效的槓桿。

因此本專案的安全預算投在：

- **強制所有帳號使用密碼管理器產生的隨機長密碼（≥ 20 字元）。** 使用者由 CLI script 建立，可以直接落實，**script 必須內建密碼產生器並預設使用它**。這是本專案最重要的一條安全措施。
- 20 字元隨機密碼的搜尋空間大到線上猜測完全不可行，這也是 9.4 可以不做帳號鎖定的前提。

另外，登入是罕見操作——session token 有效 90 天，因此 CPU 成本本身不是問題，唯一的限制是單一請求的 CPU 硬上限。

**不採用 Argon2 / bcrypt（WASM）**：兩者都是刻意設計成更耗 CPU／記憶體的演算法，在 10 ms 的預算下只會比 PBKDF2 更早撞牆。

**禁止事項**：不可為了節省 CPU 把密碼雜湊搬到前端計算。那會使雜湊值本身等同於密碼，資料庫外洩時攻擊者可直接拿 hash 登入，比原本更糟。

## 9.4 速率限制：不做帳號鎖定，失敗登入不寫 DB

**原本規劃的「同一帳號失敗 5 次鎖定 15 分鐘 + `login_attempts` 表」已廢除**，因為它會製造兩個比它要解決的問題更嚴重的漏洞：

1. **可被外人觸發的自我 DoS**：掃描器只要猜到 username（多半就是你的名字或 email）就能讓你們**永久登不進去**，而你正抱著小孩在半夜需要記錄。
2. **會打爆 D1 每日寫入額度**：免費方案每天只有 **100,000 rows written**，而超過後**當日所有 D1 查詢都會報錯直到 UTC 00:00**。一次稍微認真的掃描就能讓你連新增事件都失敗。用「每次失敗插一列」的設計把外部流量直接轉成 DB 寫入，是把可用性交到攻擊者手上。

**改為**：

- **登入失敗不寫任何 DB。** 比對後直接回 401，成本只有一次 PBKDF2。
- 主要防線是**密碼強度**（9.3）：20 字元隨機密碼讓線上猜測完全不可行，這才是真正在擋的東西。
- 次要防線：Worker isolate 內的 best-effort 計數器（同 isolate 短時間多次失敗則延遲回應）。這不可靠但免費且無副作用，不可依賴它做安全保證。
- **取得自訂網域後，改用 Cloudflare 免費方案內建的 rate limiting rule 擋 `/api/auth/*`**。這是正確的位置——不吃 Worker CPU、不吃 D1 寫入。**注意此功能需要自訂網域，`*.workers.dev` 上無法使用**，因此 2.5 所說「網域非必要」在安全性上其實是半必要的。

## 9.5 授權

- 除登入端點外，**每支 API 都必須驗證 session token 並檢查該使用者對目標資源的權限**。
- 權限檢查一律走 §6.4 定義的四個 middleware，**禁止在各 handler 內重複實作**。

## 9.6 iOS 的儲存清除限制

WebKit 對 script-writable storage 有 **7 天上限**：超過 7 天未使用，`localStorage`、IndexedDB、Service Worker registration 都可能被清除。**但已加入主畫面（manifest `display: standalone`）的 PWA 豁免。**

影響：若家人只在 Safari 分頁裡用，會不定期被登出，**而且離線佇列裡尚未送出的紀錄可能整個消失**。

因此：

- 規格明訂 **iOS 必須「加入主畫面」使用**。
- 偵測到 iOS + 非 standalone 時，顯示引導加入主畫面的提示。
- 離線佇列不可視為可靠儲存，UI 必須顯示「尚有 N 筆未同步」（§6.1）。
- 註：這也表示 9.2 的「90 天才需登入一次」只在已加入主畫面的前提下成立。

---

# 10. 開發環境

## 10.1 本機開發

- **後端**：`wrangler dev`（Miniflare）搭配**本地 D1**，資料存在本機檔案。不需要 Docker。
- **前端**：`vite dev`，透過 proxy 轉發 `/api` 到本地 Worker。
- **手機測試**：`vite dev --host` 後，以區網 IP 從手機連入。日常開發這樣就夠了。

### Service Worker 與 HTTPS 的界線

Service Worker 要求 secure context，規範定義為「HTTPS **或 localhost**」。**這取決於網址，不是取決於裝置**：

- `http://localhost:5173`（自己電腦）→ Service Worker 正常運作，**不需要 HTTPS**。
- `http://192.168.x.x:5173`（手機走區網 IP，或自己電腦用 IP 開）→ 不是 secure context，Service Worker 不會註冊。

**⚠️ 影響範圍不只 PWA**：`crypto.randomUUID()` **也需要 secure context**，而事件 id 由前端產生（§3.8）——所以在區網 HTTP 下，**連新增事件都會壞掉**，不是只有離線快取不能用。

因此：

- **`packages/shared` 必須提供 `newEventId()`**，內部優先用 `crypto.randomUUID()`，不可用時以 `crypto.getRandomValues()` 組出 UUID v4（`getRandomValues` 不受 secure context 限制）。**禁止直接呼叫 `crypto.randomUUID()`。**
- 沒有這層 fallback 的話，「用手機連區網 IP 測試記錄功能」這條開發流程根本走不通。

其餘受影響的是「離線快取」「加到主畫面 / 獨立視窗」「Web Push」。UI、路由、API 呼叫、登入、圖表則照常運作。

只有在專門測試 PWA 安裝或離線行為時才需要真實 HTTPS，由簡到繁：

1. **直接 `wrangler deploy` 到 `*.workers.dev`**。Workers 部署只要幾秒，拿到真實 HTTPS 網址。要在 iPhone 上測「加到主畫面」，這是最簡單的做法。
2. **`cloudflared tunnel --url http://localhost:5173`**，免設定的臨時 HTTPS 網址，iOS / Android 皆可。
3. Android 專用：Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 把區網 IP 加入白名單。iOS Safari 無對應功能。

不建議用 mkcert 自簽憑證——手機需安裝並手動信任根憑證，麻煩程度超過上述三種。
- **Seed 資料**：提供 script 灌入測試用的寶寶與事件，讓圖表與行事曆頁在開發時有東西可看。

## 10.2 部署

- 單一 Cloudflare Worker 同時服務靜態檔（Workers Assets）與 `/api/*`，同源，沒有 CORS 問題。

### 建置串接（Workers Assets 的三個常見坑）

`packages/web` 建置出的 `dist` 要交給 `packages/api` 的 Worker 當靜態資源。設定用 **`wrangler.jsonc`**（新專案建議格式）：

```jsonc
{
  "name": "babyapp",
  "main": "src/index.ts",
  "compatibility_date": "2026-01-01",
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",  // SPA 路由 fallback
    "run_worker_first": ["/api/*"]                    // 見下方第 1 點，必要
  },
  "d1_databases": [{ "binding": "DB", "database_name": "babyapp" }]
}
```

三個必須驗證的行為：
1. **`/api/*` 不可被 assets 攔截——必須靠 `run_worker_first` 設定，光在 handler 內判斷路徑是不夠的。**
   Workers Assets **預設是 assets 優先**：平台會先嘗試比對靜態檔，找不到才呼叫 Worker。這代表 API 的 navigation request 有可能直接收到 SPA 的 HTML，而你的 handler 根本不會被執行。`run_worker_first: ["/api/*"]` 才能反轉這個順序。
   **驗收**：打一個不存在的 API 路徑（如 `/api/nope`），必須回 JSON 格式的 404，不能回 HTML。
2. **SPA fallback**：`not_found_handling: "single-page-application"`，否則直接開 `/stats` 會 404。
3. **建置順序**：`pnpm -C packages/web build && wrangler deploy`，部署腳本必須包含前端建置，否則會部署到過期的 `dist`。
- D1 建立時指定 location hint 為 **APAC**，降低從台灣連線的延遲。
- Migration 以 `wrangler d1 migrations apply` 執行，部署流程需包含此步驟。

---

# 11. 測試策略

分三層，**重點放在第一層**：

## 11.1 純函式單元測試（最高優先，追求高覆蓋率）

這裡是最容易出錯、也最好測的地方：

- `local_date` 計算（含時區換算、跨午夜邊界）
- 跨午夜時長切分
- 統計聚合（`count` / `sum` / `last` / `duration_sum` / `avg` / `max`）
- 數值單位換算（`scale`）
- 歲數計算

## 11.2 後端整合測試

- 使用 **`@cloudflare/vitest-pool-workers`**，可在測試中跑真實的本地 D1（不是 mock 的 SQL）。
- 每支 API 至少涵蓋：成功路徑、未授權、跨寶寶存取被拒、驗證失敗、版本衝突（409）、重複 id 的 POST（§5.8）、超過每日上限（§5.7）。
- **測試必須跑在真實 D1 上**，確保 SQL 與 migration 正確。

### 把兩條平台硬限制變成自動化護欄

本機測試環境**不會**套用生產的限制，所以 §4.2 和 §9.3 這兩條最重要的規則，靠文件約束是抓不到的：

1. **D1 查詢數**：本地 D1 不強制 50 queries/invocation 上限。**寫一個測試 helper 計數每次請求的 D1 呼叫數，超過 30 次即 fail**，把這條硬限制變成 CI 會擋下來的東西。這比寫在 `AGENTS.md` 裡有效得多（理由見 13.2）。
2. **CPU 時間**：Miniflare 不套用 10 ms 限制，只能在真實部署上驗（見 9.3，列為 M1 驗收條件）。

### 必測的情境（比「每支 API 都測完整錯誤類型」更重要）

逐支 API 測遍所有錯誤碼的邊際效益不高。以下這些**跨元件的情境**才是真正會出事、也最難用眼睛看出來的：

- 兩支手機同時開始同一種計時 → 只有一筆成功，另一筆收到專用錯誤（§4.1、§7.2）
- `version` 衝突時 → 事件本體與標籤關聯**都完全沒變**（§4.3）。**這條必須真的去查 DB 驗證資料未變，不能只斷言回應是 409**——正是那個回報失敗卻已改資料的 bug 的形狀
- 刪除墓碑抵達後，較舊 `rev` 的回應**不會讓事件復活**（§6.2）
- POST 網路失敗 → 修正內容後重試 → **修正沒有被 idempotency 靜默吃掉**（§6.1）
- 標籤批次更新影響超過一頁的事件 → 全部都能被同步到（§5.4 的逐筆配號）
- POST 已成功但回應遺失 → 重送不新增、不改寫既有資料（§5.8）
- 401 暫停佇列 → 換帳號 → 重新登入 → 佇列不會串帳號（§6.1）
- 跨午夜的計時；離線關閉 app 再開啟；還原備份後重新同步（§12.2）

## 11.3 前端測試

**「UI 測試應該要 mock 後端嗎？」→ 要，但要 mock 在網路層。**

- 使用 **MSW（Mock Service Worker）**，攔截 `fetch` 本身。這樣 component、狀態管理、API client 全部跑真實程式碼，只有真正出網路那一刻被替換。
- **不要 mock 自己寫的函式**（例如去 mock `getEvents()`）。那等於把要測的東西挖掉，API 改壞了測試還是全綠。
- 涵蓋：列表渲染、空狀態、錯誤狀態（API 回 500）、表單驗證。

## 11.4 E2E

- Playwright，打真實的本地 Worker + 本地 D1。
- **只跑最關鍵的兩三條路徑**：登入 → 新增事件 → 出現在今日列表；開始睡眠 → 結束睡眠 → 時長正確。

## 11.5 覆蓋率原則

- **不追求全域覆蓋率數字。** 力氣放在 11.1 的純邏輯。
- UI 排版類測試維護成本高、抓到的 bug 少，不強求。

---

# 12. 開發里程碑

不要一次做完，按順序推進：

**排序原則：可靠地記錄 > 回顧資料 > 進階檢視。** 對這個產品而言，「半夜記錄失敗」比「少一個雙日檢視」嚴重得多，因此離線與失敗處理提前到 M2，不放在最後打磨。

| 里程碑 | 內容 | 完成後的狀態 |
|---|---|---|
| **M1 能日常記錄** | 專案結構、shared config（含完整事件類型表）、auth（含使用者管理 script）、寶寶 CRUD、事件 CRUD、**開始／結束計時**、主頁面（深色、手機優先）、備份 script **與還原演練** | 一個人已經可以每天拿來用 |
| **M2 兩人可靠共用** | 增量同步、樂觀鎖衝突處理、成員管理、**基本離線記錄與失敗處理**、**PWA 更新流程**、邀請碼 | 夫妻兩人可同時使用，且收訊不好也不會掉資料 |
| **M3 回顧資料** | 單日行事曆、核心統計圖表 | 能回頭看趨勢 |
| **M4 進階檢視** | 雙日行事曆、完整標籤操作、資料匯出 UI | |

**`version` / `rev` / `deleted_at` 必須從 M1 的 schema 就放進去**，即使 M1 還用不到。事後加欄位要寫 migration 並回填，成本高出許多。

**M1 的成員指派用 CLI 完成即可**（§9.1 的 script），不必等邀請碼 UI 做完才能兩人共用。邀請碼是便利性功能，不是共用的前提。

## 12.1 各里程碑的驗收條件（不可省略）

這三項都是「不做就會在最糟的時刻才發現」的類型：

| 里程碑 | 驗收條件 |
|---|---|
| **M1** | 部署到 `*.workers.dev` 後**實測登入 API 的 CPU 用量**，確認 50,000 次 PBKDF2 在 10 ms 內完成（本機測不出來，見 9.3） |
| **M1** | **完成一次還原演練**：把備份還原到臨時 DB，驗證筆數與抽查事件內容（見 12.2） |
| **M1** | 以手機在區網 HTTP 下實際新增一筆事件，確認 `newEventId()` 的 fallback 有效（見 10.1） |
| **M2** | 飛航模式下記錄一筆事件 → 恢復連線 → 確認同步成功且未重複 |
| **M3** | 以**一年份 seed 資料**實測 `GET /stats` 的 CPU 用量（見 5.6） |

## 12.2 備份（從 M1 就要做）

D1 免費方案的 Time Travel **只保留 7 天**，超過一週才發現的資料損壞就救不回來了。這是小孩的成長紀錄，不應該只活在一個免費方案的資料庫裡。

- **app 內的匯出 UI 排在 M4，優先度低**（維持原本決定），因為不需要它也能備份。
- **但從 M1 開始就要有可運作的備份**。

**指令必須明確加上 `--remote`**：

```sh
wrangler d1 export <db> --remote --output=backup-YYYY-MM-DD.sql
```

`wrangler d1 export` 同時有 `--local`（匯出 `wrangler dev` 用的本機 DB）與 `--remote` 兩個旗標，而**官方文件並未載明省略時的預設值**。漏掉 `--remote` 的後果是每次都備份到空的本機資料庫，而且**不會有任何錯誤訊息**——你會在需要還原的那天才發現。因此一律顯式指定。

**不要依賴「記得每月手動跑」。** Time Travel 只有 7 天，而人不會記得。`scripts/backup.sh` 需要：

1. 顯式帶 `--remote`。
2. **Sanity check**：檢查輸出檔確實含有 `INSERT INTO events`，否則 `exit 1`。沒有這關，備份壞掉是靜默的。
3. **自動排程**：用 GitHub Actions（免費）每週執行並存為 artifact 或 commit 到 private repo。開發成本不到一小時，是本規格中 CP 值最高的一項。
4. **排程失敗必須看得到**：GitHub Actions 失敗會寄信，確認該通知有開啟。靜默失敗的備份等於沒有備份。
5. **保留策略**：週備份保留 8 份、月備份保留 12 份。

### 還原演練（M1 驗收條件）

**「檔案裡有 `INSERT INTO events`」只證明有檔案，不證明救得回來。** M1 必須實際做一次還原演練：

1. 把備份還原到一個**臨時 D1 資料庫**。
2. 驗證 `events`、`tags`、`event_tags`、`baby_members` 的筆數與來源一致。
3. 抽查幾筆代表性事件（含一筆跨午夜的、一筆帶標籤的）內容正確。

### ⚠️ 還原舊備份後必須重設 client 游標

這是 `rev` 設計的副作用：還原舊備份會讓 DB 的 `rev` **倒退**，但手機上仍存著較大的 `since` 游標，於是 `rev > since` 永遠撈不到東西——**手機會看起來一切正常，卻再也同步不到任何資料**。

v1 用明確的人工復原步驟處理即可，不需要自動偵測機制。步驟必須寫在 `AGENTS.md` 與 `scripts/` 的說明中：

1. 保留待同步佇列的內容（那是還沒進 server 的資料）。
2. 清除已同步的本地快取與同步游標。
3. 以 `since=0` 重新全量同步。
4. 再送出保留的佇列。

---

# 13. Coding Standard

- 遵循各語言的社群最佳實踐。
- **型別檢查與 lint 必須零警告**：`tsc --noEmit` 與 `eslint` 通過才算完成。
- 禁止使用 `any`。

## 13.1 Agent 指示檔：單一 `AGENTS.md`

本專案會由**多種 coding agent**（Claude Code、OpenAI Codex 等）共同開發，因此指示檔必須只有一份。

**作法**：

```sh
# AGENTS.md 是本體，CLAUDE.md 是指向它的 symlink
ln -s AGENTS.md CLAUDE.md
```

- `AGENTS.md` 是 Codex、Cursor、Copilot、Gemini CLI 等多數工具的共通慣例。
- Claude Code 自 v2.1.277（2026-09-18）起原生支援 AGENTS.md，但**僅在專案沒有 CLAUDE.md 時才讀取**。
- 因此 symlink 比依賴該功能更穩：兩邊讀到的**是同一個檔案**，不可能漂移；也相容舊版 Claude Code 與尚未支援的雲端部署環境。
- **嚴禁同時存在兩份獨立內容的 `AGENTS.md` 與 `CLAUDE.md`。** 那會讓兩個 agent 依照不同規範開發，而且是靜默發生的。
- 內容必須是**工具中立**的：不可提及任何特定 agent 的專屬功能或工具名稱。

若日後各 package 需要不同規範，可在 `packages/*/` 下放置各自的 `AGENTS.md`（多數工具會自動讀取最接近的那一份）。v1 只需 root 一份。

## 13.2 規則優先放進工具鏈，而不是文件

**這是多 agent 開發最重要的一條。** 不同模型對同一句散文規則的遵守程度不同，而且無法預測。**能被 `tsc` 或 `eslint` 擋下來的規則，對所有 agent 的效力才是一致的。**

因此以下規則必須機器化，不可只寫在 `AGENTS.md`：

| 規則 | 機器化方式 |
|---|---|
| 禁止 `any` | eslint `@typescript-eslint/no-explicit-any` |
| 禁止手算時區 offset、禁止大型日期套件（§5.3） | eslint `no-restricted-imports`（moment、moment-timezone）+ `no-restricted-syntax`（`getTimezoneOffset`） |
| `local_date` 不得由 client 提供（§5.3） | 該欄位不出現在 request 的 Zod schema 中，型別上即不存在 |
| 數值必須為整數（§3.2） | Zod `.int()`；`value` 使用 branded type |
| 禁止 N+1 查詢（§4.2） | D1 查詢計數 helper，超過 30 次即 fail（§11.2） |
| 各欄位長度上限（§5.7） | Zod schema 的 `maxLength` |
| PBKDF2 迭代數 | `packages/shared` 的具名常數，不得在 handler 內寫死 |

`AGENTS.md` 只保留**真的無法機器化**的部分。

## 13.3 `AGENTS.md` 必須涵蓋的內容

- 專案結構與各 package 職責
- **新增一個事件類型的完整步驟**（改 config → 補 metadata 定義 → 補測試）
- **新增一支 API 的完整步驟**（route → Zod schema → 權限 middleware → handler → 整合測試）
- 命名慣例、檔案組織慣例
- 時區與日期處理的鐵則（不可繞過 §3.4 與 §3.4.1）
- 測試要求：哪些一定要有測試
- 禁止事項：手改線上 schema、在 handler 內重複寫權限檢查、用裝置時區算日期、soft delete 時忘記 bump `updated_at`、重送時重新產生事件 `id`、把密碼雜湊搬到前端
- 免費方案的硬限制（10 ms CPU、50 次 D1 查詢／呼叫、每日 10 萬筆寫入）以及它們對寫法的約束

## 13.4 沙箱環境的限制

部分 agent（如 Codex 的雲端模式）在**網路受限的容器**中執行。`AGENTS.md` 必須明確說明：

- 依賴安裝與測試如何在離線狀態下進行（預先安裝好，或提供 setup script）。
- **`wrangler deploy`、`wrangler d1 --remote`、以及任何觸及正式資料庫的指令，在沙箱中不會成功，也不應嘗試執行。**
- 本機測試一律使用本地 D1（`wrangler dev` / vitest-pool-workers）。
- **禁止任何 agent 讀取或寫入 `.dev.vars`、wrangler secrets 或其他機密檔案。**

---

# 14. 明確不做（未來規劃）

以下功能**目前不實作**，列在這裡是為了避免反覆糾結：

- 照片功能
- 疫苗時程表與提醒
- 推播通知 / 餵奶提醒
- 生長曲線百分位（WHO percentile）
- 多語系
- 原生 app（iOS / Android 上架）
- 自訂事件類型（使用者自行新增類型）— 目前以標籤 + `other`（「其他」）類型替代，該類型有 `title` 欄位可自由填寫名稱（見 3.1.1）

---

# 15. 參考

想要參照的 app：我的寶寶 - 寶寶生活記錄 - 寶寶成長記錄
- https://apps.apple.com/tw/app/%E6%88%91%E7%9A%84%E5%AF%B6%E5%AF%B6-%E5%AF%B6%E5%AF%B6%E7%94%9F%E6%B4%BB%E8%A8%98%E9%8C%84-%E5%AF%B6%E5%AF%B6%E6%88%90%E9%95%B7%E8%A8%98%E9%8C%84/id1439575933

本 repo **不收錄該 app 的截圖**——那是他人的著作物，而這個 repo 是公開的。
需要對照時請自行至上方連結查看。以下是當初從它身上採用的設計取向，已全部
落實在規格各處，不需要再回頭看圖：

**主頁面**
- 純深色主題（§8）
- 快捷區每一塊顯示「該類型上次發生時間」，以相對時間表示（§7.2）
- 事件列表每列為「圖示 + 名稱 + 副資訊」，副資訊含時間、時長與該類型的額外欄位（§7.2）

**新增事件頁**
- 依大分類分區呈現（§7.3）
- 每個類型有固定的圖示與顏色，同分類共用色系（§3.1.1）

實際採用的版面與配色見本專案自己的設計稿，與上述來源無關。
