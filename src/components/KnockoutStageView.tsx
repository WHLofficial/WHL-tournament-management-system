import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import DraftSaveBar from "./DraftSaveBar";
import { elimRoundName } from "../../shared/rounds";
import type {
  EntryDTO,
  MatchDTO,
  StageDTO,
  TournamentDetailDTO,
} from "../../shared/types";

/** 同一轮同一场次的多回合行 */
export interface SlotGroup {
  round: number;
  slot: number;
  third: boolean;
  legs: MatchDTO[];
}

/** 2 的幂判定（首轮 1/2/4/8/16 场合法） */
export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** 草稿里的一个首轮场次（场次号由数组下标决定：下标 i → 第 i+1 场） */
export interface DraftSlot {
  home: number | null;
  away: number | null;
}

/** sessionStorage 里恢复的草稿形状校验（entryId 必须是正整数） */
function isDraftSlot(s: unknown): s is DraftSlot {
  if (typeof s !== "object" || s === null || !("home" in s) || !("away" in s)) return false;
  const home = (s as { home: unknown }).home;
  const away = (s as { away: unknown }).away;
  const isId = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  return (home === null || isId(home)) && (away === null || isId(away));
}

/** 首轮场次数 = 第 1 轮不同场次号个数（空场次、轮空各算一场） */
export function firstRoundCount(matches: MatchDTO[]): number {
  const slots = new Set<number>();
  for (const m of matches) if (m.round === 1) slots.add(m.slot);
  return slots.size;
}

/**
 * 首轮 N 场（2 的幂）→ 满编 2N 队 → 总轮数 = log2(N) + 1（与 buildElimPlan 的 rounds 同口径）。
 * 非 2 的幂时按现有数据最大轮次回退。
 */
export function totalRoundsOf(firstCount: number, matches: MatchDTO[]): number {
  if (isPowerOfTwo(firstCount)) return Math.log2(firstCount) + 1;
  let mx = 1;
  for (const m of matches) if (m.round > mx) mx = m.round;
  return mx;
}

/** 按 轮次 + 场次号 + 是否季军赛 聚合场次行 */
export function groupSlots(matches: MatchDTO[]): SlotGroup[] {
  const map = new Map<string, SlotGroup>();
  for (const m of matches) {
    const third = m.note === "季军赛";
    const key = `${m.round}:${m.slot}:${third ? 1 : 0}`;
    const bucket = map.get(key) ?? { round: m.round, slot: m.slot, third, legs: [] };
    bucket.legs.push(m);
    map.set(key, bucket);
  }
  for (const g of map.values()) g.legs.sort((a, b) => (a.leg ?? 1) - (b.leg ?? 1));
  return [...map.values()].sort(
    (a, b) => a.round - b.round || Number(a.third) - Number(b.third) || a.slot - b.slot,
  );
}

/** 轮次标题：2 的幂时沿用 elimRoundName；非 2 的幂/空阶段回退「第 N 轮」 */
export function roundTitleOf(round: number, firstCount: number, totalRounds: number): string {
  if (isPowerOfTwo(firstCount)) return elimRoundName(round, totalRounds);
  return round === 1 ? "第 1 轮" : `第 ${round} 轮`;
}

/**
 * 后续轮次未定席位文案：`待定（第 1 轮·场次 N 胜者）`（半决赛及以后用轮次名），
 * 季军赛为 `待定（半决赛·场次 N 负者）`。
 */
export function pendingSeatLabel(
  m: MatchDTO,
  side: "home" | "away",
  firstCount: number,
  totalRounds: number,
): string {
  if (m.note === "季军赛") {
    const src = Math.max(1, totalRounds - 1);
    const name =
      isPowerOfTwo(firstCount) && src < totalRounds
        ? elimRoundName(src, totalRounds)
        : `第 ${src} 轮`;
    return `待定（${name}·场次 ${side === "home" ? 1 : 2} 负者）`;
  }
  const srcRound = Math.max(1, m.round - 1);
  const srcSlot = side === "home" ? m.slot * 2 - 1 : m.slot * 2;
  const name = srcRound === 1 ? "第 1 轮" : elimRoundName(srcRound, totalRounds);
  return `待定（${name}·场次 ${srcSlot} 胜者）`;
}

/** 比分文案：两回合制「首回合 x:y · 次回合 y:x · 总比分 A:B」（次回合按存储的主客直接展示） */
export function slotScoreLabel(legs: MatchDTO[]): string {
  const leg1 = legs.find((l) => l.leg === 1) ?? legs[0];
  if (!leg1 || leg1.note === "轮空") return "—";
  const two = legs.find((l) => l.leg === 2);
  const dash = (v: number | null) => (v == null ? "-" : String(v));
  if (!two) {
    if (leg1.scoreHome == null && leg1.scoreAway == null) return "—";
    const pen =
      leg1.penHome != null && leg1.penAway != null ? ` · 点球 ${leg1.penHome}:${leg1.penAway}` : "";
    return `${dash(leg1.scoreHome)} : ${dash(leg1.scoreAway)}${pen}`;
  }
  const parts: string[] = [];
  if (leg1.scoreHome != null || leg1.scoreAway != null)
    parts.push(`首回合 ${dash(leg1.scoreHome)}:${dash(leg1.scoreAway)}`);
  if (two.scoreHome != null || two.scoreAway != null)
    parts.push(`次回合 ${dash(two.scoreHome)}:${dash(two.scoreAway)}`);
  let pen = "";
  if (leg1.penHome != null && leg1.penAway != null) pen = ` · 点球 ${leg1.penHome}:${leg1.penAway}`;
  else if (two.penHome != null && two.penAway != null) pen = ` · 点球 ${two.penHome}:${two.penAway}`;
  if (
    leg1.scoreHome != null &&
    leg1.scoreAway != null &&
    two.scoreHome != null &&
    two.scoreAway != null
  ) {
    parts.push(`总比分 ${leg1.scoreHome + two.scoreAway}:${leg1.scoreAway + two.scoreHome}`);
  }
  return parts.length === 0 ? "—" : parts.join(" · ") + pen;
}

/** 场次整体状态：任一回合作战 → live；全部完赛 → finished；否则 pending */
export function slotStatusOf(legs: MatchDTO[]): MatchDTO["status"] {
  if (legs.some((l) => l.status === "live")) return "live";
  if (legs.length > 0 && legs.every((l) => l.status === "finished")) return "finished";
  return "pending";
}

/** 该场次的晋级方（取最后一个已填 winner 的回合） */
function slotWinner(legs: MatchDTO[]): number | null {
  for (let i = legs.length - 1; i >= 0; i--) {
    if (legs[i].winnerEntryId != null) return legs[i].winnerEntryId;
  }
  return null;
}

export default function KnockoutStageView({
  detail,
  stage,
  matches,
  qualifiers,
  busy,
  onRefresh,
}: {
  detail: TournamentDetailDTO;
  stage: StageDTO;
  matches: MatchDTO[];
  qualifiers?: number[];
  busy: boolean;
  onRefresh: () => void;
}) {
  const [panel, setPanel] = useState<{
    slot: number;
    home: number | null;
    away: number | null;
  } | null>(null);
  const [draft, setDraft] = useState<DraftSlot[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const groups = useMemo(() => groupSlots(matches), [matches]);
  const firstGroups = groups.filter((g) => g.round === 1 && !g.third);
  // 草稿基线：未进草稿时首轮按库内场次铺开（firstGroups 升序 → 场次号 = 下标 + 1）
  const draftFromMatches = useMemo(
    () =>
      firstGroups.map((g) => ({
        home: g.legs[0].homeEntryId ?? null,
        away: g.legs[0].awayEntryId ?? null,
      })),
    [firstGroups],
  );
  const firstRows = useMemo(() => {
    const bySlot = new Map(firstGroups.map((g) => [g.slot, g]));
    return (draft ?? draftFromMatches).map((s, i) => ({
      slot: i + 1,
      home: s.home,
      away: s.away,
      origin: bySlot.get(i + 1),
    }));
  }, [draft, draftFromMatches, firstGroups]);
  // 首轮场数/总轮数按草稿态取值：草稿里增删场次即时反映在标题与分层上
  const firstCount = firstRows.length;
  const totalRounds = useMemo(() => totalRoundsOf(firstCount, matches), [firstCount, matches]);
  const powerOfTwo = isPowerOfTwo(firstCount);
  const nonPower = firstCount > 0 && !powerOfTwo;
  const structureLocked = matches.some((m) => m.status !== "pending");

  const draftKey = `whl.ko.draft.${detail.tournament.id}.${stage.id}`;
  // 刷新/误关页面后恢复草稿（防丢）；形状不对就忽略
  useEffect(() => {
    const raw = window.sessionStorage.getItem(draftKey);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every(isDraftSlot)) setDraft(parsed);
    } catch {
      // 损坏的草稿直接忽略
    }
  }, [draftKey]);
  useEffect(() => {
    if (draft !== null) window.sessionStorage.setItem(draftKey, JSON.stringify(draft));
  }, [draft, draftKey]);

  // 与库内首轮的差异处数（保存条计数）
  const changeCount = useMemo(() => {
    if (!draft) return 0;
    let n = Math.abs(draft.length - draftFromMatches.length);
    const len = Math.min(draft.length, draftFromMatches.length);
    for (let i = 0; i < len; i += 1) {
      if (draft[i].home !== draftFromMatches[i].home || draft[i].away !== draftFromMatches[i].away)
        n += 1;
    }
    return n;
  }, [draft, draftFromMatches]);

  const firstTitle = firstCount === 0 ? "第 1 轮" : roundTitleOf(1, firstCount, totalRounds);
  const laterRoundNums = powerOfTwo
    ? [...new Set(groups.filter((g) => !g.third && g.round >= 2).map((g) => g.round))].sort(
        (a, b) => a - b,
      )
    : [];
  const thirdGroups = powerOfTwo ? groups.filter((g) => g.third) : [];

  const byeAdvanced = (g: SlotGroup) => {
    const leg = g.legs[0];
    if (!leg || leg.note !== "轮空" || leg.winnerEntryId == null) return false;
    return matches.some(
      (m) =>
        m.round > g.round &&
        (m.homeEntryId === leg.winnerEntryId || m.awayEntryId === leg.winnerEntryId),
    );
  };
  // 后续轮次已开打 → 首轮落位冻结（后端同口径 409）。轮空已晋级但下游仍待定时可改，
  // 后端会清掉过期预填并重跑晋级器。
  const laterStarted = matches.some((m) => m.round >= 2 && m.status !== "pending");
  const slotAllPending = (g: SlotGroup) => g.legs.every((l) => l.status === "pending");

  // 所有落位/增删都只改草稿，保存时一次提交（PUT 完整首轮快照）
  const ensureDraft = () => {
    if (draft) return draft;
    setDraft(draftFromMatches);
    return draftFromMatches;
  };
  const place = (slot: number, home: number | null, away: number | null) => {
    setDraft(ensureDraft().map((s, i) => (i + 1 === slot ? { home, away } : s)));
    setPanel(null);
  };
  const addSlot = () => {
    const d = ensureDraft();
    if (d.length >= 16) return;
    setDraft([...d, { home: null, away: null }]);
  };
  const removeSlot = (slot: number) => {
    setDraft(ensureDraft().filter((_, i) => i + 1 !== slot));
  };
  const openPanel = (slot: number) => {
    setSaveErr(null);
    const cur = ensureDraft()[slot - 1] ?? { home: null, away: null };
    setPanel({ slot, home: cur.home, away: cur.away });
  };

  // 整批保存端点（worker/routes/admin/schedule.ts 挂载在 /api/admin/tournaments 下）
  const slotsPath = `/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/slots`;
  const save = async () => {
    if (!draft || saving) return;
    if (draft.length === 0) {
      setSaveErr("首轮至少保留 1 场（空场次也算一场）");
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      await api(slotsPath, {
        method: "PUT",
        body: { slots: draft.map((s) => ({ homeEntryId: s.home, awayEntryId: s.away })) },
      });
      window.sessionStorage.removeItem(draftKey);
      setDraft(null);
      setPanel(null);
      onRefresh();
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    window.sessionStorage.removeItem(draftKey);
    setDraft(null);
    setPanel(null);
  };

  // 候选面板：qualifiers 置顶标「出线」，其余按种子；本轮已落位（编辑场次自身除外）置灰
  const qualifierIds = qualifiers ?? [];
  const qualifierSet = new Set(qualifierIds);
  const qualifierCount = qualifierIds.length;
  // 一键铺位：首轮空时按出线队数铺 N 场，N = 最小 2 幂使满编 2N ≥ 出线队数
  const fillCount = (() => {
    if (qualifierCount < 2) return 0;
    let n = 1;
    while (n < Math.ceil(qualifierCount / 2) && n < 16) n *= 2;
    return n;
  })();
  const fillByQualifiers = () =>
    setDraft(Array.from({ length: fillCount }, () => ({ home: null, away: null })));

  const entryName = (id: number | null): string | null =>
    id == null ? null : (detail.entries.find((e) => e.id === id)?.teamName ?? null);
  const orderedEntries = useMemo(() => {
    const byId = new Map(detail.entries.map((e) => [e.id, e]));
    const head: EntryDTO[] = [];
    for (const id of qualifierIds) {
      const e = byId.get(id);
      if (e && !head.includes(e)) head.push(e);
    }
    const tail = detail.entries
      .filter((e) => !qualifierSet.has(e.id))
      .sort((a, b) => a.seed - b.seed);
    return [...head, ...tail];
  }, [detail.entries, qualifiers]);

  // 本轮已落位的队（草稿态按草稿算，编辑场次自身除外）
  const occupied = useMemo(() => {
    const set = new Set<number>();
    for (const row of firstRows) {
      if (panel && row.slot === panel.slot) continue;
      if (row.home != null) set.add(row.home);
      if (row.away != null) set.add(row.away);
    }
    return set;
  }, [firstRows, panel]);

  const groupNameOf = (e: EntryDTO) =>
    e.groupId == null ? "" : (detail.groups.find((g) => g.id === e.groupId)?.name ?? "");

  const pick = (id: number) => {
    if (occupied.has(id)) return;
    setPanel((p) => {
      if (!p) return p;
      if (p.home === id) return { ...p, home: null };
      if (p.away === id) return { ...p, away: null };
      if (p.home == null) return { ...p, home: id };
      if (p.away == null) return { ...p, away: id };
      return { ...p, home: id, away: null };
    });
  };

  const sideName = (name: string | null, win: boolean) => {
    if (name == null) return <span className="muted">—</span>;
    return win ? <b>{name}</b> : <>{name}</>;
  };

  const panelPlaced = panel != null && (panel.home != null || panel.away != null);

  const renderLaterRows = (list: SlotGroup[]) =>
    list.map((g) => {
      const leg = g.legs[0];
      const status = slotStatusOf(g.legs);
      const winner = slotWinner(g.legs);
      return (
        <tr key={`${g.round}:${g.slot}:${g.third ? "t" : "n"}`}>
          <td className="muted">场次 {g.slot}</td>
          <td>
            {leg.homeTeamName == null ? (
              <span className="muted">{pendingSeatLabel(leg, "home", firstCount, totalRounds)}</span>
            ) : (
              sideName(leg.homeTeamName, winner === leg.homeEntryId)
            )}
          </td>
          <td className="score">{slotScoreLabel(g.legs)}</td>
          <td>
            {leg.awayTeamName == null ? (
              <span className="muted">{pendingSeatLabel(leg, "away", firstCount, totalRounds)}</span>
            ) : (
              sideName(leg.awayTeamName, winner === leg.awayEntryId)
            )}
          </td>
          <td>
            {g.legs.some((l) => l.walkoverSide) && <span className="badge badge-wo">弃权</span>}
            {status === "live" && <span className="badge">进行中</span>}
            {status === "finished" && <span className="badge">已完赛</span>}
          </td>
          <td />
        </tr>
      );
    });

  return (
    <div className="ko-view">
      <div className="round-group">
        <h4 className="round-title">
          {firstTitle}
          {nonPower && (
            <span className="muted"> 首轮场次数需为 2 的幂（当前 {firstCount} 场）</span>
          )}
        </h4>
        {draft && (
          <DraftSaveBar
            label={
              draft.length === 0
                ? "首轮至少保留 1 场（空场次也算一场）；点「放弃」可恢复原状"
                : changeCount === 0
                  ? "尚未修改：点〔空〕落位或增删场次后保存"
                  : `有未保存的更改 · ${changeCount} 处`
            }
            saving={saving}
            saveDisabled={draft.length === 0 || changeCount === 0}
            error={saveErr}
            onSave={() => void save()}
            onDiscard={discard}
          />
        )}
        {!draft && firstCount === 0 && (
          <p className="muted">首轮还没有场次：点〔＋新增场次〕或〔按出线队数铺场〕添加，再点空场次落位。</p>
        )}
        {firstRows.length > 0 && (
          <table>
            <tbody>
              {firstRows.map((row) => {
                const empty = row.home == null && row.away == null;
                const bye = !empty && row.away == null;
                const status = row.origin ? slotStatusOf(row.origin.legs) : "pending";
                const winner = row.origin ? slotWinner(row.origin.legs) : null;
                const canEdit = row.origin
                  ? slotAllPending(row.origin) && !laterStarted
                  : !laterStarted;
                const canDelete = canEdit && (row.origin ? !structureLocked : true);
                return (
                  <tr key={row.slot}>
                    <td className="muted">场次 {row.slot}</td>
                    {empty ? (
                      <td colSpan={5}>
                        <button
                          className="btn btn-sm ko-place"
                          type="button"
                          disabled={busy || laterStarted}
                          title={laterStarted ? "后续轮次已开打，不能再调整首轮落位" : undefined}
                          onClick={() => openPanel(row.slot)}
                        >
                          〔空〕点此落位（先点主队 → 再点客队）
                        </button>
                        {canDelete && (
                          <button
                            className="btn btn-danger btn-sm"
                            type="button"
                            disabled={busy}
                            onClick={() => removeSlot(row.slot)}
                          >
                            删除
                          </button>
                        )}
                      </td>
                    ) : (
                      <>
                        <td>{sideName(entryName(row.home), winner != null && winner === row.home)}</td>
                        <td className="score">
                          {bye ? "轮空" : row.origin ? slotScoreLabel(row.origin.legs) : "—"}
                        </td>
                        <td>{sideName(entryName(row.away), winner != null && winner === row.away)}</td>
                        <td>
                          {bye && <span className="badge">轮空</span>}
                          {row.origin?.legs.some((l) => l.walkoverSide) && (
                            <span className="badge badge-wo">弃权</span>
                          )}
                          {status === "live" && <span className="badge">进行中</span>}
                          {status === "finished" && !bye && <span className="badge">已完赛</span>}
                          {status === "pending" && !bye && <span className="muted">未开打</span>}
                        </td>
                        <td>
                          {canEdit && (
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={busy}
                              onClick={() => openPanel(row.slot)}
                            >
                              改位
                            </button>
                          )}
                          {canDelete && (
                            <button
                              className="btn btn-danger btn-sm"
                              type="button"
                              disabled={busy}
                              onClick={() => removeSlot(row.slot)}
                            >
                              删除
                            </button>
                          )}
                          {!canEdit && laterStarted && (
                            <span className="muted">后续轮次已开打，不能再改位</span>
                          )}
                          {canEdit && row.origin && byeAdvanced(row.origin) && (
                            <span className="muted">轮空已晋级（改位会重算后续轮）</span>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {panel && (
          <div className="manual-pick ko-candidates">
            <div className="manual-pick-head">
              <b>第 {panel.slot} 场落位</b>
              <span className="muted">
                {panel.home == null
                  ? "先点主队，再点客队"
                  : panel.away == null
                    ? "主队已选：再点客队，或点「轮空」"
                    : "确认落位，或再点已选队取消重选"}
              </span>
            </div>
            <div className="team-grid">
              {orderedEntries.map((e) => {
                const used = occupied.has(e.id);
                const selected = panel.home === e.id || panel.away === e.id;
                const tag = panel.home === e.id ? "主队" : panel.away === e.id ? "客队" : "";
                const groupName = groupNameOf(e);
                return (
                  <button
                    key={e.id}
                    type="button"
                    className={`tg-btn${selected ? " tg-picked" : ""}`}
                    disabled={used || busy}
                    title={used ? "本轮已落位（一队一轮只能一场）" : undefined}
                    onClick={() => pick(e.id)}
                  >
                    {e.teamName}
                    {groupName && <span className="tg-group">{groupName} 组</span>}
                    {qualifierSet.has(e.id) && <span className="badge">出线</span>}
                    {tag && <span className="tg-group">{tag}</span>}
                  </button>
                );
              })}
            </div>
            <div className="ko-candidates-actions">
              <button
                className="btn"
                type="button"
                disabled={busy || panel.home == null || panel.away == null}
                onClick={() => place(panel.slot, panel.home, panel.away)}
              >
                确认落位
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || panel.home == null || panel.away != null}
                onClick={() => place(panel.slot, panel.home, null)}
              >
                轮空
              </button>
              {panelPlaced && (
                <button
                  className="btn btn-danger-ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => place(panel.slot, null, null)}
                >
                  清除落位
                </button>
              )}
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setPanel(null);
                  setSaveErr(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="ko-add-slot">
          {!draft && firstCount === 0 && !structureLocked && (
            qualifierCount >= 2 ? (
              <button className="btn" type="button" disabled={busy} onClick={fillByQualifiers}>
                按出线队数铺 {fillCount} 场（出线 {qualifierCount} 队）
              </button>
            ) : (
              <button
                className="btn"
                type="button"
                disabled
                title="出线名单未生成（小组赛未完赛或未配置取人规则）"
              >
                按出线队数铺场
              </button>
            )
          )}
          <button
            className="btn"
            type="button"
            disabled={busy || structureLocked || firstCount >= 16}
            title={
              firstCount >= 16
                ? "已达上限（16 场）"
                : structureLocked
                  ? "已有场次开打，不能再增删场次"
                  : undefined
            }
            onClick={addSlot}
          >
            〔＋新增场次〕
          </button>
          {firstCount >= 16 && <span className="muted">已达上限（16 场）</span>}
          {structureLocked && <span className="muted">已有场次开打，不能增删场次</span>}
        </div>
        {!draft && firstCount === 0 && !structureLocked && (
          qualifierCount >= 2 ? (
            <p className="muted">
              出线 {qualifierCount} 队满编 {fillCount * 2} 队，多出席位可设轮空或删除场次。
            </p>
          ) : (
            <p className="muted">出线名单未生成（小组赛未完赛或未配置取人规则），可先手动新增场次。</p>
          )
        )}
      </div>

      {laterRoundNums.map((r) => (
        <div className="round-group" key={r}>
          <h4 className="round-title">{roundTitleOf(r, firstCount, totalRounds)}</h4>
          <table>
            <tbody>
              {renderLaterRows(groups.filter((g) => g.round === r && !g.third))}
            </tbody>
          </table>
        </div>
      ))}

      {thirdGroups.length > 0 && (
        <div className="round-group">
          <h4 className="round-title">季军赛</h4>
          <table>
            <tbody>{renderLaterRows(thirdGroups)}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}
