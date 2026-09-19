// 前后端共享的类型与常量。
import type { InjurySeverity } from "./injuries";
import type { AssignKey } from "./tactics";

// 伤病档位定义在 shared/injuries.ts（与伤病名库同文件，便于一处维护），这里转出
export type { InjurySeverity };

export type Role = "coach" | "admin" | "superadmin";
export type TournamentStatus = "draft" | "registering" | "running" | "archived";
export type TournamentFormat = "single_elim" | "round_robin" | "group_knockout" | "custom";
export type StageKind = "elim" | "round_robin" | "group";
export type MatchStatus = "pending" | "live" | "finished";
export type EventType = "goal" | "yellow" | "red";

// ---------- 行类型（与 D1 schema 一一对应） ----------

export interface UserRow {
  id: number;
  name: string;
  email: string | null;
  password_hash: string;
  role: Role;
  created_at: string;
}

export interface TeamRow {
  id: number;
  org_id: number;
  name: string;
  created_by: number | null;
  created_at: string;
}

export interface PlayerRow {
  id: number;
  team_id: number;
  name: string;
  number: string | null;
  created_at: string;
}

export interface TournamentRow {
  id: number;
  org_id: number;
  name: string;
  description: string | null;
  format: TournamentFormat;
  status: TournamentStatus;
  config_json: string;
  created_by: number;
  created_at: string;
}

export interface StageRow {
  id: number;
  tournament_id: number;
  kind: StageKind;
  sort_order: number;
  config_json: string;
  created_at: string;
}

export interface GroupRow {
  id: number;
  stage_id: number;
  name: string;
  sort_order: number;
}

export interface EntryRow {
  id: number;
  tournament_id: number;
  team_id: number;
  seed: number;
  group_id: number | null;
  created_at: string;
}

export interface MatchRow {
  id: number;
  stage_id: number;
  round: number;
  slot: number;
  leg: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
  score_home: number | null;
  score_away: number | null;
  pen_home: number | null;
  pen_away: number | null;
  status: MatchStatus;
  winner_entry_id: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface StandingRow {
  id: number;
  stage_id: number;
  group_id: number | null;
  entry_id: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  pts: number;
  gf: number;
  ga: number;
  pen_won: number;
  pen_lost: number;
}

export interface MatchEventRow {
  id: number;
  match_id: number;
  entry_id: number;
  player_id: number | null;
  type: EventType;
  minute: number | null;
  created_by: number;
  created_at: string;
}

// 同分决胜链的可用比较项（积分永远第一，种子位永远兜底）
export type TiebreakerKey = "gd" | "gf" | "h2h";

// ---------- 停赛规则（存 config_json.suspension） ----------

export interface SuspensionConfig {
  redBan: number; // 直红停赛场数
  red2yBan: number; // 两黄变一红停赛场数
  yellowThreshold: number; // 累积黄牌停赛阈值，0 = 不启用黄牌累积停赛
  yellowResetAt: string | null; // 手动"清零黄牌累计"的时间戳锚点；锚点后录入的黄牌重新计数
}

// 单个球员的停赛/黄牌累积状态（纯派生，实时计算）
export interface SuspensionStatusDTO {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  entryId: number;
  remaining: number; // 剩余停赛场数，> 0 即停赛中
  yellows: number; // 当前累积黄牌数（清零锚点后口径）
}

export interface SuspensionsResp {
  config: SuspensionConfig;
  players: SuspensionStatusDTO[]; // 只含有红黄牌记录的球员
}

// ---------- 伤停登记（injury / injury_miss 表，状态查询时派生） ----------

// 一条伤停登记关联的缺阵比赛（跨赛事；赛事名标注用）
export interface InjuryMissDTO {
  matchId: number;
  tournamentId: number;
  tournamentName: string;
  round: number;
  stageKind: "elim" | "round_robin" | "group";
  status: "pending" | "live" | "finished";
}

// 管理端单条伤停登记
export interface InjuryStatusDTO {
  id: number;
  teamId: number;
  teamName: string;
  playerId: number;
  playerName: string;
  eventId: number; // 挂靠的伤病事件（injury_minor / injury_major）
  severity: InjurySeverity; // 派生自事件类型；改事件类型会被拒绝（先删登记）
  injuryName: string | null;
  note: string | null;
  createdAt: string;
  fromMatchId: number; // 受伤那一场（event 所属比赛）
  fromLabel: string; // 受伤那场的可读标签（赛事名 · 第几轮）
  misses: InjuryMissDTO[];
  recoverPercent: number; // 伤愈进度 = 已打完的缺阵场 / 总勾选缺阵场
}

export interface InjuryListResp {
  injuries: InjuryStatusDTO[];
}

// 可勾选为「缺阵」的比赛：该队跨赛事全量（含已完赛，支持补录）
export interface InjuryMissCandidateDTO extends InjuryMissDTO {
  homeTeamId: number; // 与登记球队的 teamId 比对，决定显示「主」还是「客」
  awayTeamId: number | null; // 对手未编排时为 null
  homeTeamName: string | null;
  awayTeamName: string | null;
}

export interface InjuryCandidatesResp {
  candidates: InjuryMissCandidateDTO[];
}

// 集中登记页的「待登记」清单：已记 injury_minor/major、但还没建伤停登记的事件
export interface InjuryEventCandidateDTO {
  eventId: number;
  matchId: number;
  tournamentId: number;
  tournamentName: string;
  round: number;
  stageKind: "elim" | "round_robin" | "group";
  matchStatus: "pending" | "live" | "finished";
  teamId: number;
  teamName: string;
  playerId: number | null; // 事件没记球员时为 null（这种事件要先去赛程里补上球员才能登记）
  playerName: string | null;
  severity: InjurySeverity;
  minute: number | null;
  opponentName: string | null;
  finishedAt: string | null;
}

export interface InjuryEventCandidatesResp {
  events: InjuryEventCandidateDTO[];
}

// 公开端「因伤缺阵」名单：某场比赛中被登记为缺阵的球员（按队分组）
export interface PublicAbsenceDTO {
  playerId: number;
  playerName: string;
  teamId: number;
  severity: InjurySeverity;
  injuryName: string | null;
  note: string | null;
  recoverPercent: number; // 只给进度条用；对外文案用 recoverStageLabel 的自然阶段词
}

export interface MatchAbsencesResp {
  home: PublicAbsenceDTO[];
  away: PublicAbsenceDTO[];
}

// 公开端「伤停动态」：仍在伤停中的登记（剩余缺阵场在前，跨赛事标注赛事名）
export interface InjuryWatchDTO {
  playerId: number;
  playerName: string;
  teamId: number;
  teamName: string;
  severity: InjurySeverity;
  injuryName: string | null;
  note: string | null;
  recoverPercent: number;
  misses: InjuryMissDTO[];
  injuredInLabel: string; // 受伤那一场的可读标签（赛事名 · 第几轮）
}

export interface InjuryWatchGroupDTO {
  teamId: number;
  teamName: string;
  logoUrl: string | null;
  injuries: InjuryWatchDTO[];
}

export interface TournamentInjuriesResp {
  groups: InjuryWatchGroupDTO[];
}

// ---------- 配置（存 config_json 的形状） ----------

// 非首阶段声明"从上一阶段拿谁"
export interface StageSource {
  // entries：直接指定 entry id（手动编排用）；take：按上一阶段排名取人；
  // cross：小组交叉映射模板，如 ["A1-B2", "C1-D2", "B1-A2", "D1-C1"]
  take?: number; // 取上一阶段前 N 名（等价 from:1, to:take，保留兼容）
  from?: number; // 名次区间起点（含），如 5
  to?: number; // 名次区间终点（含），如 8；与 from 搭配取第 from..to 名
  fromStage?: number; // 取自哪个阶段（stage id）；缺省 = 上一阶段
  cross?: string[];
  entries?: number[];
}

export interface ElimStageConfig {
  legs?: 1 | 2; // 各轮回合数
  final_legs?: 1 | 2; // 决赛回合数；季军赛与决赛一致。缺省跟随 legs
  third_place?: boolean;
  source?: StageSource;
}

export interface RoundRobinStageConfig {
  loops?: 1 | 2;
  source?: StageSource;
}

export interface GroupStageConfig {
  group_count?: number;
  loops?: 1 | 2;
  qualify_per_group?: number;
  cross?: string[]; // 出线映射模板
  source?: StageSource;
}

export type StageConfig = ElimStageConfig | RoundRobinStageConfig | GroupStageConfig;

// 建赛预设：新建赛事时写入 tournament.config_json，编排引擎按它生成 stage 结构。
// custom = 空白编排，没有预设，也不预建任何阶段。
export const DEFAULT_TOURNAMENT_CONFIG: Partial<Record<TournamentFormat, StageConfig>> = {
  single_elim: { legs: 1, third_place: false },
  round_robin: { loops: 2 },
  group_knockout: { group_count: 4, loops: 1, qualify_per_group: 2 },
};

// ---------- 排名段标记（存 config_json.rankZones / rankZoneStyle） ----------

export type RankZoneStyle = "strip" | "divider"; // 左缘色条+图例 / 区间分隔线

export type RankZoneScope =
  | { kind: "all" } // 全部积分表
  | { kind: "stage"; stageId: number } // 指定阶段（循环/小组）
  | { kind: "group"; groupId: number }; // 指定小组

export interface RankZone {
  id: string; // 稳定 key（编辑不丢）
  name: string; // 如「升级区」，图例/线名直接用它
  from: number; // 名次区间起点（含），1 起
  to: number; // 名次区间终点（含），from ≤ to
  color: string; // #rrggbb
  enabled: boolean; // 停用：不渲染、不参与命中
  scope: RankZoneScope;
}

// 解析+校验+命中规则在 shared/rankZones.ts；数组顺序即优先级，越前越高。
export interface RankZoneSettings {
  style: RankZoneStyle;
  zones: RankZone[];
}

// ---------- API 载荷 ----------

export interface RegisterReq {
  name: string;
  password: string;
  signupCode: string;
  email?: string;
}

export interface LoginReq {
  name: string;
  password: string;
}

export interface MeResp {
  id: number;
  name: string;
  role: Role;
  teamId: number | null; // 绑定的队伍，未绑为 null
  locked: boolean; // 观众号：无码注册被锁定，解锁后才能绑队
  mustChangePassword: boolean; // 密码被重置后未改密：强制先改密码
}

// GET /api/auth/me 响应（统一认证迁移步骤②）：user 与认证模式一起下发。
// authMode=oidc 时前端把登录/注册/改密/登出入口指向认证中心（authHome）。
// syncProbe（进站即探测）：匿名 + oidc + 非冷却期时为 true，前端据此自动跳 /api/auth/sync
export interface MeEnvelope {
  user: MeResp | null;
  authMode: "oidc" | "shared";
  authHome: string | null;
  syncProbe?: boolean;
}

// ---------- API DTO（camelCase，路由层做映射） ----------

export interface TeamDTO {
  id: number;
  name: string;
  playerCount: number;
  entryCount: number;
  logoUrl: string | null;
}

export interface PlayerDTO {
  id: number;
  name: string;
  number: string | null;
}

export interface TournamentDTO {
  id: number;
  name: string;
  description: string | null;
  format: TournamentFormat;
  status: TournamentStatus;
  createdAt: string;
  entryCount: number;
  coverUrl: string | null;
}

export interface EntryDTO {
  id: number;
  teamId: number;
  teamName: string;
  seed: number;
  groupId: number | null;
  playerCount: number;
  pointsDeducted: number;
  teamLogoUrl: string | null;
}

export interface StageDTO {
  id: number;
  kind: StageKind;
  sortOrder: number;
  /** 阶段显示名，空时前端用赛制名兜底 */
  name: string | null;
  config: StageConfig;
}

export interface GroupDTO {
  id: number;
  stageId: number;
  name: string;
  sortOrder: number;
}

export interface TournamentDetailDTO {
  tournament: TournamentDTO;
  stages: StageDTO[];
  groups: GroupDTO[];
  entries: EntryDTO[];
  tiebreakers?: TiebreakerKey[];
  rankZones?: RankZoneSettings | null;
}

export interface SignupCodeResp {
  code: string;
  maxUses: number | null;
  expiresAt: string | null;
}

// ---------- 编排 ----------

export interface MatchDTO {
  id: number;
  stageId: number;
  round: number;
  slot: number;
  leg: number | null;
  homeEntryId: number | null;
  awayEntryId: number | null;
  homeTeamName: string | null;
  awayTeamName: string | null;
  scoreHome: number | null;
  scoreAway: number | null;
  penHome: number | null;
  penAway: number | null;
  status: "pending" | "live" | "finished";
  winnerEntryId: number | null;
  note: string | null;
  /** 弃权方：home / away / both；普通场为空 */
  walkoverSide?: "home" | "away" | "both" | null;
  /** 比分曾改判过（公开单场页提示用，不给明细） */
  rescored?: boolean;
  /** 管理端赛程列表附带：双方是否已提交战术阵容（公开端不带） */
  homeLineupSubmitted?: boolean;
  awayLineupSubmitted?: boolean;
  events?: PublicMatchEventDTO[];
  stageKind?: "elim" | "round_robin" | "group";
  /** 所属阶段显示名，单轮查询时前端直接用作阶段头 */
  stageName?: string | null;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
}

// 审计留痕（audit_log，排期 #10）：比赛域操作记录，管理端查看
export interface AuditEntryDTO {
  id: number;
  action: string;
  targetMatchId: number;
  actorName: string | null;
  detailJson: string | null;
  createdAt: string;
}

// ---------- 战术阵容提交（tactic_submission，migration 0009/0011） ----------

// slots_json 的存储形态：首发 {lid,position,player_id} + 替补 {kind:'bench',player_id}
export type StoredLineupSlot =
  | { lid: number; position: string; player_id: number }
  | { kind: "bench"; player_id: number };

// PUT /api/coach/matches/:mid/lineup 请求体
export interface LineupSubmitBody {
  form: string;
  slots: StoredLineupSlot[];
  /** 战术板编码串（FUT26 格式），随阵容存档；管理端备案可见 */
  code?: string;
  /** 球员指派：角色码 → 球员 id（见 shared/tactics 的 ASSIGN_GROUPS），只带已填项 */
  assign?: Record<string, number>;
}

// 球员附加信息（队徽/属性）。当前 player 表只有 id/name/number，
// worker/lib/playerMeta.ts 默认返回空，将来接 club 平台只改那一个文件；前端「有才渲染」。
export interface PlayerMeta {
  badges?: string[];
  attrs?: Record<string, number>;
}

export interface LineupPlayerDTO {
  playerId: number;
  /** 球员被删后为 null，前端显示「已离队」 */
  name: string | null;
  number: string | null;
  meta?: PlayerMeta;
}

export interface LineupStarterDTO extends LineupPlayerDTO {
  kind: "starter";
  lid: number;
  position: string;
}

export interface LineupBenchDTO extends LineupPlayerDTO {
  kind: "bench";
}

// 球员指派项。按 shared/tactics 的 ASSIGN_GROUPS 顺序输出；
// starter=false = 该球员已不在本场首发（保留不静默清空，前端标黄提示）。
export interface LineupAssignDTO {
  key: AssignKey;
  playerId: number;
  name: string | null;
  number: string | null;
  starter: boolean;
  meta?: PlayerMeta;
}

export interface TeamLineupDTO {
  teamId: number;
  teamName: string;
  /** 阵型值（如 433），展示用 shared/tactics 的 formTitle() 转义 */
  form: string;
  submittedAt: string;
  submittedBy: string | null;
  /** true = 这份阵容是经管理员授权的代打提交的（submittedBy 是代打者，不是本队教练） */
  viaProxy: boolean;
  starters: LineupStarterDTO[];
  bench: LineupBenchDTO[];
  /** 球员指派（未填则空数组） */
  assign: LineupAssignDTO[];
}

export interface MatchLineupDTO {
  home: TeamLineupDTO | null;
  away: TeamLineupDTO | null;
}

// 管理端 GET /api/admin/matches/:id/lineup：在 MatchLineupDTO 上附加战术码备案（公开端不返回码）
export type AdminMatchLineupDTO = MatchLineupDTO & { homeCode: string; awayCode: string };

// ---------- 阵容代打（migration 0023） ----------
// 管理员把「提交某队某场阵容」的权限临时授给另一个账号；精确到单场，
// 有效性 = 未撤销且比赛未开打，故没有 expires_at。

// 教练端 GET /api/coach/proxy/sessions：我被授权代打的清单
export interface ProxySessionDTO {
  matchId: number;
  teamId: number;
  teamName: string;
  opponentName: string | null;
  side: "home" | "away";
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  stageKind: "elim" | "round_robin" | "group";
  round: number;
  leg: number | null;
  submitted: boolean;
  submittedBy: string | null;
  grantedByName: string | null;
  grantedAt: string;
}

// 教练端 GET /api/coach/proxy/:mid/board：代打模式一次取全（名单 + 伤停停赛 + 已交阵容）
export interface ProxyBoardResp {
  session: ProxySessionDTO;
  players: { id: number; name: string; number: string | null }[];
  status: CoachStatusResp;
  lineup: TeamLineupDTO | null;
}

// 管理端 GET /api/admin/proxy-grants
export interface AdminProxyGrantDTO {
  id: number;
  matchId: number;
  teamId: number;
  teamName: string;
  opponentName: string | null;
  side: "home" | "away";
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  round: number;
  granteeUserId: number;
  granteeName: string | null;
  granteeTeamName: string | null;
  grantedBy: number;
  grantedByName: string | null;
  createdAt: string;
  revokedAt: string | null;
  /** 未撤销且比赛未开打 */
  active: boolean;
  /** 被代打的那一队这场是否已有阵容 */
  submitted: boolean;
}

// 管理端 GET /api/admin/proxy-grants/context：授权页的候选账号
// （姓名取 auth 库 account.name；不带角色——教练端能不能用由权限点判定，看本库 role 会误判）
export interface ProxyGrantCandidateDTO {
  userId: number;
  name: string;
  teamId: number | null;
  teamName: string | null;
}

// 管理端 GET /api/admin/proxy-grants/match/:mid：选好比赛后取两队的 id 与已有授权
// （比赛列表 DTO 里没有 team id，靠队名反查不可靠）
export interface ProxyMatchSidesDTO {
  matchId: number;
  status: MatchStatus;
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  round: number;
  leg: number | null;
  homeTeamId: number | null;
  homeTeamName: string | null;
  awayTeamId: number | null;
  awayTeamName: string | null;
  grants: AdminProxyGrantDTO[];
}

// ---------- 战术存档（tactic 表，migration 0009/0017） ----------

// /api/coach/tactics 列表项；roster 为战术页人员分配映射 {"首发lid"|"b0".."b8": "player_id"}
export interface TacticArchiveDTO {
  id: number;
  /** 11/12 位战术码（FUT26/FUT25），载入走解码回填 */
  code: string;
  form: string;
  buildup: string;
  lineHeight: number;
  note: string;
  roster: Record<string, string>;
  /** 球员指派：角色码 → 球员 id（跨场复用回填用） */
  assign: Record<string, number>;
  createdAt: string;
}

// ---------- 赛前情报：未开赛详情页三 Tab（交锋 / 球员 / 阵容） ----------

// GET /api/public/tournaments/:tid/matches/:mid/h2h
export interface H2HMeetingDTO {
  matchId: number;
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  round: number;
  leg: number | null;
  /** 完赛日期 YYYY-MM-DD（缺失为空串） */
  dateLabel: string;
  homeTeamName: string;
  awayTeamName: string;
  homeLogoUrl: string | null;
  awayLogoUrl: string | null;
  scoreHome: number;
  scoreAway: number;
  penHome: number | null;
  penAway: number | null;
  walkoverSide: "home" | "away" | "both" | null;
  /** 胜方球队 id；平局 null（口径同积分榜：点球点胜=胜、双弃权双方不计胜） */
  winnerTeamId: number | null;
  isThisTournament: boolean;
}

export interface H2HFormItem {
  matchId: number;
  result: "W" | "D" | "L";
  /** 该队视角比分，如 "2:1" */
  scoreLabel: string;
  opponentName: string | null;
}

export interface H2HRankSide {
  rank: number;
  pts: number;
  played: number;
  groupName: string | null;
}

export interface H2HDTO {
  home: { teamId: number; teamName: string; logoUrl: string | null } | null;
  away: { teamId: number; teamName: string; logoUrl: string | null } | null;
  /** 跨赛事总交锋（全量场次计，不只展示的前 10 场）；无历史为 null */
  overall: {
    played: number;
    winsHome: number;
    draws: number;
    winsAway: number;
    avgGoals: number;
  } | null;
  meetings: H2HMeetingDTO[];
  /** 趣味彩蛋文案（最多 3 条）：连胜/不败、点球宿敌、最大分差之战、场均进球 */
  storylines: string[];
  homeForm: H2HFormItem[];
  awayForm: H2HFormItem[];
  /** 两队同在一个非淘汰赛阶段（同组/同循环赛）时才有当前排名 */
  ranks: { label: string; home: H2HRankSide; away: H2HRankSide } | null;
}

// GET /api/public/tournaments/:tid/matches/:mid/lineup-stats
export interface TacticXIPlayerDTO {
  lid: number;
  position: string;
  playerId: number;
  name: string | null;
  number: string | null;
  /** 窗口内该阵型位上的首发次数 */
  starts: number;
}

export interface TeamTacticsDTO {
  teamId: number;
  teamName: string;
  /** 计入统计的场次（含自动沿用上一场的） */
  sampleSize: number;
  /** 其中教练真实提交阵容的场次 */
  realSubmissions: number;
  /** 阵型使用分布，按次数降序 */
  forms: { form: string; n: number }[];
  typicalForm: string | null;
  /** 最常用阵型下各位置历史首发最多的球员（只含有人的位） */
  typicalXI: TacticXIPlayerDTO[];
  topStarter: {
    playerId: number;
    name: string;
    number: string | null;
    position: string;
    starts: number;
  } | null;
}

export interface LineupStatsDTO {
  home: TeamTacticsDTO | null;
  away: TeamTacticsDTO | null;
}

// 教练端可提交的待开比赛
export interface CoachPendingMatchDTO {
  id: number;
  tournamentId: number;
  tournamentName: string;
  stageName: string | null;
  stageKind: "elim" | "round_robin" | "group";
  round: number;
  leg: number | null;
  side: "home" | "away";
  opponentName: string | null;
  submitted: boolean;
  /** 本场本队已授权他人代打：这期间本队教练提交会被拒 */
  proxyGranted: boolean;
}

// ---------- 教练端：本队伤停/停赛概览（战术板用，只读派生） ----------
// 停赛按赛事算（红黄牌在赛事内独立累计）→ 板上要选赛事；伤停跨赛事 → 不随赛事切换。

// 概览里的赛事项：本队已报名、且赛事已发布（非草稿）
export interface CoachStatusTournamentDTO {
  tournamentId: number;
  name: string;
  default: boolean; // 本队最近一场待开比赛所在赛事；没有待开比赛时取最新赛事
}

// 本队球员在所选赛事里的停赛/黄牌状态（只含有红黄牌记录的人）
export interface CoachStatusPlayerDTO {
  playerId: number;
  playerName: string;
  remaining: number; // 剩余停赛场数，> 0 即停赛中
  yellows: number; // 当前累积黄牌数
}

export interface CoachStatusResp {
  tournaments: CoachStatusTournamentDTO[];
  tournamentId: number | null; // 生效赛事（传入的赛事不属于本队时静默回落默认）；无赛事时为 null
  yellowThreshold: number; // 0 = 不启用黄牌累积停赛
  players: CoachStatusPlayerDTO[];
  injuries: InjuryWatchDTO[]; // 伤停中（跨赛事口径，不随 tournamentId 变化）
}

export interface RoundMetaDTO {
  round: number;
  count: number;
  live: number;
  finished: number;
  pending: number;
}

export interface StageRoundsDTO {
  stageId: number;
  name: string | null;
  kind: "elim" | "round_robin" | "group";
  sortOrder: number;
  rounds: RoundMetaDTO[];
}

export interface MatchSummaryDTO {
  recent: MatchDTO[];
  upcoming: MatchDTO[];
}

export type MatchEventType =
  | "goal"
  | "pen_goal"
  | "pen_miss"
  | "own_goal"
  | "injury_minor"
  | "injury_major"
  | "yellow"
  | "red"
  | "red_2y"; // 两黄变一红：录第二张黄牌时后端自动转存，只由系统生成

// 公开端事件视图：不暴露内部 id，side 标主/客
export interface PublicMatchEventDTO {
  id: number;
  type: MatchEventType;
  minute: number | null;
  side: "home" | "away";
  playerName: string | null;
  assistPlayerName: string | null;
}

export interface UpcomingDTO {
  tournamentId: number;
  tournamentName: string;
  matchId: number;
  stageKind: "elim" | "round_robin" | "group";
  stageOrder: number;
  round: number;
  homeTeamName: string;
  awayTeamName: string;
}

export interface RecentDTO {
  tournamentId: number;
  tournamentName: string;
  matchId: number;
  stageKind: "elim" | "round_robin" | "group";
  round: number;
  homeTeamName: string;
  awayTeamName: string;
  scoreHome: number;
  scoreAway: number;
  finishedAt: string | null;
  events: PublicMatchEventDTO[];
}

export interface LiveDTO {
  tournamentId: number;
  tournamentName: string;
  matchId: number;
  stageKind: "elim" | "round_robin" | "group";
  round: number;
  homeTeamName: string;
  awayTeamName: string;
  scoreHome: number;
  scoreAway: number;
  events: PublicMatchEventDTO[];
}

export interface MatchEventDTO {
  id: number;
  matchId: number;
  type: MatchEventType;
  entryId: number;
  playerId: number | null;
  assistPlayerId: number | null;
  minute: number | null;
  createdAt: string;
}

// ---------- 积分榜（管理端与公开页共用） ----------
export interface StandingRowDTO {
  entryId: number;
  teamName: string;
  teamLogoUrl: string | null;
  seed: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  penWon: number;
  penLost: number;
  pts: number;
  pointsDeducted: number;
  rank: number;
}

export interface StandingGroupDTO {
  groupId: number | null;
  name: string;
  rows: StandingRowDTO[];
}

export interface StageStandingDTO {
  stageId: number;
  kind: "group" | "round_robin";
  /** 管理员自定义的阶段显示名（编排页可改）；空 = 用 kind 默认名 */
  name: string | null;
  sortOrder: number;
  groups: StandingGroupDTO[];
}

// ---------- 排名常量（P2 才做成赛事级配置） ----------

export const POINTS = { win: 3, draw: 1, loss: 0, penWin: 2, penLoss: 1 } as const;
