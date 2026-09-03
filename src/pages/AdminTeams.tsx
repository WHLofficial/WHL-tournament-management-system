import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Page, SubmitButton, useSubmit } from "../components/ui";
import type { TeamDTO } from "../../shared/types";

export function AdminTeams() {
  const [teams, setTeams] = useState<TeamDTO[] | null>(null);
  const [name, setName] = useState("");
  const [paste, setPaste] = useState("");
  const createForm = useSubmit();
  const bulkForm = useSubmit();

  async function reload() {
    const data = await api<{ teams: TeamDTO[] }>("/api/admin/teams");
    setTeams(data.teams);
  }
  useEffect(() => {
    reload().catch(() => setTeams([]));
  }, []);

  function create(e: React.FormEvent) {
    e.preventDefault();
    void createForm.run(async () => {
      await api("/api/admin/teams", { method: "POST", body: { name } });
      setName("");
      createForm.setError(null);
      await reload();
    });
  }

  function bulk(e: React.FormEvent) {
    e.preventDefault();
    void bulkForm.run(async () => {
      const names = paste
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) throw new Error("请先粘贴队名，每行一个");
      const d = await api<{ created: number; skipped: string[] }>("/api/admin/teams/bulk", {
        method: "POST",
        body: { names },
      });
      let m = `新建 ${d.created} 支球队`;
      if (d.skipped.length > 0) m += `；已存在跳过：${d.skipped.join("、")}`;
      window.alert(m);
      setPaste("");
      bulkForm.setError(null);
      await reload();
    });
  }

  async function remove(team: TeamDTO) {
    if (!window.confirm(`删除球队「${team.name}」？`)) return;
    try {
      await api(`/api/admin/teams/${team.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <Page>
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事管理</Link>
          </p>
          <h2>球队库</h2>
        </div>
      </div>

      <div className="card">
        <h3>新建球队</h3>
        <form onSubmit={create} className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="球队名" />
          <SubmitButton busy={createForm.busy}>创建</SubmitButton>
        </form>
        {createForm.error && <p className="error-msg">{createForm.error}</p>}
      </div>

      <div className="card">
        <h3>批量建队</h3>
        <p className="muted">每行一个队名，一次最多 64 支；重名自动跳过。</p>
        <form onSubmit={bulk}>
          <textarea
            className="paste-box"
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"红狼队\n蓝鲨队\n雷霆队"}
          />
          <SubmitButton busy={bulkForm.busy}>批量创建</SubmitButton>
        </form>
        {bulkForm.error && <p className="error-msg">{bulkForm.error}</p>}
      </div>

      {teams === null ? (
        <p className="muted">加载中…</p>
      ) : teams.length === 0 ? (
        <p className="muted">球队库是空的。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>球队</th>
              <th>名单</th>
              <th>已报名赛事</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link to={`/admin/teams/${t.id}`}>{t.name}</Link>
                </td>
                <td>{t.playerCount}</td>
                <td>{t.entryCount}</td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={t.entryCount > 0}
                    title={t.entryCount > 0 ? "已报名赛事，请先移除报名" : undefined}
                    onClick={() => void remove(t)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
