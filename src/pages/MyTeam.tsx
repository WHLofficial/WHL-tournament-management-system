import { useEffect, useState } from "react";
import { api } from "../api";
import { Page } from "../components/ui";
import { useAuth } from "../auth";
import type { PlayerDTO } from "../../shared/types";

// 我的球队：教练视角只读页；未绑定时给出认证码绑定入口。
interface MyTeam {
  id: number;
  name: string;
  players: PlayerDTO[];
  members: { id: number; name: string; joinedAt: string }[];
  entries: {
    id: number;
    tournamentName: string;
    status: string;
    groupName: string | null;
    seed: number;
  }[];
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  registering: "报名中",
  running: "进行中",
  archived: "已归档",
};

export default function MyTeam() {
  const { user } = useAuth();
  const [team, setTeam] = useState<MyTeam | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    const d = await api<{ team: MyTeam | null }>("/api/coach/me/team");
    setTeam(d.team);
  }
  useEffect(() => {
    reload().catch(() => setTeam(null));
  }, []);

  async function bind(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api("/api/coach/bind", { method: "POST", body: { code } });
      setCode("");
      await reload();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "绑定失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <div className="page-head">
        <h2>我的球队</h2>
      </div>

      {team === undefined && <p className="muted">加载中…</p>}

      {team === null && user?.locked && (
        <div className="card">
          <h3>观众账号</h3>
          <p className="muted">
            你的账号是观众号，暂时不能绑定球队。请联系管理员解锁，解锁后凭球队认证码绑队。
          </p>
        </div>
      )}

      {team === null && !user?.locked && (
        <div className="card">
          <h3>绑定球队</h3>
          <p className="muted">
            还没加入球队。找管理员要一个 8 位认证码，在下面输入就能绑定。
          </p>
          <form onSubmit={bind} className="inline-form">
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="认证码"
              maxLength={8}
              style={{ letterSpacing: "0.2em", textTransform: "uppercase" }}
            />
            <button className="btn btn-primary" disabled={busy || code.length !== 8}>
              绑定
            </button>
          </form>
          {err && <p className="error-msg">{err}</p>}
        </div>
      )}

      {team && (
        <>
          <p className="pub-head">
            <strong style={{ fontSize: "1.2em" }}>{team.name}</strong>
          </p>
          <p className="muted">
            名单由管理员维护，需要转会或增补球员就找管理员。
          </p>

          {team.entries.length > 0 && (
            <div className="card">
              <h3>参加的赛事</h3>
              <ul className="team-list">
                {team.entries.map((e) => (
                  <li key={e.id}>
                    {e.tournamentName}
                    <span className={`status-badge st-${e.status}`} style={{ marginLeft: 8 }}>
                      {STATUS_LABEL[e.status] ?? e.status}
                    </span>
                    {e.groupName && <span className="muted">（{e.groupName} 组）</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h3>球员名单（{team.players.length}）</h3>
          {team.players.length === 0 ? (
            <p className="muted">还没有录入球员。</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>号码</th>
                  <th>姓名</th>
                </tr>
              </thead>
              <tbody>
                {team.players.map((p) => (
                  <tr key={p.id}>
                    <td>{p.number ?? "—"}</td>
                    <td>{p.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>教练组（{team.members.length}）</h3>
          <p className="muted">{team.members.map((m) => m.name).join("、")}</p>
        </>
      )}
    </Page>
  );
}
