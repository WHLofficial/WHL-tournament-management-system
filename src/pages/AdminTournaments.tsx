import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { Page, SubmitButton, useSubmit } from "../components/ui";
import { FORMAT_HINT, FORMAT_LABEL, STATUS_LABEL } from "../labels";
import type { TournamentDTO, TournamentFormat } from "../../shared/types";

export function AdminTournaments() {
  const navigate = useNavigate();
  const [tournaments, setTournaments] = useState<TournamentDTO[] | null>(null);
  const [name, setName] = useState("");
  const [format, setFormat] = useState<TournamentFormat>("single_elim");
  const { busy, error, setError, run } = useSubmit();

  async function reload() {
    const data = await api<{ tournaments: TournamentDTO[] }>("/api/admin/tournaments");
    setTournaments(data.tournaments);
  }
  useEffect(() => {
    reload().catch(() => setTournaments([]));
  }, []);

  function create(e: FormEventLike) {
    e.preventDefault();
    void run(async () => {
      if (!name.trim()) throw new Error("请填写赛事名称");
      const data = await api<{ id: number }>("/api/admin/tournaments", {
        method: "POST",
        body: { name, format },
      });
      setName("");
      setError(null);
      navigate(`/admin/t/${data.id}`);
    });
  }

  return (
    <Page>
      <div className="page-head">
        <h2>赛事管理</h2>
        <Link className="btn btn-ghost" to="/admin/teams">
          球队库
        </Link>
      </div>

      <div className="card">
        <h3>新建赛事</h3>
        <form onSubmit={create}>
          <label className="field">
            赛事名称
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：第五届 WHL 杯" />
          </label>
          <div className="format-cards">
            {(Object.keys(FORMAT_LABEL) as TournamentFormat[]).map((f) => (
              <label key={f} className={`format-card${format === f ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="format"
                  checked={format === f}
                  onChange={() => setFormat(f)}
                />
                <strong>{FORMAT_LABEL[f]}</strong>
                <span>{FORMAT_HINT[f]}</span>
              </label>
            ))}
          </div>
          {error && <p className="error-msg">{error}</p>}
          <SubmitButton busy={busy}>创建赛事</SubmitButton>
        </form>
      </div>

      {tournaments === null ? (
        <p className="muted">加载中…</p>
      ) : tournaments.length === 0 ? (
        <p className="muted">还没有赛事，先创建一个。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>赛事</th>
              <th>赛制</th>
              <th>状态</th>
              <th>报名数</th>
            </tr>
          </thead>
          <tbody>
            {tournaments.map((t) => (
              <tr key={t.id} className="row-link" onClick={() => navigate(`/admin/t/${t.id}`)}>
                <td>
                  <Link to={`/admin/t/${t.id}`} onClick={(e) => e.stopPropagation()}>
                    {t.name}
                  </Link>
                </td>
                <td>{FORMAT_LABEL[t.format]}</td>
                <td>
                  <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                </td>
                <td>{t.entryCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}

type FormEventLike = { preventDefault: () => void };
