# 开球时刻排期器设计（线上版 v2）

> 状态：设计定稿，待开工 · 2026-11-04
> v1（2026-11-03）已被本版取代：事实核查推翻了轮数、回合数、验收方式，21 条决策全部落定。
> 关联：插件 `astrbot_plugin_whleague_revenue_system` 从「时刻唯一持有者」降级为「只读消费者」。

---

## 0. 一句话

在 tour 里建「赛季 → 周 → 轮次窗口 + 时刻池」，把排期做成可预览、可锁定、可撤销的管理端操作；插件不再产生时刻。

---

## 1. 目标与非目标

### 目标

1. 一轮排期从「找脚本/手填 CSV」变成后台一次操作：**预览 → 公布（锁定）**。
2. 时刻成为赛程的一部分：站内赛程页、分享卡、公开 API 都能显示「第 5 周 · 周六 20:00」。
3. 跨赛事疲劳（48h 硬 / 64h 软）由系统统一校验，不靠人肉。
4. 建立赛历数据模型，换季、补后半程、加赛事都只改数据。

### 非目标

- 不生成赛历本身（周/天窗口来自 `calendar_s9.csv` 导入）。
- 不重画赛历图（matplotlib 离线）。
- 不做 cron 自动排期（排期是运营动作）。
- 不做按周日历视图（下一期）。
- 不动对阵生成（`worker/lib/seeding.ts` 照旧）；本设计只填「什么时候踢」。

---

## 2. 关键事实（2026-11-04 实测，全部已核）

| 项 | 事实 |
|---|---|
| 迁移 | 31 枚，最新 `migrations/0030_oidc_admin_token.sql`；无任何赛季/周/窗口表 |
| `tournament` | 无日期字段；`match` 无时刻字段 |
| 公开 API | `match` 对象**无任何日期/时间/场地字段**；联赛 `leg=null` |
| 顶级联赛 | id=1，22 轮 × 6；r1–11 已完赛（66），r12–22 待赛（66） |
| 次级联赛 | id=2，stage2 预赛 14 轮 × 4；stage3 **冲刺组**（4 队双循环 6 轮）、stage4 **挑战组**（同）、stage5 **升级附加赛**（`legs=2`，源=冲刺组第 2–3 名）；已完赛 40，待赛 r11–14 共 16 |
| 冠军杯 | id=3，stage6 小组 3 轮 × 10（已完赛 30）；stage7 淘汰 `legs=2` + `final_legs=1`：r1 8 场（真实队名）、r2 4 场（占位符）、r3 **1 场**（决赛，占位符） |
| 时刻数据 | 8/23 那次导入的 136 个时刻，**100% 落在已完赛场次上**；前瞻 96 场零历史参照 |
| 插件产物 | `imports\赛程_S9前半程.csv`（136 行，`轮次,主队,客队,周,天,时间`），是时刻的唯一副本 |
| 经验值 | 252 对间隔全部 ≥64h，全局最小 **64.5h**，<72h 共 23 对（两连主豁免 5） |

---

## 3. 数据模型

新增迁移 `0031_schedule_calendar.sql`。纯加表加列，不改既有列。

### 3.1 时刻是虚拟时刻（v2 核心修正）

`HH:MM` 只是**标签**，不代表真实世界时刻：

- 永不换算成真实日期，永不涉及时区、夏令时；
- 虚拟时间轴：`第 W 周第 D 天` = `((W-1)*7 + (D-1))` 天，`day 1 = 周一`；
- 间隔计算：`(W2,D2,t2) − (W1,D1,t1)` 按这条轴算分钟数；
- 一场比赛的时长常量 `MATCH_MINUTES = 120`，只用于「上一场结束」排序，不影响间隔口径；
- 间隔口径为**开球到开球**。

因此 Q12 选「显示第 N 周 · 周 X」不是妥协，是唯一正确形态。

### 3.2 赛季与周

```sql
CREATE TABLE season (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,          -- 'S9'
  weeks      INTEGER NOT NULL,              -- 31
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE season_week (
  season_id INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  week      INTEGER NOT NULL CHECK (week >= 1),
  phase     TEXT NOT NULL CHECK (phase IN ('summer','autumn','winter','spring')),
  PRIMARY KEY (season_id, week)
);
```

S9 phase（2026-11-04 定稿）：W1–7 summer、W8–12 autumn、W13–18 winter、W19–23 spring、W24–31 summer。

### 3.3 轮次窗口

```sql
CREATE TABLE round_window (
  id            INTEGER PRIMARY KEY,
  season_id     INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  tournament_id INTEGER NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
  stream        TEXT NOT NULL CHECK (stream IN ('league','playoff','group','elim')),
  round         INTEGER NOT NULL,
  leg           INTEGER,                        -- 双回合用，联赛/小组为 NULL
  week          INTEGER NOT NULL,
  day_start     INTEGER NOT NULL CHECK (day_start BETWEEN 1 AND 7),
  day_end       INTEGER NOT NULL CHECK (day_end BETWEEN day_start AND 7),
  locked_at     TEXT,                           -- 公布即锁定（Q14）
  slot_override TEXT,                           -- JSON {"day":3,"slots":[{time,cap}]}：窗口内强制某天某档
  UNIQUE (tournament_id, stream, round, leg)
);
```

`stream` 解决两个问题：

- 冠冠軍杯小组赛与淘汰赛的 round 号都从 1 起，必须区分；
- 次级冲刺组（stage 3）与挑战组（stage 4）共享同一周，窗口只能按 `stream='playoff'` 建一条。

绑定规则：`(tournament_id, stream, round)` 落到该 tournament 下 kind 匹配的 stage；playoff 允许一对多（stage 3 + stage 4）。

### 3.4 时刻池（带容量）

```sql
CREATE TABLE time_pool (
  id          INTEGER PRIMARY KEY,
  season_id   INTEGER NOT NULL REFERENCES season(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL CHECK (phase IN ('summer','autumn','winter','spring')),
  competition TEXT NOT NULL CHECK (competition IN ('top','sub','cup')),
  day         INTEGER NOT NULL CHECK (day BETWEEN 1 AND 7),
  slots       TEXT NOT NULL,   -- JSON: [{"time":"18:30","cap":3}, ...]
  UNIQUE (season_id, phase, competition, day)
);
```

`cap` 解释历史形态：杯赛一天 5 场＝`18:30` 容 3 + `21:00` 容 2；联赛每个时刻容 1。

池子取值（v1 实测；冬季 2026-11-04 单独定，春季仍沿用秋季）：

| 季 | 赛事 | D5 | D6 | D7 |
|---|---|---|---|---|
| summer | top | 20:00, 20:30 | 17:30, 19:30, 20:30 | 18:00, 20:00 |
| summer | sub | 19:30, 20:00 | 17:30, 19:00 | 18:00, 19:30 |
| autumn / spring | top | 19:30, 20:30 | 12:30, 15:00, 17:30, 20:00 | 14:00, 16:30, 20:00 |
| autumn / spring | sub | 19:30, 20:30 | 13:30, 15:30, 17:00 | 14:00, 16:30 |
| winter | top | 19:30, 20:30 | 14:00, 16:30 | 14:00, 16:30 |
| winter | sub | 19:30, 20:30 | 13:30, 15:30 | 14:00, 16:00 |
| 任意 | cup | — | — | 每比赛日 18:30 cap3 + 21:00 cap2；R3 全部 21:00 |

### 3.5 比赛加列

```sql
ALTER TABLE match ADD COLUMN kickoff_week  INTEGER;
ALTER TABLE match ADD COLUMN kickoff_day   INTEGER;
ALTER TABLE match ADD COLUMN kickoff_time  TEXT;
ALTER TABLE match ADD COLUMN kickoff_override INTEGER NOT NULL DEFAULT 0; -- 1=越窗补赛
ALTER TABLE match ADD COLUMN kickoff_reason   TEXT;
```

### 3.6 快照

```sql
-- 0032 修正：次级季后赛横跨 stage 3/4，一个窗口落不到单个 stage，改用窗口锚定。
CREATE TABLE schedule_snapshot (
  id          INTEGER PRIMARY KEY,
  window_id   INTEGER NOT NULL REFERENCES round_window(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL,   -- {"assignments":[{matchId, week, day, time}], "conflicts":[...]}
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

---

## 4. 赛历导入与标签映射

来源 `calendar_s9.csv`：`season, week, day_start, day_end, label, category`。

### 4.1 映射表（按实测修正）

| label | tournament | stream | round | leg |
|---|---|---|---|---|
| `顶级联赛N`（1–22） | 1 | league | N | — |
| `次级联赛N`（1–14） | 2 | league | N | — |
| `次级联赛N`（15–20） | 2 | playoff | N−14（1–6） | — ← 绑 stage3+stage4 |
| `冠军杯小组赛N` | 3 | group | N | — |
| `冠军杯1/4赛首回合` | 3 | elim | 1 | 1 |
| `冠军杯1/4赛次回合` | 3 | elim | 1 | 2 |
| `冠军杯半决赛首回合` | 3 | elim | 2 | 1 |
| `冠军杯半决赛次回合` | 3 | elim | 2 | 2 |
| `冠军杯决赛` | 3 | elim | 3 | —（单回合，与联赛一致用 NULL） |
| `次级附加赛首回合` | 2 | playoff | **附加赛独立窗口**（W30 D2–3） | 1 |
| `次级附加赛次回合` | 2 | playoff | 同上（W30 D6–7） | 2 |
| `超级杯` / `转会窗` | — | — | 跳过，记日志 | — |

注意：附加赛不能用 round 号（stage5 只有 round 1），窗口表需允许 `stream='playoff'` 下用特殊 round 值区分常规 playoff 轮与附加赛——采用 `round=0` 表示附加赛（round 从 1 起，0 不冲突）。

### 4.2 已知不一致（已确认，不是 bug）

- CSV 写次级 20 轮，tour 只有 14 轮常规 + 6 轮季后赛——**15–20 是冲刺/挑战组**，不是多余数据；
- CSV 的超级杯、转会窗在 tour 里没有对应赛事：跳过，不建。

### 4.3 导入方式

`scripts/import-calendar.mjs`：

- `--dry-run` 打印完整窗口表 + 跳过项 + 绑定到的 stage id，人工核对；
- `--commit` 写远程 D1（需用户下令）；
- 幂等：按 `(tournament, stream, round, leg)` upsert。

---

## 5. 排期算法

### 5.1 输入

```ts
type ScheduleInput = {
  window: { week: number; dayStart: number; dayEnd: number };
  pool: Record<number, Array<{ time: string; cap: number }>>;
  matches: Array<{ id: number; slot: number; homeTeam: string; awayTeam: string }>;
  history: Map<string, { lastStartAt: number; lastWasHome: boolean }>; // 虚拟分钟
  mode: 'league' | 'cup';
};
```

`history` 跨赛事，一次查该轮前后 ±2 周内所有已排期比赛。

### 5.2 步骤

1. **拆天**：本轮 n 场按 `slot` 均分——`ceil(n/2)` 放 `day_start`，其余 `day_end`。联赛 3+3 / 2+2，杯赛 4+4。
2. **定序**：算每场最疲劳一方的「距上次开球小时数」，越疲劳越优先取晚档。
3. **过滤**：该日池子里，双方都满足硬约束（≥48h）的时刻；非两连主再要求 ≥64h。
4. **取档**：候选由晚到早，取第一个未满 `cap` 的时刻。
5. **降级**：无候选 → 放宽 64h → 再不行回退全池并记 conflict，不静默违规。
6. **稳定**：同分按 `match.id` 升序。

### 5.3 约束

| 级别 | 约束 | 处理 |
|---|---|---|
| 硬 | 同队两场开球间隔 ≥48h（跨赛事） | 违反 → 拒绝落库 |
| 软 | 非两连主 ≥64h | 违反 → 允许 + warning |
| 硬 | 落在窗口的 week / day 区间内（补赛除外） | 违反 → 报错 |
| 硬 | 时刻属于该周 phase 的池子 | 违反 → 报错 |
| 硬 | 同一队同日不得两场 | 违反 → 报错 |
| 报告 | 所有 <72h 的配对 | 只统计 |

---

## 6. 接口

挂在 `worker/routes/admin/kickoff.ts`（`app.route("/tournaments", …)`），整体继承管理台中间件的
`tour.match.manage` + `requirePwChanged`。窗口粒度的路径都用 `round_window.id`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/admin/tournaments/:id/windows` | 窗口清单（场次数 / 已排 / 可排 / 锁定） |
| GET | `…/windows/:wid/schedule` | 当前时刻 + 约束体检 + `blocked` 原因 |
| POST | `…/windows/:wid/schedule/preview` | 试排，不落库，返回 `proposalHash` + 冲突清单 |
| POST | `…/windows/:wid/schedule/commit` | 校验 hash → 写时刻 → 存快照 → 审计 |
| DELETE | `…/windows/:wid/schedule` | 清空（仅 pending 且未锁定） |
| POST | `…/windows/:wid/publish` | 写 `locked_at`（要求窗口内每场都有时刻） |
| POST | `…/windows/:wid/unlock` | 解锁，`{reason}` 必填 |
| POST | `…/windows/:wid/restore/:snapshotId` | 回滚到指定快照 |
| PATCH | `/api/admin/tournaments/:id/matches/:matchId/kickoff` | 单场改期 `{week,day,time,reason}`；空体 = 清空 |

规则：

- 有赛果的场次（status≠pending 或有比分）→ preview/commit/clean/PATCH 全部 409（整窗拒排）。
- 已 `locked_at` → preview/commit/delete/PATCH 409（先 unlock）。
- 对手 TBD 的场次不参与排期，随提案原样返回（`unscheduled`）；publish 会因为有场次缺时刻而 409。
- 窗口 `slot_override` 存在时，调度按 `{day, slots}` 单日收缩（杯小组 R3：10 场全落 D3 21:00）。
- **末轮同时开球**（2026-11-04 补）：窗口轮次 = 该 stream 在本赛季的最大轮次时，全部场次压到「窗口最后一天的最晚档」、容量放开到全场次数。覆盖顶级 r22、次级 r14、冲刺/挑战组 r6、杯小组 r3（后者本来就有 override），防止看着别人的结果踢。非末轮不启用。
- commit 前重算一遍提案并比对 `proposalHash`，数据/历史变过就要求重新预览。
- PATCH 越出窗口/池子 → 允许但必须给 `reason`，写 `kickoff_override=1` + `kickoff_reason`，响应里带 warnings。
- 每次写操作落 `audit_log`（`kickoff_commit / kickoff_clear / kickoff_publish / kickoff_unlock / kickoff_restore / kickoff_patch / kickoff_patch_clear`，target_type=`round_window`）。
- 公开读：`MatchDTO` 增加 `kickoffWeek/kickoffDay/kickoffTime`，`public.ts` 透出（P3-A 已上线）。
- 管理端 UI：赛事管理页新增「排期」标签（`src/pages/KickoffTab.tsx`）：选窗口 → 生成提案 → 提交 / 公布 / 解锁 / 清空，行内可单场改期。

---

## 7. 回填与切换

### A. 只读上线 + 回填（P3-A，先做）

1. 执行 `0031`；
2. 导入赛历（dry-run → commit）；
3. `scripts/backfill-kickoff.mjs` 读插件 CSV，按 `(赛事, 轮次, 主队, 客队)` 匹配，队名去 `(CPU)`，写三列；输出 136/136 对账 + 未命中清单；
4. 只读展示上线（赛程页 + 分享卡加「第 N 周 · 周 X HH:MM」）。

回填是 r12 排期的**输入**（r11 的最后一个时刻决定 48h 判断），必须精确。

### B. 生成器上线

1. 用 136 场历史做「约束回放」：灌进校验器，断言 0 违规，并复现 252 对 ≥64h、最小 64.5h、<72h 23 对；
2. 首次真排：顶级 r12（W18 D5–6）→ 杯 1/4（W20）→ 次级 r11（W18）；
3. 前瞻自检：r12 报告跨轮间隔分布。

### C. 插件降级只读

1. 插件改为读公开 API 的 `kickoff_*`（Q18a），本地仍存快照；
2. 关闭插件所有时刻写入入口：`/主场赛程导入` 的周/天/时间字段解析后丢弃，老指令不报错。

顺序不可反：回填 → 生成器 → 关写入。

---

## 8. 验收

| # | 项 | 标准 |
|---|---|---|
| 1 | 赛历导入 | 窗口覆盖 22 顶级 + 20 次级（含 6 轮 playoff）+ 3 小组 + 6 淘汰赛窗口 + 2 附加赛窗口；dry-run 人工核对 |
| 2 | 回填 | 136/136 命中，0 重复键；抽查 W5 D6 三场一致 |
| 3 | 约束回放 | 136 场历史灌入校验器 0 违规，252 对 ≥64h，最小 64.5h，<72h 23 对 |
| 4 | 幂等 | 同输入两次 preview 逐场相同 |
| 5 | 锁定 | 有赛果 → 409；已锁定 → 409；unlock 后可重排 |
| 6 | 撤销 | commit 后 restore 能还原上一版 |
| 7 | 补赛 | PATCH 越窗成功并标记 override |
| 8 | TBD | 对手未定的轮次拒绝排期且有明确提示 |
| 9 | 公开读 | 未登录可见三个新字段；分享卡显示周/天/时刻 |

---

## 9. 分期

| 阶段 | 内容 | 估时 |
|---|---|---|
| P3-A | `0031` + 赛历导入 + 回填 + 只读展示 | 1d |
| P2 | 赛程自动导入 + `tour_match_id` 锚点（既有排期） | — |
| P3-B | `worker/lib/kickoff.ts` + 接口 + 排期 UI + 回归 | 2.5d |
| P3-C | 插件改读公开 API + 关写入入口 | 0.5d |

---

## 10. 数据债务（2026-11-04 已全部处理）

| # | 债务 | 处置 |
|---|---|---|
| 1 | 冠军杯决赛多建了 `leg=2`（id 295），实际单回合 | **已删**（2026-11-04），stage 7 config 写入 `final_legs: 1`；线上决赛现为 `id 294` 单场 |
| 2 | 次级附加赛只有 `leg=null` 一场，stage 配置是 `legs=2` | **已修**：`id 317 → leg=1`，补建 `leg=2`（r1 s1 两回合齐） |
| 3 | stage 级 `legs` 无法表达「半决赛双回合 + 决赛单回合」 | **误判，无需改代码**：`legsOfRound()`（`worker/lib/manualBracket.ts:47`、`worker/lib/seeding.ts:58`）本来就支持 `final_legs` 按决赛轮覆盖；只是 stage 7 的 config 没写。现已补上 |

修复方式：`scripts/fix-bracket-legs.ts`（默认 dry-run，`--remote --commit` 才写），只动「pending + 无比分 + 无事件 + 双方未定」的空白占位，否则报错退出。依据之一是赛历：`round_window` 里冠军杯决赛只有一个窗口，附加赛有首/次回合两个窗口 —— 与实际场次对齐后，P3-B 排期不会撞上不存在的窗口。

---

## 11. 决策清单（21 条）

| # | 决策 |
|---|---|
| Q1 | 插件硬关时刻写入，一律只读 |
| Q2 | 窗口只建「能踢的」：三赛事 + 附加赛；转会窗不进库；超级杯不建赛事 |
| Q3 | 验收用「136 场约束回放」，不用历史对齐率 |
| Q4 | 时刻直接公开（API + 分享卡） |
| Q5 | 本期提供单场改期 PATCH |
| Q6 | 次级 15–20 = 冲刺组/挑战组，组内双循环 6 轮 |
| Q7 | 次级附加赛双回合 |
| Q8 | 冠军杯决赛单回合 |
| Q9 | 春季沿用秋季时刻池；冬季独立（周末下午场）——2026-11-04 修订 |
| Q10 | 冲刺/挑战 stage 已存在，窗口直接绑 |
| Q11 | 决赛多余 leg2 留到决赛前处理，登记债务 |
| Q12 | 显示「第 N 周 · 周 X HH:MM」，不引入真实日期 |
| Q13 | 附加赛 leg 现在就修 |
| Q14 | 公布即锁定，重排需解锁 |
| Q15 | P3-A 先于 P2 |
| Q16 | 预览只读，个别调整走 PATCH |
| Q17 | 超级杯不建赛事，赛历跳过 |
| Q18 | 插件读公开 API |
| Q19 | 赛程页只加时刻，不做周日历视图 |
| Q20 | 补赛允许越窗，标记 override + reason |
| Q21 | commit 存快照，支持恢复 |
