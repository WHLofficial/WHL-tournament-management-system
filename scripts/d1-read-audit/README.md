# D1 读消耗量化报告（增量 38 · 步骤 1–4）+ 治理后复测（增量 38 步骤 6–9 / 增量 39）

> 量化基线：2026-09-23（UTC 15:43 采样）；**实放复测追加于 2026-09-24**（§3.5）；
> **增量 38 治理（步骤 6–9）与治理后复测追加于 2026-09-24**（见「治理后复测（增量 38）」节）；
> **增量 39（剩余 `OR` 清理 + 端点合并 + 排期守卫批量化）与复测追加于 2026-09-24**（见「治理后复测（增量 39）」节）。
> 复测命令见 §10；原始数据在同目录 `surface-measurements.json`（55 读面，桩行）、
> `live-measurements.json`（实放）、`write-path-measurements.json`（16 写面）、
> `shape-ranking.json`（形状归并）、`rewrite-ab.json`（A/B 改写对照）、`cost-model.json`（双通道成本阶梯）。

---

## 0. 结论摘要

1. **问题不在数据量，在「请求量 × 每请求扫描」。** 本仓近 24h 读 **1,428,496 行 / 8,205 条读查询 = 174 行/查询**，
   而全库只有约 1,745 行数据 ⇒ 平均每行每天被读约 **820 次**。库只有 561KB、26 张表。
2. **额度是按账号算的，本仓是账号内最大读者。** 同一 Cloudflare 账号下 4 个 D1 库近 24h 合计约 **220 万行读**，
   占免费档 500 万/日的 **44%**；本仓占其中 **65%**，库却是四个里第二小的。姊妹仓库俱乐部平台
   （`whl-club`）2026-09-21 已因超限报 `Your account has exceeded D1's free tier daily row read limit`
   （当天 4,350,235 行读）——同一天本仓也在从同一个池子里舀水。
3. **按 club 的「单次 ≥10,000 行才治理」阈值，本仓达标读面 0 个。** 55 个读面单次冷路径合计 18,904 行（桩行），
   用实放复测修正后约 **22,655 行**（§3.5），最贵的 `public/feed` 单次 6,777 行（limit=20）/ 7,016 行（limit=30）。
   ⇒ 不能照搬 club 的阈值判定，本仓的浪费是「普遍偏贵 × 高频重算」。改用「**单价 × 重算频率**」判据后
   治理已落地 6 个读面（实放合计 **−44.2%**），增量 39 又清掉剩余 3 个 `OR` 读面（实放合计 **−38.1%**）；
   两次合计见各自的「治理后复测」节。
4. **读量高度集中：`match` + `match_event` 两张表占 75%**（10,826 + 3,337 行），再加 `player` 11.7%
   ⇒ 三张表 86.6%。治理目标就是这三张。
5. **公开页轮询是日常读量的主源。** 首页 `Home.tsx` 每 60s 轮询一次；增量 39 把原来的 6 个端点合并成
   `/api/public/home` 一个（`/api/public/live` 因 TTL 不同保持独立）⇒ **一轮 2 个请求**，
   行读 **5,025 行 / 31 条语句**（合并前 6 请求、5,022 行 ⇒ **合并只省请求数，不省行读**）。
   `PublicTournament.tsx` 与 `PublicMatchDetail.tsx` 同样 60s 轮询（原为 30s，增量 38 步骤 13 统一降频，
   理由与「省的是请求数不是行读」见 §7.1）。
6. **缓存把「访客数」和「D1 读数」解耦了，但没降低每个窗口的重算单价。** `pubCache` 保证每个 TTL 窗口
   至多重算一次（与访客数无关，这是好设计），可单价太高：把 21 个公开面按「每个 TTL 窗口都有请求」相加，
   上限约 **1,449 万行/日**，是账号 500 万池的 **2.9 倍**。当前实到 143 万（= 上限的 9.9%），
   没炸只是因为流量有间歇——**这是结构性风险，不是余量充足**。治理后上限降到约 **435 万（0.87 倍）**。
7. **写端点的读不是主因，但单笔不便宜。** 16 个写面单次合计仅 648 行；最贵的 `POST /matches/:id/finish`
   单笔 **284 行**（其中两次阶段扫描各 133 行：一次取已完赛明细、一次只为数未完赛）。一个 132 场的比赛日全部报分
   约 3.8 万行 ⇒ 管理端操作相比公开页轮询是小头。
8. **两条反直觉的实测结论**（都不能靠推理得到，必须靠读数）：
   - 「给参赛队列表加队内人数」的候选改写**更贵 +68%**（380 → 639 行，因为要全表扫 `player`）；
   - 同表同 `LIMIT 4`，`ORDER BY finished_at DESC` 只读 **1 行**，`ORDER BY round DESC` 读 **136 行**
     ⇒ **排序键决定 136 倍差距，`LIMIT` 本身不省读**。
9. **免费档里比 D1 行读更早撞墙的是 Worker 请求数（10 万/日）。** 按「每次轮询 1 个请求」估算是错的——
   首页一轮本来发 **6 个请求**，30 人 × 4h @30s 就是 8.6 万请求/日，余量只有 1.16 倍。
   增量 38 把轮询降到 60s、增量 39 把 6 个端点合并成 2 个 ⇒ **降到 1.44 万请求/日**（余量 7 倍）。
   端点合并的收益全在这一项上，不在行读。

---

## 治理后复测（增量 38 步骤 6–9，2026-09-24）

治理全部落在 SQL 与 TTL 两层，**未改任何 DTO 或接口契约**；`worker/` 6 个文件、新增 4 个测试文件。
复测口径同 §3.5（实放模式，`measure-live.mts`，每面独立进程）。

### 被改读面的前后对照（实放，同 URL）

| 读面 | 治理前 | 治理后 | 变化 | 手段 |
|---|---|---|---|---|
| `admin/injury-candidates` | 1,342 | **156** | −88.4% | `OR` 作用在 join 列上 → `m.home_entry_id IN (SELECT id FROM entry WHERE team_id = ?) OR m.away_entry_id IN (…)` |
| `public/upcoming` | 1,192 | **644** | −46.0% | 两段式（先取 id，再只为入选 8 场补队名）+ TTL 60→300s |
| `public/tournament-summary` | 876 | **542** | −38.1% | 两段式（原版 `LIMIT 4` 在 join 之后才生效） |
| `coach/me-status` | 1,020 | **349** | −65.8% | 默认赛事子查询同款 `OR → IN` |
| `coach/me-matches` | 787 | **302** | −61.6% | 同款 `OR → IN` |
| `public/feed`（limit=16，首页形状） | 6,521 | **4,315** | −33.8% | §8.1 五项 + 叙事账本窄查询 |
| `public/feed`（limit=20，普查形状） | 6,777 | **4,694** | −30.7% | 同上 |
| `public/feed`（limit=30，列表页形状） | 7,016 | **4,957** | −29.3% | 同上 |
| `public/injuries` | 462 | 462 | 未改 | 无扇出，桩行读数本就准确 |
| `public/round` | 456 | 447 | 未改 | 同上 |
| `admin/injuries` | 464 | 464 | 未改 | 同上 |
| `public/tournament-rounds` | 158 | 158 | 未改 | 同上 |

**被改的 6 个面（按普查形状，feed 取 limit=20）合计 11,994 → 6,687 行，−44.2%。**

### feed 瘦身的构成

| 手段 | 省 | 说明 |
|---|---|---|
| 6.1 轮次综述按 `cap` 截断 | 视数据分布 | 输出等价，见下 |
| 6.2 综述轮次改由 `status='finished'` 预筛 | 665 → 407 | 等价子查询 `AND (m.stage_id, m.round) IN (SELECT stage_id, round FROM match WHERE status='finished')` |
| 6.3 `fetchStageMaxRounds` 请求内记忆化 | −223 | 同批阶段 id 在一轮里被问三次，其中两次是同一集合不同顺序（`[6,2,1]` / `[2,1,6]`） |
| 6.4 `fetchRoundFinished` 加 `INDEXED BY idx_match_stage` | 1,081 → 393 | 规划器原偏好 `idx_match_status` 以省排序，代价是每轮都扫全部完赛场 |
| 6.5 `injuriesInRound` 改 `match_id` 子查询 | 93 → 79 | 必须是子查询，不能由调用方传「已完赛场次 id」——`buildRoundRecap` 的轮次可能未完赛 |
| 7.2 叙事账本改窄查询 `fetchScoringEvents` | 整届全部事件 → 只取 `goal`/`pen_goal` | 账本只累加进球，非进球事件贡献为零 |

语句数也从 44 降到 26（limit=16）：6.1 截掉 9 个轮次，每轮省两条查询。

### 6.1 的输出等价性（为什么它是安全的）

`buildFeed` 的最终输出是 `items.sort(at 倒序).slice(0, cap)`，而窗口已提供 `max(cap*3, 40)` 条带 `at`
的条目 ⇒ 任何 `at` 早于 `window[cap-1].finishedAt` 的条目**必然**排在前 `cap` 之外。
所以按该 cutoff 过滤轮次在输出上不可观测；而且**只要 cutoff 守卫生效，`slice(0, cap)` 也会先丢掉这些轮**，
两者恒同向。守卫：`window.length < cap` 或 cutoff 为空时原样返回；判据用 `>=`（并列保留）保守。
回归测试见 `tests/news.narrative.test.ts` 第 3 例。

### TTL 调整（步骤 9）

| 读面 | 改前 | 改后 | 上限行读/日 |
|---|---|---|---|
| `portal/feed` | `pubCache(60)` + KV SWR 600s/60s | `pubCache(300)` + KV SWR 1800s/300s | 9,308,160 → **1,242,720** |
| `public/upcoming` | `pubCache(60)` | `pubCache(300)` | 1,716,480 → **185,472** |

代价：feed 与待打列表最长陈旧 5 分钟。`live` 与 `matches/:mid` 等仍 60s，比分实时性不受影响。
KV 写最坏 1,440/日 → 288/日（免费档约 1,000/日）。

**21 个公开面 TTL 窗口容量上限：14,488,416 → ≈ 4,350,528 行/日**
（账号 500 万池的 **2.9 倍 → 0.87 倍**，−70%）。

### 首页一次冷轮询（总验收线）

`Home.tsx:152` 每 60s 打 6 个端点（原 30s，步骤 13 降频），治理前 7,776 行 / 51 条语句 → 治理后
`tournaments 48 + upcoming 644 + live 11 + announcement 2 + feed(limit=16) 4,315 + reactions 2`
= **5,022 行 / 34 条语句（−35.4% 行读，−33% 语句）**。

### 治理后仍未达标 / 明确不做

- `public/toplists`（1,949）与 `public/stats`（1,531）未动：单价高但走 300s TTL，窗口数少。
- `admin/tournament-matches`（800）未动：已走对索引，132×5 是「返回 132 行」的固有成本。
- `public/match-report` 实放仅 65 行（桩行 1,402 属分支选择偏差，§3.5），未动。
- C 档五项全部不做（§9）；「加索引」记成**条件性豁免**，重估触发条件：`match` 涨到 2,000 行量级时
  重跑形状普查，或写配额逼近 10 万行/日时重算索引写成本。
- 步骤 7.3（叙事块按 `cap` 截断跳过）判定为**删项**：与 6.1 同理，输出不可观测且省不到。
- 步骤 7.4（去掉 `leader`/`milestone` 两类条目）需产品决策，按计划**默认不做**。
- 步骤 8.5（合并终场两次阶段扫描）**删项**：A/B 实测合并后 265 行 vs 现状两条合计 266 行，
  只省 1 行，不值得动正确性关键的晋级闸门。

---

## 治理后复测（增量 39，2026-09-24）

增量 39 做三件事：把「关联列上的 `OR`」在剩余读面清干净、合并首页与教练首屏端点、批量排期守卫批量化。
复测口径同 §3.5（实放模式，`measure-live.mts`，每面独立进程）。

### 被改读面的前后对照（实放，同 URL）

| 读面 | 增量 38 后 | 增量 39 后 | 变化 | 手段 |
|---|---|---|---|---|
| `public/match-h2h` | 1,102 | **466** | −57.7% | 两处 `OR` 改 `IN (SELECT …)` + `IS NOT NULL` 守卫 |
| `public/match-lineup-stats` | 754 | **270** | −64.2% | `buildTeamTactics` 同款改写（两条各 355 → 113） |
| `public/toplists` | 1,949 | **1,619** | −16.9% | `listActiveInjuryPlayerIds` 改窄查询（436 → 106） |
| **三面合计** | 3,805 | **2,355** | **−38.1%** | |

三面都是 TTL 60s（h2h / lineup-stats）或 300s（toplists），单价降幅直接按比例压到窗口容量上限上。

### 端点合并（只省请求数，**不省行读**）

| 端点 | 请求数 | 行读 | 说明 |
|---|---|---|---|
| `/api/public/home` | 1（原 6） | **5,025 / 31 条语句** | 与六段分算之和（48+644+11+2+4,315+2 = 5,022）基本一致 |
| `/api/coach/bootstrap` | 1（原 4） | — | 四段与四条旧路由 deep-equal（`tests/coach.bootstrap.test.ts` 守住不漂移） |

首页一轮：**6 请求 → 2**（`Promise.all([home, live])`），行读 5,022 → 5,025（等价）。
`/live` 保持 60s 独立、**没有**并进 `/home`——并进去会让 feed 按 60s 重算，4,315 × 1,440 = 621 万行/日 > 账号整池 500 万。

**这是本轮最重要的一条结论：端点个数不影响行读。** 行读只由「单价 × 重算频率」决定，
合并端点的收益全在**请求配额**上（免费档 10 万请求/日比行读更早撞墙，见 `TECH_DESIGN.md` §3）。

### 请求配额（比 D1 读更早撞墙的那条线）

`Home.tsx` 一轮从 6 个请求降到 2 个 ⇒ 30 人 × 4h 轮询（60s）从 4.3 万请求/日降到 **1.44 万/日**（免费档 10 万）。
教练页（`Tactics.tsx`）首屏 7 → 4。

### 批量排期守卫（无行读收益，纯延迟）

`POST /api/admin/tournaments/:id/stages/:stageId/matches/bulk` 原来逐对调 `guardMatch`
（每场 4 条串行查询），最多 24 场 ≈ **96 条串行查询 / 约 19s**；改为整批固定 **2 条查询** + 内存判定
（`guardMatches`）。单场路由复用同一函数，冲突分流口径（本轮/交手 409、其余 400）未变。

### 实测否决（别再试）

`worker/routes/admin/injuries.ts` 两处 `(e1.team_id = ? OR e2.team_id = ?)` **不改**：外层是
`WHERE m.id IN (...)`（rowid 列表），`OR` 只在已取回的行上求值、不驱动扫描。
**教训：关联列上的 `OR` 只有充当扫描驱动时才有害**（已写进 `TECH_DESIGN.md` §3.1 第 2 条）。

---

## 12. 剩余机会清单（增量 39 排查，**未做**）

按「单价 × 重算频率」判据都够不上「必做」，但下次做 D1 治理时可直接从这里挑：

| 位置 | 问题 | 量级 |
|---|---|---|
| `worker/routes/admin/schedule.ts:1126-1246` `buildAutoFillStmts` | `for (const next of stages)` 内 `await COUNT(*)`(:1128)、`await buildCrossStagePlan`(:1199)、`await COUNT(*)`(:1219)、`await takeRangePool`(:1228) 全串行；**每次终场都会跑** | 阶段数 × 4 条串行；当前 3 阶段约 12 条 |
| `worker/routes/admin/tournaments.ts:335-361` `checkRankZoneScope` | 逐 `stageId`/逐 `groupId` 各一条查询 | 排名段数量条串行，仅保存设置时触发 |
| `src/pages/MatchesTab.tsx:138` | 按队 `GET /api/admin/teams/:tid`（每个缺失队一次） | 已用 `playersCache` 去重，首轮按队数并发 |
| `src/pages/MatchesTab.tsx:167` | 按队 `GET /api/admin/injuries?teamId=`（每个队一次） | 同上，无缓存 |

**都不属行读问题**（管理端读量占全站 23.8%，且这些查询单价低），属**延迟 / 请求数**问题。
真要动，方向是给这两条管理端接口加 `?teamIds=` 批量形式，而不是改 SQL。

### 本轮新增的读面（未纳入普查基线）

`/api/public/home` 与 `/api/coach/bootstrap` 是新增端点，尚未写进 `surface-measurements.json`
（用 `measure-live.mts --extra=` 单独量）。下次全量普查会把它们收进去。

---

## 1. 方法

**核心手法（借 club 平台经验）：不手抄 SQL，而是直调真实路由抓下它实际发出的 SQL，再打生产库读回真实行数。**

1. `import app from "../../worker/index"`，用 Hono 的 `app.request(url, init, env, ctx)` 直调真实 handler；
   `env` 是**假 D1**（`makeCaptureDb`）：`prepare/bind` 只把 `{sql, args}` 记进 sink，执行时回桩行、不碰真库。
2. 参数内联（`inlineParams`，手写扫描器跳过字符串字面量内部；`%` 拼成 `char(37)` 防 Windows cmd.exe 展开），
   把带参 SQL 变成可独立执行的字面量 SQL。
3. `selectOnly` 只放行 `SELECT` / 纯读 `WITH`——GET 里也可能藏写（club 的 `/api/market/*` 就先跑结算）。
4. 逐条打生产：`npx wrangler d1 execute whl --remote --json --command "<SQL>"`，读回 `meta.rows_read`
   （管理通道，配额触顶期间照样能跑；测出的是 SQL 读多少行的物理事实）。
5. 鉴权靠假会话：cookie `__Host-tour_session=probe-token`，假 D1 对 `FROM oidc_session` 的查询回
   `{sub:"1", claims: JSON.stringify(PROBE_CLAIMS)}`，claims 带 `roles:["superadmin"]` 与本仓全部 4 个权限点
   （`tour.accounts.manage` / `tour.match.manage` / `tour.org.settings` / `tour.team.bind`）。
6. 详情类路由回「benignRow」桩行（数值列给 1、文本列给 `"probe"`、`status` 给 `"finished"`），
   否则 `if (!row) throw 404` 会让路由提前退出、量不到真实形状。
7. **每个读面用全新假 env**（KV 冷、`caches.default` 永不命中）⇒ 量到的是**冷路径**读数，是保守值。

### 三条边界（引用数据时必须一并说明）

| 边界 | 内容 |
|---|---|
| 通道 | 走 `wrangler d1 execute` 管理通道量的是**物理行读**，不等价于 worker 运行时通道；两者口径一致（见 §5 双通道对拍），但不要与外部的 D1 Analytics 数字直接混读 |
| 桩行偏差 | 假 D1 只记录不执行、桩行值≠真实数据 ⇒ 走的是「探针形状」，不是线上百分之百同一分支。偏大计（回一行桩数据而不是空）是配额治理的安全方向 |
| 冷路径 | 线上命中边缘缓存 / KV 的请求不产生这些行读。**本报告量的是「每个缓存窗口重算一次的单价」，不是「一天的总额」**——日常总额见 §2 的账号读数 |
| 会话查询恒为 0 | 探针 cookie 的 `token_hash`（`sha256("probe-token")`）在生产库里不存在 ⇒ **所有需鉴权读面的会话查询读数都是 0**（真实每次为 1 行，`token_hash` 是主键）。这是一处系统性低报，量级可忽略但需知情 |

### 一个通道陷阱（已定性，写报告时必须记住）

`wrangler d1 execute --file=<tmp.sql>`（多语句文件）**只回一条聚合汇总行**、不回数据行，而且**对单表索引扫描
会低报成 1**（`SELECT id FROM match` → 报 1，实际 218）。`--command` 才是逻辑行数口径。
⇒ **本报告全部读数走 `--command`**；旧 `--file` 数据留档为 `surface-measurements-file-channel.json`，
只作为通道差异证据（55 读面 13,310 vs 18,904 行，1.42 倍）。

---

## 2. 账号级基线（`npx wrangler d1 info <db> --json`，近 24h，不消耗行读）

| 库 | 大小 | 行读/日 | 读查询/日 | 行/查询 | 行写/日 |
|---|---|---|---|---|---|
| **whl（本仓）** | 561 KB | **1,428,496** | **8,205** | **174** | 2,335 |
| whl-club（俱乐部平台） | 29.1 MB | 768,098 | 7,227 | 106 | 66,703 |
| whl-auth（认证中心） | 340 KB | 5,733 | 908 | 6 | 455 |
| whl-guess（竞猜） | 262 KB | 481 | — | — | 0 |
| **账号合计** | ~30 MB | **≈ 2,202,808** | ≈ 16,340 | 135 | ≈ 69,493 |

- 免费档：**行读 5,000,000/日、行写 100,000/日，UTC 00:00 复位**；存储 5GB 按账号合计。
  ⇒ 账号读量已用 **44%**，本仓一家占 **65%**。
- **写配额对本仓不构成约束**（2,335 行/日 vs 10 万）。⇒ 加索引几乎零写成本，
  「索引要按写配额分天建」的顾虑在本仓**不成立**（这点与 club 相反，club 写 6.6 万/日、索引要排队）。
- 08:50Z 与 15:43Z 两次采样：whl 1,359,490 → 1,428,496（+69,006 行/7h ≈ **约 9,900 行/小时**）。
- 口径提醒：`d1 info` 是**每库**统计；免费档文档写的是**账号**额度。09-21 club 报错措辞是
  `Your account has exceeded…`（account 不是 database）。**若确为账号级**，则 09-21 那天
  club 4.35M + 本仓 1.36M 已越过 5M。此点建议向 Cloudflare 账单/文档再确认一次，报告里按「账号级」保守处理。

---

## 3. 全站读面普查（55 个读面 / 189 条语句 / 18,904 行读 · 单次冷路径 · **桩行模式**）

> 本节数字来自**桩行模式**（假 D1 每次查询恒回 1 行）。对固定条数的语句准确，
> 对**扇出型**读面（先查一批、再逐行/逐阶段各发一次查询）会系统性低估——
> `feed` 低报 2.7 倍、`match-lineup-stats` 低报 108 倍，`match-report` 反过来高报 20 倍。
> **实放复测见 §3.5**，引用扇出型读面的数字时以 §3.5 为准。

样本 id 取自当时线上：tournament=1（S9 顶级联赛）、阶段=1（132 场）、待打场次=284、已结束场次=182、球队=1、伤停=1。

### 3.1 按层次汇总

| 层次 | 读面数 | 行读 | 占比 |
|---|---|---|---|
| 公开面（`/api/public/*`） | 21 | 11,442 | 60.5% |
| 管理面（`/api/admin/*`） | 21 | 4,492 | 23.8% |
| 教练面（`/api/coach/*`） | 7 | 2,341 | 12.4% |
| cron（名册同步 / 账号对账） | 2 | 624 | 3.3% |
| 互动面 / 机器通道 / health | 3 | 5 | 0.03% |

### 3.2 读面排行（前 20，全量见 `surface-measurements.json`）

| 行读 | 语句数 | 读面 | 备注 |
|---|---|---|---|
| 2,392 | 18 | `public/feed?limit=20` | 语句数最多；KV SWR 之上还有边缘缓存。**桩行低估扇出 ⇒ 实放 6,777 行，见 §3.5** |
| 1,949 | 8 | `public/toplists` | 含全量停赛重放 `computeSuspensions` + 748 行的「事件明细（双 join 球员/助攻）」 |
| 1,531 | 7 | `public/stats` | 最贵表 `match_event` |
| 1,402 | 7 | `public/match-report` | 战报射手聚合。**桩行高报（走了更重的分支）⇒ 实放 65 行，见 §3.5** |
| 1,342 | 2 | `admin/injury-candidates` | **单条语句最贵**；`OR` 作用在 join 列上 ⇒ 全表扫 |
| 1,192 | 1 | `public/upcoming` | **单条语句第二贵**；返回 8 行却读 1,192 行 |
| 1,020 | 8 | `coach/me-status` | 含 `LIMIT 1` 读 755 行那条 |
| 876 | 4 | `public/tournament-summary` | `LIMIT 4` 读 808 行 |
| 800 | 2 | `admin/tournament-matches` | 132 场 × 5 ≈ 660，属「返回 132 行」的固有成本 |
| 787 | 3 | `coach/me-matches` | 同款 `OR` 模式 |
| 668 | 2 | `admin/teams` | 逐行两个相关子查询（人数 + 参赛数） |
| 590 | 2 | `cron-roster-sync` | 全表读 `player`(570) + `team`(20)，每小时一次 |
| 464 / 462 | 3 / 4 | `admin/injuries` / `public/injuries` | `injury_miss` 展开 |
| 456 | 9 | `public/round` | 轮次综述 |
| 420 / 419 | 6 / 4 | `admin/tournament` / `public/tournament` | 参赛队 + 队内人数相关子查询（各 391） |
| 384 | 11 | `coach/proxy-board` | 语句数第二多 |
| 341 | 2 | `admin/injury-events` | |
| 175 / 175 | 5 / 6 | `public/standings` / `admin/tournament-standings` | |
| 其余 35 个读面 | | 均 ≤ 158 行 | 见 JSON |

### 3.3 五个「转发认证中心」面（本仓花费为 0）

`admin/org-settings`、`admin/accounts`、`admin/accounts/catalog`、`admin/audit`、`admin/signup-codes`
经 `worker/lib/authAdmin.ts` 的 `machineCall` 走 HMAC HTTP 转给认证中心（账号真源 2026-09-14 起收口 auth）。
探针环境下回 502（连不上 auth），**在本仓 whl 库的花费只有 `attachUser` 的 1 条会话查询**
（该查询在探针下读数 0，见 §1 边界）；它们的真实读负载记在 `whl-auth` 上（该库 908 读查询/日、5,733 行/日，确实很轻）。

### 3.4 已知取样偏差

- `admin/match-events` 读 0 行：抽样场次 284 是 pending、本身没有事件 ⇒ 读量 0 属取样偏差，不是端点便宜。
- `health` 真实 0 语句（`worker/index.ts:26` 只回 `{ok,ts}`，不碰 D1）。
- `internal/team-upsert` 1 行：机器通道按 `POST|/api/internal/team-upsert|ts|body` 自签，
  签名含秒级时间戳、验签窗口 ±300s ⇒ 必须在**发请求那一刻**才算（否则 403 `bad_signature`）。
- cron 两段用假 D1 直接调 `runRosterSync(env)` / `runAccountMirror(env)`：**写被登记但不执行**，
  不会真落库；`cron-roster-sync` 日志 `[sync-rosters] 队 20 / 快照 30 人：新增 30、换队 0、改名 0、改号 0、删除 1/1、保留 0`（读路径完整、31 条写被跳过）。

### 3.5 实放复测：桩行普查对**扇出型**读面会系统性低估（新增，2026-09-24）

§3 的 18,904 行来自「桩行模式」——假 D1 的 `all()` 恒回 **1 行**（`harness.mts` 桩行模式），
于是所有「先查一批、再对每一行/每个阶段各发一次查询」的扇出循环在探针里**只跑一次**。
为量化这个偏差，给 `harness.mts` 增加了 `mode: "live"`：把语句内联参数后**实放打生产、回真实数据行**，
让应用用真实数据跑真实扇出，同时记录 `meta.rows_read`（仍是只读：写语句只记账不执行）。
复测脚本 `measure-live.mts`，结果写 `live-measurements.json`。

| 读面 | 桩行 | 实放 | 倍率 | 偏差机制 |
|---|---|---|---|---|
| `public/feed`（首页形状 `limit=15`） | 2,392 | **6,464** | **2.70×** | 扇出低估：11 条轮次综述、11 次轮次完赛名单、11 次轮次伤情在桩行下各只跑 1 次 |
| `public/feed`（`?limit=20`） | 2,392 | 6,777 | 2.83× | 同上（窗口 60 场、cap 20） |
| `public/match-lineup-stats` | 7 | **754** | **107.7×** | 扇出低估：桩行只回 1 行，真实回多行 |
| `public/match-report` | 1,402 | **65** | **0.05×** | **反向**：桩行 `stage_kind='probe'` 让路由走进了比真实数据更重的分支 |
| `coach/me-status` | 1,020 | 903 | 0.89× | 反向：桩行 `status='finished'` 让部分前置分支提前退出 |
| `public/tournament-summary` | 876 | 918 | 1.05× | 基本一致 |
| `coach/me-matches` | 787 | 820 | 1.04× | 基本一致 |
| `public/tournament-matches` | 48 | 46 | 0.96× | 基本一致 |
| `public/toplists` | 1,949 | 1,949 | 1.00× | 无扇出，桩行准确 |
| `public/stats` | 1,531 | 1,531 | 1.00× | 同上 |
| `admin/injury-candidates` | 1,342 | 1,342 | 1.00× | 单条语句，准确 |
| `public/upcoming` | 1,192 | 1,192 | 1.00× | 单条语句，准确 |
| `admin/tournament-matches` | 800 | 800 | 1.00× | 单条语句，准确 |

两条结论：

1. **桩行普查对「固定条数的语句」是准确的**（toplists / stats / injury-candidates / upcoming / tournament-matches
   全部 1.00×）⇒ §4 的表归因与形状单价依然成立，可以直接用。
2. **桩行普查对「扇出型」读面不可用**：`feed` 低报 2.7 倍，`match-lineup-stats` 低报 108 倍；
   而 `match-report` 反过来高报 20 倍（桩行值选了另一条分支）。
   ⇒ 引用**扇出型**读面的数字时，以本节的实放读数为准。

**修正后的全站单次冷路径合计**：18,904 行（桩行）→ **≈22,655 行**（把上表的差值代回：
feed +4,385、match-lineup-stats +747、match-report −1,337、me-status −117、tournament-summary +42、
me-matches +33、tournament-matches −2）。**最贵读面从 `public/toplists` 变成 `public/feed`（6,777 行）**。

`public/feed` 的实放拆解（`limit=15`，6,464 行 / 44 条语句）：
`finishedList`（7 表 join）16 次 / 2,267 行、`fetchEventRows` 5 次 / 1,718 行、
`injuryFacts` 12 次 / 982 行、`recapP` 1 次 / 665 行、`stageMaxRounds` 2 次 / 446 行、
`standingsSnapshot` 3 次 / 220 行、`standings` 3 次 / 122 行、红牌 3 行、改判 audit 41 行。

---

## 4. 表归因与形状排行（`shape-ranking.json`）

### 4.1 归因到驱动表

| 表 | 行读 | 语句数 | 占比 |
|---|---|---|---|
| **match** | **10,826** | 45 | **57.3%** |
| **match_event** | **3,337** | 23 | **17.7%** |
| **player** | **2,203** | 7 | **11.7%** |
| injury_miss | 1,079 | 10 | 5.7% |
| injury | 640 | 6 | 3.4% |
| account | 249 | 5 | 1.3% |
| standing | 185 | 5 | 1.0% |
| entry | 164 | 7 | 0.9% |
| audit_log | 49 | 2 | 0.3% |
| lineup_proxy_grant | 46 | 3 | 0.2% |
| stage | 35 | 7 | 0.2% |
| team | 23 | 4 | 0.1% |
| team_binding | 20 | 7 | 0.1% |
| user | 17 | 1 | 0.1% |
| 无表可归因（如 `SELECT 1 AS ok`） | 31 | — | 0.2% |

⇒ **`match` + `match_event` + `player` = 16,366 / 18,904 = 86.6%**。而这三张表只有 218 / 241 / 570 行数据。

### 4.2 最贵形状（`rows_read` 是**跨读面累加值**，`calls` 是出现次数 ⇒ **单价 = rows ÷ calls**）

| 单价 | 出现 | 形状要点 |
|---|---|---|
| 1,342 | ×1 | `admin/injury-candidates`：`WHERE e1.team_id = ? OR e2.team_id = ?`（`OR` 作用在 join 出来的列上）⇒ `SCAN m USING INDEX idx_match_stage` 全表 218 场 × 7 表 |
| 1,192 | ×1 | `public/upcoming`：七表 join + `ORDER BY CASE t.status…, t.id, s.sort_order, m.round, m.slot LIMIT 8` ⇒ 149 场 pending 全量 join 后再 LIMIT |
| 808 | ×1 | `public/tournament-summary`：`WHERE s.tournament_id=? AND m.status='pending' … LIMIT 4` ⇒ `idx_match_status(status=?)` 起手 + 排序全部 pending |
| 800 | ×1 | `admin/tournament-matches`：`idx_stage_tournament` + `idx_match_stage` 走对了，132 场 × 5 是「返回 132 行」的固有成本 |
| 794 | ×1 | `public/match-report` 射手聚合：`idx_match_event_type_time(type=?)` + `GROUP BY` |
| 785 | ×1 | `coach/me-matches`：同款 `OR` 模式 |
| 755 | ×1 | `coach/me-status`：`SELECT t.id … WHERE m.status='pending' … (he.team_id=? OR ae.team_id=?) ORDER BY … LIMIT 1` ⇒ **`LIMIT 1` 读 755 行** |
| 748 | ×1 | `public/toplists` 事件明细：`player` + `assist_player` 双 join（每事件多 2 行读） |
| 668 | ×1 | `admin/teams`：逐行两个相关子查询（`p.team_id = t.id` 人数 + 参赛数） |
| 665 | ×1 | `feed` 取各阶段最后完赛：`GROUP BY m.stage_id, m.round HAVING …` ⇒ **`SCAN m USING INDEX idx_match_stage`（真全索引扫）** |
| 570 | ×1 | `cron-roster-sync`：`SELECT id, team_id, name, number FROM player`（整表，每小时一次） |
| 487 | ×1 | `public/feed` 场次列表（`match` + 4 表 join） |
| 432 | ×1 | 黄牌且无 `red_2y` 的 `NOT EXISTS (SELECT 1 FROM match_event r …)` 相关子查询 |
| 420 | ×1 | 事件类型计数 `GROUP BY me.type` |
| 391 | ×2 | 参赛队 + 队内人数：`(SELECT COUNT(*) FROM player p WHERE p.team_id = e.team_id)`（`public/tournament`、`admin/tournament`） |
| 341 | ×1 | `admin/injury-events` |
| 289 | ×2 | `SELECT m.id, m.round, m.score_home, m.score_away, he.team_id…`（`public/toplists`、`public/stats`） |
| 267 | ×1 | 待打场次列表（`match` ctx 形态，`public/toplists`） |
| 240 | ×3 | `injury_miss` 展开：`SCAN im USING COVERING INDEX sqlite_autoindex_injury_miss_1` + TEMP B-TREE |
| 133 | ×5 | `SELECT stage_id, MAX(round) AS mr FROM match WHERE stage_id IN (?) GROUP BY stage_id` ⇒ `COVERING INDEX idx_match_stage`，线性（非病态） |
| 133 | ×5 | 阶段完赛场比分列表（`idx_match_stage`） |
| 61 | ×3 | `SELECT id, name, number FROM player WHERE team_id = ? ORDER BY …`（`coach/proxy-board`、`coach/me-team`、`admin/team`） |
| 58 | ×4 | `account LEFT JOIN team`（`coach/proxy-board`、`admin/proxy-grants`、`coach/proxy-sessions`、`admin/rosters-context`） |

**两处真正的 `SCAN`（全索引扫）**：① `feed` 取各阶段最后完赛（665 行）；② `injury_miss` 展开（240/次 × 3 读面）。
**主导模式**是 `SEARCH m USING INDEX idx_match_status (status=?)` + 若干 rowid 点查 + `USE TEMP B-TREE FOR ORDER BY`
——即「先用状态索引捞出全部 pending，再排序，最后才 LIMIT」。

### 4.3 关键分布（解释最贵形状）

- `match` 状态：**pending 149 / finished 69 / live 0**（合计 218）。
  ⇒ `public/upcoming` 的 1,192 行 = **149 场 pending × (1 + 7 张 join 表)**，`LIMIT 8` 在 join 之后才生效。
- `injury` 28 行、`injury_miss` 48 行、`player` 570 行、`team` 20 行、`entry` 40 行、`audit_log` 496 行。
- 核对：`SELECT count(*) FROM player` 读数 = **570**，与表行数一致 ⇒ 读数确实是物理行数。

---

## 5. 成本模型（实测，`cost-model.json`）

### 5.1 排序键决定 136 倍差距（同表、同 `LIMIT 4`）

| 形状 | 行读 |
|---|---|
| `WHERE status='finished' ORDER BY finished_at DESC LIMIT 4` | **1**（覆盖索引直接取） |
| `WHERE status='finished' ORDER BY round DESC LIMIT 4` | **136**（temp b-tree 排序全部 69 场） |

⇒ **`LIMIT` 不省读，省读的是「排序列有索引且与 `ORDER BY` 表达式逐字一致」。**

### 5.2 其它实测

| 形状 | 行读 |
|---|---|
| `SELECT id FROM match WHERE status='pending'`（返回 149） | 149 |
| `SELECT id FROM match`（返回 218） | 218 |
| `SELECT COUNT(*) FROM player`（返回 1） | 570（整表扫） |
| 8 个主键点查 | 16（2 行/点查） |
| 8 主键 + 1 表 join | 24（3 行/点查） |
| 8 主键 + 4 表 join | 48（6 行/点查） |
| 4 表 join + 排序（48 行表） | 193 |

⇒ 点查单价 = `1 + join 表数` 行；**join 每多一张表，每行多 1 行读**。这解释了为什么「七表 join 的 upcoming」
在 149 行数据上要读 1,192 行。

### 5.3 双通道对拍（`--command` vs `--file`）

8 条最贵形状两通道差 1–24%（`upcoming` 1.01×、`injury-candidates` 1.01×、`admin/tournament-matches` 1.20×、
`injury_miss` 1.24×），**只有单表索引扫描被 `--file` 低报成 1**。
⇒ join 类查询两通道可比，单表扫描必须用 `--command`。

---

## 6. 写端点的读（16 面 / 56 条 SELECT / 648 行读 · `write-path-measurements.json`）

假 D1 只记录不执行 ⇒ **写语句全部只登记、绝不落库**（本表行读只含写端点发出的 SELECT）。

| 行读 | SELECT | 跳过写 | 写面 |
|---|---|---|---|
| **284** | 6 | 4 | `POST /api/admin/matches/:id/finish`（终场 + 重算 + 晋级） |
| **284** | 6 | 4 | 同上（弃权变体，同一代码路径） |
| 28 | 5 | 0 | `POST /api/admin/tournaments/:id/entries/bulk` |
| 19 | 5 | 0 | `PUT /api/coach/matches/:mid/lineup` |
| 6 | 6 | 2 | `PUT /api/admin/matches/:id/events/:eventId` |
| 5 | 4 | 2 | `POST /api/admin/matches/:id/events`（录事件） |
| 5 | 4 | 2 | `DELETE /api/admin/matches/:id/events/:eventId` |
| 5 | 3 | 0 | `PUT /api/admin/injuries/:id` |
| 3 | 2 | 2 | `POST /api/admin/matches/:id/start` |
| 2 | 2 | 2 | `DELETE /api/admin/injuries/:id` |
| 2 | 2 | 0 | `POST /api/coach/tactics` |
| 2 | 3 | 1 | `POST /api/interact/matches/:mid/motm` |
| 1 | 3 | 0 | `POST /api/admin/injuries` |
| 1 | 2 | 1 | `POST /api/admin/tournaments/:id/transition` |
| 1 | 2 | 0 | `POST /api/admin/teams` |
| 0 | 1 | 1 | `PATCH /api/admin/teams/:id` |

**终场为什么 284 行**（逐条实测）：会话 0 + `loadMatchCtx` 三表 join 3 + `SELECT kind FROM stage WHERE id=?` 1
+ `SELECT e.id, e.group_id, e.points_deducted FROM entry e WHERE e.tournament_id = (SELECT tournament_id FROM stage WHERE id=?)` **14**
+ `SELECT … FROM match WHERE stage_id = ? AND status = 'finished'` **133**
+ `SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status != 'finished'` **133**
⇒ **每次报分都把该阶段的比赛读两遍**（同一批 132 场，一次取完赛场明细、一次只为了数未完赛场）。
132 场的比赛日全部报分 ≈ 132 × 284 ≈ **3.8 万行/日**，相对 143 万是 2.6%。

**结论**：写端点不是日常读量的主因。284 行里约 133 行是「重算积分榜必须读全部已完赛场」的固有成本，
剩下 133 行（只为一个计数而重扫整阶段）是**可以合并掉**的（一次阶段扫描同时得出已完赛明细与是否全部完赛）。

**桩行导致的提前退出（已登记为偏差，不影响结论）**：`admin/injury-post` 在「该事件已建过登记」处 409、
`admin/team-post` 在「id 已占用」处 409、`coach/lineup-put` 在「队内球员数 ≠ 11」处 400——
桩行恒有数据造成的，量到的是它们的前置读。

---

## 7. 日常读量从哪来：轮询 × TTL

### 7.1 前端轮询（`setInterval`）

| 页面 | 间隔 | 打的端点 | 单次冷成本 |
|---|---|---|---|
| `src/pages/Home.tsx:152` | **60s**（无 live 时降到 120s 兜底） | `tournaments` / `upcoming` / `live` / `announcement` / `feed` / `interact/reactions` | 48 + **644** + 11 + 2 + **4,315** + 2 = **5,022 行 / 34 条语句** |
| `src/pages/PublicTournament.tsx:163` | **60s**（仅本赛事有 live 时才轮询） | 每个可见轮次 `tournaments/:tid/matches?stageId&round`（Promise.all 并发） | 46/轮次 |
| `src/pages/PublicMatchDetail.tsx:122` | **60s**（完赛后停止轮询） | 场次详情 + 阵容 | 51 + 5 |

⇒ 首页一次冷轮询占总读量的大头，60s 触发一次。

> **2026-09-24 更新（增量 38 步骤 13）**：三处轮询从 30s 统一降到 60s（`src/lib/polling.ts` 的 `POLL_MS`）。
> 选 60s 而不是更密：这些读面都走 `pubCache`，TTL 就是 60s，比 TTL 更密的轮询里必然有一部分落在
> 同一个缓存窗口内、拿到逐字相同的数据。选 60s 而不是 90s：一场球的比分最多晚一分钟出现是「直播」
> 还能接受的边界。
>
> **要说清楚降频省的是什么**：D1 行读由 TTL 决定，不由轮询频率决定——同一个缓存窗口里轮询两次，
> 第二次读 0 行。所以降频主要省的是 **Worker 请求数**（首页一轮 6 个请求）与边缘缓存回源次数
> （请求越多越容易打到没缓存的节点、触发重算），对 D1 行读是二阶影响。真正把行读降下来的是
> 步骤 6–9 的 SQL 与 TTL 改动。

### 7.2 TTL 窗口容量（「每个 TTL 窗口都有请求」时的上限）

> 下表是**治理前**的容量；治理后（步骤 9 把 `portal/feed` 与 `public/upcoming` 拉到 300s、
> 并把两者的单价降下来）合计上限从 14,488,416 降到 **≈ 4,350,528 行/日**，见「治理后复测」节。

| 读面 | 单价 | TTL | 窗口数/日 | 上限行读/日 |
|---|---|---|---|---|
| `portal/feed` | **6,464**（实放，§3.5） | 60s（+KV SWR 60s） | 1,440 | **9,308,160** |
| `portal/matches/:mid/report` | 65（实放，§3.5） | 60s | 1,440 | 93,600 |
| `public/upcoming` | 1,192 | 60s | 1,440 | **1,716,480** |
| `public/tournament-summary` | 918（实放） | 60s | 1,440 | **1,321,920** |
| `public/toplists` | 1,949 | 300s | 288 | 561,312 |
| `public/stats` | 1,531 | 300s | 288 | 440,928 |
| `public/tournament-rounds` | 158 | 60s | 1,440 | 227,520 |
| `public/recent` | 96 | 60s | 1,440 | 138,240 |
| `public/injuries` | 462 | 300s | 288 | 133,056 |
| `portal/round` | 456 | 300s | 288 | 131,328 |
| `public/tournament` | 419 | 300s | 288 | 120,672 |
| 其余 10 个公开面 | | | | ≈ 295,200 |
| **公开面合计上限（21 个）** | | | | **14,488,416** |

- 单价一律取实放读数（扇出型读面按 §3.5 修正：feed 6,464、match-report 65、tournament-summary 918）。
- 当前实到 1,428,496 行/日 = 上限的 **9.9%**（公开面之外还有管理面/教练面/写端点/cron 的贡献）。
- **上限是账号 500 万池的 2.9 倍** ⇒ 若流量增长或出现「全天连续有访客」的窗口，账号会先于功能受限。
  club 已在 09-21 炸过一次（4,350,235 行），本仓当天同时占 1.36M。
- **单看 `portal/feed` 一项，上限就是 930 万行/日 = 账号池的 1.86 倍** ⇒ 只要 feed 的
  「每 60s 必有一次请求」成立，光它一个端点就能吃光整个账号的日读配额。
- 反过来看这是好消息：**单价降一半，上限就降一半**，不需要改架构——治理就是按这句话做的。

### 7.3 缓存现状（治理时的边界条件）

- `worker/lib/cache.ts`（25 行）`pubCache(ttl)` 用 `caches.default`：非 GET 直通、命中即返、
  只有 `c.res.ok` 才设 `Cache-Control: public, max-age=N` 并 `waitUntil(cache.put(...))`。
- **无项目级 purge 机制**（`caches.default` 多 isolate 共享、按完整 URL 作 key）⇒ 改 TTL 是安全动作，
  「写后立即失效」不是现成能力。
- `portal/feed` 另有一层 KV SWR（key `swr:feed:v2:{limit}:{before}`，治理后 `expirationTtl 1800`，
  300s 内直出、过期先回旧值再后台重算）⇒ feed 的重算频率被压到「至多每 300s 一次」，
  单价也从 6,464 行降到 4,315（首页形状）——**它是全站最贵的单次重算，但已不再是账号级风险**。
- 管理端全部未缓存；无内存缓存；无会话缓存（`PERF_PLAN.md` 明确不做：角色变更/封禁要立刻生效）。

---

## 8. A/B 改写对照（`rewrite-ab.json`，全部实测）

| # | 候选 | 改前 | 改后 | 变化 | 结论 |
|---|---|---|---|---|---|
| 1 | 伤停候选：`WHERE e1.team_id=? OR e2.team_id=?` → `WHERE m.home_entry_id IN (SELECT id FROM entry WHERE team_id=?) OR m.away_entry_id IN (…)` | 1,326 | **140** | **−89.4%** | 计划从 `SCAN m USING INDEX idx_match_stage` 变为 `MULTI-INDEX OR` + `idx_match_home`/`idx_match_away`。NULL 语义等价（away 为空时 `NULL IN (…)` 不为真，同 LEFT JOIN 效果）。**最大单笔可修浪费** |
| 2 | `upcoming` 两段式（先取 id 三表，名字另取） | 1,185 | **589** | **−50.3%** | 第二段实测 8 场取队名 = 6 行 ⇒ 合计 ≈ 595 |
| 3 | `tournament-summary` 两段式 | 805 | **397** | **−50.7%** | |
| 4 | 参赛队 + 队内人数（改由 `player` 分组驱动） | 380 | **639** | **+68.2%** | **不要改**——`player` 全表分组要 SCAN 570 行。反直觉，必须靠读数定 |
| 5 | `feed` 取各阶段最后完赛（改由 `status='finished'` 驱动 `idx_match_status`） | 655 | **140** | **−78.6%** | 替掉 `idx_match_stage` 全扫 |
| 6 | 排序键探针（同表同 LIMIT 4） | 136 | **1** | −99% | 见 §5.1 |

⇒ 同一模式的 `OR` 改写还出现在 `worker/routes/coach.ts:160`（me-matches）、`worker/routes/coach.ts:249`
（me-status，LIMIT 1 读 755 行）、`worker/routes/public.ts:688`、`worker/routes/public.ts:855`。

### 8.1 `public/feed` 瘦身套餐（实放基线 6,464 行 → 预估 **3,924 行，−39%**；实测见「治理后复测」节）

> **落地后的实测**：limit=16（首页形状）6,521 → **4,315**（−33.8%）；limit=20 6,777 → **4,694**；
> limit=30（列表页形状）7,016 → **4,957**；语句数 44 → 26（limit=16）。
> 与预估 3,924 的差额来自：第 2 项的等价改写只能到 407（而非 142，因为不能丢掉 `HAVING` 的整轮判定），
> 第 5 项按实测 −15.1%（而非按同型估的 −29%），且第 1 项的截断量随数据分布变化。

`feed` 是全站最贵的单次重算（实放 6,464 行 / 44 条语句，§3.5），下面五项**全部实测过**。
前三项互不依赖，可分别落地。

| # | 手段 | 省 | 机制与安全性 |
|---|---|---|---|
| 1 | **轮次综述按 cap 截断** | **−1,626** | `worker/lib/feedNews.ts:654` 的综述后置块现在对 `recapP` 的**全部 11 轮**各发一次 `fetchRoundFinished` + 一次 `injuriesInRound`（11 对，实测 1,081 + 893 行）。最终输出是 `items.sort(at desc).slice(0, cap)`（`:1054`/`:1060`），窗口已提供 `max(cap*3,40)=45` 条带 `at` 的条目 ⇒ **任何 `at` 早于窗口第 cap 条（`window[cap-1].finishedAt`）的条目都不可能进入前 cap**。按 `last_at >= window[cap-1].finishedAt` 过滤后只剩 2 轮（`limit=15` 时 cutoff = `2026-09-15T10:08`），9 轮可跳过。**纯 JS 过滤，不加往返、不改 SQL** |
| 2 | **`recapP` 改由 `status='finished'` 驱动** | **−523** | 现在 `GROUP BY m.stage_id, m.round HAVING …` 走 `SCAN m USING INDEX idx_match_stage`（真全索引扫，665 行，§4.2）。改写后 665 → ≈142（§8 #5 实测 655 → 140） |
| 3 | **`fetchStageMaxRounds` 请求内记忆化** | **−223** | `worker/lib/context.ts:472`。实放里被调 2 次，参数分别是 `[6,2,1]` 与 `[2,1,6]` —— **同一集合、顺序不同**，各 223 行。按 `ids.slice().sort()` 作 key 记忆化即可（波 1 的窗口阶段集与综述阶段集在这一天完全重合） |
| 4 | **`fetchRoundFinished` 强制 `INDEXED BY idx_match_stage`** | **−122** | `worker/lib/context.ts:132`。规划器偏好 `idx_match_status(status=?)`（反向扫正好满足 `ORDER BY finished_at DESC`），代价是单轮 6 场也要扫全部 69 场完赛；11 轮合计 1,081 → 393（**−64%**，§8.1 实测）。`limit=15` 只剩 2 轮 ⇒ 192 → ≈70 |
| 5 | **`injuriesInRound` 预筛 `me.match_id IN (该轮场次 id)`** | **−46** | `worker/lib/injury.ts:411`。现在按 `type=?` 扫全部 28 条伤情事件（11 轮 893 → 632，**−29%**）；`limit=15` 只剩 2 轮 ⇒ 156 → ≈110 |

合计 **−2,540 行 ⇒ 6,464 → 3,924 行（−39.3%）**。

叠加 TTL 后（`pubCache(60)` 与 KV SWR 的 60s 新鲜度一并放宽到 300s）：

| 状态 | 每次重算 | 窗口数/日 | 上限行读/日 | 相对账号 500 万池 |
|---|---|---|---|---|
| 现在 | 6,464 | 1,440 | 9,308,160 | **1.86 倍** |
| 只做代码瘦身 | 3,924 | 1,440 | 5,650,560 | 1.13 倍 |
| 代码瘦身 + TTL 300s | 3,924 | 288 | **1,130,112** | **0.23 倍** |

⇒ **组合起来上限降 88%**（930 万 → 113 万行/日），且全部是「改 SQL + 改 TTL」，不动任何接口契约。
TTL 放宽的代价：待打比赛列表与 feed 最长 5 分钟陈旧——首页本身有 60s 轮询，但缓存会把实际刷新压到 5 分钟，
**这是产品口径决定，需要确认可接受**（比赛中直播比分的 `live`/`match` 面仍保持 60s，不受影响）。

### 8.2 未做的 feed 候选（成本高或需产品决策）

- `buildNarrativeFacts`（`worker/lib/feedNews.ts:296`）对窗口涉及的**每个赛事**都拉该赛事全部完赛场次
  （`fetchTournamentFinished`，实测 234/239/289 行 × 3 个赛事）再拉全部事件行（`fetchEventRows` 合计 1,718 行），
  只为算射手榜叙事。**这是 feed 里第二贵的一块（约 1,770 行）**，但它属「摘要里要不要放赛事叙事」的产品决策，
  且叙事条目是否进入前 15 取决于数据分布，不宜在量化阶段拍定。
- `fetchEventRows` 的 90 一批拆分（`worker/lib/context.ts:180`）本身没问题。

---

## 9. 候选清单（本节是**治理前**的候选与预估；实际落地结果见「治理后复测」节）

> **实施结果（增量 38 步骤 6–9）**：A 档 7 条已落地（feed 五项 + 伤停候选 + upcoming + summary + coach 两条 + TTL 两条），
> 实测合计 **−44.2%**；`feed` 最后完赛轮次一条并入 feed 套餐的 6.2；
> **终场合并阶段扫描删项**（A/B 实测 265 vs 现状 266，只省 1 行，不值得动正确性关键的晋级闸门）；
> B 档 4 条全部未做（需契约或前端配合）；C 档 5 条全部不做（加索引记成条件性豁免）。

### A 档 · 零写成本、不动契约（改 SQL / 改 TTL）

| 候选 | 收益（单次冷） | 位置 | 落地 |
|---|---|---|---|
| **`public/feed` 瘦身套餐（五项，见 §8.1）** | 预估 −2,540 行（6,464 → 3,924，−39%）；**实测 6,521 → 4,315（limit=16）** | `worker/lib/feedNews.ts`、`worker/lib/context.ts`、`worker/lib/injury.ts` | ✅ 步骤 6 |
| 伤停候选 `OR` → `IN (SELECT …)` 改写 | 预估 −1,186 行（−89%）；**实测 1,342 → 156（−88.4%）** | `worker/lib/injury.ts` `listTeamMissCandidates` | ✅ 8.1 |
| `upcoming` 两段式 | 预估 −596 行（−50%）；**实测 1,192 → 644（−46%）** | `worker/routes/public.ts` `/upcoming` | ✅ 8.2 |
| `feed` 最后完赛轮次改由 `status` 驱动 | −523 行（−79%） | `worker/lib/feedNews.ts` recapP | ✅ 并入 6.2（等价子查询 665 → 407） |
| `tournament-summary` 两段式 | 预估 −408 行（−51%）；**实测 876 → 542（−38%）** | `worker/routes/public.ts` `/tournaments/:id/matches/summary` | ✅ 8.3 |
| `coach/me-status` / `me-matches` 同款 `OR` 改写 | **实测 −75.5% / −70.1%（1,020 → 349 / 787 → 302）** | `worker/routes/coach.ts` `/me/status`、`/me/matches` | ✅ 8.4 |
| 终场重算合并为一次阶段扫描 | 预估 −133 行/次 | `worker/lib/standings.ts` `buildStandingsStmts` | ❌ **删项**（A/B：265 vs 266） |
| `feed` 的 TTL 60s → 300s（含 KV SWR 新鲜度） | 窗口数 1,440 → 288，上限再降 5 倍 | `worker/routes/portal.ts` `/feed` | ✅ 步骤 9 |
| `upcoming` 的 TTL 60s → 更长 | 直接按倍数砍窗口数 | `worker/routes/public.ts` `/upcoming` | ✅ 步骤 9 |

### B 档 · 需改契约或前端配合

| 候选 | 说明 |
|---|---|
| 首页轮询降频 / 合并（`Home.tsx:152` 60s × 6 端点） | **已做（步骤 13，30s → 60s）**；无 live 时已降 120s，可把 `upcoming` 也纳入慢刷 |
| `feed` 叙事块（赛事射手榜） | `buildNarrativeFacts`（`worker/lib/feedNews.ts:296`）按赛事拉全部完赛场次 + 全部事件行，约 1,770 行（§8.2）。属产品决策，不是纯技术优化 |
| 公开面加「按赛事分片」的缓存键 | 现在 key = 完整 URL，`upcoming` 是全站共享单键（好），但 `stats`/`toplists` 每赛事各一份 |
| 停赛重放 `computeSuspensions` 的增量维护 | 现在 `public/toplists` 每次冷重算都全量重放 |

### C 档 · 不建议做（实测更贵或收益不足）

| 候选 | 原因 |
|---|---|
| 参赛队 + 队内人数改分组驱动 | 赛事页版 **+68.2%**（§8 #4：380 → 639）；管理端版（`admin/teams`，全部 20 队）补测 **+12%**（668 → 748）。同型的 `admin/tournament`(420)/`public/tournament`(419) 里那 391 行人数子查询同理 |
| 为「返回 132 行」的 `admin/tournament-matches` 做索引优化 | 已走对索引，132×5 是固有成本 |
| 终场重算里的 133 行「已完赛场明细」 | 重算积分榜必须读全部已完赛场，属固有成本（可省的只有另一次纯计数扫描） |
| `MAX(round) GROUP BY stage_id` 优化 | `COVERING INDEX`，133/次线性 |
| 加索引 | **外键与常用列都已有索引**（`idx_match_status`、`idx_match_stage(stage_id,round,slot)`、`idx_match_home/away`、`idx_match_event_type_time`、`idx_player_team`、`idx_entry_tournament`…），贵的形状不是缺索引造成的 |

### C 档的机制小结：同一改写，收益取决于「子查询实际碰了多少行」

上面第一条是唯一一条**看起来与 A 档同型、实测却相反**的改写，值得单独记下分水岭：

- **赛事页版**（12 支参赛队驱动）：相关子查询只碰该赛事的 entry + 对应球队的 player，
  走 `idx_player_team` 覆盖索引点查共约 380 行；改成 `GROUP BY team_id` 必须 `SCAN player` 570 行 ⇒ **亏 68%**。
- **管理端版**（全部 20 队驱动）：相关子查询本来就要碰几乎全表 player（约 560 行），
  与分组扫描 570 行基本等价，只是多付了物化开销 ⇒ 只**亏 12%**。

⇒ 结论是「这两处都别改」，但**判据不是「这个改写模式好不好」，而是「驱动集合占全表的比例」**。
子查询碰的行数远小于全表时，相关子查询赢；接近全表时，两者打平。任何改写都要先量，不能照搬模式。

补测数据（2026-09-24，`admin/teams`）：相关子查询 668 行读 / 20 行返回；单查询分组 join 748；
两段式（列表 20 + `player` 分组 570 + `entry` 分组 40）630 —— 虽省 5.7%，但多两次往返，
按 `PERF_PLAN.md` 的「每串行 D1 查询 ≈ +0.2s」口径不值得。

### 阈值口径的修正建议

club 的「单次 ≥10,000 行才治理」在本仓不适用（0 个读面达标）。建议本仓改用：

> **治理判据 = 单价 × 重算频率。** 单价 ≥1,000 行且 TTL ≤60s（即每日窗口数 ≥1,440）⇒ 上限 ≥1.44M/日，必做；
> 单价 ≥1,000 行但走 KV/长 TTL ⇒ 看实测频率再定；单价 <500 行 ⇒ 除非高频否则不动。

按此判据，A 档前四条（`upcoming`、`feed`、`summary`、`injury-candidates`）优先级最高；
其中 **`feed` 是唯一「单价 ≥6,000 且 TTL = 60s」的读面，上限 930 万行/日单独就超过账号整个池子**，
所以它是第一优先级（§8.1 已有五项实测过的瘦身手段）。

---

## 10. 复测口径

```bash
# 前置：生产 D1 读通道（不消耗行读）
npx wrangler d1 execute whl --remote --json --command "SELECT 1 AS ok"

# 账号级 24h 基线（不消耗行读）
npx wrangler d1 info whl --json

# 全站读面普查（约 13 分钟，写 surface-measurements.json）
npx vite-node scripts/d1-read-audit/measure-surface.mts
npx vite-node scripts/d1-read-audit/measure-surface.mts --only=feed   # 只复测名字含 feed 的（结果按名字合并回 JSON）
npx vite-node scripts/d1-read-audit/measure-surface.mts --no-cost --dump  # 只抓 SQL 不打生产

# 实放复测（扇出型读面必须用它，慢：每面 2–100s；结果写 live-measurements.json，按面名合并）
npx vite-node scripts/d1-read-audit/measure-live.mts --only=feed --limit=15 --dump
npx vite-node scripts/d1-read-audit/measure-live.mts --only=toplists,stats,injury-candidates,upcoming

# 治理后复测（只跑被改的 6 个面 + feed 的三种真实 limit；结果按面名合并进 live-measurements.json）
npx vite-node scripts/d1-read-audit/measure-live.mts --only=injury-candidates,upcoming,tournament-summary,me-status,me-matches
npx vite-node scripts/d1-read-audit/measure-live.mts --only=feed --limit=16
npx vite-node scripts/d1-read-audit/measure-live.mts --only=feed --limit=20
npx vite-node scripts/d1-read-audit/measure-live.mts --only=feed --limit=30

# 增量 39 复测（被改的三个面 + 基线里还没有的新端点；--extra 用 | 分隔多项）
npx vite-node scripts/d1-read-audit/measure-live.mts --only=match-h2h,lineup-stats,toplists --extra="public/home:/api/public/home?limit=16" --dump

# 写端点的读（约 7 分钟）
npx vite-node scripts/d1-read-audit/measure-writes.mts

# 形状归并 / 排行
npx vite-node scripts/d1-read-audit/rank-shapes.mts

# 形状与索引的执行计划、A/B 对照、成本阶梯
npx vite-node scripts/d1-read-audit/measure-shapes.mts
```

**复测注意**：
- `--only=` 的取值规则两个脚本不同：`measure-live.mts` 支持**逗号分隔多选**，`measure-surface.mts` 只接受**单个子串**
  （传 `--only=a,b` 会一个面都匹配不到、静默不跑）。
- 每个读面必须**独立进程**（同一进程内连跑，`caches.default` 桩与 KV 会在 isolate 内变热，读数被抹平）。
- 只执行 `SELECT`（`selectOnly`），写语句一律只登记。
- `internal/team-upsert` 的签名要在发请求那一刻算（±300s 窗口）。
- 单条语句一个 `--command`（`--file` 会把单表索引扫描低报成 1）。
- Windows 偶发 `exit 3221226505`：`runWrangler` 内置重试 3 次。

---

## 11. 未覆盖与已知缺口

1. **写端点的读只覆盖 16 个面**，且 3 个因桩行在守卫处停下（§6 末）。
   `POST /api/admin/rosters/sync-rosters` 未单列（其底层 `syncRosters` 已由 `cron-roster-sync` 量到 590 行）；
   `auth` / `oidc` 路由未量（账号真源在 `whl-auth`，本库花费很小）。
2. **重算频率（每日缓存窗口数）无法从外部实测**——本报告只给了单价与窗口上限，
   实到总额 1,428,496 行/日是**账号侧**读数。要精确定位「哪一天哪一面吃掉了配额」，需要
   D1 Analytics 的按查询分组数据（GraphQL）或自建采样表（本仓目前**完全没有**读消耗度量，
   这是最大的长期缺口：优化缺基线、事故前无预警）。
3. **账号级 vs 数据库级的额度归属**待确认（§2 末）。
4. 抽查样本单一：`tid=1`（S9 顶级联赛、132 场最多）与 `tid=2`（次级联赛、56 场）的成本未对照；
   换赛事/阶段只需改脚本里的样本 id 取法（已参数化）。
5. `admin/match-events` 因抽样场次无事件而读 0，需换一个已完赛且带事件的场次复测。
6. **实放复测覆盖 15 个读面**（`live-measurements.json` 共 20 条记录，含 feed 的 4 个 limit 形状），
   其余 40 个仍是桩行读数。已复测的覆盖了单价前 10 名。**两个已知不可用/待补的点**：
   - `coach/proxy-board` 实放 status=403（探针会话拿不到代打鉴权），读数 61 行不可信 ⇒ 该面仍按桩行 384 行看待。
   - `admin/injuries`(464)、`public/injuries`(462)、`public/round`(456→447) 已实放且与桩行一致 ⇒ 无扇出，桩行准确。
7. **治理后复测覆盖被改的 6 个面（增量 38）+ 3 个面与 2 个新端点（增量 39）**（全部实放）；未改面沿用治理前读数。
   要判断「治理后账号级日读总量降了多少」，需等治理版本部署后的 `npx wrangler d1 info whl --json` 实测
   （本仓当前**未部署**，交付纪律为不 push、不部署）。
8. **增量 39 新增的 `/api/public/home` 与 `/api/coach/bootstrap` 尚未写进普查基线**
   （`surface-measurements.json` 仍是增量 38 的 55 面），用 `measure-live.mts --extra=` 单独量。
   下次全量普查应收进去。

---

## 附：文件清单

| 文件 | 内容 |
|---|---|
| `harness.mts` | 度量基建：参数内联 / `selectOnly` / `runWrangler` / `queryMeta` / `queryRows` / `explainPlan` / `d1Info` / 假 D1 / 假 KV / `caches` 桩 / 会话桩 / `captureSurface` / `costOf` / `setValueHints` |
| `measure-surface.mts` | 55 个读面普查（含 2 个 cron、机器通道自签） |
| `measure-writes.mts` | 16 个写端点的读量普查 |
| `rank-shapes.mts` | 189 条语句归并为形状、按表归因 |
| `measure-shapes.mts` | 索引清单 / `EXPLAIN QUERY PLAN` / A/B 改写对照 / 双通道成本阶梯 |
| `measure-live.mts` | **实放复测**（`mode: "live"`：真数据跑真扇出，只读）——扇出型读面必用 |
| `smoke.mts` | 冒烟（3 个读面 + 一次 `costOf` + 一次 `EXPLAIN`） |
| `surface-measurements.json` | 读面普查原始数据（55 面 / 189 语句 / 18,904 行 · 桩行） |
| `live-measurements.json` | 实放复测原始数据（20 条记录 / 15 个面，含逐条 `rows_read` 与 `result_rows`） |
| `write-path-measurements.json` | 写面普查原始数据（16 面 / 56 语句 / 648 行） |
| `shape-ranking.json` | 形状排行（表归因 + Top 形状 + 读面榜） |
| `rewrite-ab.json` | 14 组 A/B 改写对照 |
| `cost-model.json` | 17 条双通道成本阶梯 |
| `surface-measurements-file-channel.json` | `--file` 通道旧数据（只作通道差异证据） |
