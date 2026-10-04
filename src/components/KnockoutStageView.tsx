import { useMemo, useState } from "react";
import { api } from "../api";
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
  const [acting, setActing] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const groups = useMemo(() => groupSlots(matches), [matches]);
  const firstCount = useMemo(() => firstRoundCount(matches), [matches]);
  const totalRounds = useMemo(() => totalRoundsOf(firstCount, matches), [firstCount, matches]);
  const powerOfTwo = isPowerOfTwo(firstCount);
  const nonPower = firstCount > 0 && !powerOfTwo;
  const structureLocked = matches.some((m) => m.status !== "pending");

  const firstGroups = groups.filter((g) => g.round === 1 && !g.third);
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

  const openPanel = (g: SlotGroup) => {
    setErr(null);
    const leg = g.legs[0];
    setPanel({ slot: g.slot, home: leg.homeEntryId, away: leg.awayEntryId });
  };

  const run = async (fn: () => Promise<unknown>, closePanel = true) => {
    setActing(true);
    setErr(null);
    try {
      await fn();
      if (closePanel) setPanel(null);
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "操作失败");
    } finally {
      setActing(false);
    }
  };

  // 端点与其它阶段接口同基址（worker/routes/admin/schedule.ts 挂载在 /api/admin/tournaments 下）：
  // POST /api/admin/tournaments/:id/stages/:stageId/slots，PUT/DELETE 同上 + /:slot
  const slotsPath = (slot?: number) =>
    `/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/slots${
      slot == null ? "" : `/${slot}`
    }`;
  const place = (slot: number, homeEntryId: number | null, awayEntryId: number | null) =>
    run(() => api(slotsPath(slot), { method: "PUT", body: { homeEntryId, awayEntryId } }));
  const addSlot = () => run(() => api(slotsPath(), { method: "POST" }), false);
  const removeSlot = (slot: number) => {
    if (!window.confirm(`删除第 ${slot} 场？该场落位会一并清除，后续场次序号自动前移。`)) return;
    void run(() => api(slotsPath(slot), { method: "DELETE" }), false);
  };

  // 候选面板：qualifiers 置顶标「出线」，其余按种子；本轮已落位（编辑场次自身除外）置灰
  const qualifierIds = qualifiers ?? [];
  const qualifierSet = new Set(qualifierIds);
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

  const occupied = useMemo(() => {
    const set = new Set<number>();
    for (const g of firstGroups) {
      if (panel && g.slot === panel.slot) continue;
      for (const leg of g.legs) {
        if (leg.homeEntryId != null) set.add(leg.homeEntryId);
        if (leg.awayEntryId != null) set.add(leg.awayEntryId);
      }
    }
    return set;
  }, [firstGroups, panel]);

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

  const panelGroup = panel ? firstGroups.find((g) => g.slot === panel.slot) : undefined;
  const panelPlaced = panelGroup
    ? panelGroup.legs[0].homeEntryId != null || panelGroup.legs[0].awayEntryId != null
    : false;

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
      {err && <p className="error">{err}</p>}

      <div className="round-group">
        <h4 className="round-title">
          {firstTitle}
          {nonPower && (
            <span className="muted"> 首轮场次数需为 2 的幂（当前 {firstCount} 场）</span>
          )}
        </h4>
        {firstGroups.length === 0 && (
          <p className="muted">首轮还没有场次：点〔＋新增场次〕添加，再点空场次落位。</p>
        )}
        {firstGroups.length > 0 && (
          <table>
            <tbody>
              {firstGroups.map((g) => {
                const leg = g.legs[0];
                const empty = leg.homeEntryId == null && leg.awayEntryId == null;
                const bye = leg.note === "轮空";
                const status = slotStatusOf(g.legs);
                const winner = slotWinner(g.legs);
                const canEdit = slotAllPending(g) && !laterStarted;
                const canDelete = canEdit && !structureLocked;
                return (
                  <tr key={`${g.round}:${g.slot}`}>
                    <td className="muted">场次 {g.slot}</td>
                    {empty ? (
                      <td colSpan={5}>
                        <button
                          className="btn btn-sm ko-place"
                          type="button"
                          disabled={busy || acting}
                          onClick={() => openPanel(g)}
                        >
                          〔空〕点此落位（先点主队 → 再点客队）
                        </button>
                        {!structureLocked && (
                          <button
                            className="btn btn-danger btn-sm"
                            type="button"
                            disabled={busy || acting}
                            onClick={() => removeSlot(g.slot)}
                          >
                            删除
                          </button>
                        )}
                      </td>
                    ) : (
                      <>
                        <td>{sideName(leg.homeTeamName, winner === leg.homeEntryId)}</td>
                        <td className="score">{bye ? "轮空" : slotScoreLabel(g.legs)}</td>
                        <td>{sideName(leg.awayTeamName, winner === leg.awayEntryId)}</td>
                        <td>
                          {bye && <span className="badge">轮空</span>}
                          {g.legs.some((l) => l.walkoverSide) && (
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
                              disabled={busy || acting}
                              onClick={() => openPanel(g)}
                            >
                              改位
                            </button>
                          )}
                          {canDelete && (
                            <button
                              className="btn btn-danger btn-sm"
                              type="button"
                              disabled={busy || acting}
                              onClick={() => removeSlot(g.slot)}
                            >
                              删除
                            </button>
                          )}
                          {!canEdit && laterStarted && (
                            <span className="muted">后续轮次已开打，不能再改位</span>
                          )}
                          {canEdit && byeAdvanced(g) && (
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
                    disabled={used || busy || acting}
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
                disabled={acting || busy || panel.home == null || panel.away == null}
                onClick={() => void place(panel.slot, panel.home, panel.away)}
              >
                确认落位
              </button>
              <button
                className="btn"
                type="button"
                disabled={acting || busy || panel.home == null || panel.away != null}
                onClick={() => void place(panel.slot, panel.home, null)}
              >
                轮空
              </button>
              {panelPlaced && (
                <button
                  className="btn btn-danger-ghost"
                  type="button"
                  disabled={acting || busy}
                  onClick={() => void place(panel.slot, null, null)}
                >
                  清除落位
                </button>
              )}
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setPanel(null);
                  setErr(null);
                }}
              >
                取消
              </button>
            </div>
          </div>
        )}

        <div className="ko-add-slot">
          <button
            className="btn"
            type="button"
            disabled={busy || acting || structureLocked || firstCount >= 16}
            title={
              firstCount >= 16
                ? "已达上限（16 场）"
                : structureLocked
                  ? "已有场次开打，不能再增删场次"
                  : undefined
            }
            onClick={() => void addSlot()}
          >
            〔＋新增场次〕
          </button>
          {firstCount >= 16 && <span className="muted">已达上限（16 场）</span>}
          {structureLocked && <span className="muted">已有场次开打，不能增删场次</span>}
        </div>
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
