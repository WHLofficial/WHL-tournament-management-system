# WHL 足球赛事管理系统 · 技术设计（TECH_DESIGN）

> 版本：v1（2025 落盘） · 配套：[PRD.md](./PRD.md)
> 约束：选型尽量留在 Cloudflare Pages + Workers 生态内；出圈方案必须写明代价。

---

## 0. 结论（先行）

- 前端：**Cloudflare Pages + React/Vite/TypeScript**，对阵图（bracket）手写 SVG（量级 2-3 天，不引重型图库）。
- 后端：**Workers 单体 + hono 轻路由**，一个 Worker 出所有 API。
- 主库：**D1**（云上 SQLite）。选它的决定性理由：报分 → 重算积分 → 触发晋级必须在一个事务里完成，D1 支持；朋友局单写节点，无并发痛点。
- 会话/缓存：**KV**（只放低频写：会话 token、公开页缓存）；文件：**R2**（P1 封面图）；实时：**Durable Objects**（P2）。
- 密码哈希：**WebCrypto PBKDF2**（bcrypt/argon2 在 Workers 上要么没有要么不经济，PBKDF2 原生可用）。
- 部署：wrangler + git 推送自动部署。
- 预计费用：**0 元/月起步**（免费额度账见第 3 节）。

## 1. 架构总览

```
微信群里点开的链接
        │
┌───────▼────────────────────────────────────────┐
│ Cloudflare Pages（React SPA，静态资产边缘分发）  │
└───────┬────────────────────────────────────────┘
        │ fetch /api/*
┌───────▼────────────────────────────────────────┐
│ Workers（hono 单体：API + 鉴权 + 编排器/晋级器） │
│   ├─ D1  主库（赛事/队伍/场次/积分/账号/认证码） │
│   ├─ KV  会话 token + 公开页 30s 缓存           │
│   ├─ R2  封面图等文件（P1）                     │
│   └─ DO  WebSocket 秒级推送（P2）               │
└────────────────────────────────────────────────┘
```

围观页 30 秒轮询：前端 `setInterval` 拉 `/api/tournaments/:id/overview`；该响应先查 KV 缓存（写入方在每次报分后主动失效），轮询风暴打不到 D1。

## 2. Cloudflare 组件分工与代价

| 组件 | 用途 | 为什么是它 | 代价/限制 |
|---|---|---|---|
| Pages | 前端 SPA | 同仓库同部署，免费 HTTPS | SPA 单页路由需配 fallback |
| Workers | 全部 API + 业务逻辑 | 单体最省心；hono 路由轻 | CPU 时间免费档 10ms 级，足够（无重计算） |
| D1 | 主库 | **事务**是刚需；SQLite 方言与 WHL 现有插件（`whlPointSystem` 全 SQLite）同源，将来打通成本低 | 免费档单库 5GB、读 500 万行/天；单写节点（朋友局无感） |
| KV | 会话 + 公开页缓存 | 读多写少的键值场景正对 KV 的强项 | 写限额低（1000 写/天免费档）——所以只放低频写，绝不放报分这类高频写 |
| R2 | 封面图（P1） | 免出网流量费 | P0 用不到，先不接 |
| Durable Objects | 秒级推送（P2） | 生态内唯一的有状态长连接方案 | 付费档才有意义，P2 再说 |
| Queues | 暂无用途 | — | 若 P2 通知上线可考虑 |

**明确出圈的选项及代价**：微信推送（P2）需要 Server酱/企业微信机器人，属外部服务调用，Workers 发 fetch 即可，代价是引入外部依赖与配额；除此之外核心链路零出圈。

## 3. 免费额度账（假设：以 Cloudflare 官方定价页为准）

| 资源 | 免费档 | 本系统用量估算 |
|---|---|---|
| Workers 请求 | ~10 万/天 | 30 人围观 × 4 小时 × 30s 轮询 ≈ 1.4 万请求/天，余量 7 倍 |
| D1 读 | ~500 万行/天 | 每次轮询 1 个聚合接口（KV 缓存命中则不计），远低于上限 |
| D1 存储 | 5GB | 全赛季数据 < 10MB |
| KV 读 | ~10 万/天 | 会话校验 + 缓存命中，够用 |

暴涨预案：围观人数远超预期时，第一步是把公开页缓存从 30s 延长并前置到 CDN 层（改一行配置）；第二步才是 $5/月 Workers Paid 档。

## 4. 数据模型（ER 草图）

> 主键统一 `id`（INTEGER 自增）。`?` 表示可空。JSON 配置统一 `config_json`，避免为可配置项频繁加列。

### 4.1 赛事域（主线）

```text
tournament   赛事
  id, org_id →organization, name, description,
  format,              -- 建赛预设：single_elim | round_robin | group_knockout
                       --   （仅快捷方式；实际结构由 stage 列表决定，支持任意多段串接）
  status,              -- draft | registering | running | archived
  config_json,         -- 积分规则、破同分顺序、出线数、循环轮数、是否季军赛…
  created_by →user

stage        阶段（group_knockout 赛制天然有 2 个）
  id, tournament_id →tournament,
  kind,                -- group | knockout
  sort_order,          -- 先后
  config_json          -- source（从上一阶段取人：前N名/交叉映射模板）、每轮回合数 legs、出线数等

group        小组
  id, stage_id →stage, name

entry        报名关系（队伍 × 赛事，解耦核心）
  id, tournament_id →tournament, team_id →team,
  seed,                -- 种子位 = 录入顺序，可改
  group_id? →group     -- 仅小组阶段用

match        场次（统一对阵模型，所有赛制共用这一张表）
  id, stage_id →stage,
  round,               -- 轮次（淘汰赛第几轮 / 循环赛第几轮）
  slot,                -- 轮内位次（bracket 位置）
  leg?,                -- 回合序号：该轮 legs=2 时为 1|2，主客互换，两场总比分定晋级
  home_entry_id? →entry, away_entry_id? →entry,
  score_home?, score_away?,
  pen_home?, pen_away?,        -- 点球比分：单回合平局后，或两回合总比分平（记在 leg 2）
  status,              -- pending | ready | live | finished | bye | walkover
                       --   live = 进行中（未开始 → 进行中 → 已结束）
  winner_entry_id? →entry      -- bye/walkover 也落在这里

standing     积分榜（纯重算结果，可随时全量重建）
  id, stage_id →stage, group_id? →group, entry_id →entry,
  played, won, drawn, lost, pts, gf, ga,
  pen_won, pen_lost    -- 点球决胜场次单独计（点胜2分/点负1分）
```

### 4.2 账号域

```text
user         账号
  id, name, email?, password_hash,   -- PBKDF2
  role                 -- guest 不落库（未登录即 guest）| coach | admin（录入员）| superadmin
  -- 增量 8 起：本表账号属性只读。账号真源 2026-09-14 已收口 auth
  -- （account/credential/user_role），管理台的角色改动、解锁、重置密码、注册码、
  -- 开放注册开关全部改调 auth 管理端点（worker/lib/authAdmin.ts，X-Sign HMAC，
  -- 12 条 /api/admin/*）；本表的 role/locked/password_hash 不再被应用写入
  -- 增量 36 起：上面「不再被写入」不再成立——本表改由账号投影补齐行。
  -- 登录回调把 auth account 的 id/name/locked/created_at 带进来（worker/lib/accountMirror.ts，
  -- 与建会话同批提交），cron 每小时对账再补没登录过的账号、同步改名。要投影的理由是外键：
  -- 本库 14 列指向 user(id)（tactic.created_by、match_event.created_by、audit_log.actor_user_id…），
  -- 缺行时新账号一写就 FOREIGN KEY constraint failed → 500（2026-09-23 事故）
  -- 鉴权真源仍是会话里的 JWT claims；password_hash 写哨兵值，永远验不过

team         球队（跨赛事复用的实体）
  id, org_id →organization, name, created_by →user

player       球员（只挂队伍，不挂账号）
  id, team_id →team, name, number
  -- 增量 33 起：本表是**只读镜像**，真源在俱乐部平台（club.whleague.win）。
  -- name（FC26 存档派生的显示名）与 number（球衣号）都由 clubRoster 拉取同步写入，
  -- 本仓不再有任何球员写端点；player.id 就是 FC26 playerid（两库早前一起 rekey 过），
  -- 所以对账按 id 认人，绝不按姓名匹配（tour 存完整人名、平台存官方缩写名，写法会不同）

auth_code    队伍认证码（谈判插件同款规则）
  id, team_id →team,
  code_hash,           -- 8 位明码只出现一次，库存哈希
  expires_at,          -- 默认 24h，可指定
  used_by? →user,      -- 用后作废
  created_by →user
  -- 增量 7 起休眠：码真源上收认证中心 team_bind_code（tour/club 双入口共表）

team_member  绑定关系（教练 = 在这张表里）
  id, team_id →team, user_id →user
  -- 应用层约束：一账号一队；同队多人可绑；仅超管可解绑
  -- 增量 7 起休眠：绑定真源上收认证中心（auth 库 team/team_bind_code/team_binding），
  -- 本表存量随 scripts/migrate-team-bindings.mjs 迁移后不再读写；发码/烧码/解绑
  -- 经 worker/lib/authClient.ts 走 auth 机器 API（X-Sign HMAC），派生读走只读 AUTH_DB

signup_code  注册码（注册验证：无码不能注册）
  id, code_hash, expires_at?,
  max_uses, used_count,        -- 一次 / 多次有效
  created_by →user             -- 仅超管可生成
  -- 增量 8 起休眠：注册码真源上收认证中心 signup_code（auth 库主键是 code_hash，
  -- 无自增 id；管理台发码/列表改调 auth，列表只回哈希前 12 位指纹，明码不可回查）
```

### 4.3 扩展预留（现在只建表/留位，不做功能）

```text
identity      id, user_id →user, provider, provider_uid
              -- 外部身份留位；聚合登录已确定不接，但表在，将来 OAuth 不动账号体系
organization  id, name
              -- 多组织预留：org→tournament→stage→match 归属链第一天就通
              -- 增量 8 起：开放注册开关（allow_open_reg）真源上收 auth 的 organization 表，
              -- 管理台读写改调 auth；本表这一列不再被应用读写
audit_log     (P1) id, actor_user_id, action, target, detail_json, created_at
              -- 改分留痕、解绑留痕；增量 8 起管理动作也记一份（target_type='account'，
              -- 与 auth 侧审计双写：auth 记业务事实，本表记「哪个管理员干的」）
match_event   (P0) id, match_id →match, player_id? →player, type, minute?
              -- 进球/红黄牌：live 实时录入 + 赛后补录；进球驱动实时比分；支撑射手榜与停赛
```

**扩展性自查（验收要求）**：
- 加用户体系：`user`/`identity`/`team_member` 现在就齐，无需改赛事域。
- 加多组织：`organization` 表 + 各实体的 `org_id` 已在，把"全局 admin"升级为"org 级 admin"只动权限判断层。
- 加赛制：`match` 表对赛制无感知（见第 5 节）。

### 4.4 名册同步（增量 33 起：球员表是俱乐部平台的只读镜像）

**真源归位**：球员的姓名与球衣号真源在俱乐部平台（`club.whleague.win`）——签约、解约、定号、改号都在那边操作。本仓的 `player` 表降级为镜像，只由同步写入。原先本仓的四个球员写端点（`POST /:id/players`、`POST /:id/players/bulk`、`PATCH /:id/players/:pid`、`DELETE /:id/players/:pid`）已删除，管理端球队详情页的名单区改为只读。队级端点（建队 / 批量建队 / 改名 / 删队 / 队徽）不受影响。

**数据源**：`GET {CLUB_API_BASE}/api/squads` —— 俱乐部平台一次 JOIN 出全部 20 队的一线队名册，返回 `{ squads: [{ clubId, clubName, players: [{ fcId, name, number }] }] }`。

**对账规则**（`worker/lib/clubRoster.ts` 的 `syncRosters`）：

| 情形 | 动作 |
|---|---|
| club 有、tour 无 | `INSERT INTO player (id, team_id, name, number)`，**以 fcId 当 `player.id`** |
| 两队归属不同 | `UPDATE … SET team_id = ?`（换队） |
| 姓名或号码不同 | 以 club 为准 `UPDATE`（号码空串与 `null` 等价） |
| club 无、tour 有 | `DELETE`；被外键拒绝（有比赛事件 / 伤停引用）则保留并进 `kept` 报告 |

**拉取契约**：`fetchClubSquads` 逐层校验形状（`squads` 数组 / `players` 数组 / `fcId` 整数 / `name` 字符串），坏数据抛错不写库；请求带 `AbortSignal.timeout(10_000)` —— 没有 signal 时对方挂住会让 cron 的 catch 永不执行，一行日志都没有，observability 也抓不到。号码一律归一化（空串 ≡ `null`），否则每次同步都会白改一次号。

**四条防御**（写库前）：空快照整体跳过（拉取失败不能清空名单）；形状不对抛错不写库；**只对快照里出现过的队做删除**（没出现的队一律不碰）；**快照里某队名单为空即抛错** —— 只挡 `squads.length === 0` 挡不住「快照非空但某队 `players: []`」，那种队会被判成 stale 整队删光。另有两条：同一 `fcId` 出现在两队 ⇒ 抛错；快照里的 `clubId` 本仓没有对应 `team` ⇒ 记 `unknownTeams` 并整体跳过其球员。

**触发**：`triggers.crons = ["0 * * * *"]`（每小时一次，入口 `runRosterSync`，配置缺失或失败只记日志不抛）；手动立即同步 = `POST /api/admin/sync-rosters`（加 `?dryRun=1` 只算不写，返回对账预期）。**`vars.CLUB_API_BASE` 撤掉 = 同步整体跳过**，即回滚开关。

**为什么按 id 而不按姓名**：`player.id` 就是 FC26 playerid（两个系统早前一起 rekey 过，实测 570/570 命中），而两侧姓名写法不同（tour 存完整人名 `Erling Haaland`，俱乐部平台存 FC26 派生显示名 `Erling Haaland` / 官方缩写名 `E. Haaland` 的回落）——按姓名匹配会漏人、会认错人。

**已知后果（评审查出，本轮不改）**：自动删除球员后，`tactic.roster_json` / `tactic_submission.assign_json` 里会留下悬挂的球员 id（JSON 文本无外键），教练下次保存战术时 `validateAssign` 会抛 400「队长与定位球里点到了不属于该球队的球员」——手工删除时代同样存在，要修得动教练子系统。伤停的 `ON DELETE CASCADE` 实际不可达：伤停必须挂在一条 `match_event` 上，而 `match_event.player_id` 无 `ON DELETE`（NO ACTION）⇒ 有伤停的球员必然删不掉、行进 `kept`。另外手动同步端点没有 UI、`/api/health` 不含上次同步时间 ⇒ 每小时静默失败无处发现；分批 `batch` 无原子性（代码注释已声明）。

### 4.5 球队与俱乐部双向同步（增量 37：只对「建档」这一个写动作对称）

**要解决的问题**：球队（`team.id`）与俱乐部（`clubs.id`）是**同一个号**——游戏内球队编号，两库早前一起 rekey 过。但两边原先只能各建各的：赛事系统建队不登记俱乐部，俱乐部平台建俱乐部又硬性要求「赛事系统里先有这支队」（否则 404），于是谁先建都得手工去另一侧补一次，漏补就出现「有队无俱乐部」或「有俱乐部无队」。

**为什么这里破例「推」**（增量 33 的边界调整，原文在 `worker/lib/clubRoster.ts` 顶部注释）：名册仍然严格只拉不推；只有「球队建档」这一个动作两侧都对称。理由有三条——① 建档是一次性事件，不是持续数据流；② 两侧管理端都可能先发起，纯拉取要等 1 小时 cron，而「我刚建的队去哪了」是当场就要答案的事；③ 赛事系统读不到俱乐部平台库（只有单向只读），反向拉不出「俱乐部有、赛事无」。代价是多一个写入凭据，用一条专用密钥把爆炸半径限死在「建队」上。

**对称契约**：`POST /api/internal/team-upsert`，体 `{ id, name, operator? }`，语义是**幂等建档**——已有同 id 就 200 回 `{ created: false, nameDiffers }` 且**不覆写**；没有才建。两侧各实现一份入站端点，出站基址复用既有变量（本仓用 `CLUB_API_BASE`，俱乐部平台用 `TOUR_API_BASE`），签名共用一把 `TEAM_SYNC_SECRET`。

**签名口径**（与认证中心 `machine.ts`、俱乐部平台 `notify.ts` 完全一致，不另立一套）：签名串 `` `POST|${path}|${ts}|${rawBody}` ``，头 `X-Timestamp` / `X-Sign`，HMAC-SHA256 小写 hex，时间窗 ±300s。

**fail-closed 与可用性优先的分界**：入站端点未配 `TEAM_SYNC_SECRET` → **503 拒绝**（写端点不能像 `assertCronKey` 那样「没配就放行」）；出站未配或对方不可达 → **不阻断本地操作**，只把结果标失败（建队响应带 `clubSyncError` / `clubSyncFailed`，管理端显示红字并提供「同步」按钮重试）。本地能用优先，跨系统一致性靠对账兜底。

**对账兜底放在俱乐部平台侧**（`GET/POST /api/admin/team-sync`）：那边同时读得到两个库，diff 零成本。三段差异 = 只有赛事有（补建俱乐部）/ 只有俱乐部有（推给赛事）/ 两边名字不同（**只报不改**）。

**本增量不联动的动作**（边界）：改名不联动（只在对账页显示 `nameDiffers`）；删队不联动（俱乐部平台没有删除端点）；球员名册仍严格只拉；报名、赛果、账目一律不动。

**部署要求**：两侧都要 `wrangler secret put TEAM_SYNC_SECRET`（**同值**）。只在一侧配，结果是那一侧的入站 503、出站报「未配置」——不会静默半通。

**错位风险（已知，靠对账兜底）**：从俱乐部平台发起时先推、后本地建档；若推送成功而本地建档失败（如名字撞车 409），赛事系统那支队撤不回来，只能由对账页的「只有赛事有」列出来让人处理。测试 `tests/clubTeamSync.test.ts` / `tests/team-sync.test.ts` 与两仓的金标准用例钉死了这条可见性。

## 5. 统一对阵模型 + 可插拔编排器/晋级器

设计原则：**数据只存"谁和谁踢、比分多少"**；所有赛制差异收敛在两个纯函数式组件里。

**灵活多阶段（P0）**：`tournament` 只是容器，实际结构 = 有序 `stage` 列表。创建时按预设（单淘 / 循环 / 小组+淘汰）生成初始 stage，也可在同一赛事自由串接任意多段（循环 → 循环 → 淘汰……）。每个非首 stage 在 `config_json.source` 声明"从上一阶段拿谁"（前 N 名 / 交叉映射模板），由晋级器在上一阶段收官时填充——多阶段机制就这么一条规则。

```
编排器 Seeder : (entry 列表, 赛制配置) → match 计划（pending 场次集合）
晋级器 Advancer : (某阶段完赛场次) → 下一阶段/下一轮的 entry 填充
```

### 5.1 单败淘汰编排器
- 按 `entry.seed` 排布 bracket（1 vs n、2 vs n-1…标准种子位），非 2 的幂自动留 `bye`（轮空）场。
- 可选季军赛（config）。
- 每轮回合数可配 `legs: 1|2`：legs=2 时该轮每对打两场（`leg` 1/2，主客互换），晋级器按两场总比分定胜负；总比分平 → 第二回合后的点球比分定晋级。
- 晋级器：每轮打完，胜者填入下一轮 `slot`；决赛结束 → 赛事可归档。

### 5.2 循环赛轮转（双循环）
- 经典轮转法（circle method）：n 队奇数补虚拟队，n-1 轮产出单循环。
- **双循环 = 同一轮转器跑两遍**，第二遍主客对调；"单/双"只是 `config_json` 里的 `loops: 1|2`。
- 主客健康约束（自动生成后校验）：任何队不得连续三场主场或三场客场；每队首战与末战一主一客。不满足时做轮序重排 + 主客翻转修复，多次未收敛则提示改手动。
- 晋级器：无下一轮，只触发积分榜重算。

### 5.2b 手动编排（斑马邦式，与自动并存）
- 循环赛：轮次列表先建空轮 → 管理员选轮次，依次点 A 队、B 队 → 落一场 A-B（点击顺序即主客）。
- 即点即校验：本循环内 A-B 已交手 → B 置灰不可点；一队本轮已有场次 → 不可再选。
- 可自动先生成再手动微调，以手动结果为准。

### 5.3 小组赛 → 淘汰赛（多阶段的一个实例）
- 抽签 = 把 entry 随机分配进 group（P1 支持重抽）；组内跑 5.2 的单循环。
- 淘汰阶段是**下一个 stage**，`config_json.source` 存取人模板（如 `A1 vs B2, B1 vs A2`），晋级器按模板把各组的 standing 头部填进 bracket。循环赛阶段接淘汰阶段同理——任何 stage 都能用 source 声明"从上一阶段拿谁"。
- 固定映射的取舍：映射规则简单透明（群里一句话讲得清），P1 再考虑跨组回避等花活。

### 5.4 将来加瑞士轮
新写一个编排器（每轮按当前积分临时配对），`match`/`standing` 零改动——这就是统一对阵模型的回报。

## 6. 报分 → 重算 → 晋级（一个 D1 事务）

```sql
BEGIN;
  UPDATE match SET score_home=?, score_away=?, pen_home=?, pen_away=?,
                   status='finished', winner_entry_id=?   -- 含点球/弃权判定
    WHERE id=?;
  -- 重算该 stage（或 group）全部 standing：全量重建，不做增量加减
  --   （数据量 < 百场/组，全量重建消灭"算错账"这类 bug）
  -- 晋级器：该轮是否全部 finished？是 → 填下一轮 / 出线映射
  --   （仅删除 KV 公开页缓存这一步在事务外）
COMMIT;
```

要点：
- **全量重算**而非增量累加：报分、改分、弃权、改判走同一条路径，永远收敛到正确积分。
- **进行中（live）与终场分开走**：live 期间录事件（INSERT match_event）不进本事务、不触发重算，进球事件实时累计展示比分；终场确认时才执行上面的 finished 事务。
- 点球判定规则：淘汰赛 `score_home = score_away` 且已录 `pen_home/pen_away` → 按点球定 `winner_entry_id`，积分口径 `pen_won/pen_lost`（点胜 2 / 点负 1）。
- KV 缓存失效放在事务成功后，失败自然不刷新。

## 7. 防扯皮设计（P0 / P2 两版）

- **P0（本次）**：写入口唯一。API 层所有写操作要求 `role ∈ {admin, superadmin}`；公开接口全部只读。争议在微信群里找管理员，系统只认录入员及以上录入的数据。
- **P2（预留）**：互报互认状态机 `home_reported → away_confirmed | away_disputed → admin_ruling`，加超时默认（如 24h 未确认视为认可）；`audit_log` 已在模型里。

## 8. 会话与安全

- 登录态：不透明随机 token 存 KV（TTL），`HttpOnly` Cookie 携带——比自签 JWT 简单且可主动踢下线。
- 密码：WebCrypto PBKDF2（≥ 10 万次迭代 + 每用户随机盐），存 `password_hash`。
- 注册验证：凭 `signup_code`（超管生成，批量、一次/多次有效、可限时，发群里一次即可）；密码最低 8 位且含字母与数字；注册接口加 IP 限流。不接邮件服务（无域名依赖，找回密码走超管手动重置）。
- 认证码：8 位码明码只在生成响应里出现一次，库存 `code_hash`；绑定接口限流（5 次失败锁 10 分钟，KV 计数器实现）。
- 权限中间件：`requireSuperadmin` / `requireAdmin`（录入员）/ `requireCoach(team_id)` 三层。
- 错误响应：未捕获异常由 `worker/index.ts` 的 `app.onError` 统一兜成 500 + `{"error":"internal","message":"服务异常，请稍后重试"}`（增量 36）。不兜的话 Hono 会回 text/plain 的 "Internal Server Error"，前端 `res.json()` 解析失败、界面只剩「请求失败（500）」，线上排查要反查库；前端 `src/api.ts` 同时把非 JSON 错误与 `TypeError`（网络断了）也归一成中文文案。

| 操作 | 管理员（录入员） | 超管 |
|---|---|---|
| 建赛 / 录队伍 / 编排 / 报分 / 录事件 | ✓ | ✓ |
| 提拔管理员、解绑教练、生成注册码、系统配置 | ✗ | ✓ |

## 9. 部署与开发流程

- 仓库单 monorepo：`web/`（Pages）+ `worker/`（API）+ `schema/`（D1 migration SQL）。
- D1 迁移用 wrangler migrations 管理， migration 文件进 git。
- 环境：`wrangler dev` 本地全真模拟（D1/KV 本地态）；`git push` → CI 构建 Pages + `wrangler deploy` Worker。

## 10. 未来扩展路径（不打脸清单）

| 将来要做 | 靠什么落地 | 要不要动 P0 结构 |
|---|---|---|
| 瑞士轮 | 新增编排器 | 不动 |
| 教练自助报名/名单 | `team_member` + coach 权限 | 不动 |
| 个人统计/射手榜/停赛 | `match_event` 表 | 不动 |
| 改分留痕/审计 | `audit_log` 表 | 不动 |
| 外部身份/OAuth | `identity` 表 | 不动 |
| 多组织后台 | `organization` + org_id 归属链 | 不动 |
| 秒级实时 | Durable Objects 替换轮询 | 前端改动，后端加推送通道 |
| 与 whlPointSystem 插件打通 | 双方同为 SQLite（D1 可导出），`team`/`player` 实体对齐 | 导表脚本级 |
