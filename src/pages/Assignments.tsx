// 定位球编排页：/tactics/assignments?scope=&group=&key=&mid=
// 跟战术页是一对——战术页组卡里的槽位 chip 在桌面深链进这里，一次编一整组（角球进攻 7 项之类），
// 半场板上点钉子切当前槽、右侧常驻候选栏挑人；窄屏不画板子，落到分组槽位列表 + 候选列表。
// 草稿读写同一份 localStorage（lib/assignDraft，按 scope 隔离），所以两页的已填内容来回切都是一份；
// 提交仍然在战术页（这里只改草稿）。
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  ASSIGN_GROUPS,
  ASSIGN_GROUP_OF,
  FORMS,
  assignConflicts,
  conflictText,
  isAssignKey,
  type AssignKey,
} from "../../shared/tactics";
import { nameFontSize, surname } from "../lib/pitch";
import {
  DRAFT_KEYS,
  assignCandidatesOf,
  assignPoolOf,
  loadLS,
  loadScopeState,
  parseScopeParam,
  sanitizeAssign,
  saveLS,
  type RosterPlayer,
} from "../lib/assignDraft";
import { ASSIGN_NAILS, boardSideOf } from "../lib/assignBoard";
import { statusSuffix } from "../lib/assignCandidates";
import { useNarrow } from "../lib/useNarrow";
import { AssignCandidateList, type AssignCandidateItem } from "../components/AssignCandidate";
import type {
  CoachPendingMatchDTO,
  CoachStatusPlayerDTO,
  CoachStatusResp,
  PlayerMeta,
  ProxyBoardResp,
  TeamLineupDTO,
} from "../../shared/types";

// 名册条目（与战术页同一个形状：默认队走 /bootstrap，代打走 board.players）
type TeamPlayer = RosterPlayer;

// 教练首屏聚合端点（与战术页同一支；这里只要球队名册与待选比赛）
type CoachBootstrap = { team: { name: string; players: TeamPlayer[] } | null; matches: CoachPendingMatchDTO[] };

// 球员异常状态：停赛/黄牌按赛事算，伤停跟着整包状态走（口径与战术页一致）
type PStat = { susp: number; yellows: number; near: boolean; inj: { rest: number } | null };

export default function Assignments() {
  const { user } = useAuth();
  const [sp] = useSearchParams();
  const narrow = useNarrow();

  // scope 与战术页同构：本队 ftc26、代打 ftc26-proxy-<mid>；非法值退回本队
  const { scope, proxyMid } = useMemo(() => parseScopeParam(sp.get("scope")), [sp]);
  const midParam = Number(sp.get("mid"));
  const wantMid = Number.isInteger(midParam) && midParam > 0 ? midParam : null;

  // 草稿三件套：阵型（决定哪 11 个位置）、首发名单、指派。前两样只读，指派读写。
  const state = useMemo(() => loadScopeState(scope), [scope]);
  const names = useMemo(() => loadLS<Record<string, string>>(DRAFT_KEYS(scope).names, {}), [scope]);
  const [curScope, setCurScope] = useState(scope);
  const [assign, setAssign] = useState<Record<string, number>>(() =>
    sanitizeAssign(loadLS(DRAFT_KEYS(scope).assign, null)),
  );
  // 走到另一个 scope 的深链（同一路由组件不会重挂）时整包换草稿
  useEffect(() => {
    setAssign(sanitizeAssign(loadLS(DRAFT_KEYS(scope).assign, null)));
    setCurScope(scope);
  }, [scope]);
  // 改一下就落盘：战术页读的是同一个键，返回时看到的就是这里编好的
  useEffect(() => {
    if (curScope === scope) saveLS(DRAFT_KEYS(scope).assign, assign);
  }, [assign, curScope, scope]);

  const [roster, setRoster] = useState<TeamPlayer[] | null>(null);
  const [subMatches, setSubMatches] = useState<CoachPendingMatchDTO[]>([]);
  const [mid, setMid] = useState<number | null>(null);
  const [selfStatus, setSelfStatus] = useState<CoachStatusResp | null>(null);
  const [selfMine, setSelfMine] = useState<TeamLineupDTO | null>(null);
  const [board, setBoard] = useState<ProxyBoardResp | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // 本队身份：本队名册 + 待选比赛（默认落待选第一场，与战术页的默认选中同口径）
  useEffect(() => {
    if (!user || proxyMid != null) return;
    let dead = false;
    api<CoachBootstrap>("/api/coach/bootstrap")
      .then((b) => {
        if (dead) return;
        setLoadErr(null);
        setRoster(b.team?.players ?? null);
        const list = b.matches ?? [];
        setSubMatches(list);
        setMid((cur) => {
          if (wantMid != null && list.some((m) => m.id === wantMid)) return wantMid;
          if (cur != null && list.some((m) => m.id === cur)) return cur;
          return list[0]?.id ?? null;
        });
      })
      .catch((e: unknown) => {
        if (dead) return;
        setLoadErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      dead = true;
    };
  }, [user, proxyMid, wantMid]);

  const pickedTid = proxyMid != null ? null : subMatches.find((m) => m.id === mid)?.tournamentId ?? null;

  // 本场已交阵容：FC26 数据（属性 / 徽章 / 身高）只随阵容 DTO 下发，这里是唯一来源
  useEffect(() => {
    if (!user || proxyMid != null || mid == null) {
      setSelfMine(null);
      return;
    }
    let dead = false;
    api<{ lineup: TeamLineupDTO | null }>(`/api/coach/matches/${mid}/lineup`)
      .then((b) => {
        if (!dead) setSelfMine(b.lineup);
      })
      .catch(() => {
        if (!dead) setSelfMine(null);
      });
    return () => {
      dead = true;
    };
  }, [user, proxyMid, mid]);

  // 停赛/伤停：本队口径跟着所选比赛所在赛事；代打那份由代打板整包给
  useEffect(() => {
    if (!user || proxyMid != null) {
      setSelfStatus(null);
      return;
    }
    let dead = false;
    api<CoachStatusResp>(
      `/api/coach/me/status${pickedTid != null ? `?tournamentId=${pickedTid}` : ""}`,
    )
      .then((b) => {
        if (!dead) setSelfStatus(b);
      })
      .catch(() => {
        if (!dead) setSelfStatus(null);
      });
    return () => {
      dead = true;
    };
  }, [user, proxyMid, pickedTid]);

  // 代打身份：目标队名册 + 伤停停赛 + 该场已交阵容，一次整包取回
  useEffect(() => {
    if (!user || proxyMid == null) return;
    let dead = false;
    api<ProxyBoardResp>(`/api/coach/proxy/${proxyMid}/board`)
      .then((b) => {
        if (!dead) setBoard(b);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setBoard(null);
        setLoadErr(e instanceof Error ? e.message : "代打数据读取失败");
      });
    return () => {
      dead = true;
    };
  }, [user, proxyMid]);

  const teamPlayers = proxyMid != null ? board?.players ?? null : roster;
  const status = proxyMid != null ? board?.status ?? null : selfStatus;
  const mine = proxyMid != null ? board?.lineup ?? null : selfMine;

  const form = FORMS.find((f) => f.value === state.form) ?? FORMS[0];
  const assignPool = useMemo(() => assignPoolOf(form.pos, names), [form, names]);
  // 已提交阵容 DTO 里的 meta（优先级高于名册自带的那份，见 assignCandidatesOf）
  const metaOfPid = useMemo(() => {
    const m = new Map<number, PlayerMeta>();
    if (!mine) return m;
    for (const p of [...mine.starters, ...mine.bench]) if (p.meta) m.set(p.playerId, p.meta);
    for (const a of mine.assign ?? []) if (a.meta) m.set(a.playerId, a.meta);
    return m;
  }, [mine]);
  const candidates = useMemo<AssignCandidateItem[]>(
    () => assignCandidatesOf(assignPool, teamPlayers, metaOfPid),
    [assignPool, teamPlayers, metaOfPid],
  );

  // —— 伤停 / 停赛后缀（与战术页、手机弹层共用 statusSuffix） ——
  const suspThreshold = status?.yellowThreshold ?? 0;
  const suspMap = useMemo(() => {
    const m = new Map<number, CoachStatusPlayerDTO>();
    for (const p of status?.players ?? []) m.set(p.playerId, p);
    return m;
  }, [status]);
  const injMap = useMemo(() => {
    const m = new Map<number, { rest: number }>();
    for (const i of status?.injuries ?? []) {
      const rest = i.misses.filter((x) => x.status !== "finished").length;
      if (rest > 0) m.set(i.playerId, { rest });
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
  function optionSuffix(pid: number): string {
    return statusSuffix(statOfPid(pid), suspThreshold);
  }

  // —— 页签与当前槽位：深链里的 group/key 决定开局停在哪 ——
  const groupFromUrl = ASSIGN_GROUPS.find((g) => g.title === sp.get("group")) ?? null;
  const keyFromUrl = sp.get("key");
  const [tab, setTab] = useState<string>(() => (groupFromUrl ?? ASSIGN_GROUPS[0]).title);
  const [cur, setCur] = useState<AssignKey>(() => {
    const g = groupFromUrl ?? ASSIGN_GROUPS[0];
    return keyFromUrl && isAssignKey(keyFromUrl) && ASSIGN_GROUP_OF[keyFromUrl] === g.title
      ? keyFromUrl
      : g.items[0].key;
  });
  // 地址栏变了（从战术页再点一个槽位回来）就跟着挪，别停在上一槽。
  // 组归属以 key 为准：手改地址栏把 group 与 key 写成两组时，页签跟着 key 走，
  // 否则页签与右栏会出现「看的是角球进攻、改的是任意球」这种不对版。
  useEffect(() => {
    if (keyFromUrl && isAssignKey(keyFromUrl)) {
      setTab(ASSIGN_GROUP_OF[keyFromUrl]);
      setCur(keyFromUrl);
    } else if (groupFromUrl) {
      setTab(groupFromUrl.title);
    }
  }, [groupFromUrl, keyFromUrl]);

  const group = ASSIGN_GROUPS.find((g) => g.title === tab) ?? ASSIGN_GROUPS[0];
  const item = group.items.find((it) => it.key === cur) ?? group.items[0];
  const curKey = item.key;
  const side = boardSideOf(group.title);
  const curVal = assign[curKey] ?? null;
  // 候选行悬停 → 板上同一个人的钉子跟着亮（双向高亮的另一半在候选行的 ✓ 当前）
  const [hot, setHot] = useState<number | null>(null);

  const conflictList = useMemo(() => assignConflicts(assign), [assign]);
  const conflictKeys = useMemo(
    () => new Set(conflictList.flatMap((c) => [c.a, c.b])),
    [conflictList],
  );

  // 换当前槽：钉子/槽位 chip/换组都走这里，顺手清掉悬停高亮（否则钉子会替上一个槽亮着）
  function selectSlot(key: AssignKey) {
    setCur(key);
    setHot(null);
  }
  function pickTab(title: string) {
    const g = ASSIGN_GROUPS.find((x) => x.title === title) ?? ASSIGN_GROUPS[0];
    setTab(g.title);
    // 换组就把当前槽挪到该组第一项；还在同一组则留在原槽
    if (ASSIGN_GROUP_OF[curKey] !== g.title) selectSlot(g.items[0].key);
  }
  function pickPlayer(pid: number) {
    setAssign((a) => ({ ...a, [curKey]: pid }));
  }
  function clearSlot() {
    setAssign((a) => {
      const next = { ...a };
      delete next[curKey];
      return next;
    });
  }
  function teamPlayerOf(pid: number): TeamPlayer | null {
    return teamPlayers?.find((x) => x.id === pid) ?? null;
  }
  // 槽位 chip / 候选人文案：号码 + 姓氏（查不到名册就退回 id，别显示成空白）
  function chipTag(pid: number): string {
    const p = teamPlayerOf(pid);
    if (!p) return `球员 ${pid}`;
    return `${p.number ? `#${p.number} ` : ""}${surname(p.name)}`;
  }
  function nailName(pid: number): string {
    const p = teamPlayerOf(pid);
    return p ? surname(p.name) : `#${pid}`;
  }

  if (!user) {
    return (
      <main className="tac-page asg-page">
        <header className="tac-head asg-head">
          <h1>定位球编排</h1>
          <span className="tac-badge">FC26</span>
          <p className="tac-sub">登录后按本队首发名单编排队长与定位球。</p>
        </header>
        <p className="tac-hint">
          <Link to="/login">去登录</Link>
          <span> · </span>
          <Link to="/tactics">返回战术页</Link>
        </p>
      </main>
    );
  }

  return (
    <main className="tac-page asg-page">
      <header className="tac-head asg-head">
        <h1>定位球编排</h1>
        <span className="tac-badge">FC26</span>
        <p className="tac-sub">
          {narrow
            ? "选一个槽位，再从本场首发里挑人；改动即存草稿，提交在战术页。"
            : "点半场板上的钉子切换当前槽位，右侧挑人；改动即存草稿，提交在战术页。"}
        </p>
        <Link className="btn btn-sm" to="/tactics">
          返回战术页
        </Link>
      </header>

      <nav className="asg-tabs" aria-label="指派分组">
        {ASSIGN_GROUPS.map((g) => {
          const filled = g.items.filter((it) => assign[it.key] != null).length;
          const bad = g.items.some((it) => conflictKeys.has(it.key));
          return (
            <button
              type="button"
              key={g.title}
              className={`asg-tab${g.title === group.title ? " on" : ""}${bad ? " bad" : ""}`}
              aria-pressed={g.title === group.title}
              onClick={() => pickTab(g.title)}
            >
              {g.title}
              <em>
                {filled}/{g.items.length}
              </em>
            </button>
          );
        })}
      </nav>

      {loadErr && <p className="tac-warn asg-loaderr">数据没取全：{loadErr}</p>}
      {conflictList.length > 0 && <p className="tac-warn">{conflictList.map(conflictText).join("；")}</p>}

      {/* 窄屏：半场板不渲染，这一组有哪些槽位就直接列出来 */}
      {narrow && (
        <div className="asg-slotbar">
          <div className="tac-assign-cells">
            {group.items.map((it) => {
              const v = assign[it.key] ?? null;
              const sfx = v == null ? "" : optionSuffix(v);
              const off = v != null && !assignPool.some((c) => c.id === v);
              return (
                <button
                  type="button"
                  key={it.key}
                  className={`tac-assign-chip${it.key === curKey ? " on" : ""}${
                    conflictKeys.has(it.key) ? " bad" : ""
                  }`}
                  aria-pressed={it.key === curKey}
                  title={`${it.label}｜${it.hint}`}
                  onClick={() => selectSlot(it.key)}
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
            {group.items.length % 2 === 1 && <span className="tac-assign-blank" aria-hidden="true" />}
          </div>
        </div>
      )}

      <div className={`asg-cols${side && !narrow ? "" : " no-board"}`}>
        {side && !narrow && (
          <section
            className={`card asg-board asg-board-${side}`}
            aria-label={`${group.title} 半场示意图`}
          >
            {/* 半场线画法照战术页球场（同一套白线口径），横放：球门在上、中线在下 */}
            <svg viewBox="0 0 100 78" preserveAspectRatio="none" aria-hidden="true">
              <g fill="none" stroke="rgba(255,255,255,.95)" strokeWidth=".7">
                <rect x="0" y="0" width="100" height="78" />
                <rect x="44.6" y="0" width="10.8" height="3.6" />
                <rect x="36.5" y="0" width="27" height="8.2" />
                <rect x="20.35" y="0" width="59.3" height="24.5" />
                <path d="M39.15 24.5 A 13.6 13.6 0 0 0 60.85 24.5" />
                <path d="M36.54 78 A 13.46 13.46 0 0 1 63.46 78" />
                <path d="M3 0 A 3 3 0 0 1 0 3" />
                <path d="M97 0 A 3 3 0 0 0 100 3" />
              </g>
              <circle cx="50" cy="16.3" r=".9" fill="rgba(255,255,255,.95)" />
            </svg>
            <span className="asg-board-cap">
              {group.title}
              <em>{side === "defense" ? "自家球门" : "对方球门"}</em>
            </span>
            {group.items.map((it) => {
              const nail = ASSIGN_NAILS[it.key];
              const v = assign[it.key] ?? null;
              const name = v == null ? "" : nailName(v);
              const cls = [
                "asg-nail",
                it.key === curKey ? "cur" : "",
                v == null ? "empty" : "",
                conflictKeys.has(it.key) ? "bad" : "",
                v != null && hot != null && v === hot ? "hot" : "",
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <button
                  key={it.key}
                  type="button"
                  className={cls}
                  style={{ left: `${nail.x}%`, top: `${nail.y}%` }}
                  aria-pressed={it.key === curKey}
                  aria-label={`${it.label}${v == null ? "：空" : `：${chipTag(v)}`}`}
                  title={`${it.label}｜${it.hint}${v == null ? "｜空着" : `｜${chipTag(v)}`}`}
                  onClick={() => selectSlot(it.key)}
                  // 双向高亮的另一半：鼠标停在这个人的钉子上，右栏他那一行跟着亮（空钉子无对应行）
                  onMouseEnter={() => setHot(v)}
                  onMouseLeave={() => setHot(null)}
                  onFocus={() => setHot(v)}
                  onBlur={() => setHot(null)}
                >
                  <span className="asg-nail-top">{nail.short}</span>
                  {name ? (
                    <span className="asg-nail-name" style={{ fontSize: `${nameFontSize(name, 62)}px` }}>
                      {name}
                    </span>
                  ) : (
                    <span className="asg-nail-name none">空</span>
                  )}
                </button>
              );
            })}
          </section>
        )}

        <section className="card asg-side">
          <div className="asg-side-head">
            <h2>
              {item.label}
              <small>
                {group.title} · {item.hint}
              </small>
            </h2>
            <span className={`asg-side-now${curVal == null ? " none" : ""}`}>
              {curVal == null ? "不指定" : chipTag(curVal)}
            </span>
          </div>
          {assignPool.length < 11 && (
            <p className="tac-warn">
              先把场上 11 个位置选满（现在 {assignPool.length}/11）：队长和定位球只能交给本场首发。
              <Link className="asg-goto" to="/tactics">
                去排首发
              </Link>
            </p>
          )}
          <AssignCandidateList
            players={candidates}
            assignKey={curKey}
            assign={assign}
            suffixOf={optionSuffix}
            onPick={pickPlayer}
            onClear={clearSlot}
            onHover={setHot}
            hot={hot}
          />
        </section>
      </div>

      <p className="tac-hint">
        同一个人可以兼好几项：队长兼点球、两侧角球都交给他开，都没问题。只有开角球的人和禁区里抢点的人必须分开。
      </p>
    </main>
  );
}
