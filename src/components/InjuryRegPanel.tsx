// 伤停登记面板：登记必须挂在一场具体的伤病事件上（一个事件一条登记），
// 勾选的缺阵比赛可跨赛事、含已完赛（支持补录）；出阵不拦截，登记只是记录。
// 比赛页（挂在事件行下）建登记 / 改登记，球队页（挂在已有登记下）改登记 / 撤销。
import { useEffect, useState } from "react";
import { api } from "../api";
import { INJURY_CATALOG, suggestMissIds } from "../../shared/injuries";
import type {
  InjuryCandidatesResp,
  InjuryMissCandidateDTO,
  InjurySeverity,
  InjuryStatusDTO,
} from "../../shared/types";

const MATCH_STATUS: Record<"pending" | "live" | "finished", string> = {
  pending: "未开打",
  live: "进行中",
  finished: "已完赛",
};

export function InjuryRegPanel({
  eventId,
  teamId,
  severity,
  playerName,
  existing,
  busy,
  act,
  onSaved,
}: {
  eventId: number | null; // 新建登记必填（登记挂这条事件）；改已有登记可不传
  teamId: number;
  severity: InjurySeverity;
  playerName: string;
  existing: InjuryStatusDTO | undefined;
  busy: boolean;
  act: (fn: () => Promise<string | null>) => Promise<void>;
  onSaved: () => void;
}) {
  const [name, setName] = useState(existing?.injuryName ?? "");
  const [note, setNote] = useState(existing?.note ?? "");
  const [picked, setPicked] = useState<Set<number>>(
    () => new Set((existing?.misses ?? []).map((x) => x.matchId)),
  );
  const [cand, setCand] = useState<InjuryMissCandidateDTO[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  // 没手动改过勾选时跟随伤病名库的 suggestMiss 预勾（仅是辅助，随时可改）
  const [auto, setAuto] = useState(existing === undefined);

  useEffect(() => {
    let dead = false;
    api<InjuryCandidatesResp>(`/api/admin/injuries/candidates?teamId=${teamId}`)
      .then((b) => {
        if (!dead) setCand(b.candidates);
      })
      .catch((e: unknown) => {
        if (!dead) setLoadErr(e instanceof Error ? e.message : "加载候选比赛失败");
      });
    return () => {
      dead = true;
    };
  }, [teamId]);

  // 档位来自事件类型：轻伤事件只列轻伤名，重伤事件只列重伤名（后端同样校验）
  const options = INJURY_CATALOG.filter((it) => it.severity === severity);

  // 没手动改过勾选时跟随伤病名库的 suggestMiss 预勾（仅是辅助，随时可改）。
  // 写成 effect 而不是选名时顺手勾，是为了盖住时序：先选名、候选比赛后到，也能预勾。
  useEffect(() => {
    if (!cand || !auto) return;
    const open = cand.filter((x) => x.status !== "finished").map((x) => x.matchId);
    setPicked(new Set(suggestMissIds(open, name)));
  }, [cand, name, auto]);

  // existing 是异步拉来的（MatchesTab 先渲染面板、登记稍后到）：晚到时把登记内容灌进本地状态，
  // 否则保存会拿空表单走 PUT，把已有的伤名/备注/勾选清空。只在换了另一条登记时同步（按 id），
  // 保存后父组件重拉仍是同一条，用户刚填的内容不会被冲掉。
  const existingId = existing?.id ?? null;
  useEffect(() => {
    setName(existing?.injuryName ?? "");
    setNote(existing?.note ?? "");
    setPicked(new Set((existing?.misses ?? []).map((x) => x.matchId)));
    setAuto(existing === undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existingId]);

  const pickName = (n: string) => {
    setName(n);
  };
  const toggle = (id: number) => {
    setAuto(false);
    setPicked((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const save = () =>
    act(async () => {
      if (!existing && eventId == null) return "不知道要保存哪条登记，请关闭面板重开";
      const body = {
        injuryName: name || null,
        note: note || null,
        missMatchIds: [...picked],
      };
      if (existing) await api(`/api/admin/injuries/${existing.id}`, { method: "PUT", body });
      else if (eventId != null)
        await api("/api/admin/injuries", { method: "POST", body: { eventId, ...body } });
      onSaved();
      return existing
        ? `${playerName} 的伤停登记已更新`
        : `${playerName} 的伤停登记已建立（缺阵 ${picked.size} 场）`;
    });

  const revoke = () =>
    act(async () => {
      if (!existing) return null;
      await api(`/api/admin/injuries/${existing.id}`, { method: "DELETE" });
      onSaved();
      return `${playerName} 的伤停登记已撤销`;
    });

  // 候选按赛事分组：跨赛事勾选时能分清是哪届的场次
  const groups = new Map<number, { name: string; list: InjuryMissCandidateDTO[] }>();
  for (const x of cand ?? []) {
    const g = groups.get(x.tournamentId);
    if (g) g.list.push(x);
    else groups.set(x.tournamentId, { name: x.tournamentName, list: [x] });
  }

  return (
    <div className="injury-reg">
      <div className="injury-reg-head">
        伤停登记 · {playerName}（{severity === "minor" ? "轻伤" : "重伤"}）——缺阵场次可跨赛事勾选，已完赛的也能补录
      </div>
      <div className="injury-reg-row">
        <select className="input" value={name} onChange={(e) => pickName(e.target.value)}>
          <option value="">具体伤名（可选）</option>
          {options.map((it) => (
            <option key={it.name} value={it.name}>
              {it.name}（建议缺阵 {it.suggestMiss} 场）
            </option>
          ))}
        </select>
        <input
          className="input"
          value={note}
          maxLength={200}
          onChange={(e) => setNote(e.target.value)}
          placeholder="备注（可选，200 字内）"
        />
      </div>
      {loadErr && <p className="error-text">{loadErr}</p>}
      {cand === null && !loadErr && <p className="muted">候选比赛加载中…</p>}
      {cand !== null && cand.length === 0 && (
        <p className="muted">该队还没有比赛，缺阵场次可以之后再补。</p>
      )}
      {[...groups.entries()].map(([gid, g]) => (
        <div key={gid}>
          <div className="injury-reg-group">{g.name}</div>
          <div className="injury-reg-matches">
            {g.list.map((x) => (
              <label key={x.matchId}>
                <input
                  type="checkbox"
                  checked={picked.has(x.matchId)}
                  disabled={busy}
                  onChange={() => toggle(x.matchId)}
                />
                <span>
                  第 {x.round} 轮 · {x.homeTeamName ?? "待定"} vs {x.awayTeamName ?? "待定"}
                </span>
                <span className="ir-status">
                  {MATCH_STATUS[x.status]}
                  {x.status === "finished" ? "（补录）" : ""}
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {existing && (
        <span className="injury-reg-progress">
          已完赛 {existing.misses.filter((x) => x.status === "finished").length}/
          {existing.misses.length} 场，伤愈进度 {existing.recoverPercent}%
        </span>
      )}
      <div className="injury-reg-row">
        <button className="btn btn-sm" type="button" disabled={busy} onClick={save}>
          {existing ? (busy ? "保存中…" : "保存登记") : busy ? "提交中…" : "建立登记"}
        </button>
        {existing && (
          <button
            className="btn btn-sm btn-danger"
            type="button"
            disabled={busy}
            onClick={revoke}
          >
            撤销登记
          </button>
        )}
        <span className="muted">已勾选 {picked.size} 场</span>
      </div>
    </div>
  );
}
