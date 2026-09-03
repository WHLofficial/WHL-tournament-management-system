import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type {
  EntryDTO,
  MatchDTO,
  StageDTO,
  TournamentDetailDTO,
} from "../../shared/types";

const MATCH_STATUS: Record<MatchDTO["status"], string> = {
  pending: "未开打",
  live: "进行中",
  finished: "已完赛",
};

// 单淘轮次名：按剩余场次数命名（决赛/半决赛/1/4决赛…）
function elimRoundName(round: number, rounds: number): string {
  const slots = 2 ** (rounds - round);
  if (slots === 1) return "决赛";
  if (slots === 2) return "半决赛";
  if (slots === 4) return "1/4 决赛";
  return `1/${slots} 决赛`;
}

const stageTitle: Record<StageDTO["kind"], string> = {
  elim: "淘汰赛",
  round_robin: "循环赛",
  group: "小组赛",
};

export default function ScheduleTab({
  detail,
  reload,
}: {
  detail: TournamentDetailDTO;
  reload: () => void;
}) {
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const b = await api<{ matches: MatchDTO[] }>(
        `/api/admin/tournaments/${detail.tournament.id}/matches`
      );
      setMatches(b.matches);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "加载赛程失败");
    }
  }, [detail.tournament.id]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const act = async (fn: () => Promise<void>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      await refetch();
      reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  if (detail.entries.length < 2) {
    return <p className="muted">报名不足 2 支，先去「报名」页添加参赛球队。</p>;
  }

  const generate = (stage: StageDTO) =>
    act(
      () =>
        api(`/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/generate`, {
          method: "POST",
        }),
      "将清空该阶段全部未开打的场次并重新生成，确认？"
    );

  const draw = (stage: StageDTO) =>
    act(
      () =>
        api(`/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/draw`, {
          method: "POST",
        }),
      "重新抽签将随机重新分组（已生成的组内赛程需重新生成），确认？"
    );

  return (
    <div className="schedule-tab">
      {message && <p className="error">{message}</p>}
      {detail.stages.map((stage) => (
        <StageBlock
          key={stage.id}
          detail={detail}
          stage={stage}
          matches={(matches ?? []).filter((m) => m.stageId === stage.id)}
          busy={busy}
          onRefresh={() => {
            refetch();
            reload();
          }}
          onGenerate={() => generate(stage)}
          onDraw={stage.kind === "group" ? () => draw(stage) : undefined}
        />
      ))}
    </div>
  );
}

function StageBlock({
  detail,
  stage,
  matches,
  busy,
  onRefresh,
  onGenerate,
  onDraw,
}: {
  detail: TournamentDetailDTO;
  stage: StageDTO;
  matches: MatchDTO[];
  busy: boolean;
  onRefresh: () => void;
  onGenerate: () => void;
  onDraw?: () => void;
}) {
  const cfg = stage.config as {
    loops?: number;
    legs?: number;
    group_count?: number;
  };
  const rounds = matches.reduce((mx, m) => Math.max(mx, m.round), 0);
  const roundBuckets = useMemo(() => {
    const map = new Map<number, MatchDTO[]>();
    for (const m of matches) {
      const arr = map.get(m.round) ?? [];
      arr.push(m);
      map.set(m.round, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.slot - b.slot || (a.leg ?? 1) - (b.leg ?? 1));
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [matches]);

  const roundName = (r: number) =>
    stage.kind === "elim" ? elimRoundName(r, rounds || 1) : `第 ${r} 轮`;

  return (
    <section className="card stage-block">
      <div className="stage-head">
        <h3>
          {stageTitle[stage.kind]}
          {stage.kind === "round_robin" &&
            (cfg.loops === 2 ? "（双循环）" : "（单循环）")}
          {stage.kind === "elim" && cfg.legs === 2 && "（两回合）"}
          {stage.kind === "group" && `（${cfg.group_count ?? 4} 组）`}
        </h3>
        <div className="stage-actions">
          <StageConfigEditor detail={detail} stage={stage} onSaved={onRefresh} />
          {stage.kind === "group" && (
            <button className="btn" onClick={onDraw} disabled={busy}>
              随机抽签
            </button>
          )}
          <button className="btn" onClick={onGenerate} disabled={busy}>
            自动生成{stage.kind === "elim" ? "对阵" : "赛程"}
          </button>
        </div>
      </div>

      {stage.kind === "group" && (
        <GroupOverview detail={detail} stageId={stage.id} />
      )}

      {matches.length === 0 ? (
        <p className="muted">
          还没有场次。
          {stage.kind === "group" ? "先抽签分组，再生成小组赛程。" : "点右上角自动生成。"}
        </p>
      ) : (
        roundBuckets.map(([r, list]) => (
          <div key={r} className="round-group">
            <h4 className="round-title">{roundName(r)}</h4>
            <table>
              <tbody>
                {list.map((m) => (
                  <MatchRow
                    key={m.id}
                    detail={detail}
                    match={m}
                    canDelete={
                      stage.kind !== "elim" &&
                      m.status === "pending" &&
                      m.note !== "轮空" &&
                      m.homeEntryId !== null
                    }
                    onDeleted={onRefresh}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {(stage.kind === "round_robin" || stage.kind === "group") && (
        <ManualForm
          detail={detail}
          stage={stage}
          matches={matches}
          busy={busy}
          onRefresh={onRefresh}
        />
      )}
    </section>
  );
}

function MatchRow({
  detail,
  match,
  canDelete,
  onDeleted,
}: {
  detail: TournamentDetailDTO;
  match: MatchDTO;
  canDelete: boolean;
  onDeleted: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const remove = async () => {
    if (
      !window.confirm(
        `删除 ${match.homeTeamName ?? "?"} vs ${match.awayTeamName ?? "?"} 这场未开打的比赛？`
      )
    )
      return;
    try {
      await api(
        `/api/admin/tournaments/${detail.tournament.id}/matches/${match.id}`,
        { method: "DELETE" }
      );
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  };
  const score =
    match.status === "pending"
      ? "—"
      : `${match.scoreHome ?? 0} : ${match.scoreAway ?? 0}`;
  return (
    <tr>
      <td className="muted">
        {match.leg ? `第 ${match.leg} 回合` : match.note || ""}
      </td>
      <td>{match.homeTeamName ?? "待定"}</td>
      <td className="score">{score}</td>
      <td>{match.awayTeamName ?? "待定"}</td>
      <td>
        {match.note === "轮空" ? (
          <span className="badge">轮空</span>
        ) : (
          <span className={`muted st-${match.status}`}>
            {MATCH_STATUS[match.status]}
          </span>
        )}
      </td>
      <td>
        {canDelete && (
          <button className="btn btn-danger btn-sm" onClick={remove}>
            删除
          </button>
        )}
        {err && <span className="error">{err}</span>}
      </td>
    </tr>
  );
}

function GroupOverview({
  detail,
  stageId,
}: {
  detail: TournamentDetailDTO;
  stageId: number;
}) {
  const groups = detail.groups.filter((g) => g.stageId === stageId);
  const undrawn = detail.entries.filter((e) => e.groupId == null);
  return (
    <div className="group-overview">
      {groups.map((g) => {
        const members = detail.entries.filter((e) => e.groupId === g.id);
        return (
          <div key={g.id} className="group-chip">
            <b>{g.name} 组</b>
            <span className="muted">
              {members.length
                ? members.map((m) => m.teamName).join("、")
                : "待抽签"}
            </span>
          </div>
        );
      })}
      {undrawn.length > 0 && (
        <div className="group-chip">
          <b>未分组</b>
          <span className="muted">
            {undrawn.length} 支：{undrawn.map((m) => m.teamName).join("、")}
          </span>
        </div>
      )}
    </div>
  );
}

function ManualForm({
  detail,
  stage,
  matches,
  busy,
  onRefresh,
}: {
  detail: TournamentDetailDTO;
  stage: StageDTO;
  matches: MatchDTO[];
  busy: boolean;
  onRefresh: () => void;
}) {
  const cfg = stage.config as { loops?: number };
  const loops = cfg.loops === 2 ? 2 : 1;
  const maxRound = matches.reduce((mx, m) => Math.max(mx, m.round), 0);
  const [round, setRound] = useState(String(maxRound + 1));
  const [homeId, setHomeId] = useState("");
  const [awayId, setAwayId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const nextRound = maxRound + 1;
  const roundValue = Number(round) || nextRound;

  const conflicts = useMemo(() => {
    // 对已选主队：本轮已有场次、或交手次数达上限的队 → 客队候选置灰
    const disabled = new Set<number>();
    if (!homeId) return disabled;
    const h = Number(homeId);
    for (const m of matches) {
      if (m.round === roundValue && (m.homeEntryId === h || m.awayEntryId === h)) {
        if (m.homeEntryId !== null) disabled.add(m.homeEntryId);
        if (m.awayEntryId !== null) disabled.add(m.awayEntryId);
      }
      const paired =
        (m.homeEntryId === h && m.awayEntryId !== null) ||
        (m.awayEntryId === h && m.homeEntryId !== null);
      if (paired) disabled.add(m.homeEntryId === h ? m.awayEntryId! : m.homeEntryId!);
    }
    return disabled;
  }, [matches, homeId, roundValue]);

  const playedCount = (a: number, b: number) =>
    matches.filter(
      (m) =>
        (m.homeEntryId === a && m.awayEntryId === b) ||
        (m.homeEntryId === b && m.awayEntryId === a)
    ).length;

  const candidates = (forAway: boolean): EntryDTO[] => {
    let pool = detail.entries;
    if (stage.kind === "group" && homeId) {
      const h = detail.entries.find((e) => String(e.id) === homeId);
      pool = pool.filter((e) => e.groupId != null && e.groupId === h?.groupId);
    }
    if (forAway && homeId) {
      pool = pool.filter((e) => String(e.id) !== homeId);
    }
    return pool;
  };

  const submit = async () => {
    setErr(null);
    if (!homeId || !awayId) {
      setErr("请选择主队和客队");
      return;
    }
    try {
      await api(`/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/matches`, {
        method: "POST",
        body: { round: roundValue, homeEntryId: Number(homeId), awayEntryId: Number(awayId) },
      });
      setHomeId("");
      setAwayId("");
      onRefresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "落场失败");
    }
  };

  return (
    <form
      className="inline-form manual-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label>
        轮次
        <input
          type="number"
          min={1}
          value={round}
          onChange={(e) => setRound(e.target.value)}
          placeholder={String(nextRound)}
          style={{ width: 72 }}
        />
      </label>
      <label>
        主队
        <select value={homeId} onChange={(e) => setHomeId(e.target.value)}>
          <option value="">选择主队</option>
          {candidates(false).map((e) => (
            <option key={e.id} value={e.id}>
              {e.teamName}
            </option>
          ))}
        </select>
      </label>
      <label>
        客队
        <select value={awayId} onChange={(e) => setAwayId(e.target.value)}>
          <option value="">选择客队</option>
          {candidates(true).map((e) => (
            <option
              key={e.id}
              value={e.id}
              disabled={
                conflicts.has(e.id) || playedCount(Number(homeId), e.id) >= loops
              }
            >
              {e.teamName}
              {homeId &&
                (playedCount(Number(homeId), e.id) >= loops
                  ? loops === 1
                    ? "（已交手）"
                    : "（已赛两场）"
                  : conflicts.has(e.id)
                    ? "（本轮已排）"
                    : "")}
            </option>
          ))}
        </select>
      </label>
      <button className="btn" type="submit" disabled={busy}>
        添加比赛
      </button>
      {err && <span className="error">{err}</span>}
    </form>
  );
}


// 赛制参数编辑：改动直接 PATCH，重新生成赛程后生效
function StageConfigEditor({
  detail,
  stage,
  onSaved,
}: {
  detail: TournamentDetailDTO;
  stage: StageDTO;
  onSaved: () => void;
}) {
  const cfg = stage.config as {
    loops?: number;
    legs?: number;
    final_legs?: number;
    third_place?: boolean;
  };
  const [err, setErr] = useState<string | null>(null);

  const patch = async (p: Record<string, unknown>) => {
    setErr(null);
    try {
      await api(`/api/admin/tournaments/${detail.tournament.id}`, {
        method: "PATCH",
        body: { config_json: p },
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "保存失败");
    }
  };

  if (stage.kind === "elim") {
    // group_knockout 的淘汰阶段回合数跟随小组赛后自动生成，仅 single_elim 暴露编辑
    if (stage.config && "source" in (stage.config as object)) return null;
    return (
      <span className="cfg-editor">
        {err && <span className="error">{err}</span>}
        <label>
          回合
          <select
            value={cfg.legs === 2 ? "2" : "1"}
            onChange={(e) => patch({ legs: Number(e.target.value) })}
          >
            <option value="1">单场</option>
            <option value="2">两回合</option>
          </select>
        </label>
        <label>
          决赛
          <select
            value={String(cfg.final_legs ?? cfg.legs ?? 1)}
            onChange={(e) => patch({ final_legs: Number(e.target.value) })}
          >
            <option value="1">单场</option>
            <option value="2">两回合</option>
          </select>
        </label>
        <label>
          季军赛
          <input
            type="checkbox"
            checked={!!cfg.third_place}
            onChange={(e) => patch({ third_place: e.target.checked })}
          />
        </label>
      </span>
    );
  }
  return (
    <span className="cfg-editor">
      {err && <span className="error">{err}</span>}
      <label>
        循环
        <select
          value={cfg.loops === 2 ? "2" : "1"}
          onChange={(e) => patch({ loops: Number(e.target.value) })}
        >
          <option value="1">单循环</option>
          <option value="2">双循环</option>
        </select>
      </label>
    </span>
  );
}
