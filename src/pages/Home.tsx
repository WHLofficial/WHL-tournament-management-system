import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { FORMAT_LABEL, STATUS_LABEL } from "../labels";
import type { TournamentDTO } from "../../shared/types";

// 公开首页：所有非草稿赛事，无需登录。
export function Home() {
  const [list, setList] = useState<TournamentDTO[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ tournaments: TournamentDTO[] }>("/api/public/tournaments")
      .then((b) => setList(b.tournaments))
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载失败"));
  }, []);

  return (
    <>
      <main className="container">
      <h1>WHL 赛事</h1>
      {err && <p className="error-msg">{err}</p>}
      {list === null && !err && <p className="muted">加载中…</p>}
      {list !== null && list.length === 0 && (
        <p className="muted card">还没有赛事。管理员登录后可以创建。</p>
      )}
      <div className="home-list">
        {list?.map((t) => (
          <Link to={`/t/${t.id}`} key={t.id} className="home-card">
            <div className="home-card-head">
              <strong>{t.name}</strong>
              <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
            </div>
            {t.description && <p className="home-card-desc">{t.description}</p>}
            <p className="home-card-meta">
              {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
            </p>
          </Link>
        ))}
      </div>
      </main>
    </>
  );
}
