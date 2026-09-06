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
  TeamLineupDTO,
} from "../../shared/types";

const STAGE_ZH: Record<string, string> = { elim: "淘汰赛", round_robin: "循环赛", group: "小组赛" };

const LS_STATE = "ftc26-state-v1";
const LS_NAMES = "ftc26-names-v1";
const BENCH = [0, 1, 2, 3, 4, 5, 6, 7, 8];

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
  const [subOpen, setSubOpen] = useState(false);
  const [subMatches, setSubMatches] = useState<CoachPendingMatchDTO[] | null>(null);
  const [subMatchId, setSubMatchId] = useState<number | null>(null);
  const [mine, setMine] = useState<TeamLineupDTO | null>(null);
  const [subBusy, setSubBusy] = useState(false);
  const [subMsg, setSubMsg] = useState<{ t: "ok" | "err"; text: string } | null>(null);
  const [armSubmit, setArmSubmit] = useState(false);
  const toastTimer = useRef<number | null>(null);
  const armTimer = useRef<number | null>(null);
  const subArmTimer = useRef<number | null>(null);

  useEffect(() => saveLS(LS_STATE, state), [state]);
  useEffect(() => saveLS(LS_NAMES, names), [names]);

  // 登录用户尝试拉本队名单：教练可选本队球员，其余（游客/未绑队）手输名字
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

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      if (armTimer.current !== null) window.clearTimeout(armTimer.current);
      if (subArmTimer.current !== null) window.clearTimeout(subArmTimer.current);
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

  function setPair(lid: number, pos: string, role: string, focus: string) {
    if (pairEa(pos, role, focus) == null) return;
    setState((s) => ({ ...s, roles: { ...s.roles, [lid]: [role, focus] } }));
  }

  function displayName(v: string | undefined): string {
    if (!v) return "";
    const p = teamPlayers?.find((x) => String(x.id) === v);
    return p ? p.name : v;
  }

  function importCode() {
    const raw = codeInput.trim().replace(/\s+/g, "");
    if (!raw.length) return;
    if (raw.length !== 11 && raw.length !== 12) {
      setMsg({ t: "err", text: `长度不对：战术码是 11 或 12 个字符，你现在输入了 ${raw.length} 个。` });
      return;
    }
    let t;
    try {
      t = raw.length === 12 ? decodeFut26(raw) : decodeFut25(raw);
    } catch (e) {
      setMsg({ t: "err", text: errText(e as TacticError) });
      return;
    }
    const roles: Record<number, [string, string]> = {};
    for (const s of t.slots) roles[s.lid] = [s.role, s.focus];
    setState({ form: t.form, bu: t.bu, lh: t.lh, roles });
    setSelected(null);
    setMsg({
      t: "ok",
      text: `已导入：${formTitle(t.form)}，防线 ${lhName(t.lh)}，${BU_ZH[t.bu]}`,
    });
    showToast("战术码已导入");
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
      .then((b) => setSubMatches(b.matches))
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
      refetchSubMatches();
    }
  }

  function pickSubMatch(v: string) {
    const id = v ? Number(v) : null;
    setSubMatchId(id);
    setMine(null);
    setSubMsg(null);
    disarmSubmit();
    if (id != null) {
      api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${id}/lineup`)
        .then((b) => setMine(b.lineup))
        .catch(() => setMine(null));
    }
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
    api(`/api/coach/matches/${mid}/lineup`, { method: "PUT", body: { form: state.form, slots } })
      .then(() => {
        setSubMsg({ t: "ok", text: "已提交，开赛前随时可回来覆盖" });
        showToast("阵容已提交");
        refetchSubMatches();
        api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${mid}/lineup`)
          .then((b) => setMine(b.lineup))
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
                xy[0] += SPREAD[counts[p.position]][seen[p.position] || 0];
              }
              if (cbN >= 3) {
                if (p.position === "RB" || p.position === "LB") xy[1] = 38;
                if (p.position === "CB") xy[1] = 24;
              }
              seen[p.position] = (seen[p.position] || 0) + 1;
              const pl = players[i];
              const nm = displayName(names[String(p.lid)]);
              return (
                <button
                  key={p.lid}
                  className={`tac-tile${selected === p.lid ? " sel" : ""}`}
                  style={{ left: `${xy[0]}%`, top: `${100 - xy[1]}%` }}
                  title={`${nm ? nm + " · " : ""}${roleFull(pl.role)} ${pl.focus}`}
                  aria-label={`${p.position} ${POS_ZH[p.position]} ${nm || "未命名"}，角色 ${roleFull(pl.role)} ${pl.focus}`}
                  onClick={() => setSelected(selected === p.lid ? null : p.lid)}
                >
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
              <button className="btn" onClick={importCode}>
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
                          {p.number ? `#${p.number} ${p.name}` : p.name}
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
              </section>
            )}
          </div>

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
                            {p.number ? `#${p.number} ${p.name}` : p.name}
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

          {teamPlayers && (
            <section className="card tac-submit">
              <div className="tac-submit-head">
                <h2>
                  提交阵容 <small>赛前备案 · 开赛后公开</small>
                </h2>
                <button className="btn" onClick={toggleSubmit}>
                  {subOpen ? "收起" : "展开"}
                </button>
              </div>
              {subOpen && (
                <div className="tac-submit-body">
                  <select
                    aria-label="选择比赛"
                    value={subMatchId ?? ""}
                    onChange={(e) => pickSubMatch(e.target.value)}
                  >
                    <option value="">选择比赛…</option>
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
                  {subMsg && <p className={`tac-msg ${subMsg.t}`}>{subMsg.text}</p>}
                  <button
                    className={`btn ${armSubmit ? "btn-danger" : "tac-btn-primary"}`}
                    disabled={subMatchId == null || subBusy}
                    onClick={submitLineup}
                  >
                    {armSubmit ? "确认提交?" : mine ? "覆盖提交" : "提交阵容"}
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      <footer className="tac-foot">
        代码不��球员名，名字只�在你的浏览器里。
      </footer>

      {selected != null && <button className="tac-scrim" aria-label="关闭球员卡" onClick={() => setSelected(null)} />}
      {toast && <div className="tac-toast">{toast}</div>}
    </main>
  );
}
