// 前后端共享的类型与常量。

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
  events?: PublicMatchEventDTO[];
  stageKind?: "elim" | "round_robin" | "group";
  /** 所属阶段显示名，单轮查询时前端直接用作阶段头 */
  stageName?: string | null;
  homeLogoUrl?: string | null;
  awayLogoUrl?: string | null;
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
}

export interface LineupPlayerDTO {
  playerId: number;
  /** 球员被删后为 null，前端显示「已离队」 */
  name: string | null;
  number: string | null;
}

export interface LineupStarterDTO extends LineupPlayerDTO {
  kind: "starter";
  lid: number;
  position: string;
}

export interface LineupBenchDTO extends LineupPlayerDTO {
  kind: "bench";
}

export interface TeamLineupDTO {
  teamId: number;
  teamName: string;
  /** 阵型值（如 433），展示用 shared/tactics 的 formTitle() 转义 */
  form: string;
  submittedAt: string;
  submittedBy: string | null;
  starters: LineupStarterDTO[];
  bench: LineupBenchDTO[];
}

export interface MatchLineupDTO {
  home: TeamLineupDTO | null;
  away: TeamLineupDTO | null;
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
  sortOrder: number;
  groups: StandingGroupDTO[];
}

// ---------- 排名常量（P2 才做成赛事级配置） ----------

export const POINTS = { win: 3, draw: 1, loss: 0, penWin: 2, penLoss: 1 } as const;
