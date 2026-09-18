import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  ASSIGN_GROUPS,
  ASSIGN_KEYS,
  ASSIGN_LABEL,
  BU,
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
  formTitle,
  isAssignKey,
  lhBucket,
  lhName,
  pairEa,
  roleFull,
  type AssignKey,
  type AssignGroup,
  type Buildup,
  type TacticState,
} from "../../shared/tactics";
import type {
  CoachPendingMatchDTO,
  CoachStatusPlayerDTO,
  CoachStatusResp,
  ProxyBoardResp,
  ProxySessionDTO,
  TacticArchiveDTO,
  TeamLineupDTO,
} from "../../shared/types";

const STAGE_ZH: Record<string, string> = { elim: "淘汰赛", round_robin: "循环赛", group: "小组赛" };

// 草稿按身份分开放：本队一份（ftc26-*），每个代打场次各一份（ftc26-proxy-<mid>-*）——
// 否则替别人排完阵容切回本队，会看到对方的名单，指派也叠在自己那份上。
const DRAFT_KEYS = (scope: string) => ({
  state: `${scope}-state-v1`,
  names: `${scope}-names-v1`,
  assign: `${scope}-assign-v1`,
});
const LS_ASSIGN_OPEN = "ftc26-assign-open";
const BENCH = [0, 1, 2, 3, 4, 5, 6, 7, 8];
// 切回刚看过的赛事/比赛先用缓存值立刻画，超过这个时长再后台校正
const CACHE_TTL = 60_000;

// 分层：球场与「选中位置编辑器」常驻，其余卡片按层显示（层记在 URL ?zone=，刷新/分享/后退都对）。
// 无球队绑定的身份看不到本场备案层（与提交卡同源），默认落战术设计。
type Zone = "lineup" | "design" | "tools";
const ZONES: { key: Zone; label: string; note: string }[] = [
  { key: "lineup", label: "本场备案", note: "选比赛 · 排首发 · 提交" },
  { key: "design", label: "战术设计", note: "阵型 · 组织风格 · 防线 · 队长与定位球" },
  { key: "tools", label: "工具与档案", note: "导入战术码 · 存档" },
];
// 卡里的展示顺序：队长只有 1 项，界外球 2 项排它后面填掉那点空白；组名对不上就退回原顺序
const ASSIGN_RENDER_ORDER: AssignGroup[] = (() => {
  const want = ["队长", "界外球", "任意球", "角球进攻", "角球防守"];
  const out = want
    .map((t) => ASSIGN_GROUPS.find((g) => g.title === t))
    .filter((g): g is AssignGroup => g != null);
  return out.length === ASSIGN_GROUPS.length ? out : ASSIGN_GROUPS;
})();
function isZone(v: string | null): v is Zone {
  return v === "lineup" || v === "design" || v === "tools";
}
// 指派白名单过滤：只留认识的项 + 正整数值（与后端 parseAssignJson 同口径，坏数据当没填）
function sanitizeAssign(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAssignKey(k) && Number.isInteger(v) && (v as number) > 0) out[k] = v as number;
  }
  return out;
}

// 磁贴坐标（%）：原战术板照搬；同位多人在 central 组散开，三中卫时 RB/LB 回收到中圈高度
const POS_XY: Record<string, [number, number]> = {
  GK: [50, 6],
  CB: [50, 20],
  RB: [84, 28],
  LB: [16, 28],
  CDM: [50, 38],
  CM: [50, 53],
  RM: [80, 55],
  LM: [20, 55],
  CAM: [50, 70],
  RW: [78, 79],
  LW: [22, 79],
  ST: [50, 88],
};
const SPREAD: Record<number, number[]> = { 2: [-13, 13], 3: [-22, 0, 22], 4: [-24, -8, 8, 24] };
const CENTRAL: Record<string, number | undefined> = { CB: 1, CDM: 1, CM: 1, CAM: 1, ST: 1 };
// 同位多人的左右：阵型槽序按「右→左」枚举（数据里 RB 在 LB 前、RM 在 LM 前、RW 在 LW 前，
// 而游戏把 RW 画在右），所以槽序在前的人画在靠右——取偏移时下标倒着走（见磁贴渲染处）。

function loadLS<T>(k: string, d: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(k) ?? "");
    return v == null ? d : (v as T);
  } catch {
    return d;
  }
}
function saveLS(k: string, v: unknown) {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 本机存不下就算了 */
  }
}

const DEFAULT_STATE: TacticState = { form: "3142", bu: "balanced", lh: 50, roles: {} };
function loadScopeState(scope: string): TacticState {
  const saved = loadLS<TacticState | null>(DRAFT_KEYS(scope).state, null);
  if (!saved || !FORMS.some((f) => f.value === saved.form) || BU[saved.bu as Buildup] === undefined) {
    return { ...DEFAULT_STATE };
  }
  return {
    form: saved.form,
    bu: saved.bu,
    lh: Math.min(100, Math.max(1, Number(saved.lh) || 50)),
    roles: saved.roles && typeof saved.roles === "object" ? saved.roles : {},
  };
}

type TeamPlayer = { id: number; name: string; number: string | null };

// 停赛口径的按赛事缓存（players + 黄牌阈值；伤停跨赛事，跟着整包状态走）
type StatusSlice = { players: CoachStatusPlayerDTO[]; yellowThreshold: number };

// 球员异常状态：停赛/黄牌按所选赛事算，伤停跨赛事（后端 /api/coach/me/status 派生）
type PStat = {
  susp: number; // 剩余停赛场数，> 0 即停赛中
  yellows: number; // 本赛事累计黄牌
  near: boolean; // 再吃一张黄牌就停赛
  inj: { injury: string | null; rest: number; pct: number } | null; // 伤停中：剩余缺阵场 / 恢复进度
};

export default function Tactics() {
  const { user } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [state, setState] = useState<TacticState>(() => loadScopeState("ftc26"));
  const [names, setNames] = useState<Record<string, string>>(() =>
    loadLS(DRAFT_KEYS("ftc26").names, {}),
  );
  // 球员指派：角色码 → 球员 id（只存已填项）。换阵型换人不影响它——键是角色不是位置。
  const [assign, setAssign] = useState<Record<string, number>>(() =>
    sanitizeAssign(loadLS(DRAFT_KEYS("ftc26").assign, null)),
  );
  const [assignOpen, setAssignOpen] = useState<boolean>(() => loadLS(LS_ASSIGN_OPEN, false));
  const [selected, setSelected] = useState<number | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [msg, setMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [armReset, setArmReset] = useState(false);
  const [selfPlayers, setSelfPlayers] = useState<TeamPlayer[] | null>(null);
  const [selfTeamName, setSelfTeamName] = useState<string | null>(null);
  const [subOpen, setSubOpen] = useState(true);
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
  // 登录用户尝试拉本队名单：教练可选本队球员，其余（游客/未绑队）手输名字。
  // 下面几个取数 effect 一律以 user 为门（谁都不等谁），所以名单 / 比赛 / 伤停 / 存档是并行到达的。
  useEffect(() => {
    if (!user) {
      setSelfPlayers(null);
      return;
    }
    let dead = false;
    api<{ team: { name: string; players: TeamPlayer[] } | null }>("/api/coach/me/team")
      .then((b) => {
        if (!dead) {
          setSelfPlayers(b.team?.players ?? null);
          setSelfTeamName(b.team?.name ?? null);
        }
      })
      .catch(() => {
        if (!dead) {
          setSelfPlayers(null);
          setSelfTeamName(null);
        }
      });
    return () => {
      dead = true;
    };
  }, [user]);

  // 存档登录后即可拉（未绑队端点返回空列表）：不再等本队名单那一跳
  useEffect(() => {
    if (!user) {
      setArchives(null);
      return;
    }
    let dead = false;
    api<{ tactics: TacticArchiveDTO[] }>("/api/coach/tactics")
      .then((b) => {
        if (!dead) setArchives(b.tactics ?? []);
      })
      .catch(() => {
        if (!dead) setArchives([]);
      });
    return () => {
      dead = true;
    };
  }, [user]);

  // 待选比赛：登录后即拉，默认选中未开赛的第一场（端点只返 pending 场）
  useEffect(() => {
    if (!user) {
      setSubMatches(null);
      setSubMatchId(null);
      return;
    }
    let dead = false;
    api<{ matches: CoachPendingMatchDTO[] }>("/api/coach/me/matches")
      .then((b) => {
        if (dead) return;
        const list = b.matches ?? [];
        matchesAt.current = Date.now();
        setSubMatches(list);
        setSubMatchId((cur) => (cur != null && list.some((m) => m.id === cur) ? cur : list[0]?.id ?? null));
      })
      .catch(() => {
        if (!dead) setSubMatches([]);
      });
    return () => {
      dead = true;
    };
  }, [user]);

  // 所选比赛的我方已提交阵容：自动选中与手动切换共用。
  // 命中缓存先画出来，避免切轮次时「已提交」提示与按钮文案闪回。
  useEffect(() => {
    if (subMatchId == null) {
      setSelfMine(null);
      return;
    }
    const hit = mineCache.current.get(subMatchId);
    setSelfMine(hit ? hit.v : null);
    if (hit && Date.now() - hit.at < CACHE_TTL) return;
    let dead = false;
    api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${subMatchId}/lineup`)
      .then((b) => {
        if (dead) return;
        mineCache.current.set(subMatchId, { v: b.lineup, at: Date.now() });
        setSelfMine(b.lineup);
      })
      .catch(() => {
        if (!dead && !hit) setSelfMine(null);
      });
    return () => {
      dead = true;
    };
  }, [subMatchId, user]);

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
      return;
    }
    // 代打模式下停赛口径来自代打板（目标队所在赛事），这条本队口径的请求让位
    if (proxyOn) return;
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
        setSelfStatus(b);
      })
      .catch(() => {
        if (!dead) setSelfStatus(null);
      })
      .finally(() => {
        if (!dead) setSelfStatusBusy(false);
      });
    return () => {
      dead = true;
    };
  }, [user, pickedTid, proxyOn]);

  // 代打授权清单：登录后即拉（没授权返空数组）；有授权才出现身份切换器
  useEffect(() => {
    if (!user) {
      setProxySessions(null);
      setProxyOn(false);
      setProxyMid(null);
      return;
    }
    let dead = false;
    api<{ sessions: ProxySessionDTO[] }>("/api/coach/proxy/sessions")
      .then((b) => {
        if (dead) return;
        const list = b.sessions ?? [];
        setProxySessions(list);
        setProxyMid((cur) => (cur != null && list.some((s) => s.matchId === cur) ? cur : list[0]?.matchId ?? null));
        // 授权被撤销/比赛开打后清单会空掉，这时自动切回本队身份
        if (list.length === 0) setProxyOn(false);
      })
      .catch(() => {
        if (!dead) setProxySessions([]);
      });
    return () => {
      dead = true;
    };
  }, [user]);

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
  // 分层：① 本场备案只对绑了球队（或有代打授权）的身份存在，其余身份默认落 ② 战术设计。
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

  // 指派候选池＝本场场上 11 名首发（FC26 口径：指派只能从场上球员里选），按人去重；
  // 一人占两个位置时位置串起来显示（#7 LB/LCB 张三）。没摆满 11 个位置就留空并提示。
  const assignPool = useMemo(() => {
    const out: { id: number; pos: string }[] = [];
    const at = new Map<number, number>();
    for (const p of form.pos) {
      const v = Number(names[String(p.lid)]);
      if (!Number.isInteger(v) || v <= 0) continue;
      const hit = at.get(v);
      if (hit != null) out[hit] = { ...out[hit], pos: `${out[hit].pos}/${p.position}` };
      else {
        at.set(v, out.length);
        out.push({ id: v, pos: p.position });
      }
    }
    return out;
  }, [form, names]);
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
  // 停赛用 🟥（与全站红牌图标、赛前情报一致），伤停用 🩹
  function optionSuffix(pid: number): string {
    const st = statOfPid(pid);
    if (!st) return "";
    const injSuffix = st.inj ? `（🩹伤停 剩${st.inj.rest}场）` : "";
    if (st.susp > 0) return `（🟥停赛 剩${st.susp}场）${injSuffix}`;
    if (st.near) return `（⚠️再${suspThreshold - st.yellows}黄停赛）${injSuffix}`;
    return injSuffix;
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
  // 候选文案：#号 → 位置 → 姓名 → 状态后缀，与球员卡/替补席下拉同一套后缀
  function poolLabel(c: { id: number; pos: string }): string {
    const p = teamPlayers?.find((x) => x.id === c.id);
    const num = p?.number ? `#${p.number} ` : "";
    return `${num}${c.pos} ${p?.name ?? "已不在名单"}${optionSuffix(c.id)}`;
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
        setSubMatches(b.matches);
      })
      .catch(() => setSubMatches([]));
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

  // 磁贴坐标：同位多人散开 + 三中卫回收
  const counts: Record<string, number> = {};
  form.pos.forEach((p) => {
    counts[p.position] = (counts[p.position] || 0) + 1;
  });
  const seen: Record<string, number> = {};
  const cbN = counts.CB || 0;

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
        <section className="card tac-pitch-panel">
          <div className="tac-pitch">
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
            {form.pos.map((p, i) => {
              const xy = [...POS_XY[p.position]];
              if (CENTRAL[p.position] && counts[p.position] > 1) {
                const n = counts[p.position];
                xy[0] += SPREAD[n][n - 1 - (seen[p.position] || 0)];
              }
              if (cbN >= 3) {
                if (p.position === "RB" || p.position === "LB") xy[1] = 38;
                if (p.position === "CB") xy[1] = 24;
              }
              seen[p.position] = (seen[p.position] || 0) + 1;
              const pl = players[i];
              const nm = displayName(names[String(p.lid)]);
              const pid = Number(names[String(p.lid)]);
              const st = statOf(names[String(p.lid)]);
              const dup = Number.isInteger(pid) && pid > 0 && dupPids.has(pid);
              const isCap = capPid != null && Number.isInteger(pid) && pid === capPid;
              const mark = st && st.susp > 0 ? (st.inj ? " both" : " susp") : st && st.inj ? " inj" : "";
              const tip = statTip(st);
              return (
                <button
                  key={p.lid}
                  className={`tac-tile${selected === p.lid ? " sel" : ""}${mark}${dup ? " dup" : ""}`}
                  style={{ left: `${xy[0]}%`, top: `${100 - xy[1]}%` }}
                  title={`${nm ? nm + " · " : ""}${roleFull(pl.role)} ${pl.focus}${tip ? ` · ${tip}` : ""}${dup ? " · 这名球员在本场占了多个位置" : ""}`}
                  aria-label={`${p.position} ${POS_ZH[p.position]} ${nm || "未命名"}，角色 ${roleFull(pl.role)} ${pl.focus}${tip ? `，${tip}` : ""}${dup ? "，位置重复" : ""}`}
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
                  <b>{p.position}</b>
                  {nm ? <small>{nm}</small> : null}
                </button>
              );
            })}
          </div>
        </section>

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
          {canLineup && (
            <span className={`tac-zone-mode${proxyOn ? " proxy" : ""}`} aria-live="polite">
              {proxyOn && proxySession ? `代打：${proxySession.teamName}` : "本队备案"}
            </span>
          )}
        </nav>

        {/* 选择目标比赛：默认选中未开赛的第一场，伤停/停赛跟着它走。
            手里有代打授权时上面多一个身份切换器，切过去后整页（名单/口径/提交）都换成目标队。 */}
        {(selfPlayers != null || (proxySessions?.length ?? 0) > 0) && (
          <section className="card tac-submit" hidden={zone !== "lineup"}>
            <div className="tac-submit-head">
              <h2>
                选择目标比赛{" "}
                <small>{proxyOn ? "代打模式 · 替别人交本场阵容" : "赛前备案 · 开赛后公开"}</small>
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
                        该场已于 {mine.submittedAt.slice(0, 16).replace("T", " ")} 提交（
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
                return (
                  <label className="tac-bench-slot" key={key}>
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
                  </label>
                );
              })}
            </div>
          </section>

          {/* ① 本场备案 · 收尾：风险提示与两击确认提交。文案分支按本队/代打两套保留 */}
          <section className="card tac-submit-bar" hidden={zone !== "lineup"}>
            <h2>
              提交阵容{" "}
              <small>
                {proxyOn
                  ? `代打 · ${proxySession?.teamName ?? "目标队"}`
                  : "整份替换上一份，阵容与队长定位球一起交"}
              </small>
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
                            {a.lineHeight} · {a.createdAt.slice(0, 10)}
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
          <section className="card tac-code-panel" hidden={zone !== "design"}>
            <div className="tac-code-row">
              <div className="tac-codebox">
                <code>{code}</code>
              </div>
              <button className="btn tac-btn-primary" onClick={copyCode}>
                复制
              </button>
            </div>
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
                  <h3>
                    队长与定位球 <small>FC26 球队管理 · 指派</small>
                  </h3>
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
                      {ASSIGN_RENDER_ORDER.map((g) => (
                        <section className="tac-assign-group" key={g.title}>
                          <h3>
                            {g.title} <small>{g.note}</small>
                          </h3>
                          {g.items.map((it) => {
                            const v = assign[it.key];
                            const bad = conflictKeys.has(it.key);
                            return (
                              <label
                                className={`tac-assign-field${bad ? " bad" : ""}`}
                                key={it.key}
                                title={it.hint}
                              >
                                <span>{it.label}</span>
                                <select
                                  aria-label={`${g.title} · ${it.label}`}
                                  value={v ?? ""}
                                  onChange={(e) =>
                                    setAssignKey(
                                      it.key,
                                      e.target.value ? Number(e.target.value) : null,
                                    )
                                  }
                                >
                                  <option value="">（不指定）</option>
                                  {v != null && !assignPool.some((c) => c.id === v) && (
                                    <option value={v}>{playerTag(v)}（已不在首发）</option>
                                  )}
                                  {assignPool.map((c) => (
                                    <option key={c.id} value={c.id}>
                                      {poolLabel(c)}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            );
                          })}
                        </section>
                      ))}
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
                        {roleFull(r)}
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
                          {x.focus}
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
        </div>

      </div>

      <footer className="tac-foot">
        战术码只带阵型和打法，不带球员名，也不带队长与定位球。名字只存在你的浏览器里；阵容和队长与定位球提交后才到服务器。
      </footer>

      {selected != null && <button className="tac-scrim" aria-label="关闭球员卡" onClick={() => setSelected(null)} />}
      {toast && <div className="tac-toast">{toast}</div>}
    </main>
  );
}
