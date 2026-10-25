// FC26 角色适配权重表（FIT 引擎的数据底座，B1 计划 S1 / spec §4.1）。
//
// 冻结日期：2026-10-25。来源口径：
// ① 权重与徽章的最终标准是 FC26 官方角色定义，手工定稿（每角色恰 6 项关键属性，权重 3/3/2/2/1/1）；
// ② 数据驱动初稿（.tmp/fit-analysis/，2026-10-23 生产快照 570 人）只当交叉校验：
//    11 个「一致」角色直接采纳初稿；7 组偏移角色按官方画像修正（ST 三角色 spec 已定稿：
//    AF=加速/冲刺/射术/跑位、TF=弹跳/头球/力量、PO=射术/跑位/反应）；29 个漏算角色
//    （LB/RB 边卫族、RW/WP 族、CAM|SS、GK|BPK 等）按真实足球踢法语义起草；
// ③ 徽章取相关性初稿（ps-relevance：角色人群徽章拥有率 rate≥25% 且 lift>0 优先）与官方推荐
//    合并，只存银基 psid（3-6 个；金徽 = 银基 + 100，由引擎侧识别，见 shared/fc26Playstyles）；
// ④ RoleID/PosID 映射由 scripts/freeze-fc26-refs.mjs 从 club 仓 web/assets/ref/role.json、
//    position.json 冻结生成（下方两段生成物，勿手改），attrs 的 RoleID1-5 / PosID1-4 与之精确对齐。
//
// 硬口径：
// - 键是「位置|角色码」（PTE26 语言，如 "ST|AF"），恰好覆盖 shared/tactics.ts PTE26 的 49 个
//   「位置×角色」对——113 个「位置×角色/重心」组合全部复用角色级权重（重心只影响热区 roleHeat）；
//   新增角色漏配时 tests/roleFit.test.ts 会红（CI 防漏配）。
// - CA/PA 不进 fit 公式、不进本表（spec §3：CA 只代表主位置整体水平，用户定稿）。
// - GK 族第 6 项统一用 reactions：FC26 门将只有 5 项 gk* 属性，出球型门将另用短传/长传区分。
// - 冻结后不联网、不依赖 club 仓；升级只在 FC26 版本大改时重跑冻结脚本 + 重审权重。

export interface RoleFitProfile {
  /** 中文名（候选面板展示，取 club role.json 的角色中文名），如 "突前前锋" */
  zh: string;
  /** 6 项关键属性 × 权重；键是 game_attrs 英文键（与 club 侧 FC26_GAME_ATTR_COLUMNS 同名） */
  attrs: [string, number][];
  /** 相关徽章银基 psid（金 = +100 引擎侧识别），3-6 个 */
  badges: number[];
}

export const ROLE_FIT: Record<string, RoleFitProfile> = {
  // ── GK 族（3）──
  // 门将：采纳 fit-dist 初稿（gk 五维），补第 6 项 reactions（FC26 门将只有 5 项 gk* 属性）
  "GK|GK": {
    zh: "门将",
    attrs: [
      ["gkreflexes", 3],
      ["gkdiving", 3],
      ["gkpositioning", 2],
      ["gkhandling", 2],
      ["reactions", 1],
      ["gkkicking", 1],
    ],
    badges: [56, 51, 54, 53],
  },
  // 清道夫门将：官方画像修正——kicking 1→2（SK 核心是出击 + 出球），徽章换出击/步法三枚
  "GK|SK": {
    zh: "清道夫门将",
    attrs: [
      ["gkreflexes", 3],
      ["gkpositioning", 3],
      ["gkdiving", 2],
      ["gkkicking", 2],
      ["gkhandling", 1],
      ["reactions", 1],
    ],
    badges: [54, 55, 52],
  },
  // 出球型门将：漏算起草——短传/长传/kicking（用脚下出球与门将五维区分）
  // 2026-10-26 数据裁决（原 2026-10-25 存疑销案）：保留 52=步法——它是 BPK 人群强区分徽章
  // （BPK 80% vs 其他门将 48%），而语义上更贴的 14=Tiki Taka 全联盟 0 人持有（换成死键）；
  // 出球属性画像获数据确认（短传 44.9 vs 38.2、长传 46.4 vs 40.5、开球 78.2 vs 73.0）
  "GK|BPK": {
    zh: "出球型门将",
    attrs: [
      ["gkkicking", 3],
      ["shortpassing", 3],
      ["longpassing", 2],
      ["gkreflexes", 2],
      ["gkdiving", 1],
      ["gkhandling", 1],
    ],
    badges: [52, 51, 13],
  },

  // ── LB / RB（5 + 5）── 左右同角色共用一份（role 级权重）
  // 边后卫：漏算起草——防守为先 + 套边冲刺
  "LB|FB": {
    zh: "边后卫",
    attrs: [
      ["defensiveawareness", 3],
      ["standingtackle", 3],
      ["sprintspeed", 2],
      ["stamina", 2],
      ["crossing", 1],
      ["interceptions", 1],
    ],
    badges: [21, 23, 42],
  },
  // 边翼卫：漏算起草——上下往返 + 传中
  "LB|WB": {
    zh: "边翼卫",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["acceleration", 2],
      ["standingtackle", 1],
      ["dribbling", 1],
    ],
    badges: [15, 42, 41],
  },
  // 伪后卫：漏算起草——内收中路出球（FAB，收进后腰位）
  "LB|FAB": {
    zh: "伪后卫",
    attrs: [
      ["shortpassing", 3],
      ["defensiveawareness", 3],
      ["ballcontrol", 2],
      ["standingtackle", 2],
      ["longpassing", 1],
      ["interceptions", 1],
    ],
    badges: [12, 21, 33],
  },
  // 进攻型边翼卫：采纳 fit-dist 初稿（RB|进攻型边翼卫），LB 镜像
  // 属性评审记录（2026-10-25）：crossing 与 agility 互换（1→2 / 2→1）——AWB 比 WB 更靠前，
  // 传中不能低于 WB 的 2（初稿 crossing 仅第 5，spec「一致」只背书画像方向，未审此量级）
  "LB|AWB": {
    zh: "进攻型边翼卫",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["acceleration", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [42, 15, 32, 41, 21],
  },
  // 内切型边后卫：漏算起草——内收中场组织（IWB，收进中场位，比 FAB 更靠上更重推进）
  "LB|IWB": {
    zh: "内切型边后卫",
    attrs: [
      ["shortpassing", 3],
      ["longpassing", 3],
      ["dribbling", 2],
      ["defensiveawareness", 2],
      ["vision", 1],
      ["interceptions", 1],
    ],
    badges: [12, 14, 33],
  },
  "RB|FB": {
    zh: "边后卫",
    attrs: [
      ["defensiveawareness", 3],
      ["standingtackle", 3],
      ["sprintspeed", 2],
      ["stamina", 2],
      ["crossing", 1],
      ["interceptions", 1],
    ],
    badges: [21, 23, 42],
  },
  "RB|WB": {
    zh: "边翼卫",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["acceleration", 2],
      ["standingtackle", 1],
      ["dribbling", 1],
    ],
    badges: [15, 42, 41],
  },
  "RB|FAB": {
    zh: "伪后卫",
    attrs: [
      ["shortpassing", 3],
      ["defensiveawareness", 3],
      ["ballcontrol", 2],
      ["standingtackle", 2],
      ["longpassing", 1],
      ["interceptions", 1],
    ],
    badges: [12, 21, 33],
  },
  // 进攻型边翼卫：采纳 fit-dist 初稿，徽章取 ps-relevance 全部 lift>0 五枚
  // 属性评审记录：crossing 与 agility 互换（同 LB|AWB，镜像同步修）
  "RB|AWB": {
    zh: "进攻型边翼卫",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["acceleration", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [42, 15, 32, 41, 21],
  },
  "RB|IWB": {
    zh: "内切型边后卫",
    attrs: [
      ["shortpassing", 3],
      ["longpassing", 3],
      ["dribbling", 2],
      ["defensiveawareness", 2],
      ["vision", 1],
      ["interceptions", 1],
    ],
    badges: [12, 14, 33],
  },

  // ── CB（4）──
  // 后卫：采纳 fit-dist 初稿
  // 低级别评审记录（2026-10-25）：jumping 3 居首来自 CB 人群身体共性，防守意识仅 2 可议；
  // 用户评审已背书初稿（spec「一致」），维持不变
  "CB|D": {
    zh: "后卫",
    attrs: [
      ["jumping", 3],
      ["standingtackle", 3],
      ["strength", 2],
      ["defensiveawareness", 2],
      ["interceptions", 1],
      ["aggression", 1],
    ],
    badges: [22, 26, 44, 23],
  },
  // 施压：采纳 fit-dist 初稿，徽章取 ps-relevance top5（空中堡垒/封堵 lift 最高）
  "CB|S": {
    zh: "施压",
    attrs: [
      ["jumping", 3],
      ["standingtackle", 3],
      ["aggression", 2],
      ["defensiveawareness", 2],
      ["strength", 1],
      ["interceptions", 1],
    ],
    badges: [26, 22, 5, 23, 44],
  },
  // 控球后卫：官方画像修正——初稿无任何传球属性（位置共性掩盖），出球才是 BPD 核心
  "CB|BPD": {
    zh: "控球后卫",
    attrs: [
      ["shortpassing", 3],
      ["longpassing", 3],
      ["standingtackle", 2],
      ["defensiveawareness", 2],
      ["ballcontrol", 1],
      ["vision", 1],
    ],
    badges: [13, 12, 22, 23],
  },
  // 边中卫：官方画像修正——初稿画像=普通 CB，WDB 核心是速度覆盖宽通道
  "CB|WDB": {
    zh: "边中卫",
    attrs: [
      ["sprintspeed", 3],
      ["acceleration", 3],
      ["standingtackle", 2],
      ["defensiveawareness", 2],
      ["interceptions", 1],
      ["strength", 1],
    ],
    badges: [41, 25, 21],
  },

  // ── CDM（5）──
  // 镇守：官方画像修正——初稿 shortpassing 虚高，H 应为拦截/站位型
  "CDM|H": {
    zh: "镇守",
    attrs: [
      ["stamina", 3],
      ["standingtackle", 3],
      ["interceptions", 2],
      ["defensiveawareness", 2],
      ["aggression", 1],
      ["shortpassing", 1],
    ],
    badges: [23, 42, 35],
  },
  // 拖后组织核心：采纳 fit-dist 初稿，徽章取 ps-relevance top5
  "CDM|DLP": {
    zh: "拖后组织核心",
    attrs: [
      ["shortpassing", 3],
      ["stamina", 3],
      ["ballcontrol", 2],
      ["longpassing", 2],
      ["reactions", 1],
      ["vision", 1],
    ],
    badges: [13, 11, 14, 35, 42],
  },
  // 中前卫（FC26 Centre-Half）：漏算起草——留守落位成三中卫的站桩后腰
  // 译名评审记录（2026-10-25）：zh「中前卫」是 club role.json 上游定名（id 15 chs
  // "CDM 中前卫 +"，非转录错误），但与 POS_ZH.CM 重名、且与 Centre-Half 实义有偏移；
  // 展示层如混淆，候选面板可带位置码兜底（本表只供数据，兜底在 B1 S6 候选面板实施时落，
  // 目前尚未实施），改名要连同 club 上游一起动，暂缓
  "CDM|CH": {
    zh: "中前卫",
    attrs: [
      ["defensiveawareness", 3],
      ["standingtackle", 3],
      ["strength", 2],
      ["interceptions", 2],
      ["aggression", 1],
      ["jumping", 1],
    ],
    badges: [22, 24, 23],
  },
  // 半边卫：漏算起草——辐射边路的后腰，往返扫荡
  "CDM|WH": {
    zh: "半边卫",
    attrs: [
      ["stamina", 3],
      ["standingtackle", 3],
      ["sprintspeed", 2],
      ["interceptions", 2],
      ["shortpassing", 1],
      ["defensiveawareness", 1],
    ],
    badges: [23, 42, 21],
  },
  // 禁区冲击者：漏算起草——后插上冲禁区终结
  "CDM|BC": {
    zh: "禁区冲击者",
    attrs: [
      ["positioning", 3],
      ["finishing", 3],
      ["shotpower", 2],
      ["stamina", 2],
      ["longshots", 1],
      ["strength", 1],
    ],
    badges: [3, 8, 7],
  },

  // ── CM（5）──
  // 全能中场：采纳 fit-dist 初稿（ps-relevance 仅两枚 lift>0，补健步如飞）
  // 低级别评审记录（2026-10-25）：6 项无防守属性，与 CM|DLP 区分度偏弱；初稿如此且
  // spec「一致」背书，维持不变
  "CM|BTB": {
    zh: "全能中场",
    attrs: [
      ["shortpassing", 3],
      ["ballcontrol", 3],
      ["stamina", 2],
      ["reactions", 2],
      ["dribbling", 1],
      ["longpassing", 1],
    ],
    badges: [42, 35, 41],
  },
  // 镇守（CM 版）：漏算起草——同 CDM|H 的拦截/站位语义
  "CM|H": {
    zh: "镇守",
    attrs: [
      ["standingtackle", 3],
      ["stamina", 3],
      ["interceptions", 2],
      ["defensiveawareness", 2],
      ["shortpassing", 1],
      ["aggression", 1],
    ],
    badges: [23, 24, 42],
  },
  // 拖后组织核心（CM 版）：漏算起草——比 CDM 版更靠前，视野权重上调
  "CM|DLP": {
    zh: "拖后组织核心",
    attrs: [
      ["shortpassing", 3],
      ["vision", 3],
      ["longpassing", 2],
      ["ballcontrol", 2],
      ["reactions", 1],
      ["stamina", 1],
    ],
    badges: [11, 14, 16, 13],
  },
  // 组织核心：采纳 fit-dist 初稿，徽章取 ps-relevance lift>0 四枚
  "CM|PL": {
    zh: "组织核心",
    attrs: [
      ["shortpassing", 3],
      ["ballcontrol", 3],
      ["longpassing", 2],
      ["vision", 2],
      ["reactions", 1],
      ["stamina", 1],
    ],
    badges: [11, 31, 13, 16],
  },
  // 半边锋：采纳 fit-dist 初稿
  "CM|HW": {
    zh: "半边锋",
    attrs: [
      ["ballcontrol", 3],
      ["shortpassing", 3],
      ["dribbling", 2],
      ["vision", 2],
      ["reactions", 1],
      ["agility", 1],
    ],
    badges: [16, 31, 33],
  },

  // ── LM / RM（4 + 4）── 左右同角色共用一份（role 级权重）
  // 边锋：官方画像修正——初稿缺 crossing，边锋的传中是本职
  "LM|W": {
    zh: "边锋",
    attrs: [
      ["acceleration", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["dribbling", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [32, 41, 15],
  },
  // 边路组织核心：漏算起草——内收组织，传球视野优先
  "LM|WP": {
    zh: "边路组织核心",
    attrs: [
      ["vision", 3],
      ["shortpassing", 3],
      ["dribbling", 2],
      ["ballcontrol", 2],
      ["agility", 1],
      ["longpassing", 1],
    ],
    badges: [16, 11, 33],
  },
  // 边中场：漏算起草——边路工兵，体能 + 传中 + 回防
  "LM|WM": {
    zh: "边中场",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["standingtackle", 2],
      ["dribbling", 1],
      ["interceptions", 1],
    ],
    badges: [42, 15, 21],
  },
  // 内锋：官方画像修正——初稿缺 finishing，内切后的终结是 IF 的差异点
  "LM|IF": {
    zh: "内锋",
    attrs: [
      ["acceleration", 3],
      ["agility", 3],
      ["dribbling", 2],
      ["finishing", 2],
      ["sprintspeed", 1],
      ["ballcontrol", 1],
    ],
    badges: [1, 8, 32, 41],
  },
  "RM|W": {
    zh: "边锋",
    attrs: [
      ["acceleration", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["dribbling", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [32, 41, 15],
  },
  "RM|WP": {
    zh: "边路组织核心",
    attrs: [
      ["vision", 3],
      ["shortpassing", 3],
      ["dribbling", 2],
      ["ballcontrol", 2],
      ["agility", 1],
      ["longpassing", 1],
    ],
    badges: [16, 11, 33],
  },
  "RM|WM": {
    zh: "边中场",
    attrs: [
      ["stamina", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["standingtackle", 2],
      ["dribbling", 1],
      ["interceptions", 1],
    ],
    badges: [42, 15, 21],
  },
  "RM|IF": {
    zh: "内锋",
    attrs: [
      ["acceleration", 3],
      ["agility", 3],
      ["dribbling", 2],
      ["finishing", 2],
      ["sprintspeed", 1],
      ["ballcontrol", 1],
    ],
    badges: [1, 8, 32, 41],
  },

  // ── CAM（4）──
  // 组织核心：采纳 fit-dist 初稿（徽章与 spec 语义吻合：第一脚触球/别出心裁/精准直塞）
  "CAM|PL": {
    zh: "组织核心",
    attrs: [
      ["ballcontrol", 3],
      ["dribbling", 3],
      ["shortpassing", 2],
      ["vision", 2],
      ["agility", 1],
      ["reactions", 1],
    ],
    badges: [33, 16, 11],
  },
  // 影子前锋：漏算起草——后插上终结（26 人主力角色，初稿未覆盖）
  // 2026-10-26 数据裁决（原 2026-10-25 存疑销案）：SS 人群 vs CAM 基线 longshots lift +3.8、
  // volleys +4.0、finishing +4.3——后插上远射语义成立，ballcontrol（lift +2.3，6 键最低）
  // 让位给 longshots；徽章 3=大力射门不加（12% vs 8%，低于 25% 门槛的弱信号）
  "CAM|SS": {
    zh: "影子前锋",
    attrs: [
      ["positioning", 3],
      ["finishing", 3],
      ["dribbling", 2],
      ["agility", 2],
      ["acceleration", 1],
      ["longshots", 1],
    ],
    badges: [1, 8, 16],
  },
  // 半边锋（CAM 版）：采纳 fit-dist 初稿
  "CAM|HW": {
    zh: "半边锋",
    attrs: [
      ["agility", 3],
      ["dribbling", 3],
      ["ballcontrol", 2],
      ["acceleration", 2],
      ["balance", 1],
      ["sprintspeed", 1],
    ],
    badges: [31, 16, 1],
  },
  // 传统十号位：漏算起草——自由人组织核心，视野 + 直塞 + 弧线
  "CAM|C10": {
    zh: "传统十号位",
    attrs: [
      ["vision", 3],
      ["shortpassing", 3],
      ["ballcontrol", 2],
      ["dribbling", 2],
      ["longpassing", 1],
      ["curve", 1],
    ],
    badges: [16, 11, 14],
  },

  // ── LW / RW（3 + 3）── 左右同角色共用一份（role 级权重）
  "LW|W": {
    zh: "边锋",
    attrs: [
      ["acceleration", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["dribbling", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [32, 41, 15],
  },
  "LW|WP": {
    zh: "边路组织核心",
    attrs: [
      ["vision", 3],
      ["shortpassing", 3],
      ["dribbling", 2],
      ["ballcontrol", 2],
      ["agility", 1],
      ["longpassing", 1],
    ],
    badges: [16, 11, 33],
  },
  "LW|IF": {
    zh: "内锋",
    attrs: [
      ["acceleration", 3],
      ["agility", 3],
      ["dribbling", 2],
      ["finishing", 2],
      ["sprintspeed", 1],
      ["ballcontrol", 1],
    ],
    badges: [1, 8, 32, 41],
  },
  "RW|W": {
    zh: "边锋",
    attrs: [
      ["acceleration", 3],
      ["sprintspeed", 3],
      ["crossing", 2],
      ["dribbling", 2],
      ["agility", 1],
      ["ballcontrol", 1],
    ],
    badges: [32, 41, 15],
  },
  "RW|WP": {
    zh: "边路组织核心",
    attrs: [
      ["vision", 3],
      ["shortpassing", 3],
      ["dribbling", 2],
      ["ballcontrol", 2],
      ["agility", 1],
      ["longpassing", 1],
    ],
    badges: [16, 11, 33],
  },
  "RW|IF": {
    zh: "内锋",
    attrs: [
      ["acceleration", 3],
      ["agility", 3],
      ["dribbling", 2],
      ["finishing", 2],
      ["sprintspeed", 1],
      ["ballcontrol", 1],
    ],
    badges: [1, 8, 32, 41],
  },

  // ── ST（4）──
  // 突前前锋：官方画像修正（spec 定稿：加速/冲刺/射术/跑位）——初稿被站桩型 RoleID 污染
  // 徽章评审记录（2026-10-25）：初稿的 5=精准头球来自同源被污染的 AF 人群（头球语义属 ST|TF，
  // 其徽章已含 5），换成 32=灵动迅捷，速度型终结画像不带走站桩残留
  "ST|AF": {
    zh: "突前前锋",
    attrs: [
      ["acceleration", 3],
      ["sprintspeed", 3],
      ["finishing", 2],
      ["positioning", 2],
      ["ballcontrol", 1],
      ["dribbling", 1],
    ],
    badges: [3, 1, 7, 32],
  },
  // 站桩中锋：漏算 + spec 定稿画像：弹跳/头球/力量
  "ST|TF": {
    zh: "站桩中锋",
    attrs: [
      ["jumping", 3],
      ["headingaccuracy", 3],
      ["strength", 2],
      ["finishing", 2],
      ["positioning", 1],
      ["shotpower", 1],
    ],
    badges: [5, 3, 44],
  },
  // 伪九号：官方画像修正——初稿是纯小快灵，F9 核心是回撤组织（短传/视野）
  "ST|F9": {
    zh: "伪九号",
    attrs: [
      ["shortpassing", 3],
      ["vision", 3],
      ["ballcontrol", 2],
      ["dribbling", 2],
      ["positioning", 1],
      ["finishing", 1],
    ],
    badges: [31, 33, 1, 41],
  },
  // 禁区之王：漏算 + spec 定稿画像：射术/跑位/反应
  "ST|PO": {
    zh: "禁区之王",
    attrs: [
      ["finishing", 3],
      ["positioning", 3],
      ["reactions", 2],
      ["shotpower", 2],
      ["composure", 1],
      ["sprintspeed", 1],
    ],
    badges: [7, 1, 8],
  },
};

// ── RoleID / PosID 冻结映射 ────────────────────────────────────────────────────
// 由 scripts/freeze-fc26-refs.mjs 生成（2026-10-25），来源 club 仓 web/assets/ref/role.json、
// position.json（只读）。勿手改：重跑脚本 diff 无变化即冻结仍有效。
// tier：1 = 熟悉（role.json 的 "+"，id 1-49）、2 = 世界级（"++"，id 101-149）、0 = 无熟悉（表内不出现）。

export const FC26_ROLE_BY_ID: Record<number, { slot: string; tier: 0 | 1 | 2 }> = {
  1: { slot: "GK|GK", tier: 1 },
  2: { slot: "GK|SK", tier: 1 },
  3: { slot: "RB|FB", tier: 1 },
  4: { slot: "RB|FAB", tier: 1 },
  5: { slot: "RB|WB", tier: 1 },
  6: { slot: "RB|AWB", tier: 1 },
  7: { slot: "LB|FB", tier: 1 },
  8: { slot: "LB|FAB", tier: 1 },
  9: { slot: "LB|WB", tier: 1 },
  10: { slot: "LB|AWB", tier: 1 },
  11: { slot: "CB|D", tier: 1 },
  12: { slot: "CB|S", tier: 1 },
  13: { slot: "CB|BPD", tier: 1 },
  14: { slot: "CDM|H", tier: 1 },
  15: { slot: "CDM|CH", tier: 1 },
  16: { slot: "CDM|DLP", tier: 1 },
  17: { slot: "CDM|WH", tier: 1 },
  18: { slot: "CM|BTB", tier: 1 },
  19: { slot: "CM|H", tier: 1 },
  20: { slot: "CM|DLP", tier: 1 },
  21: { slot: "CM|PL", tier: 1 },
  22: { slot: "CM|HW", tier: 1 },
  23: { slot: "RM|W", tier: 1 },
  24: { slot: "RM|WM", tier: 1 },
  25: { slot: "RM|WP", tier: 1 },
  26: { slot: "RM|IF", tier: 1 },
  27: { slot: "LM|W", tier: 1 },
  28: { slot: "LM|WM", tier: 1 },
  29: { slot: "LM|WP", tier: 1 },
  30: { slot: "LM|IF", tier: 1 },
  31: { slot: "CAM|PL", tier: 1 },
  32: { slot: "CAM|SS", tier: 1 },
  33: { slot: "CAM|HW", tier: 1 },
  34: { slot: "CAM|C10", tier: 1 },
  35: { slot: "RW|W", tier: 1 },
  36: { slot: "RW|IF", tier: 1 },
  37: { slot: "RW|WP", tier: 1 },
  38: { slot: "LW|W", tier: 1 },
  39: { slot: "LW|IF", tier: 1 },
  40: { slot: "LW|WP", tier: 1 },
  41: { slot: "ST|AF", tier: 1 },
  42: { slot: "ST|PO", tier: 1 },
  43: { slot: "ST|F9", tier: 1 },
  44: { slot: "ST|TF", tier: 1 },
  45: { slot: "GK|BPK", tier: 1 },
  46: { slot: "RB|IWB", tier: 1 },
  47: { slot: "LB|IWB", tier: 1 },
  48: { slot: "CB|WDB", tier: 1 },
  49: { slot: "CDM|BC", tier: 1 },
  101: { slot: "GK|GK", tier: 2 },
  102: { slot: "GK|SK", tier: 2 },
  103: { slot: "RB|FB", tier: 2 },
  104: { slot: "RB|FAB", tier: 2 },
  105: { slot: "RB|WB", tier: 2 },
  106: { slot: "RB|AWB", tier: 2 },
  107: { slot: "LB|FB", tier: 2 },
  108: { slot: "LB|FAB", tier: 2 },
  109: { slot: "LB|WB", tier: 2 },
  110: { slot: "LB|AWB", tier: 2 },
  111: { slot: "CB|D", tier: 2 },
  112: { slot: "CB|S", tier: 2 },
  113: { slot: "CB|BPD", tier: 2 },
  114: { slot: "CDM|H", tier: 2 },
  115: { slot: "CDM|CH", tier: 2 },
  116: { slot: "CDM|DLP", tier: 2 },
  117: { slot: "CDM|WH", tier: 2 },
  118: { slot: "CM|BTB", tier: 2 },
  119: { slot: "CM|H", tier: 2 },
  120: { slot: "CM|DLP", tier: 2 },
  121: { slot: "CM|PL", tier: 2 },
  122: { slot: "CM|HW", tier: 2 },
  123: { slot: "RM|W", tier: 2 },
  124: { slot: "RM|WM", tier: 2 },
  125: { slot: "RM|WP", tier: 2 },
  126: { slot: "RM|IF", tier: 2 },
  127: { slot: "LM|W", tier: 2 },
  128: { slot: "LM|WM", tier: 2 },
  129: { slot: "LM|WP", tier: 2 },
  130: { slot: "LM|IF", tier: 2 },
  131: { slot: "CAM|PL", tier: 2 },
  132: { slot: "CAM|SS", tier: 2 },
  133: { slot: "CAM|HW", tier: 2 },
  134: { slot: "CAM|C10", tier: 2 },
  135: { slot: "RW|W", tier: 2 },
  136: { slot: "RW|IF", tier: 2 },
  137: { slot: "RW|WP", tier: 2 },
  138: { slot: "LW|W", tier: 2 },
  139: { slot: "LW|IF", tier: 2 },
  140: { slot: "LW|WP", tier: 2 },
  141: { slot: "ST|AF", tier: 2 },
  142: { slot: "ST|PO", tier: 2 },
  143: { slot: "ST|F9", tier: 2 },
  144: { slot: "ST|TF", tier: 2 },
  145: { slot: "GK|BPK", tier: 2 },
  146: { slot: "RB|IWB", tier: 2 },
  147: { slot: "LB|IWB", tier: 2 },
  148: { slot: "CB|WDB", tier: 2 },
  149: { slot: "CDM|BC", tier: 2 },
};

export const FC26_POS_BY_ID: Record<number, string> = {
  [-1]: "-",
  0: "GK",
  3: "RB",
  5: "CB",
  7: "LB",
  10: "CDM",
  12: "RM",
  14: "CM",
  16: "LM",
  18: "CAM",
  23: "RW",
  25: "ST",
  27: "LW",
};

/** 49 条权重的属性键并集（去重排序）——trimPlayerMetaForPool 放宽的键集来源（B1 计划 S4）。
 *  从 ROLE_FIT 派生而非手抄，保证与权重表永不漂移；不含 CA/PA。 */
export const FIT_ATTR_KEYS: readonly string[] = (() => {
  const seen = new Set<string>();
  for (const p of Object.values(ROLE_FIT)) for (const [k] of p.attrs) seen.add(k);
  return [...seen].sort();
})();
