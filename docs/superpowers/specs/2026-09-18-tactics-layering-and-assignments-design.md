# 战术板：UI 分层 + 队长与定位球（FC26 Assignments）

日期：2026-09-18（2026-09-19 走查后追加第 13 步调整；2026-09-20 追加第 14 步调整）
状态：已实现并走查通过
涉及：`src/pages/Tactics.tsx`、`src/components/LineupView.tsx`、`src/components/PreMatchPanels.tsx`、`src/styles.css`、`shared/tactics.ts`、`shared/types.ts`、`worker/lib/lineup.ts`、`worker/lib/playerMeta.ts`(新)、`worker/routes/coach.ts`、`migrations/0024_assign_json.sql`(新)、`tests/assign.test.ts`(新)

## 1. 背景与目标

两件事一起做：

1. **战术板 UI 分层**：`src/pages/Tactics.tsx`（1373 行）是目前全站唯一没有层机制的大页，一长串卡片，加块就得重排。目标是「一个常驻核心 + 三个可切换面板」，以后加块＝往对应面板里插一项。
2. **新增队长与定位球（Assignments，代码里叫 `assign`）**：照 FC26 的「球队管理 → 指派」做 5 组 18 项，随阵容提交落库，教练端可回显、管理端赛前备案可见、开赛后公开端阵容里显示。

同时**必须保住刚上线的代打（proxy）功能**：它有完整的交互面（身份切换器、目标锁定、数据整组切换、提交文案分支、草稿共享问题），分层与指派都不许碰坏它。

### 用户已拍板的决策（逐条）

| 问题 | 结论 |
| --- | --- |
| 战术板未来还会加东西吗 | 「不确定，但别挡路」→ 按可扩展方式分层 |
| 战术码生成器 vs 赛前备案 谁是第一公民 | 「对于认证教练来说，阵容安排提交等是第一公民」→ 默认落备案层，但设计侧一块都不砍 |
| 手机上做到哪一步 | 「手机上全功能」→ 不能有内容藏起来不给用，只能靠切换/排序+折叠 |
| 分层机制 | 「常驻球场 + 层面板（默认落备案）」 |
| 阵型归属哪一层 | ② 战术设计面板（备案层看到的阵型来自球场站位本身） |
| 提交按钮位置 | 从 `tac-submit` 拆出，独立成备案面板底部窄卡 |
| 指派（功能名「队长与定位球」）归属哪一层 | ② 战术设计，作为**战术设置卡内的收尾块**（与阵型/组织风格/防线高度同卡）；它照旧随阵容提交、候选池＝本场首发、战术码带不走它，只是编辑入口归到设计侧 |
| 指派互斥强度 | 互斥 + **拦提交**（块头红标 + 标出冲突项 + 一键清除）；①层提交卡在冲突时给一行指路 +「去改」按钮（指派块在②层，①层看不见冲突项） |
| 球场上的指派标记 | 只给队长加 C 角标；点中球员时编辑器里列出他担任的指派 |
| 展示面 | 落库并随阵容展示 |

## 2. 页面结构

现状：页头 → `tac-submit` 提交卡 → `.tac-layout`（球场 + 右栏：战术码/导入/战术设置/位置编辑器）→ 存档 → 替补席。改为：

**常驻核心**（两种模式共用，不进层）
- 左列 400px（`.tac-left`）：球场卡（`.tac-pitch-panel`）+ **战术码卡**（`.tac-code-panel`，紧贴球场下方）。球场上：磁贴显示号码/姓名、停赛伤停标记、**队长 C 角标**、**位置重复黄标**；点磁贴选中位置。
- 右栏顶部**选中位置编辑器**（现 `tac-editor`）：这个位置放谁 + 他在打法里的角色与重心。理由：备案问「这儿放谁」，设计问「这个人干什么」，同一个动作，一步到位。

战术码与球场同排：它回答的是「这块板上现在是什么打法」，跟球场是一体两面，所以**不跟着层切换隐藏**（第 14 步从右栏②层挪出；此前被高 1300px 的战术设置卡压到页面很下面，用户以为功能被删了）。

**三个层面板**（原卡片整体搬入，内部实现不动，只换父容器）
- ① **本场备案**：选择目标比赛 + 伤停与停赛（现 `tac-submit` 左列/右列，去掉提交按钮）→ 首发与替补（现页尾 `tac-bench` 九格）→ 提交（拆出的独立窄卡）
- ② **战术设计**：战术设置（阵型/组织风格/防线高度）+ **队长与定位球（原「球员指派」，本卡收尾块）**
- ③ **工具与档案**：导入战术码（`tac-import-panel`）+ 存档（`tac-archives`）

**层切换器＝右栏卡片上方的页签**（不是页头下方的整宽横条）：球场常驻在左列，这一条只切右栏下面那一叠卡，位置与作用域一致。视觉沿用仓库现有 `.tabs`/`.tab-active`（`src/styles.css:258-277` 的下划线页签），右侧常显模式徽标。

**层状态记 URL query**：`/tactics?zone=lineup|design|tools`（默认层不写参数）。刷新/分享/前进后退都对，不污染 `ftc26-*` 草稿键。

**移动端（≤979px）**：页签吸顶可横滚、模式徽标排在页签最前（`order:-1`，否则会被推出视口）；球场常驻最上、右栏卡接在其后；现有 6 项 order 链（archives/code/import）因卡片换父容器而失效，改由 `.tac-side > *` 统一管顺序。左列 `.tac-left` 在该断点下 `display:contents`，球场与战术码直接参与 `.tac-layout` 的纵向排序（球场 0 → 页签 0 → 战术码 1 → 其余卡片），实测 414px 无横向溢出。

**CSS 顺序陷阱（踩过）**：媒体查询不提升优先级，同特异性下**由源序决定胜负**。基础槽位规则（`.tac-assign-grid{grid-template-columns:1fr 1fr}`、`.tac-as-a{grid-area:1/1}` 等，写在文件偏后）会盖掉写在文件中部那条 `@media (max-width:560px)` 里的单列改写。凡是要覆盖这些基础规则的窄屏改写，必须放在文件**末尾**那条 `@media (max-width:560px)` 内。另一条：`1fr` 实为 `minmax(auto,1fr)`，某列的 min-content（下拉里最长的选项文本）会把两列撑成不等宽，排查列宽异常先怀疑它。

**加块成本**：往某个面板插一项；开新层＝层条加一个 tab。

## 3. 队长与定位球（原「球员指派」）

功能名在 UI 上叫**「队长与定位球」**（FC26 里叫 Assignments，落在「球队管理 → 指派」；这一层名字对教练更直白）。代码里的类型与字段仍叫 `assign`/`ASSIGN_*`。

### 3.1 数据模型

`assign` ＝「角色码 → 球员 id」映射，只存已填项，例 `{"captain":123,"ca_left":45}`。键是**角色**不是位置 ⇒ 换阵型、换人不影响已填内容。

### 3.2 18 项角色码（照 FC26 清单，5 组，不增删改名）

| 组 | 项 | 角色码 |
| --- | --- | --- |
| 队长 | 队长 | `captain` |
| 任意球 | 左侧短任意球 / 右侧短任意球 / 长任意球 / 点球 | `fk_left_short` / `fk_right_short` / `fk_long` / `fk_penalty` |
| 角球（进攻） | 左侧角球 / 右侧角球 / 目标球员 / 近门柱 / 远门柱 / 禁区弧顶 / 防守掩护 | `ca_left` / `ca_right` / `ca_target` / `ca_near` / `ca_far` / `ca_arc` / `ca_cover` |
| 角球（防守） | 威胁盯防者 / 门柱守卫 / 近门柱 / 远门柱 | `cd_threat` / `cd_guard` / `cd_near` / `cd_far` |
| 界外球 | 左侧界外球主罚者 / 右侧界外球主罚者 | `ti_left` / `ti_right` |

集中在 `shared/tactics.ts` 定义：`ASSIGN_GROUPS`（5 组 18 项，含中文名与 FC26 语义提示）、`ASSIGN_KEYS` 白名单、`ASSIGN_EXCLUSIVE` 互斥表、纯函数 `assignConflicts(assign): string[]`（前端预检与后端校验共用，规则只定义一处）。

### 3.3 互斥

- 角球**主罚人**（`ca_left`、`ca_right`）⊥ 角球**进攻接应角色**（`ca_target`、`ca_near`、`ca_far`、`ca_arc`、`ca_cover`），**双向互斥**。理由：在角旗区发球的人不可能同时在禁区抢点。
- 同一人**可以**同时开左右两侧角球（用户只纠正「主罚 vs 接应」）。
- 仍可与队长、任意球、点球、界外球主罚、角球防守组兼任。
- 互斥写成声明表，要更严改一行即可。

### 3.4 候选池与交互

- 候选＝**当前模式**下场上那 11 名首发（按球员去重，FC26 口径）。首发没摆满 11 个位置时下拉留空并提示「先把场上 11 个位置选满」。
- 下拉选项文案：`#7 LB 张三（🟥停赛 剩1场）`（号码 → 位置 → 姓名 → 复用 `optionSuffix(pid)` 的停赛/黄牌临界/伤停三态）；一人占两个位置写 `#7 LB/LCB 张三`。
- 5 组在卡内的**渲染顺序与槽位**：按组名归槽位（`ASSIGN_SLOT`），宽屏是「左列队长 + 界外球 / 右列任意球（竖跨两行）/ 下一行角球进攻 | 角球防守」的 2×2 —— 界外球只有 2 项，正好插在队长下方的空隙里（第 14 步按用户预期重排，此前是两列自然流）。槽位键是组名，组名改了自动退回 `ASSIGN_GROUPS` 原顺序与自然流；存储与 DTO 始终按 `ASSIGN_GROUPS` 原序。队长组只有 1 项且项名＝组名 ⇒ **不渲染组标题**（否则「队长」出现两次），组说明降为项下小字（`.tac-assign-note`）。
- 「队长与定位球」块默认折叠、记住展开状态；块头常显摘要（已填 n/18 · 队长 #7 张三 · 角球 ←李四 →李四）+ 冲突红标 / 已填计数。
- 指派指向的球员已不在首发时**保留并标黄「已不在首发」**，不静默清空。
- **没填完不拦提交**（与「伤停只提示不拦截」一致）；**互斥冲突拦提交**。冲突项在②层可见（块内高亮 + 「清除冲突项」），①层提交卡另给一行「队长与定位球有 N 处冲突，改掉才能提交。去改」→ `selectZone("design")`。
- 已提交场次给只读摘要 + 「载入已提交的阵容」按钮（阵型、首发/替补、指派一次回填），**不自动预填**（与现有 `names` 行为一致，避免半套数据误提交）。

## 4. 存储 / 接口 / 展示

### 4.1 迁移

`migrations/0024_assign_json.sql`（`0023_lineup_proxy.sql` 已被代打占用）：
`tactic_submission` 与 `tactic` 各加 `assign_json TEXT NOT NULL DEFAULT ''`（照 `0017_tactic_roster.sql` 的 ALTER 写法）。
两处都加的理由：提交要落库并随阵容展示；存档要跨场复用回填。

### 4.2 后端（`worker/lib/lineup.ts` 是共用层）

- `WriteLineupParams` + `writeLineupStmt` 的 SQL 加 `assign_json` ⇒ 教练自提与代打提交**一次覆盖**（两条路都走这个语句）。
- `parseAssignJson(raw)`：坏 JSON / 非对象 / 数组 → `{}`；只留白名单键 + 正整数（仿 `parseRoster`）。
- `validateAssign(db, teamId, raw)`：白名单键、球员属**传入的那支队**、`assignConflicts` 为空；违规抛 `LineupError(400)`，消息点名冲突的两个角色名。teamId 必须由调用方显式传。
- `resolveAssign(raw, playerMap, starterPids, metaMap)`：按 `ASSIGN_GROUPS` 顺序输出 `LineupAssignDTO[]`（姓名/号码取自 `buildTeamLineup` 已有的球员批量查询；`starter` 由首发 playerId 集合判定）。
- `fetchMatchLineup` 的 SELECT 与 `SubRow` 补 `assign_json`；`buildTeamLineup` 输出 `assign`。
- `worker/routes/coach.ts`：本队 `PUT /matches/:mid/lineup` 与代打 `PUT /proxy/:mid/lineup` 都接 `assign`，**分别传本队 teamId / `grant.teamId`**；`POST /tactics` 接受并写 `tactic.assign_json`；`GET /tactics` 带回。
- 管理端 `worker/routes/admin/scoring.ts` 的 `GET /:id/lineup` 是 `{...lineup, homeCode, awayCode}` 展开 ⇒ 自动带指派，零改动。

### 4.3 类型（`shared/types.ts`）

- 新增 `LineupAssignDTO { key, playerId, name, number, starter, meta? }`
- `TeamLineupDTO` 加 `assign: LineupAssignDTO[]`
- `TacticArchiveDTO` 加 `assign: Record<string, number>`
- `LineupSubmitBody` 加 `assign?`
- 新增 `PlayerMeta { badges?: string[]; attrs?: Record<string, number> }`，挂到球员类 DTO 的可选 `meta?`

### 4.4 club 属性预留（只留接缝，不接外部调用）

新文件 `worker/lib/playerMeta.ts`，签名 `(db, playerIds) => Map<number, PlayerMeta>`，**默认返回空 Map**。将来接 club 平台只改这一个文件；UI「有 meta 才渲染」（下拉里徽章拼在名字后、展示清单里做小 chip）。现在**不写**排序/推荐代码（`player` 表只有 `id/name/number`，没有能力值）。

### 4.5 前端

- 新 LS 键 `ftc26-assign-v1` + 新状态 `assign`；`resetAll()` 一并清空；`saveArchive()`/`loadArchive()` 读写 `assign`；`submitLineup()` 的 body 加 `assign`。
- 「队长与定位球」块（在 `card tac-settings` 内、卡尾，上分隔线隔开）：块头（`h3` + `small` 出处 + 展开/收起 + 冲突或已填计数）+ 摘要 + 5 组 2×2 槽位网格（见 3.4，≤560px 单列）+ 冲突提示与「清除冲突项」。
- ①层提交卡副标题写「提交信息包含阵容、战术与定位球」（与拆分后的 `.tac-submit-bar h2` 同一套小字号样式，不另起字号）。
- `lineupProblem()` 末尾加互斥预检（拦提交），消息 `队长与定位球有冲突：<conflictText>`。
- 球场磁贴：队长 C 角标；位置重复（首发一人占两个位置，含与替补的判重口径）置黄；点中球员时编辑器列出他担任的项（标签「本场负责」，chip 可点掉）。

### 4.6 三端展示

- `src/components/LineupView.tsx`：`LineupSide` 首发行在队长名后插 C 标，`lu-meta` 前渲染新的 `AssignList`（按组列已填项、队长最前、不在本场首发的标「已不在首发」）。调用点只有管理端 `src/pages/MatchesTab.tsx` 与公开端 `src/pages/PublicMatchDetail.tsx` ⇒ **改一处三端生效**。
- `src/components/PreMatchPanels.tsx` 的 `MyLineupPanel` 复用同一 `AssignList`。
- 赛前公开端仍不亮牌（`fetchMatchLineup` 的 `requireStarted` 逻辑不动）。

## 5. 代打（proxy）集成 —— 不许碰坏

### C1 面板渲染门槛与身份切换器

- ① 层的渲染条件照抄现有：`selfPlayers != null || (proxySessions?.length ?? 0) > 0`。代打者的球员池、伤停停赛、已提交阵容**全部来自代打板**，不由本队绑定决定。
- 身份切换器（`<select>` 空选项＝本队，非空＝代打场次）与代打说明 banner（「你正在替「X」递交本场阵容（Y 授权）」）**原位保留在①面板顶部**，它是①的上下文开关。
- 层条右侧常显**模式徽标**（`本队备案` / `代打：<队名>`）：切到②③层后球场磁贴显示的仍是当前模式的名单，必须一眼看出在替谁做事。
- 分层不得改变现有模式切换语义：`teamPlayers`/`status`/`statusBusy`/`mine`/`curMid`/`statusTid`/`blockedByProxy` 的代打分支一个都不能动；「代打模式下本队停赛请求让位」保持不变。

### C2 草稿按模式隔离（修代打遗留的串草稿问题）

现状 `LS_STATE`/`LS_NAMES` 两种模式共用：进代打模式时槽位顶着自己队的名字而球员池是目标队的；代打编辑会覆盖自己队的草稿。而代打者必然不是目标队教练（授权接口明确拒绝「授给本队自己的教练」），所以这是真实问题。

方案：代打模式草稿落到 `ftc26-proxy-<mid>-state-v1` / `-names-v1`（每场一份，切场次各留各的），切回本队恢复 `ftc26-*`；`resetAll()` 连指派草稿一起清，但只清**当前身份**那一个 scope（重置＝把眼前这块板擦干净；跨身份擦除会误伤另一个身份的草稿）。

### C3 指派在代打链路上的口径

- 写入：两条提交路由共用 `writeLineupStmt` ⇒ 代打提交自动带指派。
- 校验：**必须按被代打队判**（`grant.teamId`），`validateAssign(db, teamId, raw)` 由两条路由分别传。绝不能用代打者自己的队，否则代打提交会 400。
- 回显：`GET /proxy/:mid/board` 的 `lineup` 是 `TeamLineupDTO` ⇒ 一加 `assign`，代打者打开就看到目标队已提交的指派（含代打留痕），可点「载入已提交的阵容」回填。
- 候选池：代打模式下指派下拉候选＝代打板上摆出的那 11 人（＝目标队球员）。

### C4 ②③ 层在代打模式下的口径

- ②层的**阵型**是本次提交内容的一部分，代打时同样有效；战术码只是字符串。
- ③层的**存档**服务端按 `teamIdOf(env,userId)` 落库，**永远进你自己的球队**，与本次代打无关 ⇒ 代打模式下③层顶部加一行提示。

### C5 提交卡拆出时必须保留的代打逻辑

`blockedByProxy`（本队教练在本场被代打时按住按钮）+ 提交按钮文案分支（确认提交?/覆盖提交/提交阵容/确认代打提交?/覆盖代打阵容/代打提交）+ 两击确认 `armSubmit` + `mine.viaProxy` 提示 + 代打提交成功后 `refetchProxy()`。

### C6 顺带修代打的可用性缺口

代打者现在要手点 11 个位置才能交（板上不预填）。`mine`（目标队该场已提交阵容）已在手，加「载入本次已提交的阵容」（slots+form+assign 一键回填），复用存档载入那段逻辑。

### C7 可见性与留痕不变

管理端赛前可见（代打提交带留痕 + 指派一并显示）；公开端开赛后随阵容显示；教练端 `GET /coach/matches/:mid/lineup` 只回本队那份不变。

## 6. 实施计划

1. 落本 spec 并 commit。
2. `migrations/0024_assign_json.sql`；`npm run db:migrate:local`（远端迁移发布时才跑）。
3. `shared/tactics.ts`：18 角色码 + `ASSIGN_GROUPS`/`ASSIGN_KEYS`/`ASSIGN_EXCLUSIVE`/`assignConflicts`。
4. `shared/types.ts`：`LineupAssignDTO`/`PlayerMeta` + 扩展相关 DTO。
5. `worker/lib/lineup.ts`（parse/resolve/validate + `WriteLineupParams`/SQL/SELECT 扩展）、`worker/lib/playerMeta.ts`（空实现接缝）、`worker/routes/coach.ts`（两条 PUT + tactics POST/GET）。
6. `tests/assign.test.ts` + `npm run typecheck` + `npm test`。
7. 前端队长与定位球块（状态/LS/存档回填/resetAll/互斥预检/submitLineup body）。
8. 前端分层 + 代打保真（页签含模式徽标、三面板、拆提交卡、①层门槛、身份切换器原位、③层代打提示、URL query、移动端 order、新样式）。
9. 草稿按模式隔离。
10. 展示（`LineupView` C 标与 `AssignList`、`PreMatchPanels`、球场标记）。
11. C6 代打载入本次已提交阵容。
12. 本地走查：本队备案 / 代打（切回本队草稿不串）/ 被代打教练被按住 / 无绑定身份 / 手机宽度。
13. 走查后的调整（已落）：页签从页头整宽横条挪到右栏卡片上方；队长与定位球并入 `tac-settings` 卡（归属从①改②）；UI 文案按 `personal-chinese-writing-style` 重写（去掉「口径」「落库」「公开端」一类内部词，带出队名的代打说明改写成教练看得懂的整句）。
14. 二轮反馈（已落）：战术码卡从右栏②层挪到左列球场正下方且任何层常显（`tac-code-panel` 的 `hidden` 撤销）；队长与定位球块改 2×2 槽位布局（左列队长+界外球 / 右列任意球跨两行 / 下排角球进攻 | 角球防守）；队长组标题与组内重复项名只留一个；①层提交卡副标题改「提交信息包含阵容、战术与定位球」并压回与其它卡片一致的小字号；窄屏单列改写搬进文件末尾的媒体查询。走查：1280px 下球场 box(118,129,400,520) → 战术码 box(118,665,400,88) 紧贴其下；2×2 实测 tac-as-a(555,521)/tac-as-b(555,627)/tac-as-c(848,521 跨两行)/tac-as-d(555,814)/tac-as-e(848,814)；414px 单列 333.6px、无横向溢出。

## 7. 范围与不做

- 不接 club 平台真实数据，只留 `worker/lib/playerMeta.ts` 接缝。
- 不做指派自动预填、模板、按能力排序/推荐（`player` 表无能力值字段）。
- 不改「赛前公开端不亮牌」策略；**战术码格式不变**（指派不进码，跨场复用走存档）。
- 不改代打的授权模型与后端鉴权（`worker/lib/lineupProxy.ts`、`worker/routes/admin/proxyGrants.ts` 不动）。
- 远端数据库迁移不在本次执行。

## 8. 验收

- `npm run typecheck` 与 `npm test` 通过（含新增指派与代打用例）。
- 本队：填完 18 项、冲突被拦、提交落库、换设备可回显；管理端赛前可见；开赛后公开端显示（队长 C + 主罚清单）。代打：提交带指派且落到目标队；用自己队球员 id 被 400；身份切换后本队草稿与已提交内容不被污染；被代打的本队教练仍被按住；管理端能看到代打提交的指派与留痕。
- 无绑定身份看不到备案层、默认落设计层；②③层在代打模式下不误导。
- 手机宽度下三层内容全可达、球场常驻。
- 指派指向的球员不在首发时不静默丢失，标黄提示。
