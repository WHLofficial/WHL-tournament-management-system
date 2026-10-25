# 战术板 FIT 适配度引擎 B1：实施计划

日期：2026-10-25
状态：待用户审阅
来源：[spec](../specs/2026-10-25-tactics-fit-engine-design.md)（§4–§6、§8 的 B1 分期）。B2（一键推荐 / 阵型对比 / 替补角色化）不在本计划。

## 1 目标与验收

1. 教练排首发时，每个磁贴的角色缩写带荧光底衬（绿/黄/红橙/灰虚线四态），一眼看出「这个人自己最适合打哪」；
2. 点磁贴的球员卡里，候选按 FIT 适配度降序、行首 mono 分数、可展开构成明细，不再是裸姓名下拉；
3. 徽章数据修好（playstyles 列从空 → PSID 口径全量自愈），属性/徽章在战术页真实可见；
4. 免责文案两层落位（页脚 + FIT 图例；第三层随 B2 推荐面板再落）；
5. 全部测试绿 + payload 增量实测记录进 PR。

硬约束（spec 定稿，实施不偏离）：

- 磁贴本体无数字；底衬不用金色（徽章 chip 专属）不用停赛红 `#c92a2a`；
- CA/PA 不进公式、不参与排序与档位；随 trim 下发作参考展示（候选行 CA 列、明细 CA/PA 标注「不参与 FIT 计算」）——用户 2026-10-25 修订，原「不展示」作废；
- 不改表结构、不加迁移、不动 club 仓、不动公开端（公开页面零 FIT 渲染，公开 lineup DTO 不加字段）；
- fitTile = 个人内百分位（阈值 85/50，GK 族与场上族分池）；fitRank = 绝对分（显示 min(99)、排序用未截断原始值）。

## 2 交付物清单

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `shared/roleFit.ts` | 新增 | 49 角色权重表 + RoleID/PosID 冻结映射 + FIT_ATTR_KEYS 键并集 |
| `shared/fitScore.ts` | 新增 | 双指标评分引擎（纯函数，前后端共用） |
| `scripts/freeze-fc26-refs.mjs` | 新增 | 一次性：从 club 仓 role.json / position.json 生成 RoleID/PosID 映射段（生成物粘进 roleFit.ts） |
| `worker/lib/clubMeta.ts` | 改 | playstyles 口径修正：下发为空时从 attrs.PSID1-15 补齐 |
| `worker/lib/playerMeta.ts` | 改 | trimPlayerMetaForPool 键集放宽（ATTR_KEYS ∪ FIT_ATTR_KEYS ∪ RoleID1-5 ∪ PosID1-4 ∪ CA/PA） |
| `src/pages/Tactics.tsx` | 改 | fitProfile memo、磁贴底衬 class 与悬停两数、球员卡 FIT 候选列表 |
| `src/components/FitCandidateList.tsx` | 新增 | FIT 排序候选列表（复用 asg- 视觉系），行内 breakdown 展开 |
| `src/styles.css` | 改 | 底衬四态、FIT 分数列、贡献条、热区缩略（全部现有色板变量） |
| `tests/roleFit.test.ts` | 新增 | 权重表完整性 + 映射哨兵值 |
| `tests/fitScore.test.ts` | 新增 | 引擎不变量 |
| `tests/fitCandidateList.test.ts` | 新增 | UI 纯函数：fitTileClass 85/50 分档边界 + sortFitCandidates 比较器（S8.4；终审补记） |
| `tests/coach.bootstrap.test.ts` | 改 | bootstrap 名册 meta 杂键用例：shotpower 已随 S4 进 FIT 键集，杂键换 volleys（终审补记，收口 commit 勿漏） |
| `tests/playerMeta.test.ts` | 改 | trim 键集放宽 + PSID 补齐两批新用例 |

## 3 分步实施

### S1 `shared/roleFit.ts`：权重表 + 映射冻结（最大的一步，先做）

**表结构**（key 用战术板语言，PTE26 的位置码+角色码）：

```ts
export interface RoleFitProfile {
  zh: string;                 // 中文名（候选面板展示），如 "突前前锋"
  attrs: [string, number][];  // 6 项关键属性 × 权重，权重取 3/3/2/2/1/1
  badges: number[];           // 相关徽章银基 psid（金=+100 引擎侧识别），3-6 个
}
export const ROLE_FIT: Record<string, RoleFitProfile>;  // key 形如 "ST|AF"，49 条
export const FC26_ROLE_BY_ID: Record<number, { slot: string; tier: 0 | 1 | 2 }>;  // RoleID1-5 → 槽位+档
export const FC26_POS_BY_ID: Record<number, string>;   // PosID1-4 → 位置码
export const FIT_ATTR_KEYS: readonly string[];         // 49 条权重的键并集（trim 放宽用）
```

**49 条怎么来**（spec §4.1 审查结论直接落地）：

- 11 个「一致」角色：直接采纳 `.tmp/fit-analysis/fit-dist.json` 数据驱动初稿；
- 7 个偏移角色（ST|F9、CB|BPD、CB|WDB、三路内锋、RM|W、GK|SK、CDM|CH）：按官方画像手工改（ST 三角色已改好：AF=加速/冲刺/射术/跑位、TF=弹跳/头球/力量、PO=射术/跑位/反应）；
- 29 个漏算（LB 全部 5 角色、RB 剩余、RW 大部、CAM|SS、GK|BPK 等）：按 FC26 官方角色定义手写，`.tmp/fit-analysis/ps-relevance.json` 交叉校验徽章；
- badges 以官方推荐为准、初稿校验（同上）。

**RoleID/PosID 映射**：`scripts/freeze-fc26-refs.mjs` 读 club 仓 `web/assets/ref/role.json` / `position.json`，把 chs（如 "ST 突前前锋 ++"）解析成 `slot = pos|roleCode + tier`，打印 TS 片段。role.json 中文名 ↔ PTE26 role 码的对应关系在脚本里内置一张 49 行覆盖表（CH/H/WH/BC 这类歧义码手工指定，如 CDM 的 CH→镇守 H、H→拖后 DLP），生成物人工核对后粘进 `roleFit.ts` 冻结——之后不联网、不依赖 club（与 fc26Playstyles.ts 同一冻结哲学）。

验收：`Object.keys(PTE26 每位置角色组合去重) ⊆ Object.keys(ROLE_FIT)` 无孤儿；徽章 psid 全部能在 FC26_PLAYSTYLES 找到。

### S2 `shared/fitScore.ts`：双指标引擎

纯函数、无依赖（只 import roleFit），供 Tactics.tsx 前端实时算——不加任何新接口，保密边界靠「只有教练端页面调它」维持。

```ts
// 一名球员的全部槽位分数，一次算完供磁贴/面板共用
fitProfileAll(meta: PlayerMeta | undefined): Map<string, FitSlotScore> | null;  // 无 meta → null
interface FitSlotScore {
  base: number;        // 6 属性加权均值（缺键按已有键加权，全缺 → 整槽位 null）
  badge: number;       // 银+0.5/金+1，封顶 3
  score: number;       // base + badge（个人内排位用这个）
  rankRaw: number;     // base + posBonus(2) + roleBonus(3/5) + badge —— 未截断
  rankShown: number;   // min(99, round(rankRaw))
  breakdown: { attr: [string, number, number][]; badgeHits: number[]; posHit: boolean; roleHit: 0|1|2 };
}
// 磁贴底衬：score 在个人内两个池（GK 族 = GK|GK / GK|SK / GK|BPK 槽位；场上族 = 其余）里的百分位 0-99
fitTile(profile: FitProfile, slot: string, group: FitGroup): number | null;
// ↑ 第 3 参 group 为终审后新增（spec §4.2「位置群兜底」修订，见 S5 冒烟补记）：跨群槽位一律 null
```

不变量（全部进单测）：百分位定义 = 池内排名 / (n-1) × 99，池内最高槽位 = 99、n=1 时 = 99；加分项 PosID 命中 +2、RoleID 一档 +3 / ++ 档 +5（tier 取该球员 RoleID1-5 里同槽位最高档）；徽章相关 = `ROLE_FIT[slot].badges` 命中（psid % 100 对银基，≥101 认金）。

### S3 `worker/lib/clubMeta.ts`：playstyles 口径修正

现状：club `/api/players/meta` 下发的 playstyles 数组几乎恒空（570 人仅 1 人有值），徽章真身在 attrs.PSID1-15。修在 tour 侧落库前（不动 club 仓）：

- `fetchPlayerMetaBatch` 解析单条后：`playstyles` 为空且 attrs 有 `PSID1..15`（值 > 0）→ 用 PSID 集合补齐（去重排序后走原有 cleanPlaystyles 同一出口）；下发正常时以下发为准不覆盖；
- 无需迁移回填：同步每小时全量跑，下一轮 570 人自愈；
- 已提交阵容 DTO（`worker/lib/lineup.ts` buildTeamLineup）的 meta 是全量下发不走 trim，徽章修复后自动受益，零改动。

### S4 `worker/lib/playerMeta.ts`：trimPlayerMetaForPool 放宽

- 键集 = `ATTR_KEYS`（11，定位球指派继续用）∪ `FIT_ATTR_KEYS`（权重表键并集，估 34±）∪ `RoleID1-5` ∪ `PosID1-4` ∪ `CA`/`PA`（仅展示参考，引擎不读、不进 FIT_ATTR_KEYS）。**不**带 PSID1-15（徽章走 playstyles）、**不**带 TeamID 等其余元数据；
- `tests/playerMeta.test.ts`：改断言到新键集，加「CA/PA 随 trim 下发（展示用）但不被引擎引用」钉住；
- payload 实测：`wrangler dev` 起本机，对比 bootstrap / /me/team 响应体前后大小，数字写进 PR。预估 attrs 从 11 键到 ~40 键，单队 30 人增量在几 KB 量级；若实测超预期，回收路径 = FIT_ATTR_KEYS 改为生成期裁剪（只含权重表实际引用键）。

> **实测补记（2026-10-25 终审轮）**：本地 D1 `player_meta` 为空、无法起完整 HTTP，改在 `backup-whl-tour-20261023-pre-v5.9.sql`（2026-10-23 生产快照，恰 570 行）上逐条量 meta 序列化尺寸——响应体里唯一变化的就是 `players[].meta`，等效于响应体增量（原始 JSON 字节数，未压缩）。脚本：`.tmp/fit-smoke/measure.ts`（旧 trim 逐句复刻自 git HEAD，新 trim 用现行 `trimPlayerMetaForPool`，S3 PSID 补齐口径逐句复刻 clubMeta）。
> - S4 键集放宽（playstyles 列不动）：人均 203 → 675 B，**+471.8 B/人**；折算单队 30 人 ≈ **13.8 KB**；全体 570 行 +268,901 B。略高于「几 KB」的字面预估但同量级，回收路径（FIT_ATTR_KEYS 生成期裁剪）保留未启用；
> - S3 叠加（PSID 补齐 playstyles）：520/570 行被补齐，再 +12,894 B（人均 +22.6 B）；S4+S3 合计单队 30 人 ≈ 14.5 KB。

### S5 `Tactics.tsx` + `styles.css`：磁贴荧光底衬

- `fitOfPid = useMemo(() => new Map(pid → fitProfileAll(metaOfPid.get(pid))))`——meta 来源维持现状两条链（bootstrap players + 已提交阵容 DTO，metaOfPid 已有）；
- 磁贴渲染处（form.pos.map 内）：`pid → profile → fitTile(profile, "${p.position}|${pl.role}")` → 映射 class `fit-g`（≥85）/ `fit-y`（50-84）/ `fit-o`（<50）/ `fit-na`（无 meta 或该槽位缺键），挂到现有 `.tac-tile-role` span 上；
- 悬停 title 追加：`个人内契合 94 · 该位置水平 86（本站估算，非 FC26 游戏内 CAPA）`（无数据则不追加）；
- CSS（定稿视觉见 fit-tile-badge-spec.html）：`.tac-tile-role` 加 `box-shadow: inset 0 -3px 0 0 <色>`（绿 `#00c882` / 黄 `#d9c34a` / 红橙 `#e0562e`），只罩角色缩写自身宽度，不占布局高度；灰虚线态用 `border-bottom: 1.5px dashed rgba(244,246,243,.35)`。磁贴 92×44、摆位表、`tests/pitch.test.ts` 零改动；
- 冒烟验收：随机抽 3 名门将确认场上槽位**不出绿档**（分池的意图）；若出现，停手回 spec §4.2 补「场上池绝对弱兜底」条款再继续，不就地发明规则。

> **冒烟补记（2026-10-25 终审轮）：首轮未过，升级后按下方裁决改引擎，复测通过（数字见下）。** 同一生产快照（570 行）上跑全量门将（不止抽 3 名）：43 名门将共 **257 个场上槽位 fitTile ≥ 85（绿档）**，实现者原版脚本 `.tmp/fit-smoke/s5-gk-smoke.mjs` 三轮随机抽 3 组亦全部复现（如 GK #234577：CDM|DLP fitTile=95 而绝对分 rankShown 仅 46）。根因是结构性的：个人内百分位恒把自己池内前 ~15% 涂绿，分池只隔离 GK 绝对分、压不住场上池内的相对排名——spec §4.2「分池后门将的场上槽位不再出虚高档」的前提被生产数据证伪（该句的原始生产验证只验了门将的 GK 槽位与场上球员，未验门将的场上槽位）。
>
> **升级裁决（主会话，同日）：定稿「位置群兜底」。** PosID1-4 任一为 GK → 门将群，其场上族槽位一律无档（灰虚线、title「非其位置群」）；场上群球员的 GK 族槽位同理。不采用绝对分下限（BPK 门将传球属性与低 CA 场上球员重叠、无干净分隔，且会连带剥夺低 CA 球员绿档，违背「低 CA 也有最佳位置」定稿）。spec §4.2 已补条款；修理工获授权改引擎并钉测试（门将 fixture 跨群槽位 null、低 CA 门将 GK 绿档保留），重跑本冒烟通过后收口。
>
> **复测记录（修理工，同日）：冒烟 PASS。** 同快照全量复测（`.tmp/fit-smoke/measure.ts`）：43 名门将场上槽位绿档 **0**、位置群误判 0、GK 族绿档保留（40/43 出绿档，另 3 人 GK|GK=GK|SK 并列同分按既有「严格低于自己个数」口径并列落黄档，非本次改动引入）；场上球员 527 人 GK 槽位出档 0、场上绿档 526 人不受连坐。跨群槽位绝对分照算（候选面板不缺行），FIT 图例灰虚线语义同步改「无数据 / 非其位置群」。

### S6 `FitCandidateList.tsx`：球员卡候选面板

球员卡（tac-editor）里：**球员 select 保留不动**（快速选人 + 触屏原生体验），其下新增 FIT 候选列表——

- 面板头：`FIT 适配度 · ${roleFull(pl.role)}（${pl.focus}）` + 该槽位 5×5 热区缩略（40px，heatOf 已有，三层绿复用 .tac-heat 色值；热区是槽位属性与球员无关，放头部一次，不进每行）；
- 行 = FIT 大号 mono 分数（rankShown，列头「FIT 适配度」）+ CA 参考列（mono 小字，如「CA 84」，图例标注不参与 FIT）+ `#号 姓名` + 状态后缀（optionSuffix 复用）+ 该角色权重前三属性 pill + 相关徽章 chip（asg-pill / asg-chip 视觉直接复用）；已被其他首发槽占用的标「已首发」（复用 asg-elsewhere 样式），仍可点（与现状 dup 检测口径一致）；
- 排序：rankRaw 降序（未截断），无 meta 排尾标「无数据」；点行 = setNames 写入该槽（与 select 同一入口）；
- 点行展开 breakdown：6 项属性贡献（名称 + mono 数值 + 权重贡献横条，条长 ∝ 属性×权重）+ 徽章加成行 + 「个人内契合 X」（fitTile）+ CA/PA 明细行（标注「不参与 FIT 计算」）；
- 窄屏：列表在球员卡内自然纵向滚动，不新开弹层（磁贴→球员卡路径触屏已通）。

### S7 免责文案两层

- 页脚 `tac-foot` 追加句：`FIT 适配度与自动推荐为本站估算，不构成对比赛表现或成绩的任何保证。`
- FIT 图例：候选面板头部小字（磁贴底衬四色图例 + `按最近一次同步的 FC26 属性与徽章加权估算，非游戏内 CAPA 或官方数值`）。

### S8 测试与收口

1. `tests/roleFit.test.ts`：PTE26 全组合无孤儿（CI 防漏配）、每条恰 6 属性、权重和 = 12、badges psid 全在 FC26_PLAYSTYLES、RoleID/PosID 映射哨兵值（如 142 → "ST|PO" tier 2）；
2. `tests/fitScore.test.ts`：区间 [0,99]、breakdown 属性贡献加权和 = base、徽章封顶 3、加分封顶组合、无 meta → null、个人内最高槽 = 99、GK/场上分池（门将 fixture 的场上槽位均分低于其 GK 槽）、rankRaw 不被 99 截断（排序用）；
3. `tests/playerMeta.test.ts`：trim 新键集（含 CA/PA 下发但引擎不引用）；PSID 补齐（下发空/非空两分支）；
4. UI 纯函数（class 映射 fitTile→fit-g/y/o/na、候选排序比较器）单测兜住，不做重型 UI 测试；
5. 收口：`npm run typecheck` + `npm test` 全绿 → code-review-skill 审查并修复复测 → payload 实测数字与「无迁移、公开端零改动」核对清单写进 PR 描述。
   **收口待办（终审轮补记，勿漏）**：① payload 实测数字（人均 +471.8 B、单队 30 人 ≈13.8 KB，S3 叠加后 ≈14.5 KB，全文见 S4 实测补记）写进 PR 描述，并随 B1 的 VERSIONS.md 条目记录（B1 尚未定版本号，VERSIONS 条目收口时补）；② `tests/coach.bootstrap.test.ts`（shotpower 进 FIT 键集、杂键换 volleys）与 `tests/fitCandidateList.test.ts` 必须进收口 commit 文件清单。

## 4 风险与回滚

| 风险 | 应对 |
| --- | --- |
| 49 权重表工作量大（半天到一天） | 偏移 7 + 漏算 29 必须一次出齐（否则 LB/RW 槽位无底衬）；一致 11 直接采纳初稿 |
| payload 增量超预期 | S4 实测把关；回收路径 = FIT_ATTR_KEYS 生成期裁剪 |
| 门将场上槽位分池后仍出绿档 | S5 冒烟验收拦住；处理回 spec 补条款，不就地改算法 |
| RoleID↔role 码桥接错位 | 生成脚本覆盖表 + 哨兵值单测 + 生成物人工核对（142=ST Poacher ++ 已验证对齐） |
| 回滚 | 全部改动无迁移无 club 依赖：revert 即净；底衬渲染以「有 fitOfPid 才画」降级，meta 断供时全灰虚线不报错 |

## 5 B1 明确不做（B2 另立计划）

一键推荐（匈牙利算法）、阵型对比、替补席角色化、推荐 diff 面板（免责第三层随它落）、对手情报、拖拽、任何 club 仓 / 数据库 / 公开端改动。
