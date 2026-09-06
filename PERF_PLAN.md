# 全站性能优化方案

> 2026-09-06 **已实施**（迁移 0012 需随下次 deploy 先行应用到远端，与 0006/0007/0010/0011 一起）。起因：用户反馈线上站（tour.whleague.win）浏览和操作等待时间普遍偏长。
> 三个方向的审计（后端接口成本 / 数据库索引 / 前端请求模式）已完成，结论都在这里。
> **第 0 步实测基线（大陆→CF，本机 curl）**：静态 HTML 一趟 0.6–0.9s；1 查询接口 0.8–1.3s（每个串行 D1 查询 ≈ +0.2s）；积分榜（8 串行）2.4–2.5s；402KB JS 包下载 2.6s；无参 /matches 24KB 1.4–1.6s。

## 与移动端改造（#9）的边界（2026-09-06）

另一会话在并行做移动端适配（排期 #9，方案见 MOBILE_PLAN.md，以其「两会话边界协议」节为准）。核对结论：**零交叉**——

- 包 A 全在 worker/ 与 migrations/，#9 完全不碰后端。
- 包 B 的 JSX 改动只落在：Home.tsx（B.3）、PublicTournament.tsx（B.2）、MatchesTab.tsx（B.5）、App.tsx（B.1）、Login.tsx + src/auth.tsx + worker/routes/auth.ts（B.4）。前四个 #9 全部 CSS-only 避让，后三个 #9 不涉及。
- 归 #9 的文件本方案不碰：styles.css、index.html、src/api.ts、PublicMatchDetail.tsx、ShareDialog.tsx、src/lib/share.ts、StandingsTab.tsx、Toplists.tsx、StatsDashboard.tsx。
- 例外条款：实施中若必须越界，先停下与 #9 会话/用户对齐，不硬碰。
- 两个 plan 文档均未跟踪，commit 时各自明确收编，别把对方文档扫进自己的 commit。

## 诊断结论（为什么哪儿都慢）

大陆访问 Cloudflare，每个请求的往返成本天生就高（几百毫秒一趟），而代码把「趟数」和「每趟的服务器工作量」都堆大了：

1. **零缓存**：所有公开接口每次请求都现算现查 D1，无 Cache API / KV / 内存缓存（全 worker/ 已 grep 证实）。同一页刷 100 次就算 100 次。
2. **串行查询瀑布**：积分榜接口 2 个阶段 = 8 个查询挨个串行等（`worker/routes/standings.ts:536-576`）；公开比赛详情 live 比分∥事件串行（`public.ts:337-341, 490-494`）、lineup 主客∥串行（`worker/lib/lineup.ts:183-186`）、toplists 里 computeSuspensions 可与 buildToplists 并行却被串在第二波（`worker/lib/suspension.ts:254-255`）。每多一个串行查询就多一趟往返。
3. **缺索引**：match 表没有 status/finished_at 索引——首页 recent/upcoming/live/summary 四个接口每次全表扫最大表（`public.ts:532-667, 407`）；entry 表按 team_id 查无索引（`coach.ts:108`）+ 管理端球队列表每行一个相关子查询 N+1（`admin/teams.ts:13, 120`）；auth_code 按 code_hash 查无索引（`coach.ts:36-39`）。已核对无问题的：match_event 的 match_id 索引在 0010 重建后还在、登录路径、team_member、tactic_submission 均有索引。
4. **录一条事件 ≈ 10 个查询**：POST /events 里跑了「全量重放整届赛事的停赛引擎」`computeSuspensions`（`admin/scoring.ts:295-297`），而它只为算一句「该球员停赛中」的警告——前端本来就已经加载了停赛数据。该引擎还被 MatchesTab 每次挂载调一次（`MatchesTab.tsx:99-113` → `admin/tournaments.ts:671`）。2 条全赛事查询 + O(球员×比赛) 内存重放，每请求无缓存。
5. **每张队徽都过会话检查**：attachUser 挂在所有 /api/* 上（`worker/index.ts:12`），含 /api/media/*——登录用户每张图 = 1 次 KV + 1 次 D1；公开接口其实也全都不需要登录态。
6. **前端串行波次多**：
   - RequireRole 门闩让所有受保护页首屏 = /me → 页面数据两段串行（`src/components/ui.tsx:13`、`src/auth.tsx:38-40`）；
   - 管理端每点一下（开赛/录事件）= 1 POST + 后台串行重拉 3-4 个全量接口（`MatchesTab.tsx:150-164` 的 act → refetchMatches → reload → setTick）；
   - 公开赛程页每 400ms 串行预热一轮（`PublicTournament.tsx:128-144`），轮次多时长时间占连接；
   - 首页无条件每 30s 轮询 4 个接口（`Home.tsx:41-43`），不似其他页有 live 判断；
   - 单 bundle 402KB 无代码分割（`src/App.tsx:5-18` 全静态 import），公开访客也要下管理端代码。
7. 顺带发现：公开 /matches 无参调用会返回全赛事全部场次+全部事件（`public.ts:309`「兼容旧调用」注释），大 payload 风险。

做得好的（不用动）：静态资源走 run_worker_first 白名单直出边缘不过 Worker、index.html 无阻塞资源、api.ts 零开销、公开赛程页轮询有 live+visibility 双闸。

## 第 0 步：实测基线（开工先做）

- curl 从本机量线上接口耗时：1 查询接口（/api/public/tournaments）vs 8 串行查询接口（standings）vs 静态资源，推算每查询成本和纯网络往返占比；改完后同法对比验证收益。
- 请用户在 CF dash 看一眼 D1 数据库位置（APAC 还是美区）。若在美区，每查询多背 ~150ms 固定税，量出来占比过大再议换库搬迁（大动作，本次不动）。

## 包 A：后端（一次 deploy 全生效）

1. **migration 0012_perf_indexes.sql**：
   - `CREATE INDEX idx_match_status ON match(status, finished_at DESC)`（救首页 4 接口）
   - `CREATE INDEX idx_entry_team ON entry(team_id)`
   - `CREATE INDEX idx_auth_code_hash ON auth_code(code_hash)`
   - 顺手 `DROP INDEX idx_tsub_match`（与 UNIQUE(match_id,team_id) 自带索引重复，纯写放大）
2. **串行改并行**（Promise.all，响应结构不变）：积分榜逐阶段（`standings.ts:545-575`）、toplists（配置∥buildToplists，再算停赛）、公开比赛详情、公开赛程 liveScores∥事件、lineup 主客∥、管理端详情 tiebreakers。
3. **公开 GET 边缘缓存**（Cache API `caches.default`，按 URL 键，只挂 /api/public/* 的 GET）：比分类（live/upcoming/recent/matches/match 详情）TTL 10s，榜单详情类（standings/toplists/stats/tournaments/lineup）TTL 60s——比现在前端 30s 轮询还新鲜。
4. **attachUser 瘦身**：/api/public/* 和 /api/media/* 不再过会话中间件（都是匿名读，公开路由无一处用登录态）。
5. **媒体边缘缓存**：/api/media/* 用 Cache API 长缓存（响应本来就 immutable，`media.ts:16`）。
6. **录事件瘦身**：POST /events 不再跑全量停赛重放，警告改由前端用已加载的停赛数据提示（前端没有就补）；红牌后不能再吃牌的守卫保留（只查本场事件，便宜）。
7. 顺手项：grep 确认无参 /matches 无调用方后，去掉「无参返回全赛事全部事件」的兼容行为。

## 包 B：前端

1. **路由懒加载**：/admin/*、/my-team、TournamentManage 用 React.lazy 拆包，公开访客不再下载管理端代码；public/_headers 给 /assets/* 配 immutable 长缓存、index.html no-cache。
2. **砍预热链**：公开赛程页删掉 400ms 串行预热（`PublicTournament.tsx:128-144`），切轮按需拉（现有按需拉取 `97-125` 本来就是 Promise.all 并行；有边缘缓存兜底，秒回）。
3. **Home 轮询加闸**：无 live 比赛时不做 30s 轮询（或降到 120s），与其他页面行为对齐。
4. **登录省一趟**：登录接口直接返回用户对象，前端免再拉 /me（登录 3 波 → 2 波）。
5. **操作后刷新并行化**：管理端 act() 的 matches/detail/suspensions 重拉改并行；MatchesTab 的停赛数据改懒加载（打开事件面板才拉，不再挂载就全量重放）。

## 验证与交付

- wrangler dev 改码后重启再测（热重载对 Edit 写入不敏感的老坑）；本地 curl 对比接口耗时。
- 浏览器 E2E 回归：公开赛事页 / 比赛详情 / 管理端录事件 / 战术板提交。
- code review 过一遍，分「后端」「前端」两个 commit，**不 push 等用户明说**。
- deploy 提醒：远端迁移要补 0006/0007/0010/0011/0012（0012 是本次新增），迁移先行再 deploy。

## 附：接口查询次数速查（审计实测）

| 接口 | 查询次数 | 备注 |
|---|---|---|
| 公开 standings | 8（2 阶段，全串行） | 最差读路径 |
| 公开 toplists | 6 + 全量停赛重放 | |
| 公开 stats | 6~7 | 全量拉完赛场聚合 |
| 公开 matches（按轮） | 3~4+，事件分块串行 | liveScores 与事件串行 |
| 公开 match 详情 | 4 全串行 | |
| 公开 lineup | 4 串行 | 主客可并行 |
| 管理端 matches 列表 | 1 + 每 live 场 1（N+1，仅 live） | |
| 管理端 suspensions | 4（含 2 次全量重放） | MatchesTab 每次挂载调 |
| **管理端录事件** | **~10（含全量重放）** | 每点一下都跑 |
| 教练 lineup GET/PUT | 5 串行 | |
