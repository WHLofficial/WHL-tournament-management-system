import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { useTimeFmt } from "../lib/datetime";
import {
  ASSIGN_GROUP_OF,
  ASSIGN_GROUPS,
  ASSIGN_KEYS,
  ASSIGN_LABEL,
  BU_ZH,
  BUILDUPS,
  FORMS,
  PTE26,
  POS_ZH,
  TacticError,
  assignConflicts,
  conflictText,
  decodeFut25,
  decodeFut26,
  defaultPair,
  encodeFut26,
  errText,
  focusAbbr,
  formTitle,
  lhBucket,
  lhName,
  pairEa,
  roleFull,
  type AssignKey,
  type Buildup,
  type TacticState,
} from "../../shared/tactics";
import { HEAT_COLS, HEAT_ROWS, heatOf } from "../../shared/roleHeat";
import { ROLE_FIT } from "../../shared/roleFit";
import { optimalXI } from "../../shared/optimalXI";
import {
  fitPosGroup,
  fitProfileAll,
  fitTile,
  fitTileTip,
  type FitGroup,
  type FitProfile,
} from "../../shared/fitScore";
import { TILE_NAME_MAX, heatSide, nameFontSize, surname, tilePositions } from "../lib/pitch";
import {
  DRAFT_KEYS,
  DEFAULT_STATE,
  assignCandidatesOf,
  assignPoolOf,
  loadLS,
  loadScopeState,
  sanitizeAssign,
  saveLS,
  type RosterPlayer,
} from "../lib/assignDraft";
import { statusSuffix } from "../lib/assignCandidates";
import { fitBenchTopTags, fitCompareRows, fitDiffRows, fitRecPool } from "../lib/fitRecommend";
import { useNarrow } from "../lib/useNarrow";
import { AssignSheet } from "../components/AssignSheet";
import { FitCandidateList, fitTileClass } from "../components/FitCandidateList";
import type { AssignCandidateItem } from "../components/AssignCandidate";
import type {
  CoachPendingMatchDTO,
  CoachStatusPlayerDTO,
  CoachStatusResp,
  PlayerMeta,
  ProxyBoardResp,
  ProxySessionDTO,
  TacticArchiveDTO,
  TeamLineupDTO,
} from "../../shared/types";

const STAGE_ZH: Record<string, string> = { elim: "淘汰赛", round_robin: "循环赛", group: "小组赛" };

// 角色/重心的中文标签（UI 友好）：FC26 官方术语是英文，磁贴上用短码不占位，但球员卡下拉、
// 悬停提示面向中文教练——给中文名 + 短码。zh 名取自 ROLE_FIT 权重表（49 角色全量），
// 取不到的组合回退官方英文名，不静默丢信息。
const FOCUS_ZH: Record<string, string> = {
  Defend: "防守",
  Balanced: "平衡",
  "Build-Up": "组织",
  Support: "策应",
  Attack: "进攻",
  Versatile: "全能",
  Aggressive: "激进",
  "Ball-Winning": "拼抢",
  Roaming: "游弋",
  Wide: "拉边",
};
function roleZhFull(position: string, role: string): string {
  const zh = ROLE_FIT[`${position}|${role}`]?.zh;
  return zh ? `${zh} ${role}` : roleFull(role);
}
function focusZh(f: string): string {
  return FOCUS_ZH[f] ? `${FOCUS_ZH[f]} ${f}` : f;
}


const LS_ASSIGN_OPEN = "ftc26-assign-open";
const BENCH = [0, 1, 2, 3, 4, 5, 6, 7, 8];
// 切回刚看过的赛事/比赛先用缓存值立刻画，超过这个时长再后台校正
const CACHE_TTL = 60_000;

// 分层：球场与「选中位置编辑器」常驻，其余卡片按层显示（层记在 URL ?zone=，刷新/分享/后退都对）。
// 无球队绑定的身份看不到阵容编排层（与提交卡同源），默认落战术设计。
type Zone = "lineup" | "design" | "tools";
const ZONES: { key: Zone; label: string; note: string }[] = [
  { key: "lineup", label: "阵容编排", note: "选比赛 · 排首发 · 提交" },
  { key: "design", label: "战术设计", note: "阵型 · 组织风格 · 防线 · 队长与定位球" },
  { key: "tools", label: "工具与档案", note: "导入战术码 · 存档" },
];
// 卡里的展示顺序：照 ASSIGN_GROUPS 的声明顺序（队长 → 任意球 → 角球进攻 → 角球防守 → 界外球）。
// 组卡内槽位 chip 走统一两列网格，槽位数为奇数补一个空位，同类槽位在各组里坐标一致。
function isZone(v: string | null): v is Zone {
  return v === "lineup" || v === "design" || v === "tools";
}

// 磁贴摆位表在 src/lib/pitch.ts（与赛前情报的小战术板共用一套），这里只负责渲染。

// meta：FC26 数据随名册一起下发（未提交阵容时候选行的属性 pill / 徽章只靠它）
type TeamPlayer = RosterPlayer;

// 停赛口径的按赛事缓存（players + 黄牌阈值；伤停跨赛事，跟着整包状态走）
type StatusSlice = { players: CoachStatusPlayerDTO[]; yellowThreshold: number };

// 球员异常状态：停赛/黄牌按所选赛事算，伤停跨赛事（后端 /api/coach/me/status 派生）
type PStat = {
  susp: number; // 剩余停赛场数，> 0 即停赛中
  yellows: number; // 本赛事累计黄牌
  near: boolean; // 再吃一张黄牌就停赛
  inj: { injury: string | null; rest: number; pct: number } | null; // 伤停中：剩余缺阵场 / 恢复进度
};

// 教练首屏聚合端点 /api/coach/bootstrap 的响应（v5.0.2）。
// 只声明本页用到的字段：team 只要 name/players，其余段沿用既有 DTO。
type CoachBootstrap = {
  team: { name: string; players: TeamPlayer[] } | null;
  tactics: TacticArchiveDTO[];
  matches: CoachPendingMatchDTO[];
  sessions: ProxySessionDTO[];
};

export default function Tactics() {
  const { dateTime, date } = useTimeFmt();
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  // 窄屏（手机）= 槽位 chip 开底部弹层；桌面 = 深链进编排页。半场板也只在桌面宽度画。
  const narrow = useNarrow();
  const [state, setState] = useState<TacticState>(() => loadScopeState("ftc26"));
  const [names, setNames] = useState<Record<string, string>>(() =>
    loadLS(DRAFT_KEYS("ftc26").names, {}),
  );
  // 球员指派：角色码 → 球员 id（只存已填项）。换阵型换人不影响它——键是角色不是位置。
  const [assign, setAssign] = useState<Record<string, number>>(() =>
    sanitizeAssign(loadLS(DRAFT_KEYS("ftc26").assign, null)),
  );
  const [assignOpen, setAssignOpen] = useState<boolean>(() => loadLS(LS_ASSIGN_OPEN, false));
  // 手机底部弹层当前看的是哪个槽（桌面不开弹层，深链去编排页那一个槽）
  const [sheetKey, setSheetKey] = useState<AssignKey | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [msg, setMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [armReset, setArmReset] = useState(false);
  const [selfPlayers, setSelfPlayers] = useState<TeamPlayer[] | null>(null);
  const [selfTeamName, setSelfTeamName] = useState<string | null>(null);
  const [subOpen, setSubOpen] = useState(true);
  // 一键推荐 diff 面板（B2 S2）：开合纯前端态，不进 URL 不进草稿
  const [recOpen, setRecOpen] = useState(false);
  // 阵型对比卡（B2 S3）：默认收起；展开态记阵型值，一次一行
  const [cmpOpen, setCmpOpen] = useState(false);
  const [cmpOpenForm, setCmpOpenForm] = useState<string | null>(null);
  const [subMatches, setSubMatches] = useState<CoachPendingMatchDTO[] | null>(null);
  const [subMatchId, setSubMatchId] = useState<number | null>(null);
  const [selfMine, setSelfMine] = useState<TeamLineupDTO | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [armSubmit, setArmSubmit] = useState(false);
  const [archives, setArchives] = useState<TacticArchiveDTO[] | null>(null);
  const [saveNote, setSaveNote] = useState("");
  const [archBusy, setArchBusy] = useState(false);
  const [armDel, setArmDel] = useState<number | null>(null);
  const [selfStatus, setSelfStatus] = useState<CoachStatusResp | null>(null);
  const [selfStatusBusy, setSelfStatusBusy] = useState(false);
  // 代打（管理员把某队某场的提交权授给了我）：身份切换器 + 目标队整包取数
  const [proxySessions, setProxySessions] = useState<ProxySessionDTO[] | null>(null);
  const [proxyOn, setProxyOn] = useState(false);
  const [proxyMid, setProxyMid] = useState<number | null>(null);
  const [board, setBoard] = useState<ProxyBoardResp | null>(null);
  const [boardNonce, setBoardNonce] = useState(0);
  const [boardBusy, setBoardBusy] = useState(false);
  // 侧栏那几个取数失败后都置空，而置空在界面上跟「本来就没有」长得一样：没存档、没比赛、
  // 没授权、没提交过阵容。所以每个来源各记一条，成功时清掉自己那条，统一在侧栏顶上显示。
  const [loadErrs, setLoadErrs] = useState<Record<string, string>>({});
  const markLoadErr = useCallback((key: string, text: string | null) => {
    setLoadErrs((prev) => {
      if (text == null) {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return prev[key] === text ? prev : { ...prev, [key]: text };
    });
  }, []);
  // 取数缓存与「已解析口径」：同一赛事/同一场比赛来回切时不再重发请求
  const statusCache = useRef(new Map<number, StatusSlice>());
  const statusTidRef = useRef<number | null>(null);
  const statusReq = useRef<number | null | undefined>(undefined); // 上次请求带的 tournamentId；undefined = 还没请求过
  const mineCache = useRef(new Map<number, { v: TeamLineupDTO | null; at: number }>());
  const matchesAt = useRef(0);
  const toastTimer = useRef<number | null>(null);
  const armTimer = useRef<number | null>(null);
  const subArmTimer = useRef<number | null>(null);
  const armDelTimer = useRef<number | null>(null);

  // 草稿作用域：本队一份（ftc26-*），代打每个场次各一份（ftc26-proxy-<mid>-*）。
  // 切作用域时整包换草稿（不合并）；下面写回带一道「已载入的作用域 === 当前作用域」的闸，
  // 免得切的这一帧把上一个身份的名单写进新身份。
  const wantScope = proxyOn && proxyMid != null ? `ftc26-proxy-${proxyMid}` : "ftc26";
  const [scope, setScope] = useState("ftc26");
  const dk = DRAFT_KEYS(scope);
  useEffect(() => {
    if (scope === wantScope) return;
    setScope(wantScope);
    setState(loadScopeState(wantScope));
    setNames(loadLS(DRAFT_KEYS(wantScope).names, {}));
    setAssign(sanitizeAssign(loadLS(DRAFT_KEYS(wantScope).assign, null)));
    setSelected(null);
    setMsg(null);
  }, [scope, wantScope]);
  useEffect(() => {
    if (scope === wantScope) saveLS(dk.state, state);
  }, [dk.state, scope, wantScope, state]);
  useEffect(() => {
    if (scope === wantScope) saveLS(dk.names, names);
  }, [dk.names, scope, wantScope, names]);
  useEffect(() => {
    if (scope === wantScope) saveLS(dk.assign, assign);
  }, [dk.assign, scope, wantScope, assign]);
  // 教练首屏取数（v5.0.2）：本队名单 / 战术存档 / 待选比赛 / 代打授权 四段合成一次请求
  // （原来 4 个 effect 各发一次），四段的队伍归属与账号名在服务端只算一次。
  // 这四段本就是同一次「教练首屏」加载，故任一段失败时四段一起报错，不再分段标错。
  useEffect(() => {
    if (!user) {
      setSelfPlayers(null);
      setSelfTeamName(null);
      setArchives(null);
      setSubMatches(null);
      setSubMatchId(null);
      setProxySessions(null);
      setProxyOn(false);
      setProxyMid(null);
      return;
    }
    let dead = false;
    api<CoachBootstrap>("/api/coach/bootstrap")
      .then((b) => {
        if (dead) return;
        markLoadErr("本队名单", null);
        markLoadErr("战术存档", null);
        markLoadErr("待选比赛", null);
        markLoadErr("代打授权", null);
        setSelfPlayers(b.team?.players ?? null);
        setSelfTeamName(b.team?.name ?? null);
        setArchives(b.tactics ?? []);
        const list = b.matches ?? [];
        matchesAt.current = Date.now();
        setSubMatches(list);
        setSubMatchId((cur) => (cur != null && list.some((m) => m.id === cur) ? cur : list[0]?.id ?? null));
        const sessions = b.sessions ?? [];
        setProxySessions(sessions);
        setProxyMid((cur) =>
          cur != null && sessions.some((s) => s.matchId === cur) ? cur : sessions[0]?.matchId ?? null,
        );
        // 授权被撤销/比赛开打后清单会空掉，这时自动切回本队身份
        if (sessions.length === 0) setProxyOn(false);
      })
      .catch((e: unknown) => {
        if (dead) return;
        const text = e instanceof Error ? e.message : "加载失败";
        markLoadErr("本队名单", text);
        markLoadErr("战术存档", text);
        markLoadErr("待选比赛", text);
        markLoadErr("代打授权", text);
        setSelfPlayers(null);
        setSelfTeamName(null);
        setArchives([]);
        setSubMatches([]);
        setProxySessions([]);
      });
    return () => {
      dead = true;
    };
  }, [user, markLoadErr]);

  // 所选比赛的我方已提交阵容：自动选中与手动切换共用。
  // 命中缓存先画出来，避免切轮次时「已提交」提示与按钮文案闪回。
  useEffect(() => {
    if (subMatchId == null) {
      setSelfMine(null);
      return;
    }
    const hit = mineCache.current.get(subMatchId);
    setSelfMine(hit ? hit.v : null);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      markLoadErr("本场已交阵容", null);
      return;
    }
    let dead = false;
    api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${subMatchId}/lineup`)
      .then((b) => {
        if (dead) return;
        mineCache.current.set(subMatchId, { v: b.lineup, at: Date.now() });
        markLoadErr("本场已交阵容", null);
        setSelfMine(b.lineup);
      })
      .catch((e: unknown) => {
        if (dead) return;
        markLoadErr("本场已交阵容", e instanceof Error ? e.message : "加载失败");
        if (!hit) setSelfMine(null);
      });
    return () => {
      dead = true;
    };
  }, [subMatchId, user, markLoadErr]);

  // 停赛口径跟随所选比赛所在赛事
  const pickedMatch = (subMatches ?? []).find((m) => m.id === subMatchId) ?? null;
  const pickedTid = pickedMatch?.tournamentId ?? null;

  // 伤停/停赛：登录后即拉（未绑队返空结构），首拉不带 tournamentId、由服务端定默认赛事；
  // 口径对齐后不再重发——同一赛事内换比赛 0 请求，换赛事才多一次且先用缓存值立刻显示。
  useEffect(() => {
    if (!user) {
      setSelfStatus(null);
      setSelfStatusBusy(false);
      statusTidRef.current = null;
      statusReq.current = undefined;
      markLoadErr("停赛状态", null);
      return;
    }
    // 代打模式下停赛口径来自代打板（目标队所在赛事），这条本队口径的请求让位
    if (proxyOn) {
      markLoadErr("停赛状态", null);
      return;
    }
    const want = pickedTid;
    const cur = statusTidRef.current;
    if (statusReq.current !== undefined && (want === null || want === statusReq.current || want === cur)) {
      return;
    }
    const hit = want != null ? statusCache.current.get(want) : undefined;
    if (hit) {
      statusTidRef.current = want;
      setSelfStatus((prev) =>
        prev
          ? { ...prev, tournamentId: want, players: hit.players, yellowThreshold: hit.yellowThreshold }
          : prev,
      );
    } else if (want != null) {
      // 没缓存：先清掉上一赛事的停赛清单，别顶着新赛事名显示旧数据
      setSelfStatus((prev) => (prev ? { ...prev, tournamentId: want, players: [] } : prev));
    }
    statusReq.current = want;
    let dead = false;
    setSelfStatusBusy(true);
    api<CoachStatusResp>(`/api/coach/me/status${want != null ? `?tournamentId=${want}` : ""}`)
      .then((b) => {
        if (dead) return;
        statusTidRef.current = b.tournamentId;
        if (b.tournamentId != null) {
          statusCache.current.set(b.tournamentId, {
            players: b.players,
            yellowThreshold: b.yellowThreshold,
          });
        }
        markLoadErr("停赛状态", null);
        setSelfStatus(b);
      })
      .catch((e: unknown) => {
        if (dead) return;
        markLoadErr("停赛状态", e instanceof Error ? e.message : "加载失败");
        setSelfStatus(null);
      })
      .finally(() => {
        if (!dead) setSelfStatusBusy(false);
      });
    return () => {
      dead = true;
    };
  }, [user, pickedTid, proxyOn, markLoadErr]);

  // 代打授权清单：已并入上面的 /api/coach/bootstrap（v5.0.2），不再单独发请求

  // 代打板：目标队名单 + 伤停停赛 + 该场已交阵容，一次整包取回（口径全由服务端定）
  useEffect(() => {
    if (!proxyOn || proxyMid == null) {
      setBoard(null);
      setBoardBusy(false);
      return;
    }
    let dead = false;
    setBoardBusy(true);
    api<ProxyBoardResp>(`/api/coach/proxy/${proxyMid}/board`)
      .then((b) => {
        if (!dead) setBoard(b);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setBoard(null);
        setSubMsg({ t: "err", text: e instanceof Error ? e.message : "代打数据读取失败" });
      })
      .finally(() => {
        if (!dead) setBoardBusy(false);
      });
    return () => {
      dead = true;
    };
  }, [proxyOn, proxyMid, boardNonce]);

  // 代打模式：名单、伤停停赛、已交阵容全部换成目标队的；
  // 本队那份留在自有 state 里，切回本队身份即恢复，不用重新取数。
  const proxySession = proxyOn
    ? (proxySessions ?? []).find((s) => s.matchId === proxyMid) ?? board?.session ?? null
    : null;
  const teamPlayers = proxyOn ? board?.players ?? null : selfPlayers;
  const status = proxyOn ? board?.status ?? null : selfStatus;
  const statusBusy = proxyOn ? boardBusy : selfStatusBusy;
  const mine = proxyOn ? board?.lineup ?? null : selfMine;
  // 当前动作指向哪一场：本队模式用所选比赛，代打模式用被授权的那一场
  const curMid = proxyOn ? proxyMid : subMatchId;
  // 停赛口径所属赛事：代打模式跟着代打板，本队模式跟着所选比赛
  const statusTid = proxyOn ? status?.tournamentId ?? null : pickedTid ?? status?.tournamentId ?? null;
  // 本场已授权他人代打：本队教练让位（后端也会 403，这里先把按钮按住）
  const blockedByProxy = !proxyOn && (pickedMatch?.proxyGranted ?? false);
  // 分层：① 阵容编排只对绑了球队（或有代打授权）的身份存在，其余身份默认落 ② 战术设计。
  // 当前层记在 URL（?zone=），刷新/分享/前进后退都对；默认层不写进 URL。
  const canLineup = user?.teamId != null || (proxySessions?.length ?? 0) > 0;
  const zoneParam = sp.get("zone");
  const zone: Zone = isZone(zoneParam) && (zoneParam !== "lineup" || canLineup)
    ? zoneParam
    : canLineup
      ? "lineup"
      : "design";
  function selectZone(z: Zone) {
    const next = new URLSearchParams(sp);
    if (z === (canLineup ? "lineup" : "design")) next.delete("zone");
    else next.set("zone", z);
    setSp(next);
  }

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      if (subArmTimer.current !== null) window.clearTimeout(subArmTimer.current);
      if (armDelTimer.current !== null) window.clearTimeout(armDelTimer.current);
    },
    [],
  );

  function showToast(text: string) {
    setToast(text);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  }

  const form = FORMS.find((f) => f.value === state.form) ?? FORMS[0];

  // 指派候选池＝本场场上 11 名首发（实现搬到 lib/assignDraft，编排页共用同一份口径）。
  // 没摆满 11 个位置就留空并提示。
  const assignPool = useMemo(() => assignPoolOf(form.pos, names), [form, names]);
  // 已提交阵容 DTO 里的 meta（含已指派但已不在首发的人）。它不再是唯一来源：
  // 名册条目（bootstrap / 代打板的 players）也带同一份数据，阵容没交过时由后者兜底。
  const metaOfPid = useMemo(() => {
    const m = new Map<number, PlayerMeta>();
    if (!mine) return m;
    for (const p of [...mine.starters, ...mine.bench]) if (p.meta) m.set(p.playerId, p.meta);
    for (const a of mine.assign ?? []) if (a.meta) m.set(a.playerId, a.meta);
    return m;
  }, [mine]);
  // 弹层与编排页共用的候选池：本场首发 + 名册文案 + 上面那份 meta（优先级见 assignCandidatesOf）
  const assignCandidates = useMemo<AssignCandidateItem[]>(
    () => assignCandidatesOf(assignPool, teamPlayers, metaOfPid),
    [assignPool, teamPlayers, metaOfPid],
  );
  // FIT 引擎输入（B1 S5/S6）：pid → 全槽位得分表，磁贴底衬与球员卡候选面板共用一次计算，
  // 前端实时算、不加任何接口（保密边界 spec §7：只渲染在教练端）。meta 优先级与
  // assignCandidatesOf 同口径：已提交阵容 DTO > 名册条目自带。
  const fitOfPid = useMemo(() => {
    const m = new Map<number, FitProfile | null>();
    for (const [pid, meta] of metaOfPid) m.set(pid, fitProfileAll(meta));
    for (const p of teamPlayers ?? []) if (!m.has(p.id)) m.set(p.id, fitProfileAll(p.meta));
    return m;
  }, [teamPlayers, metaOfPid]);
  // 位置群（fitTile 兜底定稿）：pid → 门将群/场上群，磁贴出档判定用。meta 来源与 fitOfPid
  // 同循环同优先级，保证两表对同一 pid 指向同一份 meta。
  const fitGroupPid = useMemo(() => {
    const m = new Map<number, FitGroup>();
    for (const [pid, meta] of metaOfPid) m.set(pid, fitPosGroup(meta));
    for (const p of teamPlayers ?? []) if (!m.has(p.id)) m.set(p.id, fitPosGroup(p.meta));
    return m;
  }, [teamPlayers, metaOfPid]);
  // 已填项按 ASSIGN_KEYS 顺序（队长在最前）；互斥冲突按声明表算，前端预检与后端同源
  const assignFilled = ASSIGN_KEYS.filter((k) => assign[k] != null);
  const assignConflictList = useMemo(() => assignConflicts(assign), [assign]);
  const conflictKeys = useMemo(
    () => new Set(assignConflictList.flatMap((c) => [c.a, c.b])),
    [assignConflictList],
  );
  // 折叠态也要能一眼扫到填了什么（按组列，空组不出现）
  const assignSummary = useMemo(() => {
    if (assignFilled.length === 0) {
      return "不填也能提交。填了会跟阵容一起交上去，赛前管理员能看到，开赛后公开的比赛页也会显示。";
    }
    return ASSIGN_GROUPS.map((g) => {
      const items = g.items.filter((it) => assign[it.key] != null);
      if (items.length === 0) return "";
      return `${g.title}：${items
        .map((it) => `${it.label} ${playerTag(assign[it.key]!)}`)
        .join("、")}`;
    })
      .filter(Boolean)
      .join(" · ");
  }, [assign, assignFilled.length, teamPlayers]);

  // 同一名球员占多个位置、或又首发又替补：磁贴置黄（判重口径与 lineupProblem 一致）。
  // 这也是指派候选池的前提——池子按人去重，前提是这 11 个位置本来就是 11 个人。
  const dupPids = useMemo(() => {
    const seen = new Set<number>();
    const dup = new Set<number>();
    for (const p of form.pos) {
      const v = Number(names[String(p.lid)]);
      if (!Number.isInteger(v) || v <= 0) continue;
      if (seen.has(v)) dup.add(v);
      seen.add(v);
    }
    for (const i of BENCH) {
      const v = Number(names[`b${i}`]);
      if (Number.isInteger(v) && v > 0 && seen.has(v)) dup.add(v);
    }
    return dup;
  }, [form, names]);
  const capPid = assign.captain ?? null;

  // pid → 占据的首发槽（lid + 位置码）：候选面板「已首发」标记用，查看槽本身不算「别处」
  const starterSlotsByPid = useMemo(() => {
    const m = new Map<number, { lid: number; position: string }[]>();
    for (const p of form.pos) {
      const v = Number(names[String(p.lid)]);
      if (!Number.isInteger(v) || v <= 0) continue;
      const arr = m.get(v) ?? [];
      arr.push({ lid: p.lid, position: p.position });
      m.set(v, arr);
    }
    return m;
  }, [form, names]);

  // 11 个首发：LS 里存的 pair 合法就用，否则回默认角色（换阵型后残留自动兜底）
  const players = useMemo(
    () =>
      form.pos.map((p) => {
        const stored = state.roles[p.lid];
        const pair =
          stored && pairEa(p.position, stored[0], stored[1]) != null
            ? { role: stored[0], focus: stored[1] }
            : defaultPair(p.position);
        return {
          lid: p.lid,
          position: p.position,
          ...pair,
          eaId: pairEa(p.position, pair.role, pair.focus) ?? 0,
        };
      }),
    [form, state.roles],
  );

  const code = useMemo(() => {
    try {
      return encodeFut26({
        form: state.form,
        bu: state.bu,
        lh: state.lh,
        ea: players.map((p) => p.eaId),
      });
    } catch {
      return "------------";
    }
  }, [state.form, state.bu, state.lh, players]);

  // —— 伤停/停赛：停赛按所选赛事算，伤停跨赛事（口径与录入端一致） ——
  const suspThreshold = status?.yellowThreshold ?? 0;
  const suspMap = useMemo(() => {
    const m = new Map<number, { remaining: number; yellows: number }>();
    for (const p of status?.players ?? []) {
      m.set(p.playerId, { remaining: p.remaining, yellows: p.yellows });
    }
    return m;
  }, [status]);
  // 伤停中 = 还有没打完的缺阵场（已伤愈的登记不再提示）
  const injMap = useMemo(() => {
    const m = new Map<number, { injury: string | null; rest: number; pct: number }>();
    for (const i of status?.injuries ?? []) {
      const rest = i.misses.filter((x) => x.status !== "finished").length;
      if (rest > 0) m.set(i.playerId, { injury: i.injuryName, rest, pct: i.recoverPercent });
    }
    return m;
  }, [status]);

  function statOfPid(pid: number): PStat | null {
    const s = suspMap.get(pid);
    const j = injMap.get(pid);
    if (!s && !j) return null;
    const susp = s?.remaining ?? 0;
    const yellows = s?.yellows ?? 0;
    return {
      susp,
      yellows,
      near: susp <= 0 && suspThreshold > 0 && yellows === suspThreshold - 1,
      inj: j ?? null,
    };
  }
  function statOf(v: string | undefined): PStat | null {
    const pid = Number(v);
    if (!v || !Number.isInteger(pid) || pid <= 0) return null;
    return statOfPid(pid);
  }
  // 下拉后缀：文案与优先级沿用录入端（停赛 > 黄牌临界 > 伤停）；
  // 停赛用 🟥（与全站红牌图标、赛前情报一致），伤停用 🩹。
  // 实现搬到 lib/assignCandidates 的 statusSuffix：手机弹层与桌面编排页的候选行共用同一份口径
  function optionSuffix(pid: number): string {
    return statusSuffix(statOfPid(pid), suspThreshold);
  }
  // 磁贴悬停/无障碍文案
  function statTip(st: PStat | null): string {
    if (!st) return "";
    return [
      st.susp > 0 ? `停赛剩${st.susp}场` : "",
      st.inj ? `伤停剩${st.inj.rest}场` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  // 球员卡里的整句提示
  function riskLine(st: PStat | null): string {
    if (!st) return "";
    return [
      st.susp > 0 ? `停赛中，还剩 ${st.susp} 场` : "",
      st.near ? `再吃 1 张黄牌就停赛（已累计 ${st.yellows} 张）` : "",
      st.inj
        ? `伤停中：${st.inj.injury ?? "伤病"}，剩余缺阵 ${st.inj.rest} 场（恢复 ${st.inj.pct}%）`
        : "",
    ]
      .filter(Boolean)
      .join("；");
  }
  // 提交前软提示：首发 + 替补里的状态异常者（只提示，不拦提交）
  function lineupRisks(): string[] {
    const keys = [...form.pos.map((p) => String(p.lid)), ...BENCH.map((i) => `b${i}`)];
    const out: string[] = [];
    for (const k of keys) {
      const st = statOf(names[k]);
      const why = statTip(st);
      if (why) out.push(`${displayName(names[k]) || "未命名"}（${why}）`);
    }
    return out;
  }

  // —— 一键推荐（B2 S2 / spec §5.3）：先出 diff 预览，教练点「应用推荐」才写回 ——
  // 候选池：排除停赛与伤停。口径沿用 statOfPid（提交前风险提示 / 候选行后缀同一来源；
  // 后端对停赛伤停「全部只提示不拦截」，这里同样只影响推荐池、不改提交行为）。
  // 无 meta 不进池（推荐不猜无数据的人）；可上场不足 11 人放开为全员，面板附一句提示。
  const recPool = useMemo(
    () =>
      fitRecPool(
        teamPlayers ?? [],
        (pid) => {
          const st = statOfPid(pid);
          return !(st && (st.susp > 0 || st.inj));
        },
        (pid) => fitOfPid.get(pid) != null,
      ),
    [teamPlayers, suspMap, injMap, suspThreshold, fitOfPid],
  );
  // 推荐槽位：当前阵型 11 槽各按现任角色建边（只动人不动角色）。key 用 lid——两个槽可以
  // 同角色同 slotKey，而 optimalXI 的 assignment 按 key 收敛成 Map，撞键会互相覆盖。
  const recSlots = useMemo(
    () =>
      form.pos.map((p, i) => ({
        lid: p.lid,
        position: p.position,
        slotKey: `${p.position}|${players[i].role}`,
      })),
    [form, players],
  );
  // 优化目标 Σ rankRaw（未截断，spec §5.3）；GK 槽不设硬约束。开面板才算（毫秒级，但没必要白跑）。
  const recResult = useMemo(() => {
    if (!recOpen || recPool.pids.length === 0) return null;
    return optimalXI(
      recSlots.map((s) => ({
        key: String(s.lid),
        weightOf: (pid: number) => fitOfPid.get(pid)?.get(s.slotKey)?.rankRaw ?? null,
      })),
      recPool.pids,
    );
  }, [recOpen, recPool, recSlots, fitOfPid]);
  // diff 行：推荐 vs 现任首发草稿。构造是纯函数（lib/fitRecommend，有单测），这里只注入取数；
  // FIT 变化用 rankShown（显示层口径，同候选面板行首）。
  const recRows = useMemo(() => {
    if (recResult == null) return null;
    return fitDiffRows(
      recSlots,
      (lid) => {
        const v = Number(names[String(lid)]);
        return Number.isInteger(v) && v > 0 ? v : null;
      },
      (lid) => recResult.assignment.get(String(lid)) ?? null,
      (pid, slotKey) => fitOfPid.get(pid)?.get(slotKey)?.rankShown ?? null,
    );
  }, [recResult, recSlots, names, fitOfPid]);

  function recNameOf(pid: number): string {
    const p = teamPlayers?.find((x) => x.id === pid);
    return p ? p.name : `球员 ${pid}`;
  }
  // 阵型对比（B2 S3 / spec §5.4）：29 个阵型各跑一次 optimalXI（毫秒级），useMemo 收窄依赖
  // 一次算完（池 / 分数表 / 当前阵型与角色）。当前阵型用教练已调的角色/重心（players 已带
  // pairEa 兜底），其余 28 个用默认角色——重心不影响权重，pairOf 只需给 role。
  const cmpRows = useMemo(
    () =>
      fitCompareRows(
        FORMS,
        (formValue, lid, position) => {
          if (formValue === state.form) {
            const p = players.find((x) => x.lid === lid);
            if (p) return { role: p.role, focus: p.focus };
          }
          return defaultPair(position);
        },
        recPool.pids,
        fitOfPid,
      ),
    [recPool, fitOfPid, state.form, players],
  );
  // 应用推荐：一次性把有推荐的槽写回（只动人，不动角色/重心/替补/指派），面板收起
  function applyRecommendation() {
    if (recResult == null) return;
    setNames((n) => {
      const next = { ...n };
      for (const s of recSlots) {
        const pid = recResult.assignment.get(String(s.lid));
        if (pid != null) next[String(s.lid)] = String(pid);
      }
      return next;
    });
    setRecOpen(false);
    showToast("已按推荐写回首发");
  }

  function setPair(lid: number, pos: string, role: string, focus: string) {
    if (pairEa(pos, role, focus) == null) return;
    setState((s) => ({ ...s, roles: { ...s.roles, [lid]: [role, focus] } }));
  }

  function displayName(v: string | undefined): string {
    if (!v) return "";
    const p = teamPlayers?.find((x) => String(x.id) === v);
    return p ? p.name : v;
  }

  // —— 球员指派（FC26 球队管理 · 指派 18 项）——
  // 指派下拉/摘要里的球员标签：#号 姓名（没绑定球队或球员已离队时退化成 id）
  function playerTag(pid: number): string {
    const p = teamPlayers?.find((x) => x.id === pid);
    if (!p) return `球员 ${pid}`;
    return `${p.number ? `#${p.number} ` : ""}${p.name}`;
  }
  // 槽位 chip 上的球员：#号 + 姓氏（chip 只有半栏宽，全名放不下；名册查不到时退化成 id）
  function chipTag(pid: number): string {
    const p = teamPlayers?.find((x) => x.id === pid);
    if (!p) return `球员 ${pid}`;
    return `${p.number ? `#${p.number} ` : ""}${surname(p.name)}`;
  }
  // chip 是入口：桌面深链进编排页并定位该槽，窄屏开底部弹层（弹层里只列本场首发）
  function openAssignSlot(key: AssignKey) {
    if (narrow) {
      setSheetKey(key);
      return;
    }
    const q = new URLSearchParams({ scope, group: ASSIGN_GROUP_OF[key], key });
    // 带上当前这场比赛：编排页照它取已交阵容，候选行的 FC26 数据才跟战术页看到的是同一份
    if (curMid != null) q.set("mid", String(curMid));
    navigate(`/tactics/assignments?${q.toString()}`);
  }
  function setAssignKey(key: AssignKey, pid: number | null) {
    setAssign((a) => {
      const next = { ...a };
      if (pid == null) delete next[key];
      else next[key] = pid;
      return next;
    });
  }
  function clearAssignConflicts() {
    const bad = new Set(assignConflictList.flatMap((c) => [c.a, c.b]));
    setAssign((a) => {
      const next = { ...a };
      for (const k of bad) delete next[k];
      return next;
    });
    showToast("已清除冲突项");
  }
  function toggleAssignOpen() {
    const next = !assignOpen;
    setAssignOpen(next);
    saveLS(LS_ASSIGN_OPEN, next);
  }
  // 把该场已提交的那份搬回编辑器：阵型 + 位置↔球员 + 替补顺序 + 指派一次到位（覆盖当前草稿）
  function applySubmitted(l: TeamLineupDTO) {
    const next: Record<string, string> = {};
    for (const s of l.starters) next[String(s.lid)] = String(s.playerId);
    l.bench.slice(0, BENCH.length).forEach((b, i) => {
      next[`b${i}`] = String(b.playerId);
    });
    setNames(next);
    setState((s) => ({ ...s, form: l.form }));
    setAssign(Object.fromEntries((l.assign ?? []).map((a) => [a.key, a.playerId])));
    setSelected(null);
    setMsg(null);
    showToast("已载入该场提交的阵容");
  }

  function importCode(raw?: string) {
    const fromArchive = raw != null;
    const src = (raw ?? codeInput).trim().replace(/\s+/g, "");
    if (!src.length) return;
    if (src.length !== 11 && src.length !== 12) {
      setMsg({ t: "err", text: `长度不对：战术码是 11 或 12 个字符，你现在输入了 ${src.length} 个。` });
      return;
    }
    let t;
    try {
      t = src.length === 12 ? decodeFut26(src) : decodeFut25(src);
    } catch (e) {
      if (!fromArchive) setMsg({ t: "err", text: errText(e as TacticError) });
      return;
    }
    const roles: Record<number, [string, string]> = {};
    for (const s of t.slots) roles[s.lid] = [s.role, s.focus];
    setState({ form: t.form, bu: t.bu, lh: t.lh, roles });
    setSelected(null);
    if (fromArchive) {
      showToast("已载入存档");
      return;
    }
    setMsg({
      t: "ok",
      text: `已导入：${formTitle(t.form)}，防线 ${lhName(t.lh)}，${BU_ZH[t.bu]}`,
    });
    showToast("战术码已导入");
  }

  async function saveArchive() {
    if (archBusy) return;
    if (code === "------------") {
      showToast("当前战术无效，不能存档");
      return;
    }
    setArchBusy(true);
    try {
      await api("/api/coach/tactics", {
        method: "POST",
        body: {
          note: saveNote,
          code,
          form: state.form,
          buildup: state.bu,
          lineHeight: state.lh,
          roster: names,
          assign,
        },
      });
      setSaveNote("");
      const b = await api<{ tactics: TacticArchiveDTO[] }>("/api/coach/tactics");
      setArchives(b.tactics ?? []);
      showToast("已存档");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "存档失败");
    } finally {
      setArchBusy(false);
    }
  }

  function loadArchive(a: TacticArchiveDTO) {
    // 离队球员的 id 直接丢弃，避免瓷砖显示裸 id；自由文本名字保留
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(a.roster)) {
      if (!v) continue;
      if (teamPlayers && /^\d+$/.test(v) && !teamPlayers.some((p) => String(p.id) === v)) continue;
      next[k] = v;
    }
    setNames(next);
    // 指派随存档一起回来（跨场复用：下场面还是这几个人罚）；坏数据当没填
    setAssign(sanitizeAssign(a.assign));
    importCode(a.code);
  }

  async function deleteArchive(id: number) {
    if (archBusy) return;
    // 两段式确认：首击 arm 该卡（3 秒复位），再击才真删
    if (armDel !== id) {
      setArmDel(id);
      if (armDelTimer.current !== null) window.clearTimeout(armDelTimer.current);
      armDelTimer.current = window.setTimeout(() => setArmDel(null), 3000);
      return;
    }
    if (armDelTimer.current !== null) window.clearTimeout(armDelTimer.current);
    setArmDel(null);
    setArchBusy(true);
    try {
      await api(`/api/coach/tactics/${id}`, { method: "DELETE" });
      setArchives((list) => (list ? list.filter((x) => x.id !== id) : list));
      showToast("已删除存档");
    } catch (e) {
      showToast(e instanceof Error ? e.message : "删除失败");
    } finally {
      setArchBusy(false);
    }
  }

  function copyCode() {
    const done = () => showToast(`已复制 ${code}`);
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      const ta = document.createElement("textarea");
      ta.value = code;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        done();
      } catch {
        showToast("复制失败，请手动选择");
      }
      document.body.removeChild(ta);
    }
  }

  function resetAll() {
    if (!armReset) {
      setArmReset(true);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArmReset(false), 3000);
      return;
    }
    try {
      localStorage.removeItem(dk.state);
      localStorage.removeItem(dk.names);
      localStorage.removeItem(dk.assign);
    } catch {
      /* 忽略 */
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmReset(false);
    setState({ ...DEFAULT_STATE, roles: {} });
    setNames({});
    setAssign({});
    setSelected(null);
    setCodeInput("");
    setMsg(null);
    showToast("已重置");
  }

  // ---------- 阵容提交（登录绑队后可见；两击确认沿用重置的 arm 模式） ----------
  function refetchSubMatches() {
    api<{ matches: CoachPendingMatchDTO[] }>("/api/coach/me/matches")
      .then((b) => {
        matchesAt.current = Date.now();
        markLoadErr("待选比赛", null);
        setSubMatches(b.matches);
      })
      .catch((e: unknown) => {
        markLoadErr("待选比赛", e instanceof Error ? e.message : "加载失败");
        setSubMatches([]);
      });
  }

  function disarmSubmit() {
    if (subArmTimer.current !== null) window.clearTimeout(subArmTimer.current);
    setArmSubmit(false);
  }

  function toggleSubmit() {
    const next = !subOpen;
    setSubOpen(next);
    if (next) {
      setSubMsg(null);
      // 列表已在内存里就不重拉；空列表或离上次拉过太久（可能已排新场次）才刷新
      if (subMatches == null || Date.now() - matchesAt.current > 120_000) refetchSubMatches();
    }
  }

  function pickSubMatch(v: string) {
    const id = v ? Number(v) : null;
    setSubMatchId(id);
    setSubMsg(null);
    disarmSubmit();
    setSelected(null);
  }

  // 提交前的前端预检：首发 11 人齐、无重复、指派无互斥冲突（后端还会再校验一遍）
  function lineupProblem(): string | null {
    const ids = form.pos.map((p) => Number(names[String(p.lid)]));
    if (ids.some((v) => !Number.isInteger(v) || v <= 0)) {
      return "首发还没选满 11 名球员，点球场上的位置选人";
    }
    if (new Set(ids).size !== 11) return "首发里有重复球员";
    const benchIds = BENCH.map((i) => Number(names[`b${i}`])).filter(
      (v) => Number.isInteger(v) && v > 0,
    );
    if (new Set([...ids, ...benchIds]).size !== ids.length + benchIds.length) {
      return "首发和替补有重复球员";
    }
    const bad = assignConflicts(assign);
    if (bad.length > 0) return `队长与定位球有冲突：${conflictText(bad[0])}`;
    return null;
  }

  // 提交后把清单与代打板都刷新一遍：提交人/已提交标记都变了
  function refetchProxy() {
    api<{ sessions: ProxySessionDTO[] }>("/api/coach/proxy/sessions")
      .then((b) => setProxySessions(b.sessions ?? []))
      .catch(() => {});
  }

  function pickIdentity(v: string) {
    const id = v ? Number(v) : null;
    setProxyOn(id != null);
    if (id != null) setProxyMid(id);
    setSubMsg(null);
    disarmSubmit();
    setSelected(null);
  }

  function submitLineup() {
    if (curMid == null || subBusy) return;
    const problem = lineupProblem();
    if (problem) {
      setSubMsg({ t: "err", text: problem });
      return;
    }
    if (!armSubmit) {
      setArmSubmit(true);
      if (subArmTimer.current !== null) window.clearTimeout(subArmTimer.current);
      subArmTimer.current = window.setTimeout(() => setArmSubmit(false), 3000);
      return;
    }
    disarmSubmit();
    setSubBusy(true);
    const slots = [
      ...form.pos.map((p) => ({
        lid: p.lid,
        position: p.position,
        player_id: Number(names[String(p.lid)]),
      })),
      ...BENCH.map((i) => ({ kind: "bench" as const, player_id: Number(names[`b${i}`]) })).filter(
        (s) => Number.isInteger(s.player_id) && s.player_id > 0,
      ),
    ];
    const mid = curMid;
    // 代打走代打端点（服务端校验授权的是我、且没被撤销/没开打），落的是目标队那份
    const proxy = proxyOn;
    api(proxy ? `/api/coach/proxy/${mid}/lineup` : `/api/coach/matches/${mid}/lineup`, {
      method: "PUT",
      body: {
        form: state.form,
        slots,
        code: code === "------------" ? "" : code,
        assign,
      },
    })
      .then(() => {
        const who = board?.session.teamName ?? "目标队";
        setSubMsg({
          t: "ok",
          text: proxy ? `已代 ${who} 提交，开赛前可覆盖` : "已提交，开赛前随时可回来覆盖",
        });
        showToast(proxy ? `已代 ${who} 提交` : "阵容已提交");
        if (proxy) {
          refetchProxy();
          setBoardNonce((n) => n + 1);
          return;
        }
        refetchSubMatches();
        api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${mid}/lineup`)
          .then((b) => {
            mineCache.current.set(mid, { v: b.lineup, at: Date.now() });
            setSelfMine(b.lineup);
          })
          .catch(() => {});
      })
      .catch((e: unknown) =>
        setSubMsg({ t: "err", text: e instanceof Error ? e.message : "提交失败" }),
      )
      .finally(() => setSubBusy(false));
  }

  // Esc 关球员卡（鸣谢弹层自己管自己的 Esc）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSelected(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const sel = selected != null ? players.find((p) => p.lid === selected) ?? null : null;
  const selRisk = sel ? riskLine(statOf(names[String(sel.lid)])) : "";
  const selPid = sel ? Number(names[String(sel.lid)]) : NaN;
  // 球员卡里列出这名球员在本场担任的全部指派（点一下即清除该项）
  const selAssigns = ASSIGN_KEYS.filter((k) => Number.isInteger(selPid) && assign[k] === selPid);
  const risks = lineupRisks();
  // 状态清单卡：停赛（按所选比赛的赛事；代打模式按目标队所在赛事）/ 黄牌临界 / 伤停。
  // 标题跟着所选比赛走（切赛事立刻变名），清单先给缓存值，新值到达前标「更新中」。
  const statusTName =
    (status?.tournaments ?? []).find((t) => t.tournamentId === statusTid)?.name ?? "";
  const suspList = (status?.players ?? []).filter((p) => p.remaining > 0);
  const nearList = (status?.players ?? []).filter(
    (p) => p.remaining <= 0 && suspThreshold > 0 && p.yellows === suspThreshold - 1,
  );
  const injList = (status?.injuries ?? [])
    .map((i) => ({
      playerId: i.playerId,
      playerName: i.playerName,
      injuryName: i.injuryName,
      rest: i.misses.filter((x) => x.status !== "finished").length,
      pct: i.recoverPercent,
      out: curMid != null && i.misses.some((x) => x.matchId === curMid),
    }))
    .filter((i) => i.rest > 0);

  // 磁贴坐标：同位多人散开 + 三中卫回收（算法在 src/lib/pitch.ts）
  const tiles = tilePositions(form.pos.map((p) => p.position));
  // 选中球员当前角色的活动热区（FC26 数据）。中轴线上的位置在数据里分了左右两套，
  // 按这名球员所在槽位偏左还是偏右取（heatSide 在 src/lib/pitch.ts）。
  // 没选中、或这个「位置 + 角色 + 重心」组合查不到时为 null。
  const selIdx = sel ? form.pos.findIndex((p) => p.lid === sel.lid) : -1;
  const heat =
    sel && selIdx >= 0 ? heatOf(sel.position, sel.role, sel.focus, heatSide(tiles[selIdx][0])) : null;

  return (
    <main className="tac-page">
      <header className="tac-head">
        <h1>战术板</h1>
        <span className="tac-badge">FC26</span>
        <p className="tac-sub">粘贴战术码即可查看与编辑，改动实时生成新码。</p>
        <button
          className={`btn ${armReset ? "btn-danger" : "tac-reset"}`}
          onClick={resetAll}
        >
          {armReset ? "确认清空?" : "重置"}
        </button>
      </header>

      <div className="tac-layout">
        {/* 左列：球场 + 战术码。战术码跟着球场走，不随分区页签隐藏 */}
        <div className="tac-left">
          <section className="card tac-pitch-panel">
            <div
              className={`tac-pitch${heat ? " heat-on" : ""}`}
              onClick={(e) => {
                const el = e.target as Element | null;
                if (!el?.closest?.(".tac-tile")) setSelected(null);
              }}
            >
              {/* 选中球员时压暗草地，让热区像全息图一样浮出来（没选中时完全透明） */}
              <div className="tac-pitch-veil" aria-hidden="true" />
              <svg viewBox="0 0 100 130" preserveAspectRatio="none" aria-hidden="true">
                <g fill="none" stroke="rgba(244,246,243,.75)" strokeWidth=".6">
                  <rect x="3" y="3" width="94" height="124" />
                  <line x1="3" y1="65" x2="97" y2="65" />
                  <circle cx="50" cy="65" r="13" />
                  <rect x="27" y="114" width="46" height="13" />
                  <rect x="38.5" y="124" width="23" height="3" />
                  <path d="M36 114 A 14 14 0 0 1 64 114" />
                  <rect x="27" y="3" width="46" height="13" />
                  <rect x="38.5" y="3" width="23" height="3" />
                  <path d="M36 16 A 14 14 0 0 0 64 16" />
                  <path d="M3 5 A 2 2 0 0 0 5 3" />
                  <path d="M97 5 A 2 2 0 0 1 95 3" />
                  <path d="M3 125 A 2 2 0 0 1 5 127" />
                  <path d="M97 125 A 2 2 0 0 0 95 127" />
                </g>
                <g fill="rgba(244,246,243,.75)">
                  <circle cx="50" cy="65" r=".9" />
                  <circle cx="50" cy="120.5" r=".8" />
                  <circle cx="50" cy="9.5" r=".8" />
                </g>
              </svg>
              {/* 选中球员的活动热区：盖在球场线之上、压在磁贴之下 */}
              {heat ? (
                <svg className="tac-heat" viewBox="0 0 100 130" preserveAspectRatio="none" aria-hidden="true">
                  {heat.map((lv, i) =>
                    lv > 0 ? (
                      <rect
                        key={i}
                        className={`tac-heat-${lv}`}
                        x={(i % HEAT_COLS) * (100 / HEAT_COLS)}
                        y={Math.floor(i / HEAT_COLS) * (130 / HEAT_ROWS)}
                        width={100 / HEAT_COLS}
                        height={130 / HEAT_ROWS}
                      />
                    ) : null,
                  )}
                </svg>
              ) : null}
              {form.pos.map((p, i) => {
                const xy = tiles[i];
                const pl = players[i];
                const nm = displayName(names[String(p.lid)]);
                const short = nm ? surname(nm) : "";
                const pid = Number(names[String(p.lid)]);
                const st = statOf(names[String(p.lid)]);
                const dup = Number.isInteger(pid) && pid > 0 && dupPids.has(pid);
                const isCap = capPid != null && Number.isInteger(pid) && pid === capPid;
                const mark = st && st.susp > 0 ? (st.inj ? " both" : " susp") : st && st.inj ? " inj" : "";
                const tip = statTip(st);
                // FIT 底衬（B1 S5）：个人内契合分（和自己比，本位置群内分池）→ fit-g/y/o/na 四态；
                // 门将摆上场记 0 分（走红橙档，悬停显「门将不客串」）；场上球员摆门将仍无档走
                // 灰虚线，悬停显「非其位置群」。
                // 磁贴本体严禁出现数字（spec §3/§5.1），两个数只进悬停提示；无数据不追加。
                const slotKey = `${p.position}|${pl.role}`;
                const prof = Number.isInteger(pid) && pid > 0 ? fitOfPid.get(pid) ?? null : null;
                const group: FitGroup =
                  Number.isInteger(pid) && pid > 0 ? fitGroupPid.get(pid) ?? "OUT" : "OUT";
                const fitVal = fitTile(prof, slotKey, group);
                const fitTip = fitTileTip(prof, slotKey, group);
                return (
                  <button
                    key={p.lid}
                    className={`tac-tile${selected === p.lid ? " sel" : ""}${mark}${dup ? " dup" : ""}`}
                    style={{ left: `${xy[0]}%`, top: `${100 - xy[1]}%` }}
                    title={`${nm ? nm + " · " : ""}${roleZhFull(p.position, pl.role)} ${focusZh(pl.focus)}${tip ? ` · ${tip}` : ""}${fitTip}${dup ? " · 这名球员在本场占了多个位置" : ""}`}
                    aria-label={`${p.position} ${POS_ZH[p.position]} ${nm || "未命名"}，角色 ${roleZhFull(p.position, pl.role)} ${focusZh(pl.focus)}${tip ? `，${tip}` : ""}${dup ? "，位置重复" : ""}`}
                    onClick={() => setSelected(selected === p.lid ? null : p.lid)}
                  >
                    {st && (st.susp > 0 || st.inj) ? (
                      <span className="tac-marks" aria-hidden="true">
                        {st.susp > 0 ? <i className="tac-mk-card" /> : null}
                        {st.inj ? <i className="tac-mk-cross" /> : null}
                      </span>
                    ) : null}
                    {isCap ? (
                      <span className="tac-cap" title="队长" aria-hidden="true">
                        C
                      </span>
                    ) : null}
                    {dup ? (
                      <span className="tac-mk-dup" aria-hidden="true">
                        ⚠
                      </span>
                    ) : null}
                    <span className="tac-tile-top">
                      <b>{p.position}</b>
                      {/* 空槽（没放人）不挂任何 fit 类：灰虚线的语义是「放了人但跨位置群/无数据」，
                          没放人是空位不是异常，满屏虚线会把真信号淹没 */}
                      <span className={`tac-tile-role ${Number.isInteger(pid) && pid > 0 ? fitTileClass(fitVal) : ""}`}>
                        {pl.role} - {focusAbbr(pl.focus)}
                      </span>
                    </span>
                    {nm ? (
                      <small style={{ fontSize: `${nameFontSize(short, TILE_NAME_MAX)}px` }}>{short}</small>
                    ) : null}
                  </button>
                );
              })}
            </div>
            {/* 常驻一行说明：选中/取消选中时高度不跳 */}
            <p className="tac-heat-legend">
              {sel ? (
                <>
                  <span className="tac-heat-title">热区</span>
                  <span className="tac-heat-who">
                    {sel.position} {displayName(names[String(sel.lid)]) || "未命名"} · {roleZhFull(sel.position, sel.role)}（{focusZh(sel.focus)}）
                  </span>
                  <span className="tac-heat-key" aria-hidden="true">
                    <i className="tac-heat-3" />
                    频繁
                    <i className="tac-heat-2" />
                    经常
                    <i className="tac-heat-1" />
                    偶尔
                  </span>
                </>
              ) : (
                "点球场上的球员，看他的活动热区"
              )}
            </p>
          </section>

          {/* 战术码：摆在球场下面，与「这块板上现在是什么打法」紧挨着，任何一层都看得见 */}
          <section className="card tac-code-panel">
            <div className="tac-code-row">
              <div className="tac-codebox">
                <code>{code}</code>
              </div>
              <button className="btn tac-btn-primary" onClick={copyCode}>
                复制
              </button>
            </div>
          </section>
        </div>

        <div className="tac-side">
        {/* 分区页签：球场常驻在左列，这一条切右栏下面这一叠卡（当前层记在 URL ?zone=，刷新/后退都对） */}
        <nav className="tac-zones" aria-label="战术板分区">
          {ZONES.filter((z) => z.key !== "lineup" || canLineup).map((z) => (
            <button
              key={z.key}
              className={`tac-zone${zone === z.key ? " on" : ""}`}
              aria-pressed={zone === z.key}
              title={z.note}
              onClick={() => selectZone(z.key)}
            >
              {z.label}
            </button>
          ))}
          {/* 身份徽标只在代打时出现：本队模式下标的就是自己队，不用再挂个标签；
              切到②③层后提交卡看不见，这条是唯一能看出「在替谁排」的地方。 */}
          {canLineup && proxyOn && proxySession && (
            <span className="tac-zone-mode" aria-live="polite">
              代打：{proxySession.teamName}
            </span>
          )}
        </nav>

        {/* 页签右边这一叠卡：自己一列，跟竖排页签各自从顶头开始排 */}
        <div className="tac-side-body">

        {/* 取数失败不再静默：置空在界面上跟「本来就没有」长得一样，所以每个来源各显示一条 */}
        {Object.keys(loadErrs).length > 0 && (
          <div role="status">
            {Object.entries(loadErrs).map(([k, v]) => (
              <p className="error-msg" key={k}>
                {k}加载失败：{v}
              </p>
            ))}
          </div>
        )}

        {/* 一键推荐（B2 S2 / spec §5.3）：按钮在「选择目标比赛」卡上方、不放球场内；点击只展开
            diff 面板不改阵容，应用 = 一次性写回有推荐的槽（只动人），diff 即知情确认环节。
            顶部免责为 spec §6 第三层原文（逐字）。 */}
        {teamPlayers && (
          <section className="card tac-rec" hidden={zone !== "lineup"}>
            <div className="tac-submit-head">
              <h2>
                一键推荐 <small>按 FIT 适配度排首发 · 先预览再应用</small>
              </h2>
              <button
                className="btn"
                aria-expanded={recOpen}
                onClick={() => setRecOpen((v) => !v)}
              >
                推荐首发（FIT）
              </button>
            </div>
            {recOpen && (
              <div className="tac-rec-body">
                <p className="tac-rec-legal">
                  推荐由系统按当前同步数据自动计算,不保证实际比赛表现;排兵决定权在教练
                </p>
                {recPool.widened && (
                  <p className="tac-warn">
                    可上场（非停赛/伤停）人数不足 11 人，已放开全员参与推荐。
                  </p>
                )}
                {recResult == null || recRows == null ? (
                  <p className="tac-hint">无法生成推荐：可用人选不足，或队里还没有 FC26 数据。</p>
                ) : (
                  <>
                    <ul className="tac-rec-list">
                      {recRows.map((row) => (
                        <li
                          key={row.lid}
                          className={`tac-rec-row${row.kind === "keep" ? " keep" : ""}`}
                        >
                          <b className="tac-rec-pos">{row.position}</b>
                          {row.kind === "out" ? (
                            <span className="tac-rec-who">
                              {recNameOf(row.curPid!)} 出 → {recNameOf(row.newPid!)} 入
                            </span>
                          ) : (
                            <span className="tac-rec-who">
                              {recNameOf((row.newPid ?? row.curPid)!)}{" "}
                              {row.kind === "in" ? "入" : "保持"}
                            </span>
                          )}
                          <span className="tac-rec-fit">
                            {row.kind === "out"
                              ? `FIT ${row.curShown ?? "–"} → ${row.newShown ?? "–"}${
                                  row.delta != null
                                    ? `（${row.delta > 0 ? "+" : ""}${row.delta}）`
                                    : ""
                                }`
                              : `FIT ${row.newShown ?? "–"}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <div className="tac-rec-act">
                      <button className="btn tac-btn-primary" onClick={applyRecommendation}>
                        应用推荐
                      </button>
                      <button className="btn tac-reset" onClick={() => setRecOpen(false)}>
                        取消
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* 选择目标比赛：默认选中未开赛的第一场，伤停/停赛跟着它走。
            手里有代打授权时上面多一个身份切换器，切过去后整页（名单/口径/提交）都换成目标队。 */}
        {(selfPlayers != null || (proxySessions?.length ?? 0) > 0) && (
          <section className="card tac-submit" hidden={zone !== "lineup"}>
            <div className="tac-submit-head">
              <h2>
                选择目标比赛{" "}
                <small>{proxyOn ? "代打模式 · 替别人交本场阵容" : "赛前提交 · 开赛后公开"}</small>
              </h2>
              <button className="btn" onClick={toggleSubmit}>
                {subOpen ? "收起" : "展开"}
              </button>
            </div>
            {subOpen && (
              <div className="tac-submit-body">
                {(proxySessions?.length ?? 0) > 0 && (
                  <div className="tac-identity">
                    <label className="field">
                      当前编辑
                      <select
                        aria-label="选择编辑身份"
                        value={proxyOn ? String(proxyMid ?? "") : ""}
                        onChange={(e) => pickIdentity(e.target.value)}
                      >
                        <option value="">{selfTeamName ?? "我执教的球队"}</option>
                        {(proxySessions ?? []).map((s) => (
                          <option key={s.matchId} value={s.matchId}>
                            代打 {s.teamName} · {s.tournamentName} 第{s.round}轮 vs{" "}
                            {s.opponentName ?? "待定"}
                            {s.submitted ? "（已提交）" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    {proxyOn && (
                      <p className="tac-warn">
                        你正在替「{proxySession?.teamName ?? "目标队"}」排本场阵容
                        {proxySession?.grantedByName ? `（${proxySession.grantedByName} 授权）` : ""}
                        。球员、伤停和停赛都换成了这支队的；这段时间本队教练不能提交本场阵容。
                      </p>
                    )}
                  </div>
                )}
                {proxyOn && !board ? (
                  <p className="tac-hint">
                    {boardBusy || subMsg?.t !== "err" ? "正在读取代打数据…" : subMsg.text}
                    {!boardBusy && subMsg?.t === "err" && (
                      <button className="btn btn-sm" onClick={() => setBoardNonce((n) => n + 1)}>
                        重试
                      </button>
                    )}
                  </p>
                ) : (
                <div className="tac-submit-cols">
                  <div className="tac-submit-main">
                    {proxyOn ? (
                      <p className="tac-target">
                        {proxySession
                          ? `${proxySession.tournamentName} · ${
                              proxySession.stageName ?? STAGE_ZH[proxySession.stageKind]
                            } 第${proxySession.round}轮${
                              proxySession.leg ? ` · 第${proxySession.leg}回合` : ""
                            } · ${proxySession.side === "home" ? "主" : "客"} vs ${
                              proxySession.opponentName ?? "待定"
                            }`
                          : "代打目标比赛"}
                      </p>
                    ) : (
                      <select
                        aria-label="选择目标比赛"
                        value={subMatchId ?? ""}
                        onChange={(e) => pickSubMatch(e.target.value)}
                      >
                        <option value="">选择目标比赛…</option>
                        {(subMatches ?? []).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.tournamentName} · {m.stageName ?? STAGE_ZH[m.stageKind]} 第{m.round}轮
                            {m.leg ? ` · 第${m.leg}回合` : ""} · {m.side === "home" ? "主" : "客"} vs{" "}
                            {m.opponentName ?? "待定"}
                            {m.submitted ? "（已提交）" : ""}
                            {m.proxyGranted ? "（已授权他人代打）" : ""}
                          </option>
                        ))}
                      </select>
                    )}
                    {!proxyOn && subMatches != null && subMatches.length === 0 && (
                      <p className="tac-hint">你的球队当前没有待开的比赛。</p>
                    )}
                    {blockedByProxy && (
                      <p className="tac-warn">
                        本场阵容已授权他人代打，你暂不能提交；等管理员撤销或比赛开打后恢复。
                      </p>
                    )}
                    {mine && (
                      <p className="tac-hint">
                        该场已于 {dateTime(mine.submittedAt)} 提交（
                        {formTitle(mine.form)}）
                        {mine.submittedBy ? `，提交人 ${mine.submittedBy}` : ""}
                        {mine.viaProxy ? "（代打）" : ""}，再次提交将覆盖。
                        <button className="btn btn-sm" onClick={() => applySubmitted(mine)}>
                          载入已提交的阵容
                        </button>
                      </p>
                    )}
                  </div>

                  {/* 伤停与停赛：停赛按所选比赛的赛事算 */}
                  {status && (status.tournaments.length > 0 || injList.length > 0) && (
                    <div className="tac-status tac-submit-status">
                      <h2>
                        伤停与停赛 {statusTName ? <small>{statusTName}</small> : null}
                        {statusBusy ? <small className="tac-status-busy">更新中…</small> : null}
                      </h2>
                      {suspList.length === 0 && nearList.length === 0 && injList.length === 0 ? (
                        <p className="tac-hint">{statusBusy ? "读取中…" : "本队无异常。"}</p>
                      ) : (
                        <ul className="tac-status-list">
                          {suspList.map((p) => (
                            <li key={`s${p.playerId}`}>
                              <span className="tac-status-name">{p.playerName}</span>
                              <span className="susp-badge">停赛 剩{p.remaining}场</span>
                            </li>
                          ))}
                          {nearList.map((p) => (
                            <li key={`y${p.playerId}`}>
                              <span className="tac-status-name">{p.playerName}</span>
                              <span className="yc-badge">再1黄停赛（已{p.yellows}张）</span>
                            </li>
                          ))}
                          {injList.map((i) => (
                            <li key={`i${i.playerId}`}>
                              <span className="tac-status-name">{i.playerName}</span>
                              <span className="injury-badge">伤停</span>
                              {i.out ? <span className="tac-out-badge">缺本场</span> : null}
                              <span className="tac-status-note">
                                {i.injuryName ?? "伤病"} · 剩{i.rest}场 · 恢复{i.pct}%
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
                )}
              </div>
            )}
          </section>
        )}

          <section className="card tac-bench" hidden={zone !== "lineup"}>
            <h2>
              替补席 <small>9 人 · 不进战术码，仅本机保存</small>
            </h2>
            <div className="tac-bench-grid">
              {BENCH.map((i) => {
                const key = `b${i}`;
                const v = names[key] ?? "";
                // S4 替补角色化：选中且有 fitProfile 才出「擅长」行（个人内 top3 + 该槽绝对分）；
                // 无 meta / 未选人 / 自由文本名字整行不渲染。群归属与磁贴同源（fitGroupPid）。
                const bpid = Number(v);
                const benchTags =
                  Number.isInteger(bpid) && bpid > 0
                    ? fitBenchTopTags(fitOfPid.get(bpid), fitGroupPid.get(bpid) ?? "OUT")
                    : [];
                const benchFit = benchTags.map((t) => `${t.slot} ${t.shown}`).join(" · ");
                return (
                  <label className="tac-bench-slot" key={key}>
                    <span className="tac-bench-row">
                      <span className="tac-bench-no">{i + 1}</span>
                      {teamPlayers ? (
                        <select
                          value={teamPlayers.some((x) => String(x.id) === v) ? v : ""}
                          onChange={(e) => {
                            const nv = e.target.value;
                            setNames((n) => {
                              const next = { ...n };
                              if (nv) next[key] = nv;
                              else delete next[key];
                              return next;
                            });
                          }}
                          aria-label={`替补 ${i + 1}`}
                        >
                          <option value="">（未选）</option>
                          {teamPlayers.map((p) => (
                            <option key={p.id} value={String(p.id)}>
                              {`${p.number ? `#${p.number} ${p.name}` : p.name}${optionSuffix(p.id)}`}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="text"
                          maxLength={16}
                          placeholder="替补名字"
                          value={v}
                          aria-label={`替补 ${i + 1}`}
                          onChange={(e) =>
                            setNames((n) => ({
                              ...n,
                              [key]: e.target.value.trim(),
                            }))
                          }
                        />
                      )}
                    </span>
                    {benchFit && (
                      <small className="tac-bench-fit" title={benchFit}>
                        擅长 {benchFit}
                      </small>
                    )}
                  </label>
                );
              })}
            </div>
          </section>

          {/* ① 阵容编排 · 收尾：风险提示与两击确认提交。文案分支按本队/代打两套保留 */}
          <section className="card tac-submit-bar" hidden={zone !== "lineup"}>
            <h2>
              提交阵容 <small>提交信息包含阵容、战术与定位球</small>
            </h2>
            {risks.length > 0 && (
              <p className="tac-warn">名单里有状态异常的球员：{risks.join("、")}</p>
            )}
            {assignConflictList.length > 0 && (
              <p className="tac-warn">
                队长与定位球有 {assignConflictList.length} 处冲突，改掉才能提交。
                <button className="btn btn-sm" onClick={() => selectZone("design")}>
                  去改
                </button>
              </p>
            )}
            {subMsg && <p className={`tac-msg ${subMsg.t}`}>{subMsg.text}</p>}
            <button
              className={`btn ${armSubmit ? "btn-danger" : "tac-btn-primary"}`}
              disabled={curMid == null || subBusy || blockedByProxy}
              onClick={submitLineup}
            >
              {proxyOn
                ? armSubmit
                  ? "确认代打提交?"
                  : mine
                    ? "覆盖代打阵容"
                    : "代打提交"
                : armSubmit
                  ? "确认提交?"
                  : mine
                    ? "覆盖提交"
                    : "提交阵容"}
            </button>
            <p className="tac-hint">
              {curMid == null
                ? "先在上面选一场还没开打的比赛。"
                : "开赛前可以反复覆盖，开赛后锁定，公开的比赛页会亮出双方阵容。"}
            </p>
          </section>

          <section className="card tac-archives" hidden={zone !== "tools"}>
            <h2>
              战术存档 <small>含人员分配 · 同队共享</small>
            </h2>
            {proxyOn && (
              <p className="tac-warn">
                代打模式：存档存进你自己的球队，不会存进「{proxySession?.teamName ?? "目标队"}」；载入时会把阵型、名单和队长与定位球一起带回来。
              </p>
            )}
            {teamPlayers ? (
              <>
                <div className="tac-arch-save">
                  <input
                    className="tac-code-input"
                    value={saveNote}
                    maxLength={24}
                    placeholder="存档名（选填，如：客场防反）"
                    aria-label="存档名"
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setSaveNote(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveArchive();
                    }}
                  />
                  <button
                    className="btn tac-btn-primary"
                    disabled={archBusy}
                    onClick={saveArchive}
                  >
                    存当前
                  </button>
                </div>
                {archives != null && archives.length === 0 && (
                  <p className="tac-hint">还没有存档。调好战术后点「存当前」。</p>
                )}
                {archives != null && archives.length > 0 && (
                  <div className="tac-arch-list">
                    {archives.map((a) => (
                      <div className="tac-arch-card" key={a.id}>
                        <div className="tac-arch-info">
                          <b>{a.note || "未命名存档"}</b>
                          <small>
                            {formTitle(a.form)} · {BU_ZH[a.buildup as Buildup] ?? a.buildup} · 防线{" "}
                            {a.lineHeight} · {date(a.createdAt)}
                          </small>
                        </div>
                        <div className="tac-arch-act">
                          <button className="btn tac-btn-primary" onClick={() => loadArchive(a)}>
                            载入
                          </button>
                          <button
                            className={`btn ${armDel === a.id ? "btn-danger" : ""}`}
                            disabled={archBusy}
                            onClick={() => deleteArchive(a.id)}
                          >
                            {armDel === a.id ? "确认删?" : "删"}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="tac-hint">登录并绑定球队后可存档，与同队教练共享。</p>
            )}
          </section>
          <section className="card tac-import-panel" hidden={zone !== "tools"}>
            <div className="tac-import-row">
              <input
                className="tac-code-input"
                value={codeInput}
                onChange={(e) => setCodeInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") importCode();
                }}
                placeholder="粘贴 12 位战术码"
                aria-label="战术码输入"
                autoComplete="off"
                spellCheck={false}
              />
              <button className="btn" onClick={() => importCode()}>
                解码
              </button>
            </div>
            {msg && <p className={`tac-msg ${msg.t}`}>{msg.text}</p>}
          </section>

          <div className="tac-duo">
            <section className="card tac-settings" hidden={zone !== "design"}>
              <h2>战术设置</h2>
              <div className="tac-ctl-row">
                <select
                  aria-label="阵型"
                  value={state.form}
                  onChange={(e) => {
                    setState((s) => ({ ...s, form: e.target.value }));
                    setSelected(null);
                  }}
                >
                  {FORMS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.disp}
                    </option>
                  ))}
                </select>
                <div className="tac-seg" role="group" aria-label="组织风格">
                  {BUILDUPS.map((k) => (
                    <button
                      key={k}
                      aria-pressed={state.bu === k}
                      onClick={() => setState((s) => ({ ...s, bu: k }))}
                    >
                      {BU_ZH[k]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="tac-lh-row">
                <span className="tac-lh-label">
                  防线 <b>{state.lh}</b>
                </span>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={state.lh}
                  aria-label="防线高度"
                  onChange={(e) =>
                    setState((s) => ({ ...s, lh: Number(e.target.value) }))
                  }
                />
              </div>
              <div className="tac-ticks" aria-hidden="true">
                {["Deep", "Balanced", "High", "Aggressive"].map((t, i) => (
                  <span key={t} className={lhBucket(state.lh) === i ? "on" : ""}>
                    {t}
                  </span>
                ))}
              </div>
              <p className="tac-hint">
                点击球场上的位置，编辑球员角色与重心
                {teamPlayers ? "；球员下拉来自你绑定的球队" : ""}
              </p>

              {/* 队长与定位球（FC26「球队管理 → 指派」18 项）：候选池＝场上 11 名首发。
                  只存已填项，键是角色不是位置，换阵型不影响；没填完不拦提交，互斥冲突拦提交。 */}
              <div className="tac-assign-block">
                <div className="tac-assign-head">
                  <h3>队长与定位球</h3>
                  {assignConflictList.length > 0 ? (
                    <span className="tac-assign-bad">{assignConflictList.length} 处冲突</span>
                  ) : (
                    <span className="tac-assign-ok">
                      已填 {assignFilled.length}/{ASSIGN_KEYS.length}
                    </span>
                  )}
                  <button className="btn btn-sm" onClick={toggleAssignOpen}>
                    {assignOpen ? "收起" : "展开"}
                  </button>
                </div>
                <p className="tac-assign-sum">{assignSummary}</p>
                {assignOpen && (
                  <>
                    {assignPool.length < 11 && (
                      <p className="tac-warn">
                        先把场上 11 个位置选满（现在 {assignPool.length}/11）：队长和定位球只能交给本场首发。
                      </p>
                    )}
                    <div className="tac-assign-grid">
                      {ASSIGN_GROUPS.map((g) => {
                        const filled = g.items.filter((it) => assign[it.key] != null).length;
                        return (
                          <section className="tac-assign-group" key={g.title}>
                            <h3>
                              {g.title}
                              <em
                                className={`tac-assign-count${
                                  filled === g.items.length ? " full" : ""
                                }`}
                              >
                                已指定 {filled}/{g.items.length}
                              </em>
                              <small>{g.note}</small>
                            </h3>
                            <div className="tac-assign-cells">
                              {g.items.map((it) => {
                                const v = assign[it.key] ?? null;
                                const bad = conflictKeys.has(it.key);
                                const sfx = v == null ? "" : optionSuffix(v);
                                // 换首发以后槽里可能留着已不在场上的人：照旧标出来，不静默丢
                                const off = v != null && !assignPool.some((c) => c.id === v);
                                return (
                                  <button
                                    type="button"
                                    key={it.key}
                                    className={`tac-assign-chip${v != null ? " on" : ""}${
                                      bad ? " bad" : ""
                                    }`}
                                    title={`${g.title} · ${it.label}｜${it.hint}`}
                                    onClick={() => openAssignSlot(it.key)}
                                  >
                                    <span className="tac-ac-slot">{it.label}</span>
                                    {v == null ? (
                                      <span className="tac-ac-who none">不指定</span>
                                    ) : (
                                      <>
                                        <span className="tac-ac-who">{chipTag(v)}</span>
                                        {(sfx !== "" || off) && (
                                          <span className="tac-ac-sfx">
                                            {sfx}
                                            {off && <b className="tac-ac-off">已不在首发</b>}
                                          </span>
                                        )}
                                      </>
                                    )}
                                  </button>
                                );
                              })}
                              {g.items.length % 2 === 1 && (
                                <span className="tac-assign-blank" aria-hidden="true" />
                              )}
                            </div>
                          </section>
                        );
                      })}
                    </div>
                    {assignConflictList.length > 0 && (
                      <p className="tac-warn">
                        {assignConflictList.map(conflictText).join("；")}
                        <button className="btn btn-sm" onClick={clearAssignConflicts}>
                          清除冲突项
                        </button>
                      </p>
                    )}
                    <p className="tac-hint">
                      同一个人可以兼好几项：队长兼点球、两侧角球都交给他开，都没问题。只有开角球的人
                      和禁区里抢点的人必须分开。
                    </p>
                  </>
                )}
              </div>
            </section>

            {sel && (
              <section className="card tac-editor">
                <button
                  className="tac-close"
                  aria-label="关闭球员卡"
                  onClick={() => setSelected(null)}
                >
                  ✕
                </button>
                <h2>
                  球员卡 · {sel.position} {POS_ZH[sel.position]}
                </h2>
                <label className="tac-field">
                  <span>
                    球员 <small>{teamPlayers ? "来自球队名单" : "仅本机保存"}</small>
                  </span>
                  {teamPlayers ? (
                    <select
                      value={teamPlayers.some((x) => String(x.id) === names[String(sel.lid)])
                        ? names[String(sel.lid)]
                        : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        setNames((n) => {
                          const next = { ...n };
                          if (v) next[String(sel.lid)] = v;
                          else delete next[String(sel.lid)];
                          return next;
                        });
                      }}
                    >
                      <option value="">（未选）</option>
                      {teamPlayers.map((p) => (
                        <option key={p.id} value={String(p.id)}>
                          {`${p.number ? `#${p.number} ${p.name}` : p.name}${optionSuffix(p.id)}`}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      maxLength={16}
                      placeholder="输入名字"
                      value={names[String(sel.lid)] ?? ""}
                      onChange={(e) =>
                        setNames((n) => ({
                          ...n,
                          [String(sel.lid)]: e.target.value.trim(),
                        }))
                      }
                    />
                  )}
                </label>
                {/* FIT 候选面板（B1 S6）：select 保留不动，其下按适配度排序列出全队。
                    点行与 select 走同一入口（setNames 写该槽）；key 带槽位——换槽/换角色重挂、展开态归零。 */}
                {teamPlayers && (
                  <FitCandidateList
                    key={`${sel.lid}|${sel.role}|${sel.focus}`}
                    players={teamPlayers}
                    slotKey={`${sel.position}|${sel.role}`}
                    role={sel.role}
                    focus={sel.focus}
                    heat={heat}
                    fitOfPid={fitOfPid}
                    groupOfPid={fitGroupPid}
                    currentPid={Number.isInteger(selPid) && selPid > 0 ? selPid : null}
                    elsewhereOf={(pid) =>
                      (starterSlotsByPid.get(pid) ?? [])
                        .filter((s) => s.lid !== sel.lid)
                        .map((s) => s.position)
                    }
                    suffixOf={optionSuffix}
                    onPick={(picked) => {
                      setNames((n) => ({ ...n, [String(sel.lid)]: String(picked) }));
                    }}
                  />
                )}
                <label className="tac-field">
                  <span>角色</span>
                  <select
                    value={sel.role}
                    onChange={(e) => {
                      const role = e.target.value;
                      const hit = PTE26[sel.position].find((x) => x.role === role);
                      if (hit) setPair(sel.lid, sel.position, role, hit.focus);
                    }}
                  >
                    {[...new Set(PTE26[sel.position].map((x) => x.role))].map((r) => (
                      <option key={r} value={r}>
                        {roleZhFull(sel.position, r)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tac-field">
                  <span>重心</span>
                  <select
                    value={sel.focus}
                    onChange={(e) => setPair(sel.lid, sel.position, sel.role, e.target.value)}
                  >
                    {PTE26[sel.position]
                      .filter((x) => x.role === sel.role)
                      .map((x) => (
                        <option key={x.focus} value={x.focus}>
                          {focusZh(x.focus)}
                        </option>
                      ))}
                  </select>
                </label>
                {selRisk && <p className="tac-warn">{selRisk}。</p>}
                {selAssigns.length > 0 && (
                  <div className="tac-editor-assign">
                    <span>本场负责</span>
                    {selAssigns.map((k) => (
                      <button
                        key={k}
                        className={`tac-chip${conflictKeys.has(k) ? " bad" : ""}`}
                        title="不再让他负责这一项"
                        onClick={() => setAssignKey(k, null)}
                      >
                        {ASSIGN_LABEL[k]} ✕
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>

          {/* 阵型对比（B2 S3 / spec §5.4）：29 个阵型按最优分配后的全队总 FIT 排序——选阵型从
              凭记忆变成看排序。当前阵型用教练已调的角色/重心，其余按默认角色（小字注明）；
              行展开看 11 槽分配明细（短板在前）。候选池与一键推荐同源，总分才可比。 */}
          <section className="card tac-compare" hidden={zone !== "design"}>
            <div className="tac-submit-head">
              <h2>
                阵型对比 · 全队总 FIT <small>其他阵型按默认角色计算</small>
              </h2>
              <button
                className="btn"
                aria-expanded={cmpOpen}
                onClick={() => setCmpOpen((v) => !v)}
              >
                {cmpOpen ? "收起" : "展开"}
              </button>
            </div>
            {cmpOpen && (
              <div className="tac-cmp-body">
                {recPool.pids.length === 0 ? (
                  <p className="tac-hint">无法生成对比：队里还没有 FC26 数据。</p>
                ) : (
                  <ul className="tac-cmp-list">
                    {cmpRows.map((row) => {
                      const open = cmpOpenForm === row.form;
                      return (
                        <li key={row.form} className={row.form === state.form ? "cur" : undefined}>
                          <button
                            type="button"
                            className="tac-cmp-row"
                            aria-expanded={open}
                            onClick={() => setCmpOpenForm(open ? null : row.form)}
                          >
                            <b>{formTitle(row.form)}</b>
                            {row.form === state.form && <span className="tac-cmp-cur">当前</span>}
                            <span className="tac-cmp-total">
                              {row.total != null ? row.total : "–"}
                            </span>
                          </button>
                          {open && row.details && (
                            <ul className="tac-cmp-details">
                              {row.details.map((d) => (
                                <li className="tac-cmp-drow" key={d.lid}>
                                  <b>{d.position}</b>
                                  <span>{d.pid != null ? recNameOf(d.pid) : "无推荐"}</span>
                                  <span className="tac-cmp-dfit">FIT {d.shown ?? "–"}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </section>
        </div>
        </div>

      </div>

      <footer className="tac-foot">
        战术码只带阵型和打法，不带球员名，也不带队长与定位球。名字只存在你的浏览器里；阵容和队长与定位球提交后才到服务器。
        FIT 适配度与自动推荐为本站估算,不构成对比赛表现或成绩的任何保证。
      </footer>

      {selected != null && <button className="tac-scrim" aria-label="关闭球员卡" onClick={() => setSelected(null)} />}
      {toast && <div className="tac-toast">{toast}</div>}
      {/* 窄屏开的是底部弹层（桌面深链去编排页）：选完即写草稿，面板上的 chip 跟着刷新 */}
      {narrow && sheetKey && (
        <AssignSheet
          assignKey={sheetKey}
          players={assignCandidates}
          assign={assign}
          suffixOf={optionSuffix}
          onPick={(pid) => {
            setAssignKey(sheetKey, pid);
            setSheetKey(null);
          }}
          onClear={() => {
            setAssignKey(sheetKey, null);
            setSheetKey(null);
          }}
          onClose={() => setSheetKey(null)}
        />
      )}
    </main>
  );
}
