# WHL 赛事管理系统 · 测试计划

| 项目 | 内容 |
| --- | --- |
| 被检应用 | `whl-tournament`（Cloudflare Worker + React SPA 同仓同部署） |
| 应用版本 | v5.0.3（`package.json.version`，页脚显示同值） |
| 文档版本 | v1（首版，全量盘点） |
| 生产域名 | https://tour.whleague.win |
| 关联文档 | `PRD.md` / `TECH_DESIGN.md` / `VERSIONS.md` / `PERF_PLAN.md` / `MOBILE_PLAN.md` |
| 本次交付 | 本文件 + 4 个新增自动化测试文件（106 用例） |

---

## 1. 执行摘要

本仓目前**唯一的质量门禁是 `npm run typecheck`**：没有 CI、没有覆盖率、没有 lint、没有 E2E。测试现状是 29 个 vitest 文件（28 通过 + `admin.live` 需真实认证服务而跳过），共 366 个用例。

本次按「高风险业务逻辑优先」补了 4 个自动化文件，全部落在**坏了影响最大**的链路上：比分收敛、积分榜重建、停赛重放、赛程生成。

| 指标 | 基线（本次开工前） | 本次完成后 |
| --- | --- | --- |
| 测试文件 | 24 通过 + 1 跳过（25） | 28 通过 + 1 跳过（29） |
| 用例数 | 253 通过 + 7 跳过（260） | 359 通过 + 7 跳过（366） |
| 全量耗时 | ≈5.3s | ≈7.7s |
| 新增用例 | — | **106**（scoring.finish 33 / schedule.generate 35 / suspension.replay 20 / standings.rebuild 18） |

**本次盘点同时钉住了 5 个真实行为缺陷（D1–D5，详见附录 C）**，其中 D1（自动回填用旧积分榜快照 + 新互相战绩的混合口径决定淘汰赛对阵）会导致**晋级对阵错误**，是本次最值得优先修的问题。这 5 个缺陷均已写成断言（测试记录当前实际行为），修好任一缺陷时对应断言需要同步更新为期望行为。此外还发现并当场修复了 1 处**测试基建缺陷**（T1：测试桩 `DB.batch` 内的 SELECT 恒返回空结果，见附录 C 末），它此前会让任何依赖批次内读回的断言静默失真。

手工用例本次**全量盘点**：11 个业务域共 201 条（P0 56 / P1 110 / P2 34 / P3 1），覆盖 20 条前端路由、全部 API 端点（134 个）与 3 条机器间通道。第 9 节即执行用的用例目录。

---

## 2. 测试范围

### 2.1 In（本次覆盖）

| 分类 | 内容 |
| --- | --- |
| 前端路由 | 20 条：`/`、`/t/:id`（5 tab）、`/t/:id/match/:mid`、`/tactics`、`/report/:mid`、`/weekly`、`/recap/:tid/:sid/:round`、`/news`、`/login`、`/register`、`/my-team`、`/password`、`/admin`、`/admin/teams`、`/admin/codes`、`/admin/injuries`、`/admin/teams/:id`、`/admin/t/:id`、`/admin/accounts`、`/admin/audit` |
| API 端点 | 附录 A 全量清单，共 134 个（auth 9 + public 16 + portal 6 + admin 84 + coach 13 + interact 4 + media 1 + internal 1；同路径不同 method 分别计数） |
| 权限 | 四级角色（游客 / coach / admin / superadmin）× 四个权限点：`tour.match.manage`、`tour.accounts.manage`、`tour.org.settings`、`requireSuperadmin`、`requirePwChanged` |
| 认证 | OIDC RP（`/api/auth/login|callback|sync`、`backchannel-logout`）与兼容模式（KV `sess:*` + `whl_session` + PBKDF2）双轨 |
| 定时任务 | cron `0 * * * *` → `runRosterSync` + `runAccountMirror` |
| 跨仓契约 | 入站 `POST /api/internal/team-upsert`（HMAC `X-Sign` + `X-Timestamp` ±300s，fail-closed）；出站 `pushTeamToClub`；名册入站拉取 `/api/squads` |
| 数据层 | 24 个迁移（0001–0024）的表结构与约束（含 `injury_event_uniq`、`match_event` 类型白名单） |
| 非功能 | D1 读消耗回归（`d1-read-plan`）、公开端缓存 TTL（60s/300s）、互动限流 |

### 2.2 Out（本次不做，及原因）

| 不做项 | 原因 |
| --- | --- |
| 第三方内部实现 | 俱乐部平台、认证中心的服务端代码不在本仓，只测契约（签名、状态码、幂等） |
| 生产真源数据 | 生产 D1/R2 只读，禁止写测试数据；手工用例一律在 dev/本地库执行 |
| 多语言 / i18n | 当前无 i18n，全站硬编码中文（登记为缺口而非缺陷） |
| 已砍功能 | 球员写端点（v4.0.0 下线）、WebSocket（设计上改为 60s 轮询） |
| 压测 / 容量测试 | 归 `PERF_PLAN.md` 与 `scripts/d1-read-audit/` 的治理流程，不在本计划内 |
| 视觉基线比对 | 无可用的设计稿源文件（Figma 链接缺失），仅做可用性与布局检查 |

---

## 3. 测试策略

四层，从快到慢：

| 层 | 工具 | 覆盖对象 | 何时跑 |
| --- | --- | --- | --- |
| 单元 | vitest（`tests/*.test.ts` 中纯函数部分） | `worker/lib/*`：seeding / standings / suspension / topstats / pitch / roleHeat / rankZones / news 叙事 / lineup | 每次改动 |
| 集成 | vitest + `tests/d1.ts`（Node `node:sqlite` + `applyMigrations`，进程内 `app.request`） | 路由 + 真实 SQL 形状，无需 wrangler、无需网络 | 每次改动（`npm test`） |
| 跨服务冒烟 | `scripts/smoke-oidc-local.mjs`（24 断言，需本地 auth 服务在 8792）；`tests/admin.live.test.ts`（env 就绪时才跑） | OIDC 全链路、tour→auth 机器通道 | 认证相关改动、发版前 |
| 手工探索 | 浏览器 + dev 环境 | 页面交互、跨页一致性、缓存时效、限流、cron 观察 | 发版前、功能验收 |

**为什么不引入 E2E 与覆盖率**：本仓无 CI 基础设施，worker 与 SPA 同仓同部署，引入 Playwright 需要额外的浏览器依赖与持久化测试库；当前收益最高的是把**纯逻辑高风险链路**用进程内集成测试钉死（本次已完成）。前端组件测试与 E2E 登记为缺口（见 10.3），作为下一阶段建议。

**缺陷判定原则**：凡是"数据写坏了但没有报错"的问题（混合代读取、回滚残留、榜单口径错）优先级高于"报错文案不准"，因为前者无人察觉。

**桩件保真度前提**：所有集成断言都建立在 `tests/d1.ts` 与真实 D1 语义一致之上。本次已修掉一处语义差（T1：`batch` 内的 SELECT 曾恒返回空结果，见附录 C）。后续凡新增「依赖批次内读回」的断言，必须先在桩件上确认该读回路径真能取到数据，再写期望值。

---

## 4. 测试环境

| 环境 | 启动 / 命令 | 依赖 | 数据 |
| --- | --- | --- | --- |
| 单元+集成 | `npm test`（= `vitest run`） | Node ≥ 22.5（用于 `node:sqlite`；实测 v24.12.0） | 每个文件内存 SQLite，自动 `applyMigrations` |
| 类型门禁 | `npm run typecheck`（`tsc --noEmit` + `tsc -p tsconfig.worker.json --noEmit`，双份 strict） | 无 | — |
| 本地全栈 | `npm run dev`（Worker 8790）+ `npm run dev:web`（Vite SPA） | `wrangler` 登录态、本地 D1 已迁移 | `npm run db:migrate:local` |
| 本地认证 | `npm run dev:oidc`（认证中心 8797）+ `npm run dev:auth`（auth 8792） | 独立于本仓 | `node scripts/seed-local-oidc-users.mjs`（本地用户 901–903，密码 `TestPass123`） |
| 冒烟 | `node scripts/smoke-oidc-local.mjs` | 需 auth 在 8792 运行 | 24 断言（双服务联调） |
| 生产 | https://tour.whleague.win | — | 只读验证 |

**环境风险**：`package.json` 未声明 `engines`，Node < 22.5 时 `node:sqlite` 不可用会导致 `npm test` 整体失败而没有任何前置提示。建议补 `"engines": { "node": ">=22.5" }`（已在缺口清单）。

---

## 5. 准入与准出标准

### 5.1 准入（开始测试的前提）

1. `npm run typecheck` 全绿；
2. `npm test` 全绿（允许 `admin.live` 因环境缺失而跳过，但需记录）；
3. 本地 D1 已迁移到最新（`npm run db:migrate:local`），迁移号与 `migrations/` 一致；
4. 被测版本号明确（`package.json.version`），并与本次变更说明对应；
5. 涉及认证的改动需启动 OIDC/auth 双服务，否则相关用例标记为"未执行"而非"通过"。

### 5.2 准出（可以发布）

1. **P0 用例 100% 通过**（手工 + 自动化）；
2. **P1 用例通过率 ≥ 90%**，失败项必须有明确的"已知问题"记录与影响范围；
3. 无未决的 Critical / High 缺陷（严重度定义见第 11 节）；
4. 新增/修改的数据库迁移在空库上可从 0001 顺序跑通，且在生产快照副本上演练过；
5. 回归分层中的**冒烟套件**在候选版本上跑过并留痕（第 8 节）。

---

## 6. 风险表

概率/影响：高=H、中=M、低=L。关联用例用编号，D1–D5 见附录 C。

| # | 风险 | 概率 | 影响 | 缓解措施 | 关联用例 |
| --- | --- | --- | --- | --- | --- |
| R1 | **自动回填用混合代数据决定淘汰赛对阵**（旧积分榜快照 + 新 h2h），晋级对阵错且无报错 | H | H | 已钉住 D1；修法：先执行 `buildStandingsStmts` 再构建 `takeRangePool` 取人语句，或取人查询直接基于 match 表现算名次 | TC-SCH-018/024；`tests/scoring.finish.routes.test.ts` |
| R2 | **报分失败回滚残留 `finished_at`**：比赛退回 pending 却带终场时间戳，公开端"最近完赛"会串数据 | M | M | 已钉住 D2；补偿语句需包含 `finished_at = NULL` | TC-SCO-021；`tests/scoring.finish.routes.test.ts` |
| R3 | **OIDC 回调与账号投影不同批次**：登录正常、一写就 500（外键错，2026-09-23 生产事故复现路径） | M | H | 投影语句必须与 `oidc_session` 写入同一次 `DB.batch`；`tests/oidc.test.ts` 已覆盖此约束 | TC-AUTH-003 |
| R4 | **名册同步误删球队**：小时 cron 用俱乐部平台数据对账，形状异常时会删本地球队 | L | H | 三重防线（0 squads 跳过 / 形状坏抛错不写 / 只删出现在俱乐部名单里的队），已在 `tests/rosterSync.test.ts` 固化 | TC-TEAM-010~012 |
| R5 | **循环赛与小组赛并存时榜单名次错乱**：`standing.group_id` 对所有阶段复制 `entry.group_id`，rank 变成 1,2,1,2 重复编号 | H | M | 已钉住 D3；修法：`readStandings` 仅对 `kind='group'` 的阶段分桶 | TC-PUB-008；`tests/standings.rebuild.test.ts` |
| R6 | **同分决胜链为空**：`tiebreakers` 数组全是非法值时返回空数组而非默认链，导致 h2h 一起失效、名次退化为纯 seed 序 | M | M | 已钉住 D4；修法：过滤后为空则回退 `DEFAULT_TIEBREAKERS` | TC-TOUR-005；`tests/standings.rebuild.test.ts` |
| R7 | **小组赛多组 (round,slot) 重号**：库内无唯一约束，靠 `slotOf` 每组重置；任何按 (round,slot) 去重的下游逻辑会静默合并场次 | M | L | 已钉住 D5；下游禁止用 (round,slot) 作唯一键，用 `match.id` | TC-SCH-015 |
| R8 | **赛程重生成清空已有场次**：唯一的守卫是"无 live/finished"，误点会丢掉手工调整 | M | H | 守卫已在自动化中固化（409 且一行不改）；前端二次确认文案需人工确认 | TC-SCH-020/021 |
| R9 | **归档赛事仍可被改写**：报分有 `archived` 守卫，但赛程/报名端点需逐条核对 | M | M | 用 TC-GEN-001 权限矩阵 + TC-TOUR-009 全量过一遍 | TC-TOUR-009/010、TC-SCO-015 |
| R10 | **停赛计算与实际消耗不一致**：纯派生（不落库），任何一处口径漏算都会让球员"该停的没停" | M | H | `tests/suspension.replay.test.ts` 已固化 20 条口径（轮空不计、弃权方不消耗、双弃权双方不消耗、先消耗后触发、锚点边界 `<=`/`>`） | TC-H-011~015 |
| R11 | **互动接口被刷**：MOTM 与 reaction 是匿名/低成本写端点 | M | L | 限流 10/60s 与 30/60s 已存在，需手工验证 429 触发点与代理 IP 取值 | TC-INT-006/009 |
| R12 | **内部通道鉴权被绕过**：HMAC fail-closed 未配置时返回 503，但若改动误放行则任意方可建队 | L | H | `tests/clubTeamSync.test.ts` 覆盖签名金标准与 fail-closed | TC-MED-005~007 |
| R13 | **Node 版本未声明**：无 `engines`，低版本 Node 上测试/构建静默失败 | M | M | 补 `engines`；环境准备清单里显式要求 Node ≥ 22.5 | 5.1-1、4 表 |
| R14 | **无 CI 导致门禁靠人**：typecheck/test 全凭本地自觉，回归用例可能被绕过 | H | M | 本次不引入 CI（范围外）；用第 8 节分层 + 报告模板留痕替代 | 第 8 节整节 |
| R15 | **4 队单循环无法满足主客健康约束**：n=4 时 6 场 / 每队 3 场，数学上不存在"每队前两场与后两场异侧"的解，退火停在最接近状态并返回 `balanced=false`（`worker/lib/seeding.ts:221`） | H | L | 设计内行为而非缺陷；后端返回 `balanced=false`，前端（`src/pages/ScheduleTab.tsx:81`）据此提示「已尽量均衡」——需人工确认真机上该提示确实出现 | TC-SCH-027；`tests/schedule.generate.routes.test.ts` |
| R15 | **缓存时效引发"看起来坏了"**：公开端 60s/300s 缓存 + feed SWR，改动后不立即生效 | H | L | 手工具明确等待窗口（≤5 分钟），或带 `?nocache` 类参数验证源数据 | TC-PUB-013、TC-ANN-003/004 |

---

## 7. 权限矩阵

角色四级：游客（无会话）→ `coach` → `admin` → `superadmin`。中间件实现在 `worker/middleware/auth.ts`：`attachUser` → `requireUser(401)` → `requirePermission(perm, compatLevel)` → `requirePwChanged(403 code=password_change_required)`。

| 端点组 | 游客 | coach | admin | superadmin | 实现依据 |
| --- | --- | --- | --- | --- | --- |
| `/api/public/*`、`/api/media/*` | 200（只读） | 200 | 200 | 200 | 无鉴权中间件 |
| `/api/interact/matches/:mid/motm`（POST） | 401 | 200 | 200 | 200 | `requireUser` + 限流 |
| `/api/interact/reactions/*` | 200（匿名可投） | 200 | 200 | 200 | 无鉴权 + 限流 |
| `/api/auth/me`、`/api/auth/password` | 401 | 200 | 200 | 200 | `requireUser`（password） |
| `/api/coach/*` | 401 | 200（仅本队数据） | 200 | 200 | `requireUser` + 队伍收窄 |
| `/api/admin/*`（除下列超管项） | 401 | 403 | 200 | 200 | `requirePermission("tour.match.manage")` + `requirePwChanged` |
| `PUT /api/admin/org-settings` | 401 | 403 | **403** | 200 | `requirePermission("tour.org.settings","superadmin")` |
| `PATCH /api/admin/tournaments/:id/entries/:entryId/deduction` | 401 | 403 | **403** | 200 | `requireSuperadmin` |
| `/api/admin/accounts/*`（全部 9 个端点） | 401 | 403 | **403** | 200 | `requirePermission("tour.accounts.manage","superadmin")` |
| `/api/internal/team-upsert` | 无 Cookie 也可达 | — | — | — | HMAC 签名（与角色无关，签名即身份） |

**边界必须单独验证**：

1. **兼容模式回落**：无 `AUTH_MODE=oidc` 时，`requirePermission(perm, "superadmin")` 退化为「`role === 'superadmin'`」，`"admin"` 退化为「admin | superadmin」，`"user"` 只要求登录。OIDC 模式下则查 `user.permissions`，**角色字段不再是判据**。同一账号在两种模式下权限可能不同 —— TC-GEN-001 必须在两种模式下各跑一遍。
2. **强制改密**：`must_change_pw = 1` 时所有 `/api/admin/*` 返回 403 且 `code=password_change_required`，前端 `src/api.ts` 收到后硬跳 `/password`。该盖卡在强制态下不可关闭。
3. **401 与 403 的区别**：未登录 401（前端跳登录并带回跳），登录但权限不足 403（前端只提示）。混用会让用户被莫名踢出。
4. **超管不做"免死金牌"**：除上表三类，超管与 admin 权限相同；不要假设超管能绕过归档锁定、开赛状态等业务守卫。

---

## 8. 回归套件分层

| 层 | 范围 | 命令 | 目标时长 | 触发时机 |
| --- | --- | --- | --- | --- |
| S1 冒烟 | `typecheck` + 核心 4 文件（scoring.finish / standings.rebuild / suspension.replay / schedule.generate）+ `d1-read-plan` | `npm run typecheck && npx vitest run tests/scoring.finish.routes.test.ts tests/standings.rebuild.test.ts tests/suspension.replay.test.ts tests/schedule.generate.routes.test.ts tests/d1-read-plan.test.ts` | ≤ 30s | 每次提交前 |
| S2 定向 | 按改动面选域：报分/榜单 → 上述 4 文件 + `topstats`；认证 → `oidc` + `machine` + `admin.live`；名册 → `rosterSync` + `clubTeamSync`；教练 → `coach.*` + `assign` + `lineupProxy.routes`；公开端 → `public.lists.routes` + `home.route` + `injury.*` + `news.*` | `npx vitest run tests/<域文件>` | ≤ 30s | 日常迭代 |
| S3 全量 | 全部 29 文件 | `npm test` | ≈ 8s | 发版前、每日 |
| S4 变更 sanity（手工） | 第 9 节中被改动业务域的 P0 用例 + 第 7 节权限矩阵相关行 | 手工 | 30–60 分钟 | 发版前 |
| S5 跨服务 | `node scripts/smoke-oidc-local.mjs`（需 auth 8792）+ `tests/admin.live.test.ts` | 见 4 表 | ≤ 5 分钟 | 认证/机器通道改动、发版前 |

**必动的索引形状守卫**：`tests/d1-read-plan.test.ts` 是 D1 读消耗治理的"索引形状"断言（16 用例，含 v5.0.1/v5.0.2/v5.0.3 三批）。任何改动公开端/管理端 SQL（新增查询、改 JOIN、加索引）都必须跑它；改索引需同步更新预期形状。

---

## 9. 手工用例目录

约定：`P0` 阻断核心流程（发布前必须全绿）／`P1` 主要功能／`P2` 边缘与体验。前置为空表示"以管理员登录 dev 环境的既有测试赛事"为默认。**⚠ 表示该用例期望行为尚未被代码或测试确认，执行时需先观察实际行为再判定（结果记入回归报告）。**

### A. 公开观赛与门户（TC-PUB）

1. **TC-PUB-001 首页聚合渲染** `P1` — 打开 `/`；预期：`/api/public/home` 200，「即将进行」列出未来比赛、快讯区块（`aria-label="快讯"`）有内容。
2. **TC-PUB-002 首页快讯跳战报** `P2` — 点快讯卡片的「阅读战报 →」；预期：进入 `/report/:mid` 且内容为该场。
3. **TC-PUB-003 公开赛事列表不含草稿** `P0` — 造一个 `draft` 赛事，请求 `/api/public/tournaments`；预期：列表中不出现该赛事。
4. **TC-PUB-004 草稿赛事详情不可访问** `P0` — 请求 `/api/public/tournaments/:draftId`；预期：404 `{message:"赛事不存在或未发布"}`。
5. **TC-PUB-005 赛事页 5 个 tab** `P1` — 打开 `/t/:id` 依次切换 比赛/赛程/积分榜/射手榜/统计；预期：每 tab 数据非空且无控制台报错。
6. **TC-PUB-006 比赛 tab 过滤** `P2` — 带 `?stageId=` 与 `?round=` 请求 `/api/public/tournaments/:id/matches`；预期：单阶段/单轮过滤生效，无参返回全量。
7. **TC-PUB-007 阶段改名影响公开端** `P2` — 管理端改阶段显示名（如"小组赛"），刷新 `/t/:id` 赛程 tab；预期：轮次前缀显示新名；留空恢复默认名。
8. **TC-PUB-008 积分榜分区分档** `P1` — 查看赛事积分榜；预期：晋级/降级区分档色条与图例正确；**⚠ 若同一赛事同时存在小组赛与循环赛阶段，需核对循环赛榜单的 rank 是否出现 1,2,1,2 重复（D3）**。
9. **TC-PUB-009 射手榜点球口径** `P1` — 录入含 `pen_goal` 的比赛后查看射手榜；预期：点球进球计入进球数，与快讯叙事口径一致。
10. **TC-PUB-010 统计面板** `P2` — 查看统计 tab；预期：团队进球/失球/零封等面板渲染，数值与榜单可交叉核对。
11. **TC-PUB-011 单场详情完整性** `P1` — 打开 `/t/:id/match/:mid`；预期：比分、事件时间线（含助攻/黄红牌/伤停）、双方阵容、h2h 均正确。
12. **TC-PUB-012 轮空场展示** `P2` — 打开轮空场详情；预期：显示"轮空"且晋级方已预填，不显示可报分的空比分。
13. **TC-PUB-013 live 场 60s 刷新** `P1` — 对 live 场改一个事件，停留在详情页；预期：≤ 60s 内页面比分自动更新（对齐 `pubCache(60)`）；超过 60s 未更新即缺陷。
14. **TC-PUB-014 归档赛事只读** `P2` — 打开 archived 赛事公开页；预期：可浏览，无任何管理入口或可提交控件。
15. **TC-PUB-015 快讯页与表态** `P1` — 打开 `/news`，对一条快讯表态；预期：匿名可投、票数立即变化、刷新后保留。
16. **TC-PUB-016 周报默认本周** `P1` — 打开 `/weekly`；预期：默认显示本周；本周 0 场时自动回退到最近有完赛的周并标注回退（最多回退 8 周）。
17. **TC-PUB-017 周报指定周不回退** `P1` — 打开 `/weekly?week=<空周>`；预期：显式指定周即使 0 场也显示空态，**不回退**。
18. **TC-PUB-018 战报页内容** `P1` — 打开 `/report/:mid`；预期：含进球/助攻/黄红牌/伤停小节，数据与事件表一致。
19. **TC-PUB-019 轮次回顾** `P2` — 打开 `/recap/:tid/:sid/:round`；预期：列出该轮全部场次与小结。
20. **TC-PUB-020 公开战术板** `P1` — 打开 `/tactics`：选目标比赛、选编辑身份、调阵型/防线高度/组织风格、粘贴 12 位战术码；预期：各控件可用，状态可保存/回显，非法战术码有拒绝提示。
21. **TC-PUB-021 跨赛事进行中列表** `P1` — 请求 `/api/public/live`；预期：列出全部 live 场，比分口径为 `goal`/`pen_goal` 计事件方、`own_goal` 计对方。
22. **TC-PUB-022 最近完赛列表** `P2` — 请求 `/api/public/recent` 后改判其中一场；预期：最近完赛 10 场按 `finished_at` 倒序，改判后该场时间刷新并前移。
23. **TC-PUB-023 待打列表缓存** `P2` — 请求 `/api/public/upcoming` 并新增一场未来的手动落场；预期：≤ 5 分钟后出现在列表（TTL 300s，不是缺陷）。
24. **TC-PUB-024 公开端坏参数** `P2` — 请求 `/api/public/tournaments/999999`；预期：404；请求 `?stageId=abc`；预期：按全量返回而非 500。
25. **TC-PUB-025 匿名可达性** `P0` — 清除所有 Cookie，逐个请求全部 `/api/public/*`、`/api/media/*`；预期：全部 200，无一处 401。
26. **TC-PUB-026 页脚版本号** `P2` — 打开任意页面看页脚；预期：显示 `package.json.version` 同值（构建注入 `__APP_VERSION__`）。

### B. 账号与认证（TC-AUTH）

1. **TC-AUTH-001 OIDC 登录入口** `P0` — OIDC 模式下打开 `/login`；预期：显示「登录已统一到认证中心」与「点这里继续」，不出现本地账号密码表单。
2. **TC-AUTH-002 跳转参数正确** `P0` — 点「点这里继续」；预期：跳 `auth.whleague.win` 授权页，`redirect_uri` 指向本仓 `/api/auth/callback`，带 `state` 与 `nonce`。
3. **TC-AUTH-003 回调建会话与投影同批次** `P0` — 完成一次登录；预期：`oidc_session` 有行、Cookie 为 `__Host-tour_session`，且 `user` 表投影行同时就位（**任一步缺失都会导致"登录正常但一写就 500"**）。
4. **TC-AUTH-004 state 校验** `P0` — 手工构造 `state` 不匹配或过期的 callback；预期：拒绝建会话并回登录页，不产生孤儿会话行。
5. **TC-AUTH-005 静默同步探测** `P1` — 已登录状态刷新页面；预期：`GET /api/auth/sync`（`prompt=none`）不闪屏、不误踢登录态；`/api/auth/me` 的 `MeEnvelope` 含 `syncProbe` 结果。
6. **TC-AUTH-006 后台登出通知** `P1` — 对 `/api/auth/backchannel-logout` 发带 `logout_token` 的请求；预期：本地会话被撤销，后续请求 401。
7. **TC-AUTH-007 兼容模式登录** `P1` — 去掉 `AUTH_MODE` 环境变量，用本地账号（901–903 / `TestPass123`）登录；预期：PBKDF2 校验通过，Cookie 为 `whl_session`，KV `sess:<token>` 有值。
8. **TC-AUTH-008 登出清彻底** `P0` — 点登出；预期：KV 会话删除、Cookie 清除，再请求 `/api/auth/me` 返回 401。
9. **TC-AUTH-009 /me 字段完整** `P1` — 请求 `/api/auth/me`；预期：`{user, authMode, authHome, syncProbe}` 齐全，`authHome` 指向认证中心。
10. **TC-AUTH-010 正常注册** `P0` — 用 8 位注册码在 `/register` 注册（昵称 + 密码）；预期：建号成功、注册码标记已用、可立即登录。
11. **TC-AUTH-011 注册码异常** `P0` — 用错误码 / 已用码 / 过期码注册；预期：各给出明确文案，且不创建 `user` 行。
12. **TC-AUTH-012 无码注册开关** `P1` — 超管在 `/admin/codes` 打开「无码注册」（开关仅超管可改）；预期：打开后可无码注册，关闭后拒绝。
13. **TC-AUTH-013 昵称唯一** `P1` — 用已存在昵称注册；预期：拒绝（`user.name` UNIQUE），文案不泄露其它账号信息。
14. **TC-AUTH-014 密码强度** `P1` — 注册/改密输入纯数字或长度不足；预期：前端提示「至少…同时包含字母和数字」，后端同样拒绝（不能只靠前端）。
15. **TC-AUTH-015 主动改密** `P1` — 在 `/password` 输入旧密码与新密码；预期：旧密码错则拒绝；成功后旧会话失效需重新登录。
16. **TC-AUTH-016 强制改密拦截** `P0` — 超管重置某管理员密码后用临时密码登录，访问 `/admin`；预期：进入 `/password` 盖卡，且该账号直接请求任意 `/api/admin/*` 返回 403 且 `code=password_change_required`。
17. **TC-AUTH-017 强制盖卡不可关闭** `P1` — 强制态下尝试关闭改密盖卡或直接导航到 `/admin/teams`；预期：被弹回改密页；改完自动消失并回主页。
18. **TC-AUTH-018 重置后登录路径** `P1` — 超管用 `/admin/accounts` 重置密码；预期：该账号下次登录被引到改密，改完才能用管理功能。
19. **TC-AUTH-019 会话撤销** `P1` — 对某账号调用 `POST /api/admin/accounts/:id/sessions/revoke`；预期：该账号下一次请求 401，其它账号不受影响。
20. **TC-AUTH-020 401 前端行为** `P1` — 会话失效后点任意需要登录的页面；预期：跳登录并带回跳路径，登录后回到原页面。
21. **TC-AUTH-021 锁定账号** `P1` — 把账号 `locked=1`（或用 disable 端点）后尝试登录；预期：拒绝并提示账号已停用，不建会话。

### C. 赛事管理（TC-TOUR）

1. **TC-TOUR-001 赛事列表** `P1` — 打开 `/admin`；预期：列表含赛事名/赛制/状态/报名数；空库时显示「还没有赛事，先创建一个。」。
2. **TC-TOUR-002 新建赛事** `P0` — 「新建赛事」填名称、选赛制（`single_elim`/`round_robin`/`group_knockout`）或套用模版；预期：创建成功并进入管理页，状态为 `draft`。
3. **TC-TOUR-003 名称边界** `P2` — 名称留空 / 超长 / 重名；预期：留空拒绝；超长与重名行为明确且不产生半成品赛事。
4. **TC-TOUR-004 编辑基本信息** `P0` — `PATCH /:id` 改名称/描述/赛制；预期：保存成功，公开端同步（受 300s 缓存约束）。
5. **TC-TOUR-005 同分规则** `P1` — 在「同分规则」调整顺序（gd/gf/h2h，最多 3 项）并保存；预期：积分榜名次随之变化；**⚠ 若把规则设成全部非法值，核对是否退化为纯 seed 序而非回退默认链（D4）**。
6. **TC-TOUR-006 排名段标记** `P2` — 在「排名段标记」添加/上移下移/自定义颜色/保存；预期：积分榜色条与图例一致（`rankZones` 校验生效）。
7. **TC-TOUR-007 封面图上传** `P1` — 上传 png/jpg/webp ≤1MB；预期：成功且旧对象被删除；上传 >1MB 或非白名单类型；预期：明确拒绝。
8. **TC-TOUR-008 删除封面** `P2` — 删除封面；预期：回到按赛事名生成的默认模板封面，`cover_key` 置空。
9. **TC-TOUR-009 状态流转合法路径** `P0` — 依次 `draft→registering→running→archived`；预期：每步成功，公开端可见性随状态变化（draft 不可见）。
10. **TC-TOUR-010 非法流转拒绝** `P0` — 尝试 `archived→running`、`draft→running`、`registering→archived`；预期：全部 400 且状态不变（`ALLOWED` 状态机）。
11. **TC-TOUR-011 删除赛事** `P1` — 删除 `running`/`archived` 赛事；预期：行为明确（拒绝或级联），不得留下孤儿报名/阶段/场次。
12. **TC-TOUR-012 单条报名** `P0` — 「从球队库添加」选择球队报名；预期：报名成功并出现在列表，seed 有值。
13. **TC-TOUR-013 批量报名** `P1` — 「批量报名」粘贴多行（`球队库名 + 名称` 格式）；预期：合法行全部成功，非法行逐条提示且不影响合法行。
14. **TC-TOUR-014 重复报名拒绝** `P1` — 对同一赛事重复添加同一球队；预期：拒绝（`UNIQUE(tournament_id, team_id)`）。
15. **TC-TOUR-015 删除报名** `P1` — 删除已有场次引用的报名；预期：行为明确（拒绝或连带清理），刷新后无悬挂引用、公开端不报错。
16. **TC-TOUR-016 扣分设置** `P0` — 超管在赛事管理页「扣分」给某队设 3 分；预期：该队 `pointsDeducted=3`、积分榜 `pts` 减少、名次可能需要调整；设 0 清除。
17. **TC-TOUR-017 扣分非法值** `P1` — 输入 `-1` / `1.5` / `1000`；预期：400「扣分必须是不超过 999 的非负整数（0 表示清除）」。
18. **TC-TOUR-018 扣分后改判一致** `P1` — 扣分后改判一场比赛比分；预期：积分榜仍按「新比分结果 − 当前 `points_deducted`」计算，扣分不被重置。
19. **TC-TOUR-019 管理中台数据 tab** `P2` — 在 `draft` 赛事的「全部积分表/伤停/停赛/统计/审计」tab 之间切换；预期：草稿赛事也能查看（管理端榜单不要求先发布）。
20. **TC-TOUR-020 审计留痕** `P0` — 依次做开赛/终场/改判/弃权/事件增删；预期：`audit_log` 各写一条（`match_start`/`match_finish`/`match_rescore`/`match_walkover`/事件类），`GET /:id/audit?matchId=` 可查该场，不传参看整届（倒序最多 100 条）。
21. **TC-TOUR-021 赛事不存在** `P2` — 打开 `/admin/t/999999`；预期：显示「赛事不存在。」并提供「返回赛事列表」。

### D. 赛制编排（TC-SCH）

1. **TC-SCH-001 新增各类型阶段** `P0` — 依次新增 `elim` / `round_robin` / `group`（`group` 必须为首阶段）；预期：成功返回 `{ok:true, stageId, sortOrder}`。
2. **TC-SCH-002 非首阶段建分组赛** `P1` — 在已有阶段之后新增 `group`；预期：400「分组赛只能作为第一阶段」。
3. **TC-SCH-003 首阶段配取人规则** `P1` — 给第一阶段配取人/区间；预期：400「第一阶段直接使用全部报名队，不需要取人规则」。
4. **TC-SCH-004 取人名额越界** `P1` — 取人名额填 1 与 65；预期：400「取人名额需在 2 到 64 之间」。
5. **TC-SCH-005 名次区间非法** `P1` — 只填起点 / 起点非 1 / 区间只有 1 个名次 / 终点 >128；预期：四条各自对应 400 文案。
6. **TC-SCH-006 来源阶段校验** `P1` — 取人来源填不存在的阶段 / 排在本阶段之后的阶段 / 淘汰赛阶段；预期：三条各自对应 400 文案。
7. **TC-SCH-007 阶段改名** `P2` — 改阶段名、留空恢复默认；预期：公开端轮次前缀同步（见 TC-PUB-007）。
8. **TC-SCH-008 阶段排序与删除** `P1` — 上移/下移阶段后生成赛程；预期：`sort_order` 生效；删除阶段（连同其全部场次）需二次确认且彻底清理。
9. **TC-SCH-009 淘汰赛生成** `P0` — 8 队 `elim` 生成；预期：7 场 3 轮；首轮种子位为 (1v8)(4v5)(2v7)(3v6) 展开后的位序，4 强与决赛为待定壳。
10. **TC-SCH-010 轮空处理** `P0` — 6 队（非 2 的幂）生成；预期：2 场轮空，轮空场 `status=pending`、晋级方预填主队、`note='轮空'`。
11. **TC-SCH-011 双回合与决赛单回合** `P1` — 设 `legs=2`、`final_legs=1`；预期：首轮每对两回合主客对调，决赛仅一回合（单回合场 `leg` 为空）。
12. **TC-SCH-012 季军赛** `P2` — 开 `third_place`；预期：在决赛轮多出一场 `note='季军赛'` 的场次，位置不与决赛冲突。
13. **TC-SCH-013 单循环生成质量** `P0` — 4/5/8 队单循环生成；预期：轮次与场次数正确（4 队 3 轮 6 场）；每队主场 3–4 场且**不出现连续三场同侧**。
14. **TC-SCH-014 双循环生成** `P1` — `loops=2` 生成；预期：每对主客各一场（4 队 6 轮 12 场）。
15. **TC-SCH-015 小组赛生成** `P1` — 3 组各 2 队 + 一个不足 2 队的组；预期：前 3 组生成、不足 2 队的组进 `skipped`；**⚠ 注意同阶段多组的 (round, slot) 会重号（D5），不要按 (round,slot) 做唯一性判断**。
16. **TC-SCH-016 抽签** `P0` — 对 6 队 3 组抽签并重复抽一次；预期：每次重新分配且覆盖手工调整；报名 3 支（不足每组 2 队）→ 400；报名超出组数×容量 → 400 且不写入。
17. **TC-SCH-017 抽签守卫** `P1` — 对非 group 阶段抽签 → 400「只有小组赛阶段支持抽签」；无小组行 → 400「该阶段没有小组」；阶段已有开打场次 → 409。
18. **TC-SCH-018 名次取人生成** `P0` — 上一阶段（循环赛）全部完赛后，下一阶段配 `source.take=4` 并生成；预期：按积分榜 1–4 名取人，首轮为 1v4、2v3；返回体含 `source:"topN"`。
19. **TC-SCH-019 取人守卫** `P1` — 来源未全部完赛 → 400「取人来源阶段尚未全部完赛，还不能按名次取人生成」；来源无积分榜数据 → 400「来源阶段还没有积分榜数据，先生成并完赛它的赛程」；区间越界 → 400「来源阶段共 N 支队，取不到第 X 到第 Y 名」。
20. **TC-SCH-020 跨组对阵模板** `P1` — 配 `A1-B2,B1-A2` 类模板生成淘汰赛；预期：组赛程未完赛时 400「请先生成小组赛程，再生成淘汰赛对阵」/「小组赛尚未全部完赛，不能生成淘汰赛对阵」；非法位置（如 `Z9`）→ 400 明确文案；`qualify ≠ 2` → 400「跨组对阵暂仅支持每组出线 2 队」。
21. **TC-SCH-021 生成守卫** `P0` — 对已有 live/finished 场次的阶段点重新生成；预期：409「该阶段已有开打或完赛的场次，不能重新生成」，且已有 7 行一行未改（含手工落场的残留行不被清除）。
22. **TC-SCH-022 一键清除** `P1` — 对全 pending 阶段点清除；预期：场次归零；已有开打 → 409「该阶段已有开打或完赛的场次，不能一键清除」；空阶段 → `deleted:0`。
23. **TC-SCH-023 单场删除** `P1` — 删除 pending 场次成功；删除 finished 场次 → 409「只有未开打的比赛可以删除」；不存在的 matchId → 404「比赛不存在」。
24. **TC-SCH-024 补全双循环** `P1` — 4 队单循环后点「补齐第二循环」；预期：新增 6 场，轮次 = 原轮次 + 3、主客对调；重复执行幂等；第二循环已有开打 → 409；第一循环不完整（轮数不足/重复交手/场次数不符）→ 各自 400。
25. **TC-SCH-025 自动回填** `P0` — 让上一阶段最后一场完赛；预期：下一阶段对阵列自动生成（淘汰/循环/取人三型）且不需手工点生成；**⚠ 若下一阶段配了取人规则，必须核对生成的种子位与积分榜实际名次一致（D1：当前会用旧积分榜快照算名次）**。
26. **TC-SCH-026 阶段结构限制** `P1` — 在 `running` 赛事上增/删阶段；预期：409「赛事已开赛或已归档，不能再调整阶段结构」；`draft`/`registering` 下可增删。
27. **TC-SCH-027 主客均衡退化提示** `P1` — 对 4 支队的循环赛阶段点「生成赛程」；预期：赛程正常生成（6 场/3 轮），同时页面提示「赛程已生成，但当前队数下无法做到每队前两场一主一客、后两场一主一客（如 4 队单循环），已尽量均衡。」；再对 5/6/8 队各生成一次，预期**无**此提示（`balanced` 不再为 false）。

### E. 报分与比赛事件（TC-SCO）

1. **TC-SCO-001 开赛** `P0` — 对 pending 场点开赛；预期：`status=live`，`audit_log` 写 `match_start`。
2. **TC-SCO-002 轮空场开赛** `P2` — 对轮空场开赛；预期：400「轮空场无需开赛」。
3. **TC-SCO-003 对阵未定开赛** `P1` — 对双方未定的淘汰赛场开赛；预期：400「对阵双方尚未确定，无法开赛」。
4. **TC-SCO-004 重复开赛** `P1` — 对 live/finished 场再开赛；预期：400「仅待开打的比赛可以开赛」。
5. **TC-SCO-005 快速报分** `P1` — 对 pending 场直接点终场（不传比分）；预期：成功结束（0:0 口径）、写 `match_finish` 审计。
6. **TC-SCO-006 正常报分** `P0` — 传最终比分结束比赛；预期：`status=finished`、`winner_entry_id` 正确、积分榜重建。
7. **TC-SCO-007 live 场按事件累计** `P0` — 对 live 场不传比分直接终场，先录 2 个进球 + 1 个乌龙；预期：比分按事件累计，乌龙球记给对方。
8. **TC-SCO-008 改判** `P0` — 对 finished 场传完整新比分；预期：`match_rescore` 审计、积分榜按新比分重算、旧结果完全消失。
9. **TC-SCO-009 改判翻转胜负** `P1` — 把胜方改成负方；预期：`winner_entry_id` 翻转；若已影响下一轮落位，需手工调整且系统给出可理解的现状（**⚠ 已知不会自动回退下一轮已生成的场次**）。
10. **TC-SCO-010 淘汰赛平局必须点球** `P0` — 淘汰赛 1:1 只传比分；预期：400「淘汰赛平局需录入点球比分才能定晋级」。
11. **TC-SCO-011 点球相同拒绝** `P1` — 传 `pen_home=pen_away`；预期：400「点球比分不能相同」。
12. **TC-SCO-012 点球决胜记账** `P1` — 传 1:1 + 点球 4:3；预期：比分记平、积分榜双方各记平且点胜 +2 / 点负 +1。
13. **TC-SCO-013 弃权** `P0` — 依次设为主队弃权/客队弃权/双方弃权；预期：比分与备注符合规则、`match_walkover` 审计、积分榜按弃权口径（单方 0:3；双弃权各记负 0 分不进失球）。
14. **TC-SCO-014 淘汰赛双方弃权** `P1` — 淘汰赛双方弃权不指定晋级方；预期：400「双方弃权的淘汰赛必须指定晋级方」。
15. **TC-SCO-015 归档赛事报分** `P0` — 对 archived 赛事中的场次报分；预期：400「赛事已归档，比分已锁定」。
16. **TC-SCO-016 事件录入八类** `P0` — 依次录入 `goal`/`pen_goal`/`own_goal`/`injury_minor`/`injury_major`/`yellow`/`red` 与助攻；预期：全部成功，时间线与榜单同步；`red_2y` 不在手选列表内。
17. **TC-SCO-017 第二张黄牌自动 red_2y** `P0` — 同一球员同场第二张黄牌；预期：新事件存为 `red_2y` 并提示停赛场数；同场已有红牌时 → 400「该球员本场已被罚下，如需更正请先删除红牌事件」。
18. **TC-SCO-018 事件校验** `P1` — 分钟 -1/301、球员不属于该队、助攻与进球同人、未开赛录事件、记助攻却不选进球球员；预期：各自对应 400 文案。
19. **TC-SCO-019 事件删除/修改实时回算** `P1` — 删除一张红牌；预期：停赛立即消失、榜单 `suspended` 消失（纯派生不落库）；改事件分钟；预期：停赛消耗序列随之变化。
20. **TC-SCO-020 阵容查询一致** `P2` — 对比 `GET /:id/lineup` 与公开端 `lineup-stats`；预期：名单与统计口径一致。
21. **TC-SCO-021 晋级回填与失败回滚** `P0` — 让一场淘汰赛完赛触发下一轮落位，再制造一个必然失败的场景（如双方弃权未指定晋级方）；预期：失败时返回 409 且比分/状态回滚；**⚠ 回滚后检查 `finished_at` 是否残留（D2）**。
22. **TC-SCO-022 全链路一致性** `P1` — 完整打完一届 8 队淘汰赛（7 场）；预期：全程无 409/500，冠军唯一，积分/榜单/公开端一致。

### F. 球队与名册（TC-TEAM）

1. **TC-TEAM-001 球队库列表** `P1` — 打开 `/admin/teams`；预期：显示球队名/游戏 ID/已报名赛事；空库显示「球队库是空的。」。
2. **TC-TEAM-002 新建球队** `P0` — 「新建球队」填球队名 + 游戏球队 ID；预期：创建成功并推送给俱乐部平台（幂等），本地记录可查。
3. **TC-TEAM-003 批量建队** `P1` — 「批量建队」粘贴多行；预期：合法行创建、非法行逐条提示，不中断。
4. **TC-TEAM-004 球队详情取齐** `P1` — 打开 `/admin/teams/:id`；预期：一次请求取回名单/已报名赛事/上下文，不出现多次瀑布请求。
5. **TC-TEAM-005 编辑球队** `P1` — 改球队名；预期：本地更新，俱乐部平台同步行为明确（成功或可见失败提示）。
6. **TC-TEAM-006 队徽** `P2` — 上传/删除队徽；预期：校验规则与赛事封面一致，旧图被清理。
7. **TC-TEAM-007 删除球队** `P1` — 删除已被赛事引用的球队；预期：行为明确（拒绝或级联），不留孤儿引用。
8. **TC-TEAM-008 重推俱乐部平台** `P1` — 点「把球队建档重推给俱乐部平台（幂等）」；预期：成功/失败有反馈；失败不阻断本地数据。
9. **TC-TEAM-009 球员写端点已下线** `P1` — 直接调用旧的球员增删改端点；预期：404/405（v4.0.0 起名册为只读镜像）。
10. **TC-TEAM-010 名册同步 dryRun** `P0` — `POST /api/admin/sync-rosters?dryRun=1`；预期：只报告差异，一行不写。
11. **TC-TEAM-011 名册同步三重防线** `P0` — 构造三种坏数据：0 squads / 形状异常 / 俱乐部名单缺该队；预期：分别为跳过、抛错不写、只删出现在俱乐部名单里的队（绝不误删本地球队）。
12. **TC-TEAM-012 cron 同步观察** `P2` — 观察整点 cron（`runRosterSync` + `runAccountMirror`）；预期：日志正常完成，无异常写入、无账号投影断档。
13. **TC-TEAM-013 球队成员管理** `P1` — 在球队详情查看绑定教练；超管解绑某教练；预期：解绑后该教练 `/my-team` 回到未绑定态。
14. **TC-TEAM-014 队伍认证码** `P1` — 生成并查看某队认证码（8 位，`GET /admin/teams/:id/auth-codes` → 管理端 `/admin/codes`）；预期：显示已用/上限与过期时间，过期码不可用。

### G. 教练子系统（TC-COACH）

1. **TC-COACH-001 绑队** `P0` — 用 8 位认证码在 `/my-team` 绑定球队；预期：绑定成功并显示队伍信息。
2. **TC-COACH-002 一账号一队** `P0` — 已绑定的账号用另一队的认证码再绑；预期：拒绝（一账号一队），原绑定不受影响。
3. **TC-COACH-003 认证码异常** `P1` — 错误码/过期码/已用码；预期：各给明确文案，不产生绑定。
4. **TC-COACH-004 我的球队页** `P1` — 查看 `/my-team`；预期：队伍信息/球员名单/参加的赛事正确；无球员时显示「还没有录入球员。」。
5. **TC-COACH-005 未绑队态** `P1` — 用未绑队的 coach 打开 `/my-team`；预期：显示绑定引导（「观众账号」提示），不显示报错。
6. **TC-COACH-006 我的比赛列表** `P1` — 查看本队比赛；预期：只列本队相关场次，状态与时间正确。
7. **TC-COACH-007 赛前状态回显** `P1` — 打开 `/api/coach/me/status` 与首屏；预期：回显本队阵容、停赛与伤停名单，数据与榜单一致。
8. **TC-COACH-008 提交阵容** `P0` — 提交 11 首发 + 替补；预期：保存成功并可回显；越界人数或非本队球员被拒。
9. **TC-COACH-009 阵容提交窗口** `P1` — 对 finished/pending 之外的非法状态或非本队比赛提交阵容；预期：拒绝并说明原因。
10. **TC-COACH-010 首屏聚合** `P1` — 打开教练首屏；预期：`/api/coach/bootstrap` 一次取齐，无多余瀑布请求。
11. **TC-COACH-011 代打授权** `P1` — 超管在 `/admin` 相关入口给某场比赛授权代打；预期：被授权者 `/api/coach/proxy/sessions` 出现该场；未授权者看不到。
12. **TC-COACH-012 代打提交** `P1` — 被授权者通过 `/proxy/:mid/lineup` 提交阵容；预期：提交成功、归属与审计正确（署名是代打者）。
13. **TC-COACH-013 战术板保存回显** `P1` — 在 `/tactics` 调阵型/防线高度/组织风格/指派并保存；预期：刷新后完整回显。
14. **TC-COACH-014 战术码** `P1` — 导出 12 位战术码再导入；预期：还原一致；非法码给出拒绝提示。
15. **TC-COACH-015 战术存档** `P2` — 命名存档、列表、删除；预期：存档名可重复处理明确，删除后列表同步。
16. **TC-COACH-016 教练权限边界** `P0` — coach 会话直接请求 `/api/admin/*` 与 `/api/admin/accounts/*`；预期：403（不是 200，也不是 500）。

### H. 伤停与停赛（TC-INJ / TC-SUS）

1. **TC-INJ-001 伤停登记** `P0` — 在 `/admin/injuries` 选球员 + 伤情 + 受伤场次登记；预期：写入成功并在集中页可见。
2. **TC-INJ-002 同一事件重复登记** `P1` — 对同一 `event_id` 再登记一次；预期：被 `idx_injury_event_uniq` 拒绝，文案说明已登记。
3. **TC-INJ-003 事件无球员提示** `P2` — 选一个没记球员的事件登记伤情；预期：提示「该事件没记球员，先去赛程里补上球员」。
4. **TC-INJ-004 缺阵候选** `P1` — 请求缺阵候选列表；预期：按比赛列出应缺阵球员（伤停窗口计算正确）。
5. **TC-INJ-005 伤停编辑与删除** `P1` — 修改伤情名/备注，再删除一条；预期：缺阵名单与公开端露出同步变化。
6. **TC-INJ-006 伤停集中页** `P1` — 使用搜索（按名字）、球队与伤情过滤；预期：结果正确，空结果有空态。
7. **TC-INJ-007 公开露出** `P1` — 查看赛事页伤停板块与单场缺阵标记；预期：与登记一致（`injured` 标记出现）。
8. **TC-INJ-008 伤情快讯** `P2` — 登记伤情后查看快讯与周报；预期：伤情进入叙事且措辞正确。
9. **TC-INJ-009 停赛规则配置** `P0` — 在赛事管理页「停赛规则」改直红停赛/两黄变一红停赛/黄牌阈值；预期：保存成功，榜单停赛场数随之变化；填负数/11/小数 → 400「停赛场数与黄牌阈值须为 0-10 的整数」。
10. **TC-INJ-010 配置段隔离** `P1` — 改停赛规则后检查同分规则；预期：`tiebreakers` 等其它 `config_json` 键保留（只改 `suspension` 段）。
11. **TC-INJ-011 红牌停赛消耗口径** `P0` — 直红停 2 场：轮空场不计、pending 不消耗、弃权方不消耗、双弃权双方都不消耗；预期：逐场核对停赛场数。
12. **TC-INJ-012 两黄变一红停赛** `P1` — 同场两黄（1 黄 + 1 `red_2y`）；预期：停 1 场，且同场黄牌不计入黄牌累积。
13. **TC-INJ-013 黄牌阈值与清零** `P1` — 满阈值后停 1 场并清零；阈值设 0；预期：阈值 0 时只累计不停赛。
14. **TC-INJ-014 并行叠加** `P1` — 同一球员既有红牌停赛又有黄牌累积；预期：两者并行，剩余场数为叠加而不是取大。
15. **TC-INJ-015 清零锚点** `P1` — 点清零黄牌（`reset-yellows`）；预期：仅锚点之后的黄牌重新计数（毫秒时间戳参与字典序比较），红牌照常消耗；锚点值在改配置时被保留。
16. **TC-INJ-016 榜单停赛标记与排序** `P1` — 查看射手榜/红黄牌榜；预期：`suspended`/`injured` 标记正确，按剩余停赛场次降序、再黄牌数降序。

### I. 公告与互动（TC-ANN / TC-INT）

1. **TC-ANN-001 公告发布** `P1` — 在管理端发布一条公告；预期：门户公告位显示，时间正确。
2. **TC-ANN-002 公告编辑** `P1` — 编辑已发布公告内容；预期：覆盖生效，标题与正文都更新。
3. **TC-ANN-003 公告无内容降级** `P2` — 无公告时打开门户；预期：公告位隐藏或显示空态，不出现破版。
4. **TC-ANN-004 公告缓存时效** `P2` — 发布公告后立即刷新；预期：≤5 分钟生效（`pubCache(300)`，不是缺陷）。
5. **TC-ANN-005 快讯 feed 缓存** `P2` — 连续请求 `/api/public/feed`；预期：命中 KV 时快速返回，过期回源重建；内容与 DB 一致。
6. **TC-INT-001 MOTM 投票** `P1` — 登录用户对一场比赛投最佳球员；预期：投票成功并可查结果；同场重复投行为明确（覆盖或拒绝）。
7. **TC-INT-002 MOTM 未登录** `P1` — 未登录投票；预期：401，前端引导登录。
8. **TC-INT-003 MOTM 限流** `P1` — 同 IP 60 秒内投 11 次；预期：第 11 次返回 429。
9. **TC-INT-004 快讯表态匿名** `P1` — 未登录对快讯表态；预期：成功、票数增加、刷新保留。
10. **TC-INT-005 表态参数与限流** `P1` — 一次请求 >50 个 `ids` → 拒绝；同 IP 60 秒内第 31 次 → 429。
11. **TC-INT-006 互动与卡片联动** `P2` — 表态后返回快讯列表；预期：票数立即同步显示。

### J. 媒体与内部通道（TC-MED / TC-INT2）

1. **TC-MED-001 合法媒体读取** `P0` — 请求 `/api/media/team/<id>/<file>` 与 `/api/media/tournament/<id>/<file>`；预期：200，`Content-Type` 正确。
2. **TC-MED-002 非法 key 拒绝** `P0` — 请求不匹配 `^(team|tournament)/\d+` 的 key（含路径穿越）；预期：404/403，绝不返回任意对象。
3. **TC-MED-003 缓存头** `P2` — 检查响应头；预期：`immutable` 且有效期 1 年；换图后 key 版本化，旧 key 不再被页面引用。
4. **TC-MED-004 上传类型与体积** `P1` — 上传非白名单类型与 >1MB 文件；预期：拒绝且不写 R2。
5. **TC-INT2-001 内部通道缺签名** `P0` — `POST /api/internal/team-upsert` 不带 `X-Sign`/`X-Timestamp`；预期：403（fail-closed）。
6. **TC-INT2-002 签名与时间戳校验** `P0` — 签名错误 → 403；时间戳偏差 >|300s| → 403；正确签名 → 200。
7. **TC-INT2-003 未配置密钥** `P0` — 移除 `TEAM_SYNC_SECRET` 后请求；预期：503（不是 200，也不能建队）。
8. **TC-INT2-004 重放与幂等** `P1` — 同一请求发两次；预期：幂等，不产生重复球队。
9. **TC-INT2-005 gameTeamId 契约** `P1` — 通过 `team-upsert` 建队后核对；预期：`team.id == gameTeamId == club.clubs.id` 三者一致。
10. **TC-INT2-006 出站推送失败处理** `P1` — 让俱乐部平台不可达后建队；预期：本地不阻断、失败可查（有日志或状态字段），不产生"半建"数据。

### K. 通用、权限与平台（TC-GEN）

1. **TC-GEN-001 权限矩阵回归** `P0` — 用游客/coach/admin/superadmin 四个会话按第 7 节表格逐组请求；预期：401/403/200 与表格完全一致，**且在 OIDC 模式与兼容模式各跑一遍**。
2. **TC-GEN-002 403 响应形状** `P1` — 触发权限不足；预期：`{error:"forbidden", message:"需要超级管理员权限"/"需要管理员权限"}`，前端能读出 message 提示。
3. **TC-GEN-003 超管专属端点** `P0` — 普通 admin 请求 `PUT /org-settings`、扣分 PATCH、`/accounts/*`；预期：全部 403；superadmin 全部 200。
4. **TC-GEN-004 强制改密边界** `P0` — 见 TC-AUTH-016/017；此处核对管理端所有子路由（teams/tournaments/matches/accounts/audit/announcements/injuries/proxy-grants/sync-rosters）都被拦截。
5. **TC-GEN-005 SPA 深链兜底** `P0` — 直接访问并刷新 `/admin/t/1`、`/t/1/match/1`；预期：返回 SPA 而不是 404（`not_found_handling: single-page-application`）。
6. **TC-GEN-006 run_worker_first** `P0` — 请求 `/api/public/tournaments`；预期：由 Worker 处理（不是静态资源 404）。
7. **TC-GEN-007 未匹配 API 路径** `P1` — 请求 `/api/nope`；预期：JSON `{error:"not_found"}`，不是 HTML。
8. **TC-GEN-008 前端超时行为** `P2` — 模拟慢响应；预期：常规 15s、Blob 60s 超时后给出可读提示，`ApiError` 含 `status/code`。
9. **TC-GEN-009 轮询与缓存对齐** `P2` — 打开 live 场与首页，切到后台再切回；预期：60s 轮询与服务端 TTL 对齐，切回后不出现长时间陈旧数据。
10. **TC-GEN-010 版本号一致** `P2` — 页脚版本 = `package.json.version` = 本次发布说明版本。
11. **TC-GEN-011 cron 执行** `P1` — 观察整点触发；预期：`runRosterSync` 与 `runAccountMirror` 均完成，observability 有痕迹，无异常删除。
12. **TC-GEN-012 账号真源投影** `P1` — 在认证中心改某账号角色，等投影；预期：本仓 `user` 行随之更新，权限判断（OIDC 模式）跟随 `permissions`。
13. **TC-GEN-013 签名金标准** `P1` — 用已知密钥/时间戳/路径/体构造 `X-Sign`；预期：与 club 仓签名逐字同值（跨仓契约回归）。
14. **TC-GEN-014 读消耗治理守卫** `P1` — 跑 `npx vitest run tests/d1-read-plan.test.ts`；预期：16 用例全过（关键查询计划形状未坏）。
15. **TC-GEN-015 大列表执行计划** `P1` — 跑 `npx vite-node scripts/d1-read-audit/smoke.mts`（或在生产副本上）；预期：读消耗不超 `cost-model.json` 上限，无新增全表扫。
16. **TC-GEN-016 中文与日期格式** `P3` — 全站巡检；预期：无英文残留，日期为 `zh-CN` 格式。
17. **TC-GEN-017 窄屏可用性** `P2` — 375px 宽度下走一遍公开端与教练端主流程；预期：无横向溢出、关键按钮可点。

---

## 10. 覆盖矩阵与缺口清单

### 10.1 端点 → 用例映射

| 模块 | 端点组 | 自动化覆盖 | 手工覆盖 |
| --- | --- | --- | --- |
| `/api/auth` | register / login / logout / password / me / login / sync / callback / backchannel-logout | `oidc.test.ts`（17）、`machine.test.ts` | TC-AUTH-001~021 |
| `/api/public` | tournaments、tournaments/:id、matches*、lineup、h2h、lineup-stats、upcoming、live、recent、standings、toplists、injuries、stats | `public.lists.routes.test.ts`（待打/摘要）、`home.route.test.ts`、`injury.routes.test.ts`、`topstats`、`scorers` | TC-PUB-003~013、021~025 |
| `/api/public`（门户） | announcement、feed、home、weekly、report、round | `home.route.test.ts`、`injury.news.test.ts`、`weekly.fallback.test.ts`、`news.*` | TC-PUB-015~019、TC-ANN-* |
| `/api/admin`（赛事/报名/扣分） | tournaments CRUD、transition、entries、deduction、cover、audit、stats、toplists、injuries、team-players | 本次 `scoring.finish.routes.test.ts`、`standings.rebuild.test.ts`（含扣分导致名次位移） | TC-TOUR-001~021 |
| `/api/admin`（赛制/赛程） | stages CRUD、generate、draw、matches、bulk、complete-double、清除 | 本次 `schedule.generate.routes.test.ts`（35，含季军赛回填）、`schedule.bulk.routes.test.ts` | TC-SCH-001~027 |
| `/api/admin/matches`（报分/事件） | start、finish、events CRUD、lineup | 本次 `scoring.finish.routes.test.ts`（33，含 finish 19 + events 9） | TC-SCO-001~022 |
| `/api/admin`（球队） | teams CRUD、bulk、logo、context、sync-club、members、auth-codes | `clubTeamSync.test.ts`（含批量建队/报名） | TC-TEAM-001~009、013~014 |
| `/api/admin`（名册） | sync-rosters | `rosterSync.test.ts`（23） | TC-TEAM-010~012 |
| `/api/admin`（伤停/停赛） | injuries CRUD、candidates、events、suspensions、reset-yellows | `injury.*`、本次 `suspension.replay.test.ts`（20） | TC-INJ-001~016 |
| `/api/admin`（账号/审计/公告/代打/org） | accounts/*、audit、announcements、proxy-grants、org-settings、signup-codes | `lineupProxy.routes.test.ts`（代打两端） | TC-AUTH-019、TC-TOUR-020、TC-ANN-*、TC-COACH-011/012、TC-GEN-003 |
| `/api/coach` | bind、me/*、lineup、proxy/*、bootstrap、tactics | `coach.bootstrap.test.ts`、`coach.status.routes.test.ts`、`lineupProxy.routes.test.ts`、`assign.test.ts` | TC-COACH-001~016 |
| `/api/interact` | motm、reactions | 无 | TC-INT-001~006 |
| `/api/media` | GET `/*` | 无 | TC-MED-001~004 |
| `/api/internal` | team-upsert | `clubTeamSync.test.ts`（签名金标准、fail-closed） | TC-INT2-001~006 |

### 10.2 页面 → 用例映射

| 页面（路由） | 手工用例 |
| --- | --- |
| `/` Home | TC-PUB-001/002/026 |
| `/t/:id` PublicTournament（5 tab） | TC-PUB-005~010、TC-INJ-007 |
| `/t/:id/match/:mid` | TC-PUB-011~013 |
| `/news`、`/weekly`、`/report/:mid`、`/recap/...` | TC-PUB-015~019 |
| `/tactics` | TC-PUB-020、TC-COACH-013~015 |
| `/login`、`/register`、`/password` | TC-AUTH-001~021 |
| `/my-team` | TC-COACH-001~009 |
| `/admin`、`/admin/t/:id` | TC-TOUR-001~021、TC-SCH-*、TC-SCO-* |
| `/admin/teams`、`/admin/teams/:id` | TC-TEAM-001~009、013~014 |
| `/admin/injuries` | TC-INJ-001~008 |
| `/admin/codes` | TC-AUTH-010~014、TC-TEAM-014 |
| `/admin/accounts`、`/admin/audit` | TC-AUTH-019、TC-GEN-003、TC-TOUR-020 |

### 10.3 缺口清单（已知未覆盖，按建议优先级）

| # | 缺口 | 影响 | 建议 |
| --- | --- | --- | --- |
| G1 | **无 CI**：typecheck 与 test 全靠本地执行 | 回归可能被整体绕过 | 加 GitHub Actions：`npm ci && npm run typecheck && npm test`（本次范围外） |
| G2 | **无覆盖率统计** | 不知道盲区在哪，只能靠人工盘点（即本文件） | 引入 `@vitest/coverage-v8`，先只做报告不做门禁 |
| G3 | **无 lint / format / pre-commit** | 风格与低级错误靠 review | 引入 ESLint + Prettier，或最低限度加 pre-commit 跑 typecheck |
| G4 | **无前端组件测试与 E2E** | 页面交互、跨页状态、真机布局无自动回归 | 下一阶段评估 Playwright（含移动端视口） |
| G5 | **`/api/interact/*` 完全无自动化** | MOTM 与 reactions 是匿名写端点，最易被刷爆 | 补 `tests/interact.routes.test.ts`（限流 429、匿名投票、>50 ids） |
| G6 | **`/api/media/*` 无自动化** | key 白名单与缓存头是安全边界 | 补 key 匹配与缓存头断言（R2 可 stub） |
| G7 | ~~赛程事件端点 CRUD 无独立文件~~ **本次已闭合** | — | `POST/GET/PUT/DELETE events` 已在 `tests/scoring.finish.routes.test.ts` 覆盖 9 例：校验顺序（分钟范围先于比赛状态）、实时比分累计与乌龙计对方、第二张黄牌自动转 `red_2y`、球员/助攻归属六类 400、伤病事件悬挂与级联撤销、GET 列表字段。管理端 `GET /matches/:id/lineup` 由 `lineupProxy.routes.test.ts` 覆盖，无需新增文件 |
| G8 | **账号管理端点（accounts/*）无自动化** | 重置密码、禁用、撤销会话是敏感操作 | 补 `tests/admin.accounts.routes.test.ts`（需 stub authAdmin） |
| G9 | **cron 无测试** | 名册同步与账号投影的定时入口无回归 | 直接对 handler 函数做集成测试（不依赖真实 cron） |
| G10 | **`admin.live.test.ts` 常驻跳过** | 机器通道无真实联调回归 | 在发版流程里显式要求启动 auth 8792 并执行（S5） |
| G11 | **无 `engines` 声明** | 低版本 Node 上 `node:sqlite` 直接失败 | 补 `"engines": { "node": ">=22.5" }` |
| G12 | **公开端 h2h / lineup-stats / rounds / live / recent / stats 无自动化** | 公开端细节口径易漂移 | 随下次改动就近补测 |

---

## 11. 缺陷报告模板与严重度定义

### 11.1 严重度定义

| 级别 | 判定标准 | 例子 |
| --- | --- | --- |
| **Critical** | 数据被写坏且无报错，或核心流程完全不可用 | 积分榜/晋级对阵算错（D1）、内容投影不一致导致一写 500（R3）、名册同步误删球队 |
| **High** | 主要功能不可用或结果错误但有报错；权限可被绕过 | 报分失败、归档后仍可改数据、普通 admin 能调超管端点 |
| **Medium** | 边缘场景错误、状态残留、文案误导 | 回滚残留 `finished_at`（D2）、榜单 rank 重复（D3）、决胜链失效（D4） |
| **Low** | 体验问题、样式/文案、缓存时效观感 | 缓存导致的"看起来没更新"、窄屏溢出 |

### 11.2 缺陷模板

```markdown
### BUG-<序号> <一句话标题>

- **严重度**：Critical / High / Medium / Low
- **优先级**：P0 / P1 / P2
- **环境**：dev / 生产 · 版本 vX.Y.Z · 认证模式 oidc/compat · 浏览器
- **关联用例**：TC-XXX-000
- **复现步骤**：
  1. …
  2. …
- **实际结果**：（贴请求/响应、截图、D1 查询结果）
- **期望结果**：
- **影响范围**：（哪些赛事/队伍/榜单受影响；是否已写坏数据，是否需要数据修复）
- **数据修复建议**：（如有）
- **证据**：`file:line`、日志片段、失败断言
```

### 11.3 已知行为缺陷（BUG 预登记）

| ID | 标题 | 严重度 | 关联断言 | 状态 |
| --- | --- | --- | --- | --- |
| BUG-001 | 自动回填用混合代数据决定淘汰赛对阵（D1） | Critical | `tests/scoring.finish.routes.test.ts`「autoFill 取人当前使用旧积分榜快照」 | 已钉住，待修 |
| BUG-002 | 报分失败回滚残留 `finished_at`（D2） | Medium | 同上「409 回滚不复原 finished_at」 | 已钉住，待修 |
| BUG-003 | 循环赛与小组赛并存时榜单 rank 按组重复编号（D3） | Medium | `tests/standings.rebuild.test.ts`「D3：group_id 泄漏到循环赛阶段」 | 已钉住，待修 |
| BUG-004 | `tiebreakers` 全非法值时不回退默认链（D4） | Medium | 同上「非法决胜链不回退默认」 | 已钉住，待修 |
| BUG-005 | 同阶段多组 (round, slot) 重号（D5） | Low | `tests/schedule.generate.routes.test.ts`「两组各自 slot 从 1 起」 | 已钉住，待修 |

---

## 12. 测试运行报告模板

```markdown
# 测试运行报告 · vX.Y.Z

- **版本**：package.json version = ?
- **提交**：<sha>
- **环境**：dev / 生产副本 · Node 版本 · 认证模式
- **执行人 / 日期**：

## 1. 自动化结果
| 套件 | 命令 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 类型门禁 | `npm run typecheck` | PASS/FAIL | |
| 全量单测 | `npm test` | 通过/失败 用例数 | |
| D1 读计划守卫 | `npx vitest run tests/d1-read-plan.test.ts` | | |
| 跨服务冒烟 | `node scripts/smoke-oidc-local.mjs` | | |
| 实联（可选） | `tests/admin.live.test.ts` | 执行/跳过 | |

## 2. 手工执行结果
| 域 | 用例总数 | P0 通过 | P1 通过 | 未执行 | 备注 |
| --- | --- | --- | --- | --- | --- |
| TC-PUB 公开观赛 | | | | | |
| TC-AUTH 账号认证 | | | | | |
| TC-TOUR 赛事管理 | | | | | |
| TC-SCH 赛制编排 | | | | | |
| TC-SCO 报分事件 | | | | | |
| TC-TEAM 球队名册 | | | | | |
| TC-COACH 教练端 | | | | | |
| TC-INJ 伤停停赛 | | | | | |
| TC-ANN/INT 公告互动 | | | | | |
| TC-MED/INT2 媒体与内部通道 | | | | | |
| TC-GEN 通用权限 | | | | | |

## 3. 缺陷
| BUG | 严重度 | 标题 | 状态 |
| --- | --- | --- | --- |

## 4. 准出判定
- [ ] P0 全通过
- [ ] P1 通过率 ≥ 90%
- [ ] 无未决 Critical / High
- [ ] 冒烟套件已跑并留痕
- 结论：**可以发布 / 不可以发布**（理由）

## 5. 未执行项与原因
```

---

## 附录 A：端点全量清单

`/api/*` 入口见 `worker/index.ts:30-38`；`/api/admin/*` 统一前置 `requirePermission("tour.match.manage")` + `requirePwChanged`（`worker/routes/admin.ts:34-35`）。

| 前缀 | 端点 |
| --- | --- |
| `/api/auth` | POST `/register`、POST `/login`、POST `/logout`、POST `/password`、GET `/me`、GET `/login`、GET `/sync`、GET `/callback`、POST `/backchannel-logout` |
| `/api/public` | GET `/tournaments`、`/tournaments/:id`、`/tournaments/:id/matches`、`/tournaments/:id/matches/rounds`、`/tournaments/:id/matches/summary`、`/tournaments/:id/matches/:mid`、`/matches/:mid/lineup`、`/tournaments/:id/matches/:mid/h2h`、`/tournaments/:id/matches/:mid/lineup-stats`、`/upcoming`、`/live`、`/recent`、`/tournaments/:id/standings`、`/tournaments/:id/toplists`、`/tournaments/:id/injuries`、`/tournaments/:id/stats` |
| `/api/public`（门户） | GET `/announcement`、`/feed`、`/home`、`/weekly`、`/matches/:mid/report`、`/tournaments/:tid/round/:sid/:round` |
| `/api/admin` | GET/PUT `/org-settings`、POST/GET `/signup-codes`、POST/GET `/teams/:id/auth-codes`、GET `/teams/:id/members`、DELETE `/teams/:id/members/:userId` |
| `/api/admin/teams` | GET `/`、POST `/`、POST `/bulk`、GET `/:id`、GET `/:id/context`、PATCH `/:id`、POST `/:id/sync-club`、DELETE `/:id`、PUT/DELETE `/:id/logo` |
| `/api/admin/tournaments` | GET `/`、POST `/`、GET `/:id`、GET `/:id/standings`、PATCH `/:id`、POST `/:id/transition`、DELETE `/:id`、POST `/:id/entries`、POST `/:id/entries/bulk`、DELETE `/:id/entries/:entryId`、PATCH `/:id/entries/:entryId/deduction`（超管）、GET `/:id/toplists`、`/:id/injuries`、`/:id/team-players`、`/:id/team-injuries`、`/:id/suspensions`、`/:id/audit`、`/:id/stats`、PUT `/:id/suspensions`、POST `/:id/suspensions/reset-yellows`、PUT/DELETE `/:id/cover` |
| `/api/admin/tournaments`（赛程） | POST `/:id/stages`、DELETE `/:id/stages/:stageId`、PATCH `/:id/stages/:stageId/name`、POST `/:id/stages/:stageId/generate`、POST `/:id/stages/:stageId/draw`、PATCH `/:id/stages/:stageId/entries/:entryId/group`、POST `/:id/stages/:stageId/matches`、POST `/:id/stages/:stageId/matches/bulk`、GET `/:id/matches`、DELETE `/:id/matches/:matchId`、DELETE `/:id/stages/:stageId/matches`、POST `/:id/stages/:stageId/complete-double` |
| `/api/admin/matches` | POST `/:id/start`、POST `/:id/finish`、POST `/:id/events`、DELETE `/:id/events/:eventId`、PUT `/:id/events/:eventId`、GET `/:id/events`、GET `/:id/lineup` |
| `/api/admin/accounts`（全部超管） | GET `/catalog`、GET `/`、GET `/:id`、PATCH `/:id/roles`、PUT `/:id/grants`、POST `/:id/reset-password`、POST `/:id/unlock`、POST `/:id/disable`、POST `/:id/sessions/revoke` |
| `/api/admin/audit` | GET `/` |
| `/api/admin/announcements` | GET `/`、POST `/`、PUT `/:id` |
| `/api/admin/injuries` | GET `/`、GET `/events`、GET `/candidates`、POST `/`、PUT `/:id`、DELETE `/:id` |
| `/api/admin/proxy-grants` | GET `/`、GET `/context`、GET `/match/:mid`、POST `/`、DELETE `/:id` |
| `/api/admin`（名册） | POST `/sync-rosters` |
| `/api/coach` | POST `/bind`、GET `/me/team`、`/me/matches`、`/me/status`、GET/PUT `/matches/:mid/lineup`、GET `/proxy/sessions`、GET `/bootstrap`、GET `/proxy/:mid/board`、PUT `/proxy/:mid/lineup`、GET/POST `/tactics`、DELETE `/tactics/:id` |
| `/api/interact` | POST `/matches/:mid/motm`、GET `/matches/:mid/motm`、POST `/reactions/:itemId`、GET `/reactions` |
| `/api/media` | GET `/*`（key 须匹配 `^(team\|tournament)/\d+`） |
| `/api/internal` | POST `/team-upsert`（HMAC fail-closed） |

---

## 附录 B：本次新增自动化资产

| 文件 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `tests/scoring.finish.routes.test.ts` | 33 | start 5 例（pending→live + 审计、非 pending 拒绝、轮空、对阵未定、404）；finish 19 例（快速报分、事件累计含乌龙、改判需完整比分并写 `match_rescore`、轮空/归档/弃权/点球各守卫、晋级回填、下游开打 409 回滚、D2 回滚残留、D1 混合代取人现状）；events 9 例（校验顺序、实时比分累计、第二张黄牌自动转 `red_2y`、球员/助攻归属与组合校验、类型白名单、删除回退比分、编辑不误转 `red_2y`、伤病事件 409 与级联、GET 列表） |
| `tests/schedule.generate.routes.test.ts` | 35 | 淘汰赛（8/6/4/2 队、种子位、轮空、legs/final_legs、季军赛及其**回填连线**）、循环赛（单/双循环、主客平衡含 4 队退化 `balanced=false`、重复生成幂等）、小组赛（分桶、skipped、D5 slot 重号）、抽签（分配/重抽/容量与报名守卫/409）、名次取人（1v4-2v3、返回体 `source:"topN"`、五类守卫）、一键清除、单场删除、complete-double（镜像 `round+k`、幂等、五类守卫）、阶段结构增删与 draft/running 限制 |
| `tests/suspension.replay.test.ts` | 20 | 直红/两黄变一红/并行叠加、黄牌累积与阈值（含阈值 0 只累计）、轮空与弃权消耗口径（主队/客队/双弃权三种）、清零锚点两遍重放（含 `created_at` 恰等于锚点的边界取向）、配置 PUT 归一（数字串、小数 floor、走私 `yellowResetAt` 无效、不动 `tiebreakers`、坏值逐字段回退）、榜单 `suspended` 标记与排序、三端点 404 且校验先于存在性 |
| `tests/standings.rebuild.test.ts` | 18 | 计分口径（胜 3 平 1 负 0、点球平局 +2/+1、双弃权、单方弃权 0:3、两回合各算一场且 h2h 合计）、幂等与作用域、排序链（默认链、h2h 优先、链可配、D4 钉住、gd↔gf 换序）、小组与循环赛共存（组内 rank、D3 钉住）、扣分（写入、负数、0 清除、400/404、改判后仍按当前扣分计算、扣分导致名次位移） |

---

## 附录 C：已钉住的行为缺陷详情（D1–D5、T1）

### D1 · 自动回填用混合代数据决定对阵（Critical）

`worker/routes/admin/scoring.ts` 的 finish 是两段式提交：先写入终场比分，再构建后续语句。`buildStandingsStmts`（重算积分榜）与 `buildAutoFillStmts`（生成下一阶段对阵）在**同一次** `DB.batch` 里执行，但 `buildAutoFillStmts` 内部（`worker/routes/admin/schedule.ts:1232` 调 `takeRangePool`）读到的 `standing` 表**还是上一场的快照**（不含刚完赛这一场），而同一排序里的 h2h 子查询读的是**最新的 match 行**。于是名次是「旧积分 + 新互相战绩」的混合口径。

**可复现夹具**（已写入 `tests/scoring.finish.routes.test.ts`）：4 队循环赛、目标阶段配 `{"source":{"take":2}}`，场次 800(500v501 1:0)、801(500v503 1:0)、802(502v501 0:1)、803(502v503 0:3)。803 完赛后真实第 2 名是 503（3 分、净胜 +2），实际生成的淘汰赛对阵却是 **500 vs 501**。

**修法方向**：让取人查询基于 match 表现算名次，或把积分重算与取人拆成两个 batch（先重算再取人）。

### D2 · 报分失败回滚残留 `finished_at`（Medium）

finish 的 `AdvancerError` 补偿语句（`worker/routes/admin/scoring.ts:289-309`）复原了 `score_home/score_away/pen_home/pen_away/status/winner_entry_id/walkover_side/note`，**没有复原 `finished_at`**。结果：比赛退回 `pending` 却留着终场时间戳，公开端「最近完赛」（按 `finished_at` 倒序）会把这场待打比赛当成完赛场次展示。断言：`expect(matchOf(sqlite, 820).finished_at).not.toBeNull()`。

### D3 · 榜单 rank 按组分子块编号（Medium）

`buildStandingsStmts` 对**所有**阶段都把 `entry.group_id` 复制进 `standing.group_id`（`worker/lib/standings.ts` 的 INSERT 列），而 `readStandings` 按 `groupId ?? 0` 分桶、`rank` 是桶内编号。后果：同一赛事既有小组赛阶段又有循环赛阶段时（例如 group→round_robin→elim），循环赛榜单对外只呈现一组，rank 呈 `1,2,1,2,1,2`，且分块顺序是 `group_id` 首次出现顺序而非全局积分序；h2h 也只在桶内生效。纯 `round_robin` 赛事（报名无 `group_id`）不受影响。断言见 `tests/standings.rebuild.test.ts` 赛事 9 / 阶段 84。

### D4 · `tiebreakers` 全非法值不回退默认链（Medium）

`normalizeTiebreakers(v)`（`worker/lib/standings.ts:438-445`）只对**非数组**回退 `DEFAULT_TIEBREAKERS`；数组里全为非法值时返回空数组，注释写「缺省回退默认链」与实际不符。后果：决胜链为空，连 `h2h` 一起失效，同分只按 seed 排序。已钉住：`{tiebreakers:["nonsense","nope"]}` → 名次为纯 seed 序。

### D5 · 同阶段多组 (round, slot) 重号（Low）

小组赛生成时 `slotOf` map **每组重置**（`worker/routes/admin/schedule.ts` 的 group 分支），因此同阶段不同组的第 1 轮各有一场 `slot=1`。库内 `match` 表无 `(stage_id, round, slot)` 唯一约束（只有 `idx_match_stage` 普通索引）。任何按 `(round, slot)` 作唯一键的下游逻辑会静默合并场次；正确做法一律用 `match.id`。断言：两组各自 `slot` 从 1 起。

### T1 · 测试桩 `DB.batch` 内的 SELECT 恒返回空（测试基建缺陷，已在本次修复）

`tests/d1.ts` 的 `createTestD1` 原实现里 `batch()` 对每条语句只调 `await st.run()`，而 shim 的 `run()` 只返回 `{meta:{changes,last_row_id}}`。但**真实 D1 的 `batch` 对 SELECT 会带回结果行**，因此任何「把 SELECT 放进同一 batch 再读回」的路由代码在测试里都拿到空结果。这是**静默失真**：既能掩盖真实回归（测试全绿但路径没被验证），也让 HTTP 级断言无法成立——本次 `POST /matches/:id/events` 的实时比分恒为 `0` 就是这样暴露的。

**修复**：给 `prepare` 返回的语句加 batch 专用方法 `__exec()`——SQL 匹配 `/^\s*(select|with)/i` 时返回 `{meta:{changes:0,last_row_id:0}, results: exec.all(...args)}`，否则走 `run()`；`batch()` 优先调 `__exec()`、回落 `run()`。原 `run()` 公开形状未变（既有调用方零影响）。修好后全量 366 用例仍全绿，且新写的实时比分断言由「恒 0」变为真实值。

**教训**：当断言依赖「批次内读回」时，先在测试桩上确认该读回路径真能取到数据；否则「断言通过」只证明了读到空这条路径。
