import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  BU,
  BU_ZH,
  BUILDUPS,
  FORMS,
  PTE26,
  POS_ZH,
  TacticError,
  decodeFut25,
  decodeFut26,
  defaultPair,
  encodeFut26,
  errText,
  formTitle,
  lhBucket,
  lhName,
  pairEa,
  roleFull,
  type Buildup,
  type TacticState,
} from "../../shared/tactics";
import type {
  CoachPendingMatchDTO,
  CoachStatusPlayerDTO,
  CoachStatusResp,
  TacticArchiveDTO,
  TeamLineupDTO,
} from "../../shared/types";

const STAGE_ZH: Record<string, string> = { elim: "淘汰赛", round_robin: "循环赛", group: "小组赛" };

const LS_STATE = "ftc26-state-v1";
const LS_NAMES = "ftc26-names-v1";
const BENCH = [0, 1, 2, 3, 4, 5, 6, 7, 8];
// 切回刚看过的赛事/比赛先用缓存值立刻画，超过这个时长再后台校正
const CACHE_TTL = 60_000;

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
function loadState(): TacticState {
  const saved = loadLS<TacticState | null>(LS_STATE, null);
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
  const [state, setState] = useState<TacticState>(loadState);
  const [names, setNames] = useState<Record<string, string>>(() => loadLS(LS_NAMES, {}));
  const [selected, setSelected] = useState<number | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [msg, setMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [armReset, setArmReset] = useState(false);
  const [teamPlayers, setTeamPlayers] = useState<TeamPlayer[] | null>(null);
  const [subOpen, setSubOpen] = useState(true);
  const [subMatches, setSubMatches] = useState<CoachPendingMatchDTO[] | null>(null);
  const [subMatchId, setSubMatchId] = useState<number | null>(null);
  const [mine, setMine] = useState<TeamLineupDTO | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [armSubmit, setArmSubmit] = useState(false);
  const [archives, setArchives] = useState<TacticArchiveDTO[] | null>(null);
  const [saveNote, setSaveNote] = useState("");
  const [archBusy, setArchBusy] = useState(false);
  const [armDel, setArmDel] = useState<number | null>(null);
  const [status, setStatus] = useState<CoachStatusResp | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
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

  useEffect(() => saveLS(LS_STATE, state), [state]);
  useEffect(() => saveLS(LS_NAMES, names), [names]);

  // 登录用户尝试拉本队名单：教练可选本队球员，其余（游客/未绑队）手输名字。
  // 下面几个取数 effect 一律以 user 为门（谁都不等谁），所以名单 / 比赛 / 伤停 / 存档是并行到达的。
  useEffect(() => {
    if (!user) {
      setTeamPlayers(null);
      return;
    }
    let dead = false;
    api<{ team: { players: TeamPlayer[] } | null }>("/api/coach/me/team")
      .then((b) => {
        if (!dead) setTeamPlayers(b.team?.players ?? null);
      })
      .catch(() => {
        if (!dead) setTeamPlayers(null);
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
      setMine(null);
      return;
    }
    const hit = mineCache.current.get(subMatchId);
    setMine(hit ? hit.v : null);
    if (hit && Date.now() - hit.at < CACHE_TTL) return;
    let dead = false;
    api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${subMatchId}/lineup`)
      .then((b) => {
        if (dead) return;
        mineCache.current.set(subMatchId, { v: b.lineup, at: Date.now() });
        setMine(b.lineup);
      })
      .catch(() => {
        if (!dead && !hit) setMine(null);
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
      setStatus(null);
      setStatusBusy(false);
      statusTidRef.current = null;
      statusReq.current = undefined;
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
      setStatus((prev) =>
        prev
          ? { ...prev, tournamentId: want, players: hit.players, yellowThreshold: hit.yellowThreshold }
          : prev,
      );
    } else if (want != null) {
      // 没缓存：先清掉上一赛事的停赛清单，别顶着新赛事名显示旧数据
      setStatus((prev) => (prev ? { ...prev, tournamentId: want, players: [] } : prev));
    }
    statusReq.current = want;
    let dead = false;
    setStatusBusy(true);
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
        setStatus(b);
      })
      .catch(() => {
        if (!dead) setStatus(null);
      })
      .finally(() => {
        if (!dead) setStatusBusy(false);
      });
    return () => {
      dead = true;
    };
  }, [user, pickedTid]);

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
      localStorage.removeItem(LS_STATE);
      localStorage.removeItem(LS_NAMES);
    } catch {
      /* 忽略 */
    }
    if (armTimer.current !== null) window.clearTimeout(armTimer.current);
    setArmReset(false);
    setState({ ...DEFAULT_STATE, roles: {} });
    setNames({});
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

  // 提交前的前端预检：首发 11 人齐、无重复（后端还会再校验一遍）
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
    return null;
  }

  function submitLineup() {
    if (subMatchId == null || subBusy) return;
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
    const mid = subMatchId;
    api(`/api/coach/matches/${mid}/lineup`, {
      method: "PUT",
      body: { form: state.form, slots, code: code === "------------" ? "" : code },
    })
      .then(() => {
        setSubMsg({ t: "ok", text: "已提交，开赛前随时可回来覆盖" });
        showToast("阵容已提交");
        refetchSubMatches();
        api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${mid}/lineup`)
          .then((b) => {
            mineCache.current.set(mid, { v: b.lineup, at: Date.now() });
            setMine(b.lineup);
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
  const risks = lineupRisks();
  // 状态清单卡：停赛（按所选比赛的赛事）/ 黄牌临界 / 伤停。
  // 标题跟着所选比赛走（切赛事立刻变名），清单先给缓存值，新值到达前标「更新中」。
  const statusTName =
    (status?.tournaments ?? []).find(
      (t) => t.tournamentId === (pickedTid ?? status?.tournamentId),
    )?.name ?? "";
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
      out: subMatchId != null && i.misses.some((x) => x.matchId === subMatchId),
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

      {/* 选择目标比赛：默认选中未开赛的第一场，伤停/停赛口径跟着它走 */}
      {teamPlayers && (
        <section className="card tac-submit">
          <div className="tac-submit-head">
            <h2>
              选择目标比赛 <small>赛前备案 · 开赛后公开</small>
            </h2>
            <button className="btn" onClick={toggleSubmit}>
              {subOpen ? "收起" : "展开"}
            </button>
          </div>
          {subOpen && (
            <div className="tac-submit-body">
              <div className="tac-submit-cols">
                <div className="tac-submit-main">
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
                      </option>
                    ))}
                  </select>
                  {subMatches != null && subMatches.length === 0 && (
                    <p className="tac-hint">你的球队当前没有待开的比赛。</p>
                  )}
                  {mine && (
                    <p className="tac-hint">
                      该场已于 {mine.submittedAt.slice(0, 16).replace("T", " ")} 提交（
                      {formTitle(mine.form)}），再次提交将覆盖。
                    </p>
                  )}
                  {risks.length > 0 && (
                    <p className="tac-warn">名单里有状态异常的球员：{risks.join("、")}</p>
                  )}
                  {subMsg && <p className={`tac-msg ${subMsg.t}`}>{subMsg.text}</p>}
                  <button
                    className={`btn ${armSubmit ? "btn-danger" : "tac-btn-primary"}`}
                    disabled={subMatchId == null || subBusy}
                    onClick={submitLineup}
                  >
                    {armSubmit ? "确认提交?" : mine ? "覆盖提交" : "提交阵容"}
                  </button>
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
            </div>
          )}
        </section>
      )}

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
              const st = statOf(names[String(p.lid)]);
              const mark = st && st.susp > 0 ? (st.inj ? " both" : " susp") : st && st.inj ? " inj" : "";
              const tip = statTip(st);
              return (
                <button
                  key={p.lid}
                  className={`tac-tile${selected === p.lid ? " sel" : ""}${mark}`}
                  style={{ left: `${xy[0]}%`, top: `${100 - xy[1]}%` }}
                  title={`${nm ? nm + " · " : ""}${roleFull(pl.role)} ${pl.focus}${tip ? ` · ${tip}` : ""}`}
                  aria-label={`${p.position} ${POS_ZH[p.position]} ${nm || "未命名"}，角色 ${roleFull(pl.role)} ${pl.focus}${tip ? `，${tip}` : ""}`}
                  onClick={() => setSelected(selected === p.lid ? null : p.lid)}
                >
                  {st && (st.susp > 0 || st.inj) ? (
                    <span className="tac-marks" aria-hidden="true">
                      {st.susp > 0 ? <i className="tac-mk-card" /> : null}
                      {st.inj ? <i className="tac-mk-cross" /> : null}
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

          <section className="card tac-import-panel">
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
            <section className="card tac-settings">
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
              </section>
            )}
          </div>
        </div>

        <section className="card tac-archives">
          <h2>
            战术存档 <small>含人员分配 · 同队共享</small>
          </h2>
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

        <section className="card tac-bench">
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
      </div>

      <footer className="tac-foot">
        代码不包含球员名，名字只存在你的浏览器里。
      </footer>

      {selected != null && <button className="tac-scrim" aria-label="关闭球员卡" onClick={() => setSelected(null)} />}
      {toast && <div className="tac-toast">{toast}</div>}
    </main>
  );
}
