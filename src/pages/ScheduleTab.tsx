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

  const editable = detail.tournament.status === "draft" || detail.tournament.status === "registering";

  const removeStage = (stage: StageDTO) =>
    act(
      () =>
        api(`/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}`, {
          method: "DELETE",
        }),
      `删除「${stageTitle[stage.kind]}」阶段将连同其全部场次一起删除，确认？`
    );

  const clearStage = (stage: StageDTO) =>
    act(
      () =>
        api(`/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/matches`, {
          method: "DELETE",
        }),
      "将清除该阶段全部未开打的场次，确认？"
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
          editable={editable}
          onRefresh={() => {
            refetch();
            reload();
          }}
          onGenerate={() => generate(stage)}
          onDraw={stage.kind === "group" ? () => draw(stage) : undefined}
          onDelete={editable ? () => removeStage(stage) : undefined}
          onClear={editable ? () => clearStage(stage) : undefined}
        />
      ))}
      {editable && (
        <AddStageForm
          detail={detail}
          busy={busy}
          onAdded={() => {
            refetch();
            reload();
          }}
        />
      )}
    </div>
  );
}

function StageBlock({
  detail,
  stage,
  matches,
  busy,
  editable,
  onRefresh,
  onGenerate,
  onDraw,
  onDelete,
  onClear,
}: {
  detail: TournamentDetailDTO;
  stage: StageDTO;
  matches: MatchDTO[];
  busy: boolean;
  editable: boolean;
  onRefresh: () => void;
  onGenerate: () => void;
  onDraw?: () => void;
  onDelete?: () => void;
  onClear?: () => void;
}) {
  const cfg = stage.config as {
    loops?: number;
    legs?: number;
    group_count?: number;
  };
  const rounds = matches.reduce((mx, m) => Math.max(mx, m.round), 0);
  const roundBuckets = useMemo(() => {
    // 季军赛与决赛同轮，单独成组显示标题
    const map = new Map<string, { round: number; third: boolean; list: MatchDTO[] }>();
    for (const m of matches) {
      const key = `${m.round}:${m.note === "季军赛" ? 1 : 0}`;
      const bucket = map.get(key) ?? { round: m.round, third: m.note === "季军赛", list: [] };
      bucket.list.push(m);
      map.set(key, bucket);
    }
    for (const bucket of map.values()) {
      bucket.list.sort((a, b) => a.slot - b.slot || (a.leg ?? 1) - (b.leg ?? 1));
    }
    return [...map.values()].sort(
      (a, b) => a.round - b.round || Number(a.third) - Number(b.third),
    );
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
          {editable && (
            <>
              {matches.length > 0 && (
                <button
                  className="btn"
                  onClick={onClear}
                  disabled={busy}
                  title="清除该阶段全部未开打的场次"
                >
                  清除赛程
                </button>
              )}
              <button
                className="btn btn-danger-ghost"
                onClick={onDelete}
                disabled={busy}
                title="删除整个阶段（连同其全部场次）"
              >
                删除阶段
              </button>
            </>
          )}
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
        roundBuckets.map(({ round, third, list }) => (
          <div key={`${round}:${third ? 1 : 0}`} className="round-group">
            <h4 className="round-title">
              {third ? "季军赛" : roundName(round)}
            </h4>
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

// 点选式手动排赛：先点主队，再点客队，点击即建成场次（无需确认按钮）
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
  const [picked, setPicked] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nextRound = maxRound + 1;
  const roundValue = Number(round) || nextRound;

  // 本轮已上场的队（作客队时置灰）
  const roundBusy = useMemo(() => {
    const set = new Set<number>();
    for (const m of matches) {
      if (m.round !== roundValue) continue;
      if (m.homeEntryId !== null) set.add(m.homeEntryId);
      if (m.awayEntryId !== null) set.add(m.awayEntryId);
    }
    return set;
  }, [matches, roundValue]);

  const playedCount = (a: number, b: number) =>
    matches.filter(
      (m) =>
        (m.homeEntryId === a && m.awayEntryId === b) ||
        (m.homeEntryId === b && m.awayEntryId === a)
    ).length;

  const pickedEntry =
    picked != null ? detail.entries.find((e) => e.id === picked) : undefined;

  // 选中主队后，这支队作客队行不行；返回置灰原因
  const blockReason = (e: EntryDTO): string | null => {
    if (picked == null || !pickedEntry) return null;
    if (e.id === picked) return null; // 自己：再点取消
    if (stage.kind === "group" && (e.groupId == null || e.groupId !== pickedEntry.groupId)) {
      return "不同组";
    }
    if (roundBusy.has(e.id)) return "本轮已排";
    if (playedCount(picked, e.id) >= loops) return loops === 1 ? "已交手" : "已赛两场";
    return null;
  };

  const groupName = (gid: number) =>
    detail.groups.find((g) => g.id === gid)?.name ?? "";

  const click = async (e: EntryDTO) => {
    if (busy || submitting) return;
    if (picked == null) {
      setPicked(e.id);
      setErr(null);
      return;
    }
    if (e.id === picked) {
      setPicked(null);
      return;
    }
    const why = blockReason(e);
    if (why) {
      setErr(`${e.teamName} 不能作客队：${why}`);
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      await api(
        `/api/admin/tournaments/${detail.tournament.id}/stages/${stage.id}/matches`,
        { method: "POST", body: { round: roundValue, homeEntryId: picked, awayEntryId: e.id } }
      );
      setPicked(null);
      onRefresh();
    } catch (err2) {
      setErr(err2 instanceof Error ? err2.message : "落场失败");
      setPicked(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="manual-pick">
      <div className="manual-pick-head">
        <label>
          轮次
          <input
            type="number"
            min={1}
            value={round}
            onChange={(e2) => setRound(e2.target.value)}
            placeholder={String(nextRound)}
            style={{ width: 72 }}
          />
        </label>
        <span className="muted">
          {picked == null
            ? "点一支队作主队"
            : `主队 ${pickedEntry?.teamName}——点客队成场，再点主队取消`}
        </span>
      </div>
      {err && <p className="error">{err}</p>}
      <div className="team-grid">
        {detail.entries.map((e) => {
          const why = blockReason(e);
          const isPicked = e.id === picked;
          return (
            <button
              key={e.id}
              type="button"
              className={`tg-btn${isPicked ? " tg-picked" : ""}`}
              disabled={!!why && !isPicked}
              title={why ?? undefined}
              onClick={() => click(e)}
            >
              {e.teamName}
              {stage.kind === "group" && e.groupId != null && (
                <span className="tg-group">{groupName(e.groupId)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
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

// ---------- 添加阶段（灵活多阶段：仅 draft/registering 显示） ----------

function AddStageForm({
  detail,
  busy,
  onAdded,
}: {
  detail: TournamentDetailDTO;
  busy: boolean;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"elim" | "round_robin">("elim");
  const [legs, setLegs] = useState("1");
  const [thirdPlace, setThirdPlace] = useState(false);
  const [loops, setLoops] = useState("1");
  const [take, setTake] = useState("");
  const [cross, setCross] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const isFirst = detail.stages.length === 0;
  const lastKind = detail.stages[detail.stages.length - 1]?.kind;
  const sourceMode = cross ? "cross" : take ? "take" : "";

  // 上一阶段是小组赛时，跨组模板给个默认值（组两两交叉：A1-B2、B1-A2…）
  const defaultCross = () => {
    const prev = detail.stages[detail.stages.length - 1];
    if (!prev || prev.kind !== "group") return "";
    const gc = (prev.config as { group_count?: number }).group_count ?? 4;
    const pairs: string[] = [];
    for (let i = 0; i + 1 < gc; i += 2) {
      const a = String.fromCharCode(65 + i);
      const b = String.fromCharCode(65 + i + 1);
      pairs.push(`${a}1-${b}2`, `${b}1-${a}2`);
    }
    return pairs.join("，");
  };

  const submit = async () => {
    setErr(null);
    const body: Record<string, unknown> = { kind };
    if (kind === "elim") {
      body.legs = Number(legs) === 2 ? 2 : 1;
      body.thirdPlace = thirdPlace;
    } else {
      body.loops = Number(loops) === 2 ? 2 : 1;
    }
    const crossList = cross
      .split(/[,，\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (crossList.length > 0) {
      body.source = { cross: crossList };
    } else if (take) {
      const n = Number(take);
      if (!Number.isInteger(n) || n < 2 || n > 64) {
        setErr("取人名额需是 2 到 64 的整数");
        return;
      }
      body.source = { take: n };
    }
    try {
      await api(`/api/admin/tournaments/${detail.tournament.id}/stages`, {
        method: "POST",
        body,
      });
      setOpen(false);
      setTake("");
      setCross("");
      onAdded();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "添加阶段失败");
    }
  };

  if (!open) {
    return (
      <button className="btn add-stage" onClick={() => setOpen(true)} disabled={busy}>
        ＋ 添加阶段
      </button>
    );
  }
  return (
    <form
      className="card add-stage-form"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="add-stage-row">
        <label>
          赛制
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as "elim" | "round_robin")}
          >
            <option value="elim">淘汰赛</option>
            <option value="round_robin">循环赛</option>
          </select>
        </label>
        {kind === "elim" ? (
          <label>
            回合
            <select value={legs} onChange={(e) => setLegs(e.target.value)}>
              <option value="1">单场</option>
              <option value="2">两回合</option>
            </select>
          </label>
        ) : (
          <label>
            循环
            <select value={loops} onChange={(e) => setLoops(e.target.value)}>
              <option value="1">单循环</option>
              <option value="2">双循环</option>
            </select>
          </label>
        )}
        {kind === "elim" && (
          <label className="check">
            <input
              type="checkbox"
              checked={thirdPlace}
              onChange={(e) => setThirdPlace(e.target.checked)}
            />
            季军赛
          </label>
        )}
      </div>
      {!isFirst && (
        <div className="add-stage-row">
          <label>
            取人规则
            <select
              value={sourceMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "take") {
                  setTake(take || "4");
                  setCross("");
                } else if (v === "cross") {
                  setCross(cross || defaultCross());
                  setTake("");
                } else {
                  setTake("");
                  setCross("");
                }
              }}
            >
              <option value="">全部报名队</option>
              <option value="take">上一阶段前 N 名</option>
              {lastKind === "group" && <option value="cross">跨组对阵模板</option>}
            </select>
          </label>
          {take && (
            <label>
              名额 N
              <input
                type="number"
                min={2}
                max={64}
                value={take}
                onChange={(e) => setTake(e.target.value)}
                style={{ width: 80 }}
              />
            </label>
          )}
          {cross && (
            <input
              type="text"
              value={cross}
              onChange={(e) => setCross(e.target.value)}
              placeholder="A1-B2，B1-A2，C1-D2，D1-C2"
              style={{ flex: 1 }}
            />
          )}
        </div>
      )}
      <p className="muted add-stage-hint">
        新阶段排在最后；生成赛程时
        {take
          ? `取上一阶段积分榜前 ${take} 名`
          : cross
            ? "按模板对阵"
            : "使用全部报名队"}
        。结构只在开赛前可调。
      </p>
      {err && <p className="error">{err}</p>}
      <div className="add-stage-row">
        <button className="btn" type="submit" disabled={busy}>
          添加
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          取消
        </button>
      </div>
    </form>
  );
}
