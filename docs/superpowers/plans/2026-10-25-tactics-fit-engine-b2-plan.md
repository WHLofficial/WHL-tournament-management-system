# 战术板 FIT 适配度引擎 B2：实施计划

日期：2026-10-25
状态：待用户审阅（B1 由工作流 dwfrun-3c7a6ed2 实施中，B2 计划先行评审，实施排在 B1 落地之后）
来源：[spec](../specs/2026-10-25-tactics-fit-engine-design.md) §5.3–§5.5、§6（免责第三层）、§8 的 B2 分期。
前置依赖：**B1 已交付** `shared/roleFit.ts`（ROLE_FIT / FIT_ATTR_KEYS）与 `shared/fitScore.ts`（fitProfileAll / fitTile / fitRank 的 rankRaw / rankShown / breakdown）；B2 全部消费这层引擎，不改引擎公式。

## 1 目标与验收

1. 一键推荐：提交卡上方次级按钮 → **先出 diff 预览**（逐槽「出/入、FIT 变化」），教练点「应用」才写回阵容——diff 即知情确认，不是自动改板；
2. 阵型对比：全部 **29 个**阵型按「最优分配后的全队总 FIT」排序，展开看短板槽位——选阵型从凭记忆变成看排序；
3. 替补角色化：替补每人标注「覆盖哪些槽位 + FIT」，按角色补强而非按名字堆人；
4. 免责第三层落位（推荐 diff 面板顶部，spec §6 原文）；
5. `npm run typecheck` + `npm test` 全绿，code-review-skill 审查通过。

硬约束（延续 B1）：不改表结构、不动公开端（推荐/对比/替补标注只渲染在教练端与代打板）、不装新依赖（匈牙利算法手写）、不做拖拽、不做对手情报。

## 2 交付物清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `shared/optimalXI.ts` | 新增 | 二部图最大权匹配（匈牙利算法），纯函数 |
| `src/pages/Tactics.tsx` | 改 | 推荐按钮 + diff 面板、阵型对比卡、替补覆盖标注 |
| `src/styles.css` | 改 | diff 面板、阵型对比列表、替补小字（现有色板变量） |
| `tests/optimalXI.test.ts` | 新增 | 最优性对拍 / 冲突用例 / 空候选 |
| `tests/`（现有文件补例） | 改 | 若 UI 纯函数抽出（diff 行构造、总分计算），补单测 |

无数据库、无 worker 改动、无新接口——三个功能全部是前端对 fitProfile 数据的再消费。

## 3 分步实施

### S1 `shared/optimalXI.ts`：匈牙利算法

```ts
/** 二部图最大权匹配：slots（≤11）× candidates（≤ 全队）。
 *  权重用 fitRankRaw（未截断），返回 Map<slotKey, playerPid> 与总权重。
 *  槽位多于可分配候选时允许空槽（该槽无推荐）；候选不足返回 null。 */
export function optimalXI(
  slots: { key: string; weightOf: (pid: number) => number | null }[],
  candidatePids: number[],
): { assignment: Map<string, number>; total: number } | null;
```

- 手写 Kuhn–Munkres（矩形阵补 0 权虚点化方阵，n≤40，毫秒级）；`weightOf` 返回 null = 不可分配（不建边）；
- 单测：① 最优性对拍——随机小规模（5 槽 × 8 人）与暴力全排列枚举总权一致（固定种子样本若干组）；② spec 点名的冲突用例：两人都是 ST 最优，验证次优者流向另一槽使**总和**最大（不是两人都挤 ST）；③ 空候选 / 槽位全不可分配 → null；④ 一人只占一槽（分配无重复）。

### S2 一键推荐 + diff 预览 + 免责第三层（Tactics.tsx）

- 按钮放「选择目标比赛」提交卡上方，次级按钮（`btn` 默认样式），文案「推荐首发（FIT）」；不放球场内；
- 点击 → 不改阵容，按钮下方展开 diff 面板（复用 subOpen 折叠模式）：
  - 顶部免责（spec §6 原文）：`推荐由系统按当前同步数据自动计算，不保证实际比赛表现；排兵决定权在教练`；
  - 逐槽行：`ST：王五 出 → 李四 入，FIT 64 → 87（+23）`；空槽只有「入」；推荐与现状相同的人显示「保持」；
  - 底部「应用推荐」「取消」两键；应用 = 一次性 setNames 写回 11 槽（只动人，不动角色/重心/替补/指派），面板收起；
- 候选池规则：全队 teamPlayers，**排除停赛与伤停**（提交本来会被拦/警示）；排除后不足 11 人则放开为全员并附一句提示；**无 meta 球员不进候选池**（推荐不猜无数据的人），现状里已占首发槽的无 meta 球员在 diff 中显示为「出」；
- 优化目标 = Σ fitRankRaw（未截断）；GK 槽不设硬约束（fitRank 的位置加分让真门将天然占优；队里没有真门将是数据事实，算法如实呈现）；
- 指派（队长/定位球）不动：被换出者承担的指派若悬空，沿用现有 assign 冲突/已填提示口径，不新发明规则。

### S3 阵型对比卡（Tactics.tsx + styles）

- 位置：战术设置卡（tac-settings）下方新增折叠卡「阵型对比 · 全队总 FIT」；
- 口径：当前阵型用**教练已调的角色/重心**；其余 28 个阵型用 DEFAULT_ROLES + PTE26 默认 focus（卡内一句小字注明「其他阵型按默认角色计算」）；
- 每阵型跑一次 optimalXI（29 × 毫秒级，useMemo 一次算完，依赖 form/roles/fitOfPid）；
- 列表按总分降序：`433 · 总分 912`，当前阵型高亮标「当前」；每行可展开 11 槽分配明细（槽位+人名+FIT，**升序排，短板在前**——spec §5.4「展开看短板槽位排序」）；
- 总分 = Σ fitRankRaw 取整显示、排序同口径。

### S4 替补角色化（Tactics.tsx + styles）

- 替补席（tac-bench-grid）每槽：选中球员且有 fitProfile 时，select 下方一行小字（mono，现有 muted 色）：
  `擅长 ST|AF 92 · CB|D 87 · CM|BTB 85`——槽位按**个人内 fitTile 降序**取 top3（他最适合打哪），值为对应槽位的 **fitRank shown**（打上去是什么水平）；「打哪」与「多强」双口径一行说完；
- 无 meta 或未选人：整行不渲染（与磁贴灰虚线语义一致，替补行不值得占位）；窄屏一行小字不挤占现有布局（替补槽本就是一列一项）。

### S5 测试与收口

1. `tests/optimalXI.test.ts` 四组用例（S1 清单）；
2. UI 纯函数补测：diff 行构造（出/入/保持三分支、空槽、无 meta）、阵型总分与短板排序、替补 top3 截取——能抽纯函数的抽到 lib，不写重型 UI 测试；
3. `npm run typecheck` + `npm test` 全绿 → code-review-skill 审查修复复测；
4. 浏览器冒烟待人工：diff 面板交互、29 阵型列表滚动、替补标注窄屏。

## 4 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 匈牙利实现出错（推荐非最优） | 暴力全排列对拍单测兜底，冲突用例钉住 |
| 33 阵型全量计算卡 UI | useMemo 依赖收窄（form/roles/fitOfPid），实测 >200ms 再降级为展开时惰性算 |
| 推荐被当成自动排兵 | diff 确认制 + 免责第三层 + 按钮文案带「（FIT）」提示口径 |
| B1 引擎接口变动 | B2 只依赖 fitProfileAll/fitTile/rankRaw 三个名字，B1 评审已锁定接口；若 B1 返工改接口，B2 的 S2-S4 联动改名即可（无逻辑耦合） |
| 回滚 | 纯前端增量：revert 即净，无迁移无接口 |

## 5 B2 明确不做

对手情报/克制分析（另立 spec）、拖拽排兵、公开端任何渲染、替补席自动推荐换人、指派（队长/定位球）的自动调整、数据库与 worker 改动。
