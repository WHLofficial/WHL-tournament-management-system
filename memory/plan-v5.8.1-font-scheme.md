# v5.8.1 字体方案（tour 试点）· 实现计划

> 2026-10-22 起草。范围：**只做 whl-tournament**，作为全平台字体推广的试点；guess / auth 待本仓验收后再议。
> 判级：**patch**（无新增能力，纯展示微调，口径见 `VERSIONS.md`「判级口径」）。package.json `5.8.0` → `5.8.1`。
> 上游参考：club 仓 v6.53.2（`web/src/styles.css` 顶部 5 条 `@font-face`、`UI_DESIGN.md` §7）。两仓角色三件套同名同源，但**衬线作用域不同**（见 F2）。

## 0. 目标

1. 西文换 Inter（只覆盖拉丁，CJK 仍走系统黑体，不自托管中文正文）。
2. 数字换 JetBrains Mono，并修掉 `--mono` 栈里 `ui-monospace` 抢首位的旧 bug（41 处 `var(--mono)` 自动跟随）。
3. 中文标题上衬线（Noto Serif SC 600 子集），**只给版面级大字**，把「报纸头版」的门户气质坐实。
4. 字号、行高、组件尺寸一律不动；本增量只换字形与字体栈。

## 1. 裁决（F 表）

| # | 议题 | 裁决 | 依据 |
|---|---|---|---|
| F1 | 字体资产 | 自托管 5 个 woff2：tour 子集宋体 600 `276,784 B`（2023 字，CJK 1409）+ Inter latin `48,444` / latin-ext `74,328` + JetBrains latin `40,404` / latin-ext `15,196`；三族全 OFL，许可证随文件入仓 | 子集按本仓源码 + 生产 20 个中文队名切；首屏（纯拉丁/中文正文）只需 3 个文件 = **365,632 B**，latin-ext 靠 `unicode-range` 懒加载 |
| F2 | 衬线作用域 | **只给 4 个选择器**：`h1`（26–32px 页面标题）、`.art-title`（26px 战报/综述大标题）、`.page-head h2`（24px）、`.whl-masthead h2`（24px / ≤480 19px 报头） | 实测反白 16px 头条标题换衬线后笔画显细、输给黑体（见 §2 证据）；h3（13/15/16px 卡片小标题）一律保持黑体 |
| F3 | 中文正文 | 不引入网络中文字体，正文仍 `PingFang SC / Microsoft YaHei / Noto Sans SC` 系统栈 | 与 club 一致；省 300KB+，12–13px 密集表格靠系统 hinting 更稳 |
| F4 | 数字 | `--mono` 改 `'JetBrains Mono', ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace`，并保留 `--mono` 名称（41 处不用改）；已带 `tabular-nums` 的规则不动 | 旧栈 `ui-monospace` 首位导致 JetBrains 永远轮不到（club 同款 bug） |
| F5 | 字重 | 宋体只载 600，标题规则写 `font-weight: 600; font-synthesis-weight: none` | 单字重资产；禁用合成粗，避免 CJK 糊边 |
| F6 | 加载 | `index.html` 只 preload `/fonts/inter-latin.woff2`（`crossorigin`）；**不 preload 277KB 宋体** | preload 越多越抢占首屏带宽；宋体 `font-display: swap` 渐进替换 |
| F7 | 375 报头折行 | **顺带修**（既有缺陷）：375 下 `.whl-masthead-date` 占 155px，把「WHL 头版」挤成两行（改字号前后都是 2 行，但衬线行高更高，行盒 59→65px）。方案：≤480 日期改短格式（`10-22 周四`）或整行隐藏，`.whl-masthead h2 { white-space: nowrap }` | 截图与实测数据见 §2；不修会把缺陷带进衬线版 |
| F8 | 明确不做 | ①中文正文网络字体；②全局 `.num` 等宽改造；③admin 表格列宽手术；④guess/auth 仓改动 | 控制 patch 半径；表格宽度只在 JetBrains 引起回归时单点处理 |

## 2. 衬线 A/B 证据（2026-10-22，生产门户 + 注入子集实测）

页面：`https://tour.whleague.win/`（首页 = 报纸头版）与 `/report/195`（战报大标题）。字体用 `C:/tmp/serif-tour.woff2`（即 F1 的子集）以 data URI 注入，未改仓库、未改生产。

| 位置 | 字号 | 现状（黑体） | 衬线 | 结论 |
|---|---|---|---|---|
| `.whl-masthead h2`「WHL 头版」 | 24 / 19px，字距 6px | 像加粗小标题 | 报纸报头，字距被衬线吃住，气质直接到位 | **采用** |
| `.art-title`（战报标题） | 26px | 有力度但通用 | 更像报纸头条，中文顿号与引号更工整 | **采用** |
| `h1`「WHL 赛事」 | 32px | 通用粗黑 | 版面标题感，与头版呼应 | **采用** |
| `.whl-headline-title`（头条卡内标题） | 16px，深绿底反白 | 粗黑有冲击力 | 笔画偏细，反白下显弱 | **不采用**（保持黑体） |
| `.upcoming h2`「进行中/即将进行」 | 16px | 粗黑 | 16px 衬线偏轻 | **不采用**（保持黑体） |
| 卡片 h3（`.md-lineups` 15px、`.tac-assign-head` 13px、`.share-dialog-head` 16px） | 13–16px | — | 小字号衬线发虚 | **不采用** |

报头实测（同一页面，注入前 → 注入后）：

- 1440：宽 150→152px，行盒 41→46px，单行不变。
- 375：可用宽 343px 中被日期占 155px，报头可用仅 104px；改前 2 行（48px）、改后 2 行（54px）——**折行是既有缺陷**，与字体无关，但衬线让两行更显眼，故列入 F7。

## 3. 改动清单

| 文件 | 改动 |
|---|---|
| `package.json` | `version` 5.8.0 → 5.8.1 |
| `src/styles.css` | ①文件头 5 条 `@font-face`（宋体 600 无 `unicode-range`；Inter / JetBrains 各 latin + latin-ext 双 `unicode-range`，全部 `font-display: swap`）；②`:root` 增 `--font-display` / `--font-sans` / `--font-mono`，`--mono: var(--font-mono)`（原 16 行）；③`body`（23–31 行）改 `font-family: var(--font-sans)`；④新增 `h1, .art-title, .page-head h2, .whl-masthead h2 { font-family: var(--font-display); font-weight: 600; font-synthesis-weight: none }` |
| `src/pages/portal.css` | ①`.whl-masthead h2` 加 `white-space: nowrap`；②≤480 媒体查询内把报头行改为「报头 + 日期短格式/隐藏」，避免 F7 折行 |
| `index.html` | `<head>` 加 `<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />` |
| `public/fonts/` | 5 个 woff2 + `OFL-NotoSerifSC.txt` / `OFL-Inter.txt` / `OFL-JetBrainsMono.txt` + `README.md`（来源、字符集、再生成命令） |
| `scripts/build-fonts.py` | 从 club `scripts/build-serif-subset.py` 移植：下载 `NotoSerifSC_600SemiBold.ttf` 到 `.cache/`，扫 `src/**/*.{ts,tsx,css}`、`worker/**/*.ts`、`shared/**/*.ts`、`index.html` + 生产 20 队名 + 中文标点，输出 277KB 子集 |
| `.gitignore` | 增 `scripts/.font-cache/` |
| `VERSIONS.md` | 新增 `5.8.1` 行（patch：纯展示微调） |
| `TEST_PLAN.md` | 增补字体验收用例（见 §4） |

## 4. 验收

基线（改动前实测）：`npm run test` **52 文件 / 628 例通过（7 跳过）**；`npm run typecheck` 0 error；`npm run build` 通过。

1. `npm run typecheck` / `npm run test` / `npm run build` 三绿，用例数不低于基线。
2. 首屏字体请求：`/` 与 `/report/:mid` 只拉 3 个文件（宋体 + Inter latin + JB latin）= **365,632 B**，无 latin-ext；控制台无 404。
3. 截图（1440 / 375）：`/`、`/news`、`/report/:mid`、`/t/:id`、`/tactics`、`/admin/teams`——报头单行、页标题衬线、卡片 h3 仍黑体、无新横滚。
4. 表宽回归：`.standings-table`、赛程表 `.schedule-tab`、战术板数字列，对比改动前后列宽与 375 溢出；`--mono` 41 处中 `.code-text`（邀请码 18px + 0.25em 字距）与 `.rp-scorebox .num`（44px/800）必须单独看。
5. 大比分：`.whl-headline-score` 44px/80px 数字在 JetBrains 下的实际宽度 vs `min-width: 170px`（375 下 112px），确认两侧队名不被挤压。
6. 回退：删 `@font-face` 与令牌即回系统字体，无数据/接口影响。

## 5. 风险

- **JetBrains 比 Consolas 宽**：大比分、邀请码、时间戳可能变宽换行；只在回归时单点调 `min-width` / `letter-spacing`，不动布局。
- **衬线单字重**：标题内若有 `<strong>` 会被压回 600；如视觉需要强调，用字号或颜色而非字重。
- **子集缺字**：命中子集外字符会逐字回退 SimSun（可接受）；文案或队名改动后必须重跑 `scripts/build-fonts.py`，否则新字掉回宋体。
- **深色底反白**：报头是深绿字（`--pitch-deep`）在浅底，风险低；头条卡内标题已裁决不上衬线，规避了反白变细的问题。

## 6. 待办（实施时）

- [x] S1 资产生成与入仓（`.woff2` + OFL + README）
- [x] S2 `styles.css` 令牌 / `@font-face` / body / 衬线规则
- [x] S3 `index.html` preload
- [x] S4 `portal.css` 375 报头修复
- [x] S5 构建 + 六页两宽度截图
- [x] S6 表宽 / 大比分宽度回归
- [x] S7 三绿门禁
- [x] S8 `VERSIONS.md` + `TEST_PLAN.md` 回写
- [ ] 上线后再评估 guess（静态站）→ auth（无 assets 管道，最后做）

## 7. 实测结果（2026-10-23，本地 dist @ 8790）

- 门禁：`typecheck` 0 error；`test` **52 文件 / 629 通过（7 跳过）**（基线 628 + 新增 `fmtDateShortWd` 1 例）；`build` 成功，`dist/fonts/` 5 woff2 + 3 OFL + README。
- 字体请求（`/t/3`、`/weekly`、`/report/360`）：只拉 `noto-serif-sc-600-subset` + `inter-latin` + `jbmono-latin` = **365,632 B**，无 latin-ext、无 404。`/` 因本地种子数据含 `Ȩ`（U+0228）触发 latin-ext 74KB——恰好证明 `unicode-range` 分片生效；生产首页无此字符。
- 标题命中：`h1` 32px、`.whl-masthead h2` 24/19px、`.art-title` 26/21px、admin `.page-head h2` 均为 Noto Serif SC 600；`.whl-headline-title` 16px 仍 Inter；h3 仍黑体。
- 375 报头：短日期 `10-23 周五` 生效，`.whl-masthead` 行盒 **65 → 38px**，恢复单行（改前两行）。
- 横滚：`/`、`/weekly`、`/t/3`、`/report/360`、`/admin/t/3`、`/admin/codes` 在 375 下 `scrollWidth == innerWidth`；积分榜表 1440/375 = 928 / 351px，`scrollWidth == clientWidth`；数字列 computed font = `JetBrains Mono`。
- 大比分：`/` 375 下 `2:0` 与两侧队名未挤压（`tour-impl-home-375.png`）。
- 未覆盖：`/news`、`/tactics`、`/admin/teams` 截图（本地种子数据无内容/需额外登录态）；admin 两页用 KV `sess:<token>`（user 904）种会话验证，衬线与表格宽度均正常。
- 截图：`C:/tmp/fontwork/tour-impl-{home,weekly,tour,report,standings,admin,codes}-{1440,375}.png`。

## 8. v5.8.2 补丁：分享卡字体（2026-10-23）

v5.8.1 只改了页面 CSS；`src/lib/share.ts` 的 canvas 卡片把系统字体栈写死在 `FONT` 里、又不继承页面样式，所以卡片仍是旧字形。补丁口径：

- `FONT` 改为 `'Inter', <系统 CJK 栈>`；新增 `FONT_DISPLAY`（宋体 600）用于 `drawHeader` 44px 卡名与头条卡 44px 大标题；新增 `FONT_NUM`（JetBrains 前置、尾部带雅黑接中文）用于单场 72px 比分、轮次卡 22px 胶囊比分、点球注、榜单卡数字列、头条卡 110px 大比分。
- `ensureShareFonts()`：canvas 不会触发 `@font-face` 下载，5 个 `drawXxxCard` 开头先 `await document.fonts.load` 三族，否则首张卡用回退字体量宽。
- 单场卡队名/徽标原固定在中轴 ±104px，等宽数字下「1 : 0」约 190px 会压到队名；改为按比分实测宽度取 `sideGap = max(104, min(scoreW,520)/2+16)`，`nameMax` 同步让位；轮次胶囊、单场中轴、头条大比分各加超宽缩号兜底。
- 实测（本地 dist @ 8790）：4 种卡片均 890×N，`document.fonts` 三族 loaded，卡片生成前 3 个字体文件各 200；typecheck 0 error、52 文件 / 629 通过、build 成功。截图 `C:/tmp/fontwork/share-{match,tour,table,news}.png`。

## 9. v5.8.3 补丁：比分回正文栈（2026-10-23）

用户反馈「赛事卡的比分字体能不能不变，现在这个间距太大」——JetBrains 是等宽字，`2 : 4` 里每个空格都占满一个数字宽，胶囊与 72/110px 大比分都发空。

- 比分（轮次卡胶囊与点球注、单场卡 72px 与点球注、头条卡 110px）全部回到 `FONT`（Inter + 系统 CJK），恢复改动前观感。
- `FONT_NUM` 只保留积分榜数字列（`strong` 800/28、其余 400/24），列对齐仍靠等宽。
- 单场卡 `sideGap` 实测公式与三处超宽缩号兜底保留；比例字下 `sideGap` 回到 104 下限。
- 实测：赛事总览卡 890×760，比分恢复比例字、卡名仍宋体、榜单卡数字列仍 JetBrains；typecheck 0 错误、52 文件 / 629 通过（7 跳过）、build 成功。
