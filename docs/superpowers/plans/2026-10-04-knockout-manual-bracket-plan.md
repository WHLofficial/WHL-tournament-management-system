# 实现计划：淘汰赛手动落位编排

- 日期：2026-10-04
- 设计：`docs/superpowers/specs/2026-10-04-knockout-manual-bracket-design.md`（已获批；含审阅后补齐的占位数据通路/决赛归属决议）
- 验收命令：`npm run typecheck`、`npm test`（vitest run，34 个测试文件基线）
- 分工：后端（T1–T8）由主 agent 实现；管理端前端（T9）与公开页前端（T10）各派一个 subagent 并行实现，契约见 §2（先冻结 `shared/types.ts` 再开工）

## 1. 契约冻结（先做）

`shared/types.ts`：

```ts
// MatchDTO 增补（公开端只用占位；管理端只用 qualifiers）
/** 空席位候选占位（仅公开赛程下发；非空席位/算不出时为 undefined） */
homePlaceholder?: string | null;
awayPlaceholder?: string | null;
```

管理端 `GET /api/admin/tournaments/:id/matches` 响应增补：

```ts
{ matches: MatchDTO[]; qualifiers?: Record<string, number[]> } // stageId(字符串键) → 出线队 entryId 列表（best-effort，解不出则缺省）
```

新管理端接口（仅 elim、仅首轮；`round = 1`）：

| 方法 | 路径 | 请求体 | 语义 |
| --- | --- | --- | --- |
| POST | `/api/admin/tournaments/:id/stages/:stageId/slots` | — | 首轮末尾追加一个空场次（N 上限 16） |
| PUT | `/api/admin/tournaments/:id/stages/:stageId/slots/:slot` | `{homeEntryId: number, awayEntryId: number \| null}` | 落位/改位/轮空（away=null）/清空（两者皆 null 时的等价写法：`{homeEntryId:null, awayEntryId:null}`） |
| DELETE | `/api/admin/tournaments/:id/stages/:stageId/slots/:slot` | — | 删除首轮场次（后续场次序号前移） |

错误码：非 elim → 400；`home=null && away≠null` → 400；队伍不属本赛事 / 主队=客队 → 400；首轮 >16 场 → 400；单场删除端点对 elim → 400；淘汰阶段出现场次后改回合制参数 → 400；不存在的首轮场次号 → 404（路由无 round 参数，`:slot` 只按首轮寻址，后续轮无从表达）；目标场次已开打 / 同轮一队两场 / 阶段已开打时增删 / 后续轮次已开打时调整首轮落位 → 409。

## 2. 后端任务

- **T1 `worker/lib/manualBracket.ts`（新建）**
  - `roundsFor(n)`：2 的幂 → `log2(n) + 1`（首轮 N 场 = 满编 2N 队，总轮数 = log2(2N)），否则 0；`isPowerOfTwo(n)`。
  - `layoutShells(stageId, firstRoundCount, cfg)`：首轮 N = 2^k 时铺 r∈[2..k+1] 空壳（r 轮场次 = N/2^(r-1)；`r === 总轮数` 用 `final_legs`，其余用 `legs`；启用季军赛且总轮数 ≥ 2 时加季军赛段）。**必须与 `worker/lib/seeding.ts` 现有空壳布局逐键一致**（round/slot/leg），用测试钉住 `buildElimPlan` 同布局不变式。
  - `relayRound1Stmts(stageId, legs, desired, existing)`：未开打的首轮已落位场次按新的决赛归属重铺 leg 行（保留对阵；两回合 leg1 主/leg2 主客对调；轮空单行 + `winner_entry_id` + `note='轮空'`；形状不变时原地 UPDATE 保 `match.id`，形状变才删行重插）。
  - `shellStmts(stageId, n, cfg, rows)`：后续轮空壳差量对齐（多出的键删除、缺失的插入、键一致但带过期预填的 pending 行置 NULL）；非 2 的幂时清掉 r ≥ 2 的空壳。
  - 所有「结构变化」路径收口为一个 `rebuildStmts(stageId, n, cfg, desired, rows)`：重建空壳 → 重铺 leg 行 → 返回语句数组；调用方随后补跑 `buildAdvanceStmts`（`worker/lib/standings.ts:167`，幂等）并捕获 `AdvancerError` → 409。
- **T2 端点实现（`worker/routes/admin/schedule.ts`，与现有手动落场端点并列）**：POST/PUT/DELETE `/api/admin/tournaments/:id/stages/:stageId/slots[/:slot]`；校验按 §1；落位 = 删该场次现有行后按 legs 重铺（轮空单行）；删除 = 删除该 slot 全部 leg 行 + 后续 slot 前移（`UPDATE match SET slot = slot - 1 ...`）；每次变更后 `rebuildStmts` + 补跑晋级器。（`schedule.ts` 无审计写法，故不写 audit。）
- **T3 关闭自动生成**：`POST …/generate` 对 elim → 400「淘汰赛改为手动落位，不再自动生成对阵」。
- **T4 自动补生成跳过 elim 目标**：`buildAutoFillStmts`（`worker/routes/admin/schedule.ts`）在**目标阶段 kind === "elim"** 时 continue（现状只跳来源是 elim 的，需确认后补上）。
- **T5 开打闸门**：`worker/routes/admin/scoring.ts:107-129`（start）与 `:130-340`（finish，含快速报分/弃权/改判分支）在 elim 阶段首轮场次数非 2 的幂时 → 409「首轮场次数需为 2 的幂」。两个入口都要覆盖。
- **T6 公开占位（`worker/routes/public.ts:266-375`）**：`/tournaments/:id/matches` 为 elim 阶段计算 `homePlaceholder`/`awayPlaceholder`（规则见 spec §3.5）：round ≥ 2 取上一轮 slot 2s-1/2s（季军赛取两场半决赛）已有队名「/」连接；round 1 按来源（cross token → 队名或「A 组第 1」；range → ≤2 支列名、>2 支「阶段 N 第 from–to 名」）；否则「待定」。
- **T7 管理端 qualifiers**：`GET /api/admin/tournaments/:id/matches` 增补 `qualifiers` 映射（cross token 队 / range 名次区间队；来源未完赛则缺省）。
- **T8 后端测试**：新增 `tests/schedule.slots.routes.test.ts`（增/删/落位/轮空/清空、全部 400/409、1/2/4/8/16 布局、N=1 用 final_legs、1→4 场次变更重铺 leg、清空回退空场次）、`tests/public.placeholder.routes.test.ts`（「1/2 vs 3/4」、区间回退、待定回退、季军赛）；扩展 `tests/schedule.generate.routes.test.ts`（elim → 400）与 `tests/scoring.finish.routes.test.ts`（非 2 的幂开打 409）；晋级器回归沿用 `tests/standings.rebuild.test.ts`。

## 3. 前端任务（subagent 并行）

- **T9 管理端淘汰赛视图（`src/pages/ScheduleTab.tsx`，可拆新组件 `src/components/KnockoutStageView.tsx`）**：elim 阶段改为分层列表（spec §3.1）；空场次「〔空〕点此落位」→ 候选面板（全部参赛队 + 分组字母；`qualifiers` 置顶加「出线」；已落位队置灰）；先主后客 → 确认；单队 → 「轮空」；已落位未开打可改/清；段落末「〔＋新增场次〕」；首轮非 2 的幂提示 + 禁用开打相关操作；有 live/finished 后只读（保留清除赛程）；移除「自动生成对阵」按钮。文案统一「场次」。
- **T10 公开页（`src/pages/PublicTournament.tsx`）**：elim 两回合轮次按【首回合】/【次回合】区块渲染（单场轮次不分块），晋级方在次回合行高亮；未定席位用 `homePlaceholder`/`awayPlaceholder`（回退「待定」）；零场次显示「赛程待编排」。
- **T11 前端测试**：管理端分层列表与落位流程、公开页区块与占位（沿用 jsdom + 现有组件测试范式）。

## 4. 收口

- `npm run typecheck` + `npm test` 全绿；code-review-skill 过一遍。
- 版本：`package.json` + `VERSIONS.md` → v5.2.0（minor，新能力：淘汰赛手动落位编排）。
- commit 分段：契约 → 后端 → 管理端前端 → 公开页前端 → 测试/版本收口。
