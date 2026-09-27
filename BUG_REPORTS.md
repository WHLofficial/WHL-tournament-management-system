# WHL 赛事管理系统 · 缺陷报告

| 项目 | 内容 |
| --- | --- |
| 被检应用 | `whl-tournament` v5.0.4（Cloudflare Worker + React SPA 同仓同部署） |
| 报告日期 | 2026-09-26 |
| 报告依据 | 本轮测试交付：`TEST_PLAN.md` + 4 个回归测试文件（106 用例）；下列缺陷均已由**通过中的断言**钉住现状 |
| 生产域名 | https://tour.whleague.win |
| 复现环境 | 本地 Node v24.12.0 + Vitest 3.2.7（`tests/d1.ts` 的 `node:sqlite` 桩件，已 `PRAGMA foreign_keys = ON`）；本地 Worker dev（`npm run dev`，8790）；生产同代码路径 |
| 关联文档 | `TEST_PLAN.md`（11.3 BUG 预登记表 / 附录 C 缺陷详情）、`VERSIONS.md`、`TECH_DESIGN.md` |

## 0. 取证方式与可信度声明

本报告的每一条「实际行为」都来自**已经执行过**的自动化断言——不是阅读代码后的推测。复跑方式与结果：

```
npm test          # 28 passed | 1 skipped (29 files)、359 passed | 7 skipped (366 tests)
npx vitest run tests/scoring.finish.routes.test.ts tests/standings.rebuild.test.ts
```

这些断言当前**全部通过**，因为它们记录的正是产品的现状行为（缺陷）。因此每条缺陷都附了一节「修复后验收断言」，写明修复完成后该断言应当改成什么——这也是修复是否真正生效的判据。

与之相对，本报告中标注 **（未实操）** 的「手工复现步骤」是依据代码路径推导出来的操作序列，给出了每一步的预期与实际。我没有在浏览器里完整点过这些流程（本轮计划明确不做 E2E），所以它们需要在本地或生产环境按步骤确认一次；其中「实际行为」一栏写的是代码可证的后果，不是我的观察记录。凡我未能证实的猜测，一律标注为「待确认」而不是当作结论。

界面可见性的判定依据是具体组件的渲染行（都有 `文件:行号`），不是「应该会显示」。

---

## 1. 缺陷概览

| ID | 对应 | 标题 | 严重度 | 优先级 | 类型 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| BUG-001 | D1 | 阶段收官自动生成淘汰赛对阵时，取人读到的是陈旧积分榜快照 → **晋级对阵写错队** | Critical | P1 | 功能 / 数据正确性 | 已修（v5.0.6） |
| BUG-002 | D2 | 报分 409 回滚未复原 `finished_at` → 比赛退回 pending 却留着终场时间戳 | Medium | P2 | 数据一致性 | 已修（v5.0.7） |
| BUG-003 | D3 | 小组赛与循环赛阶段并存时，循环赛榜单名次按 `entry.group_id` 分桶重复编号 | Medium | P2 | 功能 / 展示 | 待修（已钉住） |
| BUG-004 | D4 | `tiebreakers` 为空数组或全非法值时退化成一整条空决胜链，不回退默认链 | Low | P2 | 功能 / 契约 | 已修（v5.0.7，哨兵方案） |
| BUG-005 | D5 | 小组赛阶段内每组 `slot` 从 1 重新计数 → 同阶段 `(round, slot)` 重号 | Low | P3 | 数据模型 / 展示 | 待修（已钉住） |
| BUG-006 | 本轮新发现 | 积分榜页脚的同分规则说明是硬编码，与赛事实际配置不符 | Low | P3 | 展示 / 文案 | 已修（v5.0.7） |

**严重度定义**（沿用 `TEST_PLAN.md`，赛事系统对「竞赛结果正确性」按最高档处理）：

| 级别 | 判据 | 本仓典型后果 |
| --- | --- | --- |
| Critical | 数据写入错误且对外可见、竞赛结果不可信、需人工介入才能纠正 | 错误球队进入淘汰赛；比分/名次错算 |
| Medium | 功能部分失效或口径不一致，有绕过办法，不改变最终竞赛结果 | 榜单展示自相矛盾；时间戳残留 |
| Low | 界面/文案/边界口径问题，不影响业务判定 | 名次说明文案不符；列表顺序交错 |

**优先级定义**：P1 = 应尽快修（影响竞赛结果）；P2 = 下个维护窗口修；P3 = 排期修或随相关重构一并处理。

**修复建议批次**（详见附录 B）：第 1 批 BUG-001（唯一会写错数据的一条）；第 2 批 BUG-002 + BUG-003 + BUG-004（口径与一致性）；第 3 批 BUG-005 + BUG-006（展示与数据模型洁癖）。

---

## 2. 缺陷详情

## BUG-001：阶段收官自动生成的淘汰赛对阵使用陈旧积分榜快照，会写错晋级球队

**严重度：** Critical　**优先级：** P1　**类型：** 功能 / 数据正确性　**状态：** 已修（v5.0.6：重算语句先落库、回填取人改读最新快照；钉住断言已改为期望行为，并新增「末轮不改名次」回归用例）

### 环境
- 应用版本：v5.0.4（`package.json.version`）
- 触发角色：`admin`（`tour.match.manage` 权限即可，无需超管）
- 触发入口：管理员 `/admin/t/:id` → 比赛管理报分完赛（`POST /api/admin/matches/:id/finish`）
- 数据前置：赛事存在两个阶段，前一阶段为非淘汰（`group` / `round_robin`），后一阶段 `elim` 且配置了取人规则

### 描述
在循环赛/小组赛阶段**最后一场**报分完赛时，系统会自动按取人规则生成下一阶段淘汰赛首轮对阵（`worker/routes/admin/scoring.ts:282` → `buildAutoFillStmts`）。但取人用的积分榜与即时口径不一致：

- 排名主键（积分 pts、净胜球 gf/ga）读的是 `standing` **快照表**（`worker/lib/standings.ts:353` `readStandings`，经 `worker/routes/admin/schedule.ts:1053` 调用）；
- 而排序链里的相互战绩（h2h）子查询读的是**最新的 `match` 行**（`worker/lib/standings.ts:415` `const finishedRows = finished.results ?? [];` → `:426` 传给 `sortStandRows` → `:501` 的 h2h 小循环）。

自动回填发生在同一次请求里、且早于积分重算语句执行（`scoring.ts:269-272` 的注释已说明这是「先提交终场写入、后构建重算语句」的两段式设计，重算语句在 `scoring.ts:280` 构建、随 `scoring.ts:288` 的 batch 执行），于是回填读到的快照**不含刚刚完赛的这一场**，却混入了这一场带来的最新 h2h。结果：末轮改变的名次不被采纳，名次错误时**错误的球队被写进淘汰赛对阵**。

### 前置条件
- 赛事有 ≥3 支报名球队，前一阶段为非淘汰赛且已生成赛程；
- 后一阶段为淘汰赛，阶段配置带取人规则（UI 路径：赛程 tab 的「名次区间」写法为 `body.source = { from, to }`，见 `src/pages/ScheduleTab.tsx:1004-1008`；接口也可写 `{ take: n }`）；
- 触发完赛的那一场，其赛果改变了取人区间内的名次顺序。

### 复现步骤（自动化复现 —— 已执行）

```
npx vitest run tests/scoring.finish.routes.test.ts -t "取人读的是陈旧积分榜快照"
```

夹具（`tests/scoring.finish.routes.test.ts:402-450`）：4 队循环赛，阶段 70 只留 4 场（`800` = 500v501、`801` = 500v503、`802` = 502v501、`803` = 502v503），淘汰阶段 72 配 `{"source":{"take":2}}`。

1. 报分 `800` 1:0、`801` 1:0、`802` 0:1（501 胜）→ 此时快照里 500 = 6 分、501 = 3 分（净胜 0），第 2 名是 501；
2. 报分 `803` 0:3（503 胜）——这是阶段收官的一场，返回 `regenerated: true`；
3. **预期**：真实名次为 500（6 分，净胜 +4）→ 503（3 分，净胜 +2）→ 501（3 分，净胜 0），第 2 名是 **503**，淘汰赛首轮应为 `500 vs 503`；
4. **实际**：接口生成的淘汰赛对阵是 `{ home_entry_id: 500, away_entry_id: 501 }`（`tests/scoring.finish.routes.test.ts:449` 断言的就是这个现状值）。

注意同一时刻积分榜接口给出的排序是**正确**的：`tests/scoring.finish.routes.test.ts:437-438` 断言 `rows.map(r => r.entryId)` 等于 `[500, 503, 501, 502]`、503 的 `rank` 为 2。即「积分榜说 503 是第 2 名」与「对阵里写的是 501」在同一份数据上并存。

### 复现步骤（手工 —— 未实操）

1. 用 `admin` 登录，进 `/admin/teams` 建 4 支球队，进 `/admin/t` 建赛事并在赛程/报名处把 4 队全部报名（`/admin/t/:id` →「批量报名」/「从球队库添加」）；
2. 加阶段「常规赛」（`round_robin`）并生成赛程 → **预期**：4 队 6 场；**实际**：同；
3. 再加阶段「季后赛」（`elim`），在赛程 tab 的阶段配置里填「名次区间」1–2（`src/pages/ScheduleTab.tsx:1004`）→ **预期**：保存成功；
4. 在比赛管理里逐场报分，让最后一轮之前 501 恰好排在第 2 名；
5. 报分收官那一场，让 503 大比分取胜从而在积分上反超 501 → **预期**：季后赛首轮出现 `第 1 名 vs 第 2 名`，即包含 503；
   **实际（代码可证）**：首轮里出现的是 501；
6. 切到积分榜 tab 对照 → 那里 503 明确排第 2。两个 tab 的结论互相矛盾，但对阵已经被写进库。

### 预期行为
淘汰赛对阵按**收官那一刻的真实名次**生成：末轮结果计入积分（pts / 净胜球 / 进球数）与相互战绩之后再做取人；即上例首轮应为 `500 vs 503`。

### 实际行为
取人用的是「末轮之前的积分快照 + 末轮之后的相互战绩」的混合口径，末轮对积分/净胜球的影响丢失，501 被判为第 2 名并被写入淘汰赛首轮。

### 证据
- 触发点：`worker/routes/admin/scoring.ts:282` `const autoStmts = await buildAutoFillStmts(c.env, ctx.tournamentId, m.stage_id);`（定义在 `worker/routes/admin/schedule.ts:1096`）
- 快照来源：`worker/routes/admin/schedule.ts:1053` `const ranked = await readStandings(env.DB, srcStage.id, chain);`
- 口径分裂：`worker/lib/standings.ts:415` 读 live `match` 行做 h2h，`worker/lib/standings.ts:426` 用它排序快照行
- 实测断言：`tests/scoring.finish.routes.test.ts:437-438`（榜单正确）与 `:449`（对阵错误）同时通过
- 该缺陷**不会报错**：`buildAutoFillStmts` 对取人失败的守卫一律 `catch {}` / `continue` 静默跳过（`worker/routes/admin/schedule.ts:1231-1235`），但本例不是抛错路径，是被算错

### 影响
- **用户影响**：错误球队进入淘汰赛，且这个对阵会公开显示（公开赛程页 `src/pages/PublicTournament.tsx:288-353`）；若管理员未人工核对，比赛会按错误对阵开打直至产生错误冠军。
- **频率**：前置条件（非淘汰阶段 + 后一阶段配取人）满足时，只要**收官那场改变了取人区间内的名次**就必然发生；收官场不改变名次时不可见。
- **绕过办法**：收官后人工核对对阵，若错误则删除淘汰赛首轮场次重新生成（`DELETE /api/admin/tournaments/:id/stages/:stageId/matches` 后重生成）；但没有任何界面提示需要这样做。
- **可发现性**：低。积分榜与对阵不在同一屏（公开页与管理页都把 schedule / standings 分为不同 tab），必须跨 tab 对照才看得出。

### 根因
`POST /api/admin/matches/:id/finish` 是两段式提交（`scoring.ts:259-272` 先写终场、`:275-288` 再构建并执行重算/回填）。第二段里的语句是**一次性构建后整批执行**的，而 `buildAutoFillStmts` 在构建期就要读积分榜——此时第一段已提交、第二段的 `buildStandingsStmts` 尚未执行，所以读到的是上一轮的快照。虽然 h2h 用的是最新 `match` 行，但那只在「积分/净胜球/进球数全同」的并列块内才参与，无法掩盖末轮造成的分差变化。

### 修复建议
把「积分重算」与「自动回填」拆成两次 batch，让回填读到重算后的快照：

1. `scoring.ts:280` 之后先 `await c.env.DB.batch(standingsStmts)`；
2. 再 `const autoStmts = await buildAutoFillStmts(...)`，与 `auditStmt` 一起作第二次 batch；
3. 保持 `AdvancerError` 的 409 语义：回填阶段若抛错，仍按 `scoring.ts:289-309` 回滚终场写入（注意与 BUG-002 一并处理 `finished_at`）。

代价是收官那一场多一次 batch 往返（仅发生在阶段收官时，可接受）。替代方案是让 `takeRangePool` 不读快照表、改为现算（改动面更大，且要同步处理 D1 读量预算）。

### 修复后验收断言
- `tests/scoring.finish.routes.test.ts:449`：`away_entry_id` 由 `501` 改为 **`503`**；
- 新增：收官那场不改名次时，回填结果与修复前一致（防回归）。

### 关联
`TEST_PLAN.md` 附录 C 的 D1、11.3 表 BUG-001；风险表 R4/R5 相关；手工用例域 TOUR / SCH。

---

## BUG-002：报分失败回滚未复原 `finished_at`，留下「未开打却有终场时间」的比赛

**严重度：** Medium　**优先级：** P2　**类型：** 数据一致性　**状态：** 已修（v5.0.7：回滚 UPDATE 逐列复原补上 finished_at；钉住断言改 toBeNull 并新增改判冲突用例）

### 环境
- 应用版本：v5.0.4　**触发角色：** `admin`　**触发入口：** `POST /api/admin/matches/:id/finish`
- 触发条件：终场写入成功后的重算/晋级阶段抛出 `AdvancerError`（典型：下游场次已开打、需要换人）

### 描述
`finish` 在晋级冲突时返回 409 并执行补偿回滚（`worker/routes/admin/scoring.ts:289-309`）。补偿 UPDATE（`:292-305`）复原了 `score_home`、`score_away`、`pen_home`、`pen_away`、`status`、`winner_entry_id`、`walkover_side`、`note`，**唯独没有复原 `finished_at`**；而正常写入路径是设置它的（`scoring.ts:261-264` 的 `finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`）。于是回滚后比赛状态退回 `pending`，却带着一个看起来很正常的终场时间戳。

### 前置条件
- 淘汰赛阶段，某场下游比赛已经 `live`，且其场上球队与本次完赛将要产生的晋级方不同；
- 管理员对上游场次报分。

### 复现步骤（自动化复现 —— 已执行）

```
npx vitest run tests/scoring.finish.routes.test.ts -t "下游场次已开打且需换人"
```

夹具（`tests/scoring.finish.routes.test.ts:371-400`）：阶段 72 上 `820` = 500v501（pending）、`821` = 502vnull（winner 预填 502，虚拟位）、`822` = 503v502（**live**）。

1. 报分 `820` 1:0 → 晋级器要让 500 进入 `822`，而 `822` 已开打且场上是 503；
2. **预期**：409 + 回滚，比赛 `820` 回到「从未完赛」的干净状态；
3. **实际**：409 返回 `"后续场次已开打，晋级对阵无法更新"`，`820` 的 `status`/比分/`winner` 都复原了（`:389-394`），但 `finished_at` 仍是刚才写入的时间戳（`:399` 断言 `not.toBeNull()`）。

### 复现步骤（手工 —— 未实操）

1. 造一个淘汰赛阶段：第 1 轮两场 + 第 2 轮一场；把第 2 轮那场手工改成已开打（比赛管理里开始比赛），并让场上球队与即将晋级的一方不同；
2. 对第 1 轮剩余的场次报分完赛 → **预期**：提示「后续场次已开打，晋级对阵无法更新」，该场回到未开打；
3. 打开开发者工具看 `GET /api/admin/matches/:id`（或直接查库）的 `finished_at` → **实际（代码可证）**：`status` 是 pending，`finished_at` 非空。

### 预期行为
回滚必须把这场比赛的写前状态**逐列**复原，包括 `finished_at`（该行原本为 `NULL` 时恢复为 `NULL`，改判场景则恢复为改动前的旧值）。回滚后该行应当与「从未提交过这次终场」完全一致。

### 实际行为
`finished_at` 保留为本次（已被放弃的）终场写入的时间戳。

### 证据
- 写入：`worker/routes/admin/scoring.ts:261-264`
- 回滚：`worker/routes/admin/scoring.ts:292-305`（SET 列表里无 `finished_at`）
- 实测断言：`tests/scoring.finish.routes.test.ts:399` `expect(matchOf(sqlite, 820).finished_at).not.toBeNull();`

### 影响
- **用户影响**：几乎不可见。`MatchDTO` 不含 `finishedAt`，前端唯一显示终场时间的地方是 `src/pages/WeeklyPage.tsx:175-176` 与 `src/pages/ReportPage.tsx:109-110`，其数据源都按 `status='finished'` 过滤，陈旧时间戳进不去。**唯一的可证泄漏路径**：若该场挂着伤病事件，`Week in Review` / 轮次综述的伤情板块会按 `m.finished_at` 窗口取数，而该查询**没有** status 过滤（`worker/lib/injury.ts:480-486` `injuriesInWindow` → `injuryFacts`），于是会被错归到某一份周报里。
- **频率**：仅在发生 409 回滚时出现（需要下游已开打的冲突）。
- **绕过办法**：修好下游冲突后重新报分，该行会被正常覆写，陈旧值随即消失。
- **次要影响**：`GET /api/public/recent`（SQL 在 `worker/routes/public.ts:1220-1223`）按 `m.finished_at` 倒序取最近完赛，但它带 `WHERE ... m.status = 'finished'` 过滤，所以**不会**列出这场退回 pending 的比赛——这条路径是安全的。风险在于任何**绕过本仓接口、直连 D1 或自行按 `finished_at` 取数**的下游脚本与报表：它们会读到这个时间戳。

### 根因
补偿语句是手写列举列的 UPDATE，与正常写入语句没有共享列清单；新增 `finished_at` 列（migration `0006_match_finished_at.sql`）时只加到了写入语句上，回滚语句没跟上。

### 修复建议
在 `scoring.ts:292-305` 的 SET 列表补 `finished_at = ?`，绑定改动前行的值（`m.finished_at`，未开打场为 `null`）。更稳的做法是让两处共用同一份「可回滚列」定义（例如导出 `TERMINAL_COLS` 常量数组 + 生成 SET 片段），避免下次加列再漏。

### 修复后验收断言
- `tests/scoring.finish.routes.test.ts:399`：改为 `expect(matchOf(sqlite, 820).finished_at).toBeNull();`
- 新增：改判失败回滚时 `finished_at` 恢复为原值（非 null 的旧时间戳）。

### 关联
`TEST_PLAN.md` 附录 C 的 D2、11.3 表 BUG-002；手工用例域 SCO（报分与改判）。

---

## BUG-003：小组赛与循环赛阶段并存时，循环赛榜单名次按 `entry.group_id` 分桶重复编号

**严重度：** Medium　**优先级：** P2　**类型：** 功能 / 展示　**状态：** 待修（已钉住）

### 环境
- 应用版本：v5.0.4　**触发角色：** 任意（公开页可见，无需登录）
- 触发入口：`GET /api/admin/tournaments/:id/standings`、`GET /api/public/tournaments/:id/standings`
- 展示位置：公开页积分榜 tab `src/pages/PublicTournament.tsx:441-480`、管理页 `src/pages/TournamentManage.tsx:141` → `src/pages/StandingsTab.tsx`

### 描述
`standing.group_id` 对所有阶段都复制 `entry.group_id`（抽签产生），而 `readStandings` 一律**按 `r.groupId ?? 0` 分桶、桶内从 1 编号**（`worker/lib/standings.ts:418-425`，`rank` 赋值在 `worker/lib/standings.ts:542`）。当同一赛事既有小组赛阶段又有循环赛阶段时，循环赛阶段的报名带着上一阶段的 `group_id`，于是它的榜单被切成多块：

- 对外只呈现**一张表**（`worker/lib/standings.ts:590-591` 对非 group 阶段合成 `groups = [{ groupId: null, name: "", rows }]`）；
- 表内名次是各桶各自从 1 开始的 `1,2,3,…,1,2,3,…`；
- 因为 `name` 为空串，组名 caption 不渲染（`src/pages/StandingsTab.tsx:251` `{group.name && <caption>{group.name} 组</caption>}`），读者看不到任何分组依据；
- 分块顺序也不是积分序，而是 `standing` 表按 `group_id` 首次出现的顺序。

### 前置条件
（均已用夹具钉住，夹具见 `tests/standings.rebuild.test.ts:57` 注释与赛事 9 的构造）
- 赛事同时存在 `group` 阶段与 `round_robin` 阶段；
- 报名行带 `group_id`（由抽签写入）。

### 复现步骤（自动化复现 —— 已执行）

```
npx vitest run tests/standings.rebuild.test.ts -t "缺陷 D3"
```

夹具：赛事 9 有阶段 81（`group`，组 900 A / 901 B）与阶段 84（`round_robin`）；报名 610/611 → 组 900，612/613 → 组 901，614/615 → 无组。

1. 取阶段 84 的榜单 → **预期**：六支球队按积分排出唯一的 1–6 名；
2. **实际**：名次序列为 `1,1,1,2,2,2`（`tests/standings.rebuild.test.ts:358` 起的用例断言其排序后的多重集为 `[1,1,1,2,2,2]`），且同组两队固定占据该块的 1、2 名。

### 复现步骤（手工 —— 未实操）

1. 建赛事 → 报名 6 队 → 加 `group` 阶段（第一阶段），抽签分成 A/B 两组 → 生成小组赛程；
2. 再加一个 `round_robin` 阶段（排名赛）→ 生成赛程 → 报几场分；
3. 打开积分榜 tab → **预期**：循环赛那张表的「名次」列是从 1 连续排到 6；
   **实际（代码可证）**：名次列出现重复的 `1,2,3` 又 `1,2,3`，且表格没有组名标题，看不出为什么重复；
4. 管理页开启「排名段标记」（`strip` 或 `divider`）→ **实际**：同一名次区间跨组重复着色，`strip` 模式下同色条纹出现两次，`divider` 模式在重复名次处多画分隔线（`src/pages/StandingsTab.tsx:173` 与 `:233` 都以 `r.rank` 为判据）。

### 预期行为
每个阶段的榜单各自独立编号：`group` 阶段按组内名次（现在就是这样），非 group 阶段（`round_robin`）应当是**全阶段唯一的名次 1..N**。`entry.group_id` 是小组赛的分组信息，不应泄漏成循环赛的名次分段依据。

### 实际行为
循环赛阶段按 `entry.group_id` 分块、每块各自编号，单张表里名次重复；分块顺序是 `group_id` 首次出现序而非积分序。

### 证据
- 分桶与编号：`worker/lib/standings.ts:418-425`（`byGroup`），`:542`（`rows.forEach((r, idx) => (r.rank = idx + 1));`）
- 非 group 阶段合成单表：`worker/lib/standings.ts:590-591`
- 组名 caption 被空串跳过：`src/pages/StandingsTab.tsx:251`
- 名次渲染与分区着色：`src/pages/StandingsTab.tsx:180` / `:207`（`<td className="num">{r.rank}</td>`）、`:173`、`:233`
- CSV 导出同样带重复名次：`src/pages/StandingsTab.tsx:59`、`:84`
- 实测断言：`tests/standings.rebuild.test.ts:358` 起的用例

### 影响
- **用户影响**：公开积分榜与管理页都会显示重复名次且无组名区分，读者会认为系统算错；排名段标记（如「第 1–2 名出线」）的着色与分隔线会跨组重复命中，误导出线判断；导出的 CSV 同样如此。
- **频率**：采用「小组赛 → 循环赛排名赛」赛制的赛事**必然**出现（比赛中只要该阶段被重建过就成立）。
- **绕过办法**：无界面绕过办法；纯 `round_robin` 赛制（报名无 `group_id`）不受影响，出口在赛制设计而非用户操作。
- **注意**：这是展示与编号口径问题，不影响 `standing` 表里存的积分数据本身。

### 根因
`standing.group_id` 的语义在不同阶段被混用：它既是「小组赛分组」也是排序分桶的键。读侧（`readStandings`）没有按阶段类型区分是否该分桶，而是无条件按 `group_id` 分块；写侧（`buildStandingsStmts`）则把所有阶段的 `entry.group_id` 原样复制。

### 修复建议
优先改读侧，改动面小、不动历史数据：给 `readStandings` 传入阶段类型（或让调用方一次性读阶段表），仅当 `kind === "group"` 时才按 `group_id` 分桶，否则整表单桶、名次全局 1..N。次要方案是写侧对非 group 阶段写 `group_id = NULL`，但那会与 `entry.group_id` 的既有数据产生一致性歧义，且已有赛事的数据需要回填。

注意 `takeRangePool` 在来源是 `group` 阶段时**依赖**桶内名次做跨组取人（`worker/routes/admin/schedule.ts:1060` 的 `if (a.rank !== b.rank) return a.rank - b.rank;` 优先比较桶内名次），所以修复必须保留 group 阶段的桶内编号语义——只在非 group 阶段取消分桶。

### 修复后验收断言
- `tests/standings.rebuild.test.ts:358` 用例：改为断言六队名次是 `[1,2,3,4,5,6]` 且互不重复；
- 新增：`group` 阶段仍按组内 1..N（现有用例 `tests/standings.rebuild.test.ts` 的「小组按组隔离」保持通过，防回归）。

### 关联
`TEST_PLAN.md` 附录 C 的 D3、11.3 表 BUG-003；手工用例域 TOUR（积分榜）与 PUB（公开榜单）。

---

## BUG-004：`tiebreakers` 为空数组或全非法值时退化成一整条空决胜链，不回退默认链

**严重度：** Low　**优先级：** P2　**类型：** 功能 / 契约　**状态：** 已修（v5.0.7，方案 A 哨兵变体：空数组/全非法值回退默认链；「不启用」用显式哨兵 `["none"]` 表达，读侧 `effectiveTiebreakers` 映射为空链）

> 严重度相对 `TEST_PLAN.md` 11.3 的初判（Medium）**下调为 Low**：进一步核查发现「按积分、随后按种子位」是一个可以通过界面明确表达出来的意图（三个下拉全选「不启用」），缺的只是提示与文案，不会算错积分本身。真正的问题收窄为两点：接口层的回退契约与注释不符、以及界面口径说明与实际配置不符（后者另立 BUG-006）。

### 环境
- 应用版本：v5.0.4　**触发角色：** `admin`（`PATCH /api/admin/tournaments/:id` 只需 `tour.match.manage`）
- 触发入口：管理页设置 tab「同分规则」（`src/pages/TournamentManage.tsx:430-452`）保存；或直接调 `PATCH /api/admin/tournaments/:id` 带 `{"tiebreakers": []}`

### 描述
`normalizeTiebreakers`（`worker/lib/standings.ts:438-445`）只在**入参不是数组**时回退默认链 `["gd","gf","h2h"]`；如果传进来的是数组但里面全是非法值，或者就是一个空数组，函数返回**空数组**。而 `PATCH /api/admin/tournaments/:id` 会把归一化结果原样落库（`worker/routes/admin/tournaments.ts:288-302`），`getTiebreakers` 又只做 JSON 解析、没有兜底，于是该赛事从此没有任何决胜链：同分时只比较积分，随后直接按报名种子位（`seed` 升序）兜底，净胜球、进球数、相互战绩全部失效。

同时前端保存路径没有任何「至少启用一项」的校验：三个优先级下拉全选「不启用」就会提交 `tiebreakers: []`（`src/pages/TournamentManage.tsx:345-371`），保存后无任何提示。

### 前置条件
- 赛事已存在；管理员能打开设置 tab；
- 已有的名次数据中存在同分球队（否则看不出差异）。

### 复现步骤（自动化复现 —— 已执行）

```
npx vitest run tests/standings.rebuild.test.ts -t "同分规则可配置"
```

夹具：赛事 8 循环赛，`{ tiebreakers: ["nonsense", "nope"] }`。

1. 写入全非法链 → **预期**（按代码注释 `worker/lib/standings.ts:447` 「缺省回退默认链」）：决胜链为默认 `["gd","gf","h2h"]`；
2. **实际**：决胜链为空，同分球队只剩种子位兜底 —— `tests/standings.rebuild.test.ts:294` 起的用例断言名次为 `[600,601,602,603,604,605]`（纯 seed 序），与「按默认链比较净胜球」的结果不同。

### 复现步骤（手工 —— 未实操）

1. 建赛事并报名 ≥4 队，生成循环赛赛程，制造两支同分球队（例如 600 与 601 各积 1 分、净胜球不同）；
2. 打开 `/admin/t/:id` 设置 tab 的「同分规则」，把「第 1/2/3 优先级」全部选成「不启用」→ 点保存；
3. **预期**：要么明确提示「至少启用一项同分规则」，要么保存后界面清楚显示「当前不启用任何同分规则，同分仅按种子位排列」；
   **实际（代码可证）**：保存静默成功（`src/pages/TournamentManage.tsx:364-370`），随后积分榜的排序丢掉了净胜球/进球数/相互战绩，而页脚说明仍然写着默认链（见 BUG-006）；
4. 再调 `PATCH /api/admin/tournaments/:id` 传 `{"tiebreakers": ["foo"]}` → **实际**：同样落库为空链，无 400。

### 预期行为
二选一，但要与界面一致：
- **方案 A（推荐，改动最小）**：`normalizeTiebreakers` 对「空数组或过滤后为空」的输入回退 `DEFAULT_TIEBREAKERS`，与注释里的契约一致；若要表达「不启用任何同分规则」，用一个显式哨兵（如 `["none"]` 或 `null`）而不是空数组。
- **方案 B**：保留空数组 = 不启用链的语义，但前端必须校验「至少选一项」，且积分榜要用文案明确告知当前链为空。

### 实际行为
空数组/全非法数组 → 空链，且无提示；接口不接受「非法值」但也不告知用户它们被丢弃了。

### 证据
- 归一化：`worker/lib/standings.ts:438-445`（`if (!Array.isArray(v)) return DEFAULT_TIEBREAKERS;` 之后只收集合法项）
- 契约注释与实际不符：`worker/lib/standings.ts:447-448`「读赛事的同分规则配置；缺省回退默认链」
- 落库：`worker/routes/admin/tournaments.ts:288-302`（`cfg.tiebreakers = chain;`）
- 空链的后果：`worker/lib/standings.ts:471-485`（`nonH2h` 为空 → 同分只比 `pts`，再退 `seed`；`chain.includes("h2h")` 为假 → 整个 h2h 块跳过）
- 前端无「至少一项」校验：`src/pages/TournamentManage.tsx:345-371`
- 实测断言：`tests/standings.rebuild.test.ts:294` 起

### 影响
- **用户影响**：名次可能与管理员的预期不同（例如两队列净胜球不同却按报名顺序排名），且界面不说明原因；管理员会以为系统算错。
- **频率**：需要管理员主动把三级都设为「不启用」，或经由接口写入非法值；日常用户不会碰到。
- **绕过办法**：重新选一个有效规则并保存即可恢复。

### 根因
两处契约没有对齐：注释与调用方都假设「非法/缺失值 → 默认链」，但实现只在「非数组」时兜底；空数组被当成合法输入原样传递。前端与后端各自都没有「同分规则不得为空」的约束。

### 修复建议
按「预期行为」选方案 A 或 B，并同步更新 `worker/lib/standings.ts:447` 的注释措辞。若选 A，注意与 `getTiebreakers` 的调用方（`worker/lib/standings.ts:560` 的 `readStageStandings`、`worker/routes/admin/schedule.ts:1051` 的 `takeRangePool`）一并核对：它们都期望拿到一条可用的链。

### 修复后验收断言
- `tests/standings.rebuild.test.ts:294` 用例：`{tiebreakers:["nonsense","nope"]}` 的结果改为默认链排序（名次不再是纯 seed 序）；
- 新增：空数组的行为与所选方案一致（回退默认链，或明确表达为「不启用」且能被界面识别）。

### 关联
`TEST_PLAN.md` 附录 C 的 D4、11.3 表 BUG-004；手工用例域 TOUR（同分规则）。

---

## BUG-005：小组赛阶段内每组 `slot` 从 1 重新计数，同阶段 `(round, slot)` 重号

**严重度：** Low　**优先级：** P3　**类型：** 数据模型 / 展示　**状态：** 待修（已钉住）

### 环境
- 应用版本：v5.0.4　**触发角色：** `admin`　**触发入口：** `POST /api/admin/tournaments/:id/stages/:stageId/generate`（小组赛阶段）
- 展示位置：管理员赛程 tab `src/pages/ScheduleTab.tsx`、公开赛程 `src/pages/PublicTournament.tsx`、`GET /api/public/tournaments/:id/matches`

### 描述
小组赛阶段生成赛程时，`slotOf` 计数器建在**每个小组的循环内部**（`worker/routes/admin/schedule.ts:436-439`），于是每个小组的场次都从 `(round=1, slot=1)` 开始编号。同一阶段内 `(stage_id, round, slot)` 因此不唯一，而库内也没有对应唯一约束（`idx_match_stage` 是普通索引，见 `worker/lib/context.ts:57` 注释）。

当前有两个代码路径**假设了** `(round, slot)` 唯一，但因为都限定在 `stageKind === "elim"` 分支、而淘汰赛生成不产生重号，所以尚未被触发：
- `worker/lib/standings.ts:205` 的 `byRS` 以 `${m.round}:${m.slot}` 为键（`:213` / `:240` / `:291-294` 都用它取胜者/负者回填下一轮）；
- `worker/routes/admin/scoring.ts:173-178` 与 `:208-213`：`SELECT COUNT(*) ... WHERE stage_id=? AND round=? AND slot=?`，用「计数 == 1」判定该场是否为单回合对局。

实际已被触发的后果是展示层的：所有 `ORDER BY ... m.round, m.slot` 的列表（`worker/routes/public.ts:351`、`worker/routes/admin/schedule.ts:832`、`worker/lib/standings.ts:195` 等）在重号时退化为组间交错；管理页赛程按 `${round}:${third}` 分桶后只用 `slot`、`leg` 排序（`src/pages/ScheduleTab.tsx:247`），组别不参与排序，轮次标题也只有 `第 N 轮`、不带组名。

### 前置条件
- 赛事有一个 `group` 阶段，且抽签后分成 ≥2 组、每组 ≥2 队；
- 生成该阶段赛程。

### 复现步骤（自动化复现 —— 已执行）

```
npx vitest run tests/schedule.generate.routes.test.ts -t "小组赛"
```

夹具：赛事 47，`group` 阶段 47x，三组（A/B/C，C 组只有 1 队）。

1. 生成小组赛程 → **预期**：同阶段内场次编号两两不同，或每个小组各自独立编号且列表能按组聚合；
2. **实际**：第 1 轮两场的 `slot` 都是 1 —— `tests/schedule.generate.routes.test.ts:481` 断言 `round1.map(r => r.slot)` 等于 `[1, 1]`。

### 复现步骤（手工 —— 未实操）

1. 建赛事，报名 4–6 队，加「小组赛」（group）阶段，抽签分成 2 组，生成赛程；
2. 打开公开赛程页对应阶段的第 1 轮 → **预期**：同一轮里按小组聚在一起，能看出「A 组两场、B 组两场」；
   **实际（代码可证）**：列表按 `slot` 升序排，两组同号场次并列交错（A 第 1 场、B 第 1 场、A 第 2 场…），且标题只有「第 1 轮」，没有任何组名，读起来像随机顺序；
3. 管理员赛程 tab 同样表现（`src/pages/ScheduleTab.tsx:247`）。

### 预期行为
`(stage_id, round, slot)` 在阶段内唯一，或至少让列表/轮次视图能按小组稳定聚合（轮次标题带组名、排序含 `group_id`）。生成器内部可以按组独立编号，但必须保证对外可见的排序键能区分它们。

### 实际行为
每个小组的 `slot` 从 1 重新计数，同阶段 `(round, slot)` 重号；列表与轮次视图按 `slot` 排序时组间交错，且无组标。

### 证据
- 生成：`worker/routes/admin/schedule.ts:436-439`（`const slotOf = new Map<number, number>();` 在 `for (const g of groups.results ?? [])` 内部）
- 重号实测：`tests/schedule.generate.routes.test.ts:481`
- 排序受影响：`worker/routes/public.ts:351`（`ORDER BY s.sort_order, m.round, m.slot, m.leg`）、`src/pages/ScheduleTab.tsx:247`（`bucket.list.sort((a, b) => a.slot - b.slot || (a.leg ?? 1) - (b.leg ?? 1))`）
- 无唯一约束：`worker/lib/context.ts:57` 注释所述 `idx_match_stage(stage_id, round, slot)` 为普通索引（迁移中无 UNIQUE）
- 潜在假设（当前未触发）：`worker/lib/standings.ts:205`、`worker/routes/admin/scoring.ts:173-178` 与 `:208-213`

### 影响
- **用户影响**：公开赛程与管理赛程在小组赛阶段的可读性下降（组间交错、无组标），并非数据错误；比赛本身不会算错。
- **频率**：任何多小组的赛事必然出现。
- **风险（未触发但需记入）**：`(round, slot)` 被两处代码当作唯一键使用。若将来小组赛阶段被纳入晋级回填或单回合判定逻辑，会直接踩中。修 BUG-005 的价值一半在消除这个隐性前提。
- **绕过办法**：无（属编号方案问题）。

### 根因
生成器把「组内序号」当成了「全阶段槽位号」。组别信息只存在 `match` 行的 `home_entry_id`/`away_entry_id` → `entry.group_id` 的间接关系里，`match` 表本身没有 `group_id` 列，因此排序时无法直接按组聚合。

### 修复建议
- 最小改动：把 `slotOf` 提到小组循环外（同阶段共享计数器），组内轮次顺序不变，`(round, slot)` 恢复唯一；
- 或（更能表达语义）给 `match` 增列 `group_id` 并在公开/管理赛程的排序键里加入它，轮次标题带组名；
- 两种方案都不需要动已有赛事的静态赛程数据，但**若选前者**，需要确认前端对 `slot` 只做排序用途、不做「第几场」展示承诺（公开页第 N 轮标题来自 `round`，不来自 `slot`）。

### 修复后验收断言
- `tests/schedule.generate.routes.test.ts:481`：`round1.map(r => r.slot)` 改为 `[1, 2]`（或按所选方案断言新语义）；
- 新增：三组各 2 队的阶段，全部 `(round, slot)` 组合互不重复。

### 关联
`TEST_PLAN.md` 附录 C 的 D5、11.3 表 BUG-005；手工用例域 SCH（赛程生成）。

---

## BUG-006：积分榜页脚的同分规则说明是硬编码，与赛事实际配置不符（本轮新发现）

**严重度：** Low　**优先级：** P3　**类型：** 展示 / 文案　**状态：** 已修（v5.0.7：admin/public standings 响应补 `tiebreakers` 字段（复用已有 config_json 查询），`StandingsTables` 按生效链动态渲染页脚，空链有明确措辞）

### 环境
- 应用版本：v5.0.4　**触发角色：** 任意（公开页可见）
- 展示位置：积分榜底部说明，`src/pages/StandingsTab.tsx:145-147`（公开页与管理页复用同一组件）

### 描述
积分榜底部的口径说明是一段写死的文本：「\* 积分：胜 3、平 1、负 0；平局后点球决胜的点球胜者记 2 分、负者记 1 分。排名依次比较积分、净胜球、进球数、相互战绩。」但赛事的同分规则是可以配置的（`tournament.config_json.tiebreakers`，管理页设置 tab 可改）。当管理员把规则改成「只按积分」或调整顺序后，这段说明仍宣称按默认链排序——而排名输赢也随之改变却没有任何别的提示。

这条与 BUG-004 是同一主题的两面：BUG-004 是配置退化后没有正确回退/提示，本条是界面无论配置如何都宣称默认规则。分开登记是因为修法不同（一个改后端归一化，一个改前端渲染）。

### 前置条件
- 任一场次已完成、积分榜有数据；
- 赛事配置了非默认的同分规则（或如 BUG-004 所述变成了空链）。

### 复现步骤（手工 —— 未实操）

1. 打开任一赛事的积分榜（公开 `/t/:id` 的积分榜 tab，或管理页的「全部积分表」）；
2. 读底部说明 → **实际（代码可证）**：文本固定为默认链，与赛事 `config_json.tiebreakers` 无关；
3. 到设置 tab 把同分规则改成只按积分（或按 BUG-004 的方式清空），保存后回积分榜 → **实际**：名次可能变化，说明文字不变。

### 预期行为
说明文字按赛事实际生效的决胜链渲染（例如「排名依次比较积分、净胜球。」或「当前未启用其他同分规则，同分按报名顺序排列」）；空链时明确告知读者。

### 实际行为
无论配置如何，都宣称「积分、净胜球、进球数、相互战绩」。

### 证据
- 硬编码文本：`src/pages/StandingsTab.tsx:145-147`
- 实际配置来源：`worker/lib/standings.ts:448` `getTiebreakers`（读 `tournament.config_json.tiebreakers`），榜单接口 `GET .../standings` 目前**不返回** `tiebreakers` 字段（响应为 `{ standings, rankZones }`），所以前端要显示就必须让接口补这个字段

### 影响
- **用户影响**：读者可能据此误判名次依据（尤其在名次接近时），属于误导性文案；不影响计算。
- **频率**：只要配置非默认链就必然不一致。
- **绕过办法**：靠管理员在赛前说明里另行告知。

### 根因
说明文案是静态 JSX 文本，榜单接口也没有把生效的决胜链暴露给前端。

### 修复建议
`GET /api/admin/tournaments/:id/standings` 与 `GET /api/public/tournaments/:id/standings` 的响应里加 `tiebreakers`（或 `tiebreakerText`），`StandingsTab` 依它渲染说明；空链时给出明确措辞。可与 BUG-004 同批修（同一处配置的读与显）。

### 修复后验收断言
- 新增断言：榜单接口返回的 `tiebreakers` 与赛事配置一致（默认、自定义链、空链三种）；
- 前端属于展示层，无自动化断言覆盖（`TEST_PLAN.md` 缺口清单 G1 已记录前端组件测试缺席），修复后按手工用例确认。

### 关联
`TEST_PLAN.md` 手工用例域 TOUR（积分榜口径说明）；与 BUG-004 同批修复。

---

## 附录 A：已修复 —— BUG-T1（测试基建，非产品缺陷）

**状态：** Fixed（本轮修复）　**类型：** 测试基建　**严重度：** 高（会影响断言可信度，但不影响产品）

- **现象**：`tests/d1.ts` 的 `createTestD1` 桩件在 `batch()` 里对每个语句只调 `await s.run()`，而 `run()` 只返回 `{ meta: { changes, last_row_id } }`——**批次内的 SELECT 取不到结果行**（真实 D1 的 `batch` 对 SELECT 会带回 `results`）。
- **后果**：任何「在 batch 尾随一条 SELECT 并读回结果」的路由在测试里都静默读到空数据。实际踩到的例子是 `POST /api/admin/matches/:id/events` 尾随的 `LIVE_SCORE_SQL`（`worker/routes/admin/scoring.ts:437`、`:502`、`:652`），导致**实时比分恒为 0**，且不会报错。
- **修复**：给 prepare 出的 stmt 增加 batch 专用方法 `__exec()`，SQL 匹配 `/^\s*(select|with)/i` 时返回 `{ meta: { changes: 0, last_row_id: 0 }, results: exec.all(...args) }`，否则走 `run()`；`batch()` 优先调 `__exec()` 并回落到 `run()`。原有 `run()` 形状不变，既有调用方零影响。
- **影响面核查**：全仓唯一消费 batch 返回值的三处（`worker/routes/admin/scoring.ts:437`、`:502`、`:652`）都只读 `batchRes[2].results`，不存在「以 SELECT 开头却需要 `meta.changes`」的语句。
- **残留局限（已写进 `tests/d1.ts` 注释）**：桩件的 `run()` / `__exec()` 对 UPDATE/DELETE 返回的 `last_row_id` 是连接上最近一次 INSERT 的 rowid，真实 D1 此时返回 0 —— 断言不要依赖写语句的 `last_row_id`。
- **教训**：断言如果依赖「批次内的读回」，必须先在桩件上确认该读回路径真能取到数据，再写期望值；否则得到的是恒真或恒假的断言，既掩盖回归也让 HTTP 级验证不可能。

---

## 附录 B：修复优先级与批次建议

| 批次 | 缺陷 | 为什么这个顺序 | 触发面 |
| --- | --- | --- | --- |
| 第 1 批（尽快） | BUG-001 | 唯一会**写错竞赛数据**的一条：错误的晋级对阵入库并公开可见，且不报错、不可自愈 | 任何非淘汰阶段 + 后接配了取人的淘汰阶段 |
| 第 2 批（下个维护窗口） | BUG-002、BUG-004、BUG-006 | 都是「口径/一致性」类：回滚残留列、决胜链退化、文案与配置不符。BUG-004 与 BUG-006 同一处配置（读 + 显）建议同批修 | 特定赛制/特定操作 |
| 第 3 批（排期或随重构） | BUG-003、BUG-005 | 展示与编号口径；BUG-005 额外价值是消除两处对 `(round, slot)` 唯一性的隐性假设 | 小组赛、混合赛制 |

**修复时的共同要求**：
1. 每个缺陷都有一条对应的「钉住现状」断言（除 BUG-006 外），修复时必须把该断言改成期望行为——否则等于没修；
2. 修复后必须同时跑 `tests/d1-read-plan.test.ts`（索引形状守卫）：BUG-001 与 BUG-003 的修复可能改变查询形状；
3. 改动 `worker/` 后跑全量 `npm test` + `npm run typecheck`，并确认 `tests/schedule.bulk.routes.test.ts`、`tests/lineupProxy.routes.test.ts` 不回归。

---

## 附录 C：经核查**不**认定为缺陷的行为

以下行为在第一眼像缺陷，逐行核对后确认是设计内选择，登记以免被后续测试再误报：

| 现象 | 结论 | 依据 |
| --- | --- | --- |
| 4 队单循环时接口返回 `balanced: false`，前端提示「已尽量均衡」 | 设计内，数学上无解（每队 3 场无法满足前两场/后两场异侧），退火取最接近解并如实上报 | `worker/lib/seeding.ts:221` 注释；前端提示 `src/pages/ScheduleTab.tsx:81`；实测 n=4 → `[2,1,2,1]`，n=5/6/8 → `true` |
| 未报分的阶段在榜单接口里整块缺席（而不是显示全 0 行） | 设计内：榜单只列被重建过的阶段 | `worker/lib/standings.ts:567`（`rows.length === 0 → null` 被 filter 掉） |
| 提前 return 的「名次取人」分支不返回 `balanced` 字段 | 设计内：取人分支不跑均衡算法 | `worker/routes/admin/schedule.ts` 的 topN 分支 |
| 「小组赛阶段全组凑不出对阵」返回 400 时，已有场次没被清空 | 设计内且是良好行为：清空语句在 batch 之前 return | `worker/routes/admin/schedule.ts` 的 `created === 0` 分支 |
| 停赛列表里出现 `remaining: 0` 的球员 | 设计内：凡有红黄牌事件的球员都列出，便于核对累计 | `worker/lib/suspension.ts:242-270` |
| `computeSuspensions` 改判/改弃权后停赛场次会「回涨」 | 设计内：纯派生不落库，按当前事件重放 | `worker/lib/suspension.ts`（两遍 replay） |

---

## 附录 D：缺陷 → 断言 / 手工用例映射

| 缺陷 | 钉住断言 | 修复后应改成的期望 | 手工用例域 |
| --- | --- | --- | --- |
| BUG-001 | `tests/scoring.finish.routes.test.ts:402-450`（`:449` 断言 `away_entry_id: 501`） | `away_entry_id: 503` | SCH / TOUR |
| BUG-002 | `tests/scoring.finish.routes.test.ts:371-400`（`:399`） | `toBeNull()` | SCO |
| BUG-003 | `tests/standings.rebuild.test.ts:358` 起 | 名次为唯一的 `1..6` | TOUR / PUB |
| BUG-004 | `tests/standings.rebuild.test.ts:294` 起 | 回退默认链（或按方案 B 明确语义） | TOUR |
| BUG-005 | `tests/schedule.generate.routes.test.ts:481` | `[1, 2]`（或按所选方案） | SCH |
| BUG-006 | 无（展示层，缺口 G1） | 接口补 `tiebreakers` 字段并前端动态渲染 | TOUR |
| BUG-T1（已修） | `tests/scoring.finish.routes.test.ts` 的 events 用例（实时比分累计） | — | — |
