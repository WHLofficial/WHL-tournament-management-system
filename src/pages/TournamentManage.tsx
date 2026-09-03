import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import ScheduleTab from "./ScheduleTab";
import MatchesTab from "./MatchesTab";
import { SubmitButton, useSubmit } from "../components/ui";
import { FORMAT_LABEL, NEXT_ACTIONS, STATUS_LABEL } from "../labels";
import type {
  EntryDTO,
  TeamDTO,
  TournamentDetailDTO,
  TournamentStatus,
} from "../../shared/types";

type Tab = "entries" | "schedule" | "matches" | "settings";

export function TournamentManage() {
  const { id } = useParams();
  const tournamentId = Number(id);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TournamentDetailDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("entries");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function reload() {
    try {
      setDetail(await api<TournamentDetailDTO>(`/api/admin/tournaments/${tournamentId}`));
    } catch {
      setMissing(true);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  async function transition(to: TournamentStatus, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api(`/api/admin/tournaments/${tournamentId}/transition`, {
        method: "POST",
        body: { to },
      });
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setActionBusy(false);
    }
  }

  if (missing)
    return (
      <div className="container">
        <p className="error-msg">赛事不存在。</p>
        <Link to="/admin">返回赛事列表</Link>
      </div>
    );
  if (!detail) return <div className="container">加载中…</div>;

  const t = detail.tournament;
  const actions = NEXT_ACTIONS[t.status];

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事列表</Link>
          </p>
          <h2>
            {t.name} <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          </h2>
          <p className="muted">
            {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
          </p>
        </div>
        <div className="btn-col">
          {actions.map((a) => (
            <button
              key={a.to}
              className="btn"
              disabled={actionBusy}
              onClick={() => void transition(a.to, a.confirm)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {actionError && <p className="error-msg">{actionError}</p>}

      <nav className="tabs">
        {(
          [
            ["entries", `报名 (${detail.entries.length})`],
            ["schedule", "编排"],
            ["matches", "比赛"],
            ["settings", "设置"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`tab${tab === key ? " tab-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "entries" && <EntriesTab detail={detail} reload={reload} />}
      {tab === "schedule" && <ScheduleTab detail={detail} reload={reload} />}
      {tab === "matches" && <MatchesTab detail={detail} reload={reload} />}
      {tab === "settings" && <SettingsTab detail={detail} reload={reload} onDeleted={() => navigate("/admin")} />}
    </div>
  );
}

function EntriesTab({ detail, reload }: { detail: TournamentDetailDTO; reload: () => Promise<void> }) {
  const t = detail.tournament;
  const editable = t.status === "draft" || t.status === "registering";
  const [paste, setPaste] = useState("");
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamId, setTeamId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    api<{ teams: TeamDTO[] }>("/api/admin/teams")
      .then((d) => setTeams(d.teams))
      .catch(() => setTeams([]));
  }, []);

  const entered = useMemo(() => new Set(detail.entries.map((e) => e.teamId)), [detail.entries]);
  const available = teams.filter((tm) => !entered.has(tm.id));

  function parseNames(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function bulkEnter(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      const names = parseNames(paste);
      if (names.length === 0) throw new Error("请先粘贴队名，每行一个");
      const d = await api<{
        createdEntries: number;
        createdTeams: number;
        skippedAlready: string[];
      }>(`/api/admin/tournaments/${t.id}/entries/bulk`, { method: "POST", body: { names } });
      let m = `新增报名 ${d.createdEntries} 支，新建球队 ${d.createdTeams} 支`;
      if (d.skippedAlready.length > 0) m += `；已在赛事中跳过：${d.skippedAlready.join("、")}`;
      setMsg(m);
      setPaste("");
      await reload();
    });
  }

  function addOne(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (!teamId) throw new Error("请选择球队");
      await api(`/api/admin/tournaments/${t.id}/entries`, {
        method: "POST",
        body: { teamId: Number(teamId) },
      });
      setTeamId("");
      setMsg(null);
      await reload();
    });
  }

  async function removeEntry(entry: EntryDTO) {
    if (!window.confirm(`把「${entry.teamName}」移出本赛事？`)) return;
    try {
      await api(`/api/admin/tournaments/${t.id}/entries/${entry.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "移除失败");
    }
  }

  return (
    <div>
      {!editable && (
        <p className="hint">已开赛：报名球队锁定；球员名单不受限，可随时在球队页调整（转会、新增）。</p>
      )}
      <div className="card">
        <h3>批量报名</h3>
        <p className="muted">从球队库批量报名；球队库里没有的队名会自动建队。每行一个队名。</p>
        <form onSubmit={bulkEnter}>
          <textarea
            className="paste-box"
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"红狼队\n蓝鲨队\n雷霆队"}
            disabled={!editable}
          />
          <SubmitButton busy={busy}>批量报名</SubmitButton>
        </form>
      </div>

      <div className="card">
        <h3>从球队库添加</h3>
        <form onSubmit={addOne} className="inline-form">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!editable}>
            <option value="">选择球队…</option>
            {available.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
          <SubmitButton busy={busy}>添加</SubmitButton>
        </form>
      </div>

      {msg && <p className="hint">{msg}</p>}
      {error && <p className="error-msg">{error}</p>}

      {detail.entries.length === 0 ? (
        <p className="muted">还没有球队报名。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>球队</th>
              <th>名单人数</th>
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {detail.entries.map((e) => (
              <tr key={e.id}>
                <td>{e.seed}</td>
                <td>
                  <Link to={`/admin/teams/${e.teamId}`}>{e.teamName}</Link>
                </td>
                <td>{e.playerCount}</td>
                {editable && (
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => void removeEntry(e)}>
                      移除
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SettingsTab({
  detail,
  reload,
  onDeleted,
}: {
  detail: TournamentDetailDTO;
  reload: () => Promise<void>;
  onDeleted: () => void;
}) {
  const t = detail.tournament;
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? "");
  const { busy, error, setError, run } = useSubmit();

  function save(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(`/api/admin/tournaments/${t.id}`, {
        method: "PATCH",
        body: { name, description },
      });
      setError(null);
      await reload();
    });
  }

  async function remove() {
    if (!window.confirm(`删除赛事「${t.name}」？此操作不可恢复。`)) return;
    try {
      await api(`/api/admin/tournaments/${t.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <div className="card">
      <h3>基本信息</h3>
      <form onSubmit={save}>
        <label className="field">
          赛事名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          简介（可选）
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error && <p className="error-msg">{error}</p>}
        <SubmitButton busy={busy}>保存</SubmitButton>
      </form>
      <hr className="divider" />
      <h3>危险操作</h3>
      <p className="muted">只能删除草稿或报名中的赛事；进行中/已归档的赛事会永久保留。</p>
      <button className="btn btn-danger" onClick={() => void remove()}>
        删除赛事
      </button>
    </div>
  );
}
