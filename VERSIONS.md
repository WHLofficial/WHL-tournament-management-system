# 版本记录 · WHL 赛事系统（tour）

> 各仓自持语义化版本（2026-09-25 起）。口径见「判级口径」。本表即本仓台账起点。

## 判级口径

- **major**：① 外部/跨仓契约或 URL 不兼容；② 生产数据真源或口径重定义、需重导；③ 写入口下线或必须多仓同轮。
- **minor**：新增用户可见能力（新域 / 页面 / 端点 / 规则），向后兼容。
- **patch**：无新增能力（缺陷修补 / 性能与读量治理 / 文档 / 内部重构 / 纯展示微调）。
- 起点：**v0.1.0**（地基）。纯他仓的 wave 不占本仓版本。

## 判级表

| 原编号 | 版本 | 主题 | 判级理由 |
| --- | --- | --- | --- |
| 地基（2026-09-03 ~ 09-15，无标签） | v0.1.0 | 服务初建与首个可用版本 | 起点 |
| 7 | v1.0.0 | 球队绑定真源上收认证中心（旧写入口休眠） | major：写入口下线 + 跨仓同轮 |
| 8 | v2.0.0 | 管理台改调认证中心 + FC26 ID 重键数据底座 | major：跨仓契约 + 生产重键 |
| 9 | v3.0.0 | 统一认证收口（`isOidc` 改判 `AUTH_MODE`）+ 兼容直写死码删除 | major：写入口下线 |
| 10 | v3.1.0 | 审计日志页 `/admin/audit` | minor：新增用户可见能力 |
| 17 | — | 仅 `shared/fc26Teams.ts` 一处跨仓引用（俱乐部平台 v2.3.0） | 不占本仓版本 |
| 32 | — | 球衣号编辑入口已搬回俱乐部平台（俱乐部平台 v4.0.0） | 不占本仓版本 |
| 33 | v4.0.0 | 名册改从俱乐部平台拉取（`/api/squads`）+ 四个球员写端点下线 | major：写入口下线 + 跨仓 |
| 36 | v4.1.0 | 错误文案收口 + 账号投影与定时对账 | minor |
| 37 | v5.0.0 | 球队建档双向同步（`team.id` 与 `clubs.id` 同号） | major：跨仓同轮 |
| 38 | v5.0.1 | D1 读消耗量化基建与治理 | patch：纯性能 |
| 39 | v5.0.2 | OR 清理 + 端点合并 | patch：纯性能 |
| 40 | v5.0.3 | 赛事作用域批量端点 + 球队详情聚合 + 周报探针 | patch：纯性能 |
| 41 | v5.0.4 | 测试计划（`TEST_PLAN.md`）+ 赛事核心链路回归测试 4 文件 + 测试桩保真度修复 | patch：文档与测试基建 |
| 42 | v5.0.5 | 缺陷报告 `BUG_REPORTS.md`（BUG-001~006 + 已修测试基建缺陷 BUG-T1） | patch：文档 |
| 43 | v5.0.6 | 修复 BUG-001：阶段收官自动回填补赛改读重算后的最新积分快照（重算先落库、回填后取人） | patch：缺陷修补 |
| 44 | v5.0.7 | 修复 BUG-002（回滚补复原 `finished_at`）、BUG-004（同分规则空链哨兵 `["none"]`）、BUG-006（积分榜页脚按生效链渲染） | patch：缺陷修补 |
| 45 | v5.0.8 | 修复 BUG-003（循环赛榜单名次全表唯一，读侧按阶段类型分桶）、BUG-005（小组赛 `(round, slot)` 阶段内唯一） | patch：缺陷修补 |
| 46 | v5.1.0 | 时区口径对齐（club v6.25.0 四仓约定移植）：业务日历日改上海口径（`cnDate`/H2H `dateLabel`/周报周界改上海周一）+ 前端共享时区偏好层 `src/lib/datetime.ts`（默认北京时间，三档可切）+ 19 处展示点收敛 + 时间展示静态锁 | minor：新增用户可见能力（时区偏好切换） |

| 47 | v5.2.0 | CPU 队接管向导配套入站端点：`POST /api/internal/team-rename`（HMAC 与 team-upsert 同口径、签名串含路径、同名早退 / 撞名 409 指名）+ 审计 `actor_user_id` 放开可空（迁移 `0025_audit_actor_nullable.sql`）+ `tests/internalTeamRename.test.ts` 8 例 | minor：新增端点（向后兼容） |

| 48 | v5.3.0 | 淘汰赛改手动落位编排（去自动生成）：新接口 `POST/PUT/DELETE …/stages/:stageId/slots[/:slot]`（首轮 2 的幂、上限 16 场、轮空、两回合自动铺 leg 行、结构变更原地 UPDATE 保 `match.id`）+ `generate` 对 elim 400、自动补生成跳过 elim 目标 + 单场删除端点对 elim 400、出现场次后回合制参数锁定 + 开打闸门（首轮非 2 的幂 → start/finish 409）+ 管理端淘汰赛分层列表视图 `src/components/KnockoutStageView.tsx`（点选落位/出线标记/待定来源引用）+ 公开赛程页两回合按回合分区块与空席位候选占位（`homePlaceholder`/`awayPlaceholder`，来源未完赛回退「待定」）+ 管理端 `qualifiers` 出线名单 + `tests/schedule.slots.routes.test.ts` 19 例、`tests/public.placeholder.routes.test.ts` 8 例 | minor：新增用户可见能力（淘汰赛编排方式与赛程展示改版） |

| 49 | v5.4.0 | 编排整批保存（草稿态）：worker 新端点 `PUT …/stages/:stageId/slots`（完整首轮快照 1..16 场整批落位，锁定口径与单场端点同源：started 增删闸、已开打槽位逐槽比对、后续轮开打仅幂等放行、快照内一队一场）+ `PUT …/stages/:stageId/matches/batch`（小组/循环跨轮增删混合，adds≤64/deletes≤32/总≤96，`guardMatches` 扩展 `extraPairs`/`excludeIds` 支持先删后排与跨轮 loops 计数，单 `db.batch` 原子落库）+ 前端淘汰赛落位改草稿态（`DraftSaveBar` 公共保存条、sessionStorage 防丢、锁定口径前端同源禁用）+ 按出线队数一键铺场（N=最小 2 的幂满编，只铺空槽）+ 小组/循环手动排赛草稿化（跨轮攒场去 2 场下限/24 上限、行删除入草稿待删除可撤销、置灰口径=库内+草稿−待删除）+ 测试 slots 26 例、bulk 15 例、UI 19+7 例（全量 486 passed） | minor：新增用户可见能力（整批保存与一键铺位，端点向后兼容） |

| 50 | v5.5.0 | 队长与定位球选人改版 + 跨仓 FC26 元数据链路：`shared/tactics.ts` 冻结属性/徽章口径（`ATTR_KEYS` 11 键、`ASSIGN_BADGE`（死球/精准头球/空中堡垒，psid 4/5/26）、`ASSIGN_RELEVANCE` 角色相关映射、`assignRelevanceScore`）与 `shared/fc26Playstyles.ts` 73 项徽章译名（金=psid≥101）；跨仓 meta 随名册同步入库（club v6.38.0 `GET /api/players/meta`，迁移 `0026_player_meta.sql`，失败不中断名册同步）+ `/me/team`、`/bootstrap`、代打板名册条目随包下发裁剪版 meta（11 属性+身高+playstyles 兜底）；战术页 18 槽位改只读 chip（两列等宽网格防组内漂移）+ 手机底部弹层选人、桌面独立编排页 `/tactics/assignments`（半场板钉子 ↔ 候选行双向悬停高亮、草稿两页共享、深链按组归属落位）+ 候选行两行式（属性胶囊 + 金银徽章 chip、冲突 ⚠ 仍可选提交拦截、无数据降级）+ `LineupView` 结构化徽章渲染；测试全量 574 passed | minor：新增用户可见能力（面板与编排页；跨仓端点为新增向后兼容，club 未上线时静默降级为无数据） |

| 51 | v5.6.0 | 循环赛带入积分（浮点倍率）+ 扣分改按阶段记录表：阶段级配置 `stage.config_json.carry = { fromStage?, mode: points/record, multiplier }`（没有该键 = 不带入，历史行为不变），`carriedPts = round(源阶段榜上的实际积分 × multiplier/100)`——折算基数就是源榜的 `pts`（净值，已扣过该阶段命中的扣分），所以罚分会沿带入链往下传导、不做「加回扣分」的还原，链式带入（A→B→C）自动成立；`pts = 本阶段得分 + carriedPts − 本阶段命中扣分`，mode=record 时场次列叠加源阶段战绩、points 时只算本阶段；落库新增 `standing.carried_pts` / `standing.deduct_pts`（读侧只取不算），迁移 `0027_stage_carry_and_deduction.sql` 建记录表 `points_deduction(id, entry_id, stage_id NULL=全赛事, points)` 并把 `entry.points_deducted` 回填成一条全赛事记录后置 0 废弃（同时给存量榜补 `deduct_pts`，保住「−N」标记）；新端点 `PUT …/stages/:stageId/carry`（不套「已有场次即锁」的赛制锁，带入不动场次结构）、扣分端点改整表替换 `items: [{ points, stageId }]`（`[]` = 清空）；级联重建 `buildStandingsForStagesStmts`（本阶段 + 其后所有积分阶段，同一轮把算出的分值直接喂给下游，避开 batch 生效前读到旧值的滞后）接上报分/改判、扣分、重新生成、删单场、清赛程；配了 `source` 的循环赛阶段参与集收敛为「本阶段场次出现过的 entry 并集」（无场次回退全量）；前端编排页带入三件套（来源 / 倍率(%) 可带小数且非负 / 方式）、新建阶段表单同款、积分榜「含带入 N」上标（负带入也显示）+ 阶段标题口径 chip + 脚注、扣分改记录列表面板（分数 + 生效阶段，最多 20 条）；测试 `tests/standings.carry.test.ts` 10 例 + 扣分旧用例改造，全量 584 passed | minor：新增用户可见能力（端点与迁移向后兼容） |

| 52 | v5.6.1 | 带入口径改「倍数」+ 默认值翻转 + 窄屏溢出修复：`config_json.carry.multiplier` 从百分数改成倍数（1 = 源分照搬、0.5 = 一半、0 = 不带分），折算式由 `round(源阶段榜上的实际积分 × multiplier/100)` 改为 `round(源阶段榜上的实际积分 × multiplier)`，迁移 `0028_carry_multiplier_to_factor.sql` 把 5.6.0 期间界面写下的百分数一次性 ÷100（`json_set` 只覆盖 `carry.multiplier`、只处理数值型，其余键与坏 JSON 原样保留；线上赛事 2 阶段 3 的 `{mode:record, multiplier:100}` → `1`）；「方式」缺省值从 `points` 翻成 `record`（`normalizeCarry` 与 `PUT …/stages/:stageId/carry` 同源，显式给了仍只收这两档），编排页带入开关与新建阶段表单默认「带入 + 积分+战绩 + 1 倍」（第一个阶段没有上游循环赛时不算「要带入」，不白报错）、「倍率(%)」标签与校验文案改「倍数」（`1 = 源分照搬`）＋界面 chip/脚注去掉百分号（`带入：预赛阶段 × 1 倍`，title 写明「按源榜实际积分 × N 倍」）；窄屏溢出三处：积分榜行内带入标记整体去掉（5.6.0 引入的「含带入 N」上标与 `.carried` 样式一并删除——此前 10 列表格被「含带入 17」撑宽 16px 触发横向滚动；带入信息由阶段标题 chip 与脚注承担，脚注不再引用标记名）、编排页 `.cfg-editor` 允许换行且子项 `max-width: 100%`（带入三件套 4 个控件不再撑破卡片）、报名表扣分面板宽改 `min(320px, calc(100vw - 24px))` 且 ≤640px 变底部固定抽屉（赛事表在窄屏是横滚容器，绝对定位面板会被裁掉）；测试 `tests/standings.carry.test.ts` 改倍数口径并新增「方式缺省 = 积分+战绩」与迁移 0028 换算用例（12 例），全量 586 passed | patch：口径与默认值调整 + 窄屏缺陷修补（存储语义变更由迁移 0028 自动换算，端点契约不变） |

| 53 | v5.7.0 | 积分榜与分享卡「近 5 场」状态列 + 首页「即将进行」每赛事一轮：积分榜（小组赛/循环赛）与分享卡新增「近 5 场」W/D/L 圆点列（绿 `#0e7a46` = 胜、灰 `#b7c2ba` = 平、红 `#b05a3a` = 负，与 H2H 的 `.fdot-W/D/L` 同色），统计该队**本赛事全部已完赛场次**（含小组赛/淘汰赛/往期循环赛，跨阶段合并；不跨赛事）；新 `readTournamentForm(db, tournamentId)` 一次扫该赛事已完赛场次（排除 `note='轮空'` 与空对手位，双边弃权 `walkover_side='both'` 双方记负，平分看点球、其余记平），按（阶段顺序 → 轮次 → 回合 → 场序）**倒序**每队收满 5 场即止，再 `reverse()` 成正序下发（最左最早、**最右为最近一场**；不用 `finished_at` 排序——改判会改 `updated_at`，轮次才是稳定键），与破同分规则并行取数；`StandingRowDTO.form` 随榜下发（一场未完为空数组）；界面圆点整组**右对齐**锚在列右缘（场次不足 5 场时左缘参差、最近一场始终上下对齐），表头「近 5 场」与圆点同右缘、表头 title 与脚注写明口径，≤640px 整列隐藏；分享卡 `TableCardData` 增 `formCol` / `forms` / `strongCol`（加粗列由「最后一列」改为可指定，空 form 画「—」，圆点与表头共用文字右界 `x + w - 8`）；首页 `buildUpcomingList` 每赛事只保留排序最靠前的**一轮**（扫描窗口 `LIMIT 8` → 120 行，JS 按 (stage_order, round) 锁定后收满 8 条，晚轮整轮丢弃、名额让给其它赛事）；测试 `tests/standings.form.test.ts` 4 例 + `tests/public.lists.routes.test.ts` 新增每赛事一轮用例，全量 591 passed | minor：新增用户可见能力（榜单与分享卡新增展示列，端点与 DTO 向后兼容） |

**当前版本：v5.7.0**

## 落地位置

- 版本号单一真源 = `package.json` 的 `version`。
- `vite.config.ts` 读 `package.json` 注入 `define.__APP_VERSION__` → `src/lib/version.ts` 导出 `APP_VERSION` → `src/App.tsx` 在 `AppShell` 内渲染全局页脚 `.app-footer`（样式在 `src/styles.css`）。
- 迁移文件名保留原编号（已 apply 的历史），靠本表桥接；历史 commit message 同样不改写。
- 子步骤标签（`增量 9C` / `9D` / `10C` 等）收敛到所在 wave 的版本号。

## 已知缺口

- 1–6、11–16、18–31、34、35 在本仓无任何「增量 N」标注（追踪与未追踪文件都查过），只能按时序推断，**不作为判级依据**；地基一段整体记为 v0.1.0。
- 本仓 `docs/` 只有用户手册资产，此前无台账文件。
