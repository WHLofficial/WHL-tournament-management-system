import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Page, SubmitButton, useSubmit } from "../components/ui";
import type { PlayerDTO } from "../../shared/types";

interface TeamDetail {
  team: { id: number; name: string };
  players: PlayerDTO[];
}

interface AuthCodeRow {
  id: number;
  expiresAt: string | null;
  used: boolean;
  usedAt: string | null;
  createdAt: string;
}

interface MemberRow {
  userId: number;
  name: string;
  joinedAt: string;
}

export function TeamDetailPage() {
  const { id } = useParams();
  const teamId = Number(id);
  const [data, setData] = useState<TeamDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [codes, setCodes] = useState<AuthCodeRow[]>([]);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [name, setName] = useState("");
  const [playerName, setPlayerName] = useState("");
  const [playerNumber, setPlayerNumber] = useState("");
  const editForm = useSubmit();
  const playerForm = useSubmit();

  async function reload() {
    try {
      const d = await api<TeamDetail>(`/api/admin/teams/${teamId}`);
      setData(d);
      setName(d.team.name);
      const [cs, ms] = await Promise.all([
        api<{ codes: AuthCodeRow[] }>(`/api/admin/teams/${teamId}/auth-codes`),
        api<{ members: MemberRow[] }>(`/api/admin/teams/${teamId}/members`),
      ]);
      setCodes(cs.codes);
      setMembers(ms.members);
    } catch {
      setMissing(true);
    }
  }

  async function genCode() {
    try {
      const r = await api<{ code: string }>(`/api/admin/teams/${teamId}/auth-codes`, {
        method: "POST",
        body: { expiresInHours: 24 },
      });
      setNewCode(r.code);
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "生成失败");
    }
  }

  async function unbind(m: MemberRow) {
    if (!window.confirm(`将「${m.name}」移出球队？`)) return;
    try {
      await api(`/api/admin/teams/${teamId}/members/${m.userId}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "解绑失败");
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  if (missing)
    return (
      <Page>
        <p className="error-msg">球队不存在。</p>
        <Link to="/admin/teams">返回球队库</Link>
      </Page>
    );
  if (!data) return <Page>加载中…</Page>;

  function rename(e: React.FormEvent) {
    e.preventDefault();
    void editForm.run(async () => {
      await api(`/api/admin/teams/${teamId}`, { method: "PATCH", body: { name } });
      editForm.setError(null);
      await reload();
    });
  }

  function addPlayer(e: React.FormEvent) {
    e.preventDefault();
    void playerForm.run(async () => {
      await api(`/api/admin/teams/${teamId}/players`, {
        method: "POST",
        body: { name: playerName, number: playerNumber || null },
      });
      setPlayerName("");
      setPlayerNumber("");
      playerForm.setError(null);
      await reload();
    });
  }

  async function renamePlayer(p: PlayerDTO) {
    const newName = window.prompt("修改球员名", p.name);
    if (newName === null || !newName.trim()) return;
    try {
      await api(`/api/admin/teams/${teamId}/players/${p.id}`, {
        method: "PATCH",
        body: { name: newName.trim() },
      });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "修改失败");
    }
  }

  async function removePlayer(p: PlayerDTO) {
    if (!window.confirm(`删除球员「${p.name}」？`)) return;
    try {
      await api(`/api/admin/teams/${teamId}/players/${p.id}`, { method: "DELETE" });
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
            <Link to="/admin/teams">← 球队库</Link>
          </p>
          <h2>{data.team.name}</h2>
        </div>
      </div>

      <div className="card">
        <h3>队名</h3>
        <form onSubmit={rename} className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <SubmitButton busy={editForm.busy}>保存</SubmitButton>
        </form>
        {editForm.error && <p className="error-msg">{editForm.error}</p>}
      </div>

      <div className="card">
        <h3>录入球员</h3>
        <form onSubmit={addPlayer} className="inline-form">
          <input
            value={playerName}
            onChange={(e) => setPlayerName(e.target.value)}
            placeholder="姓名"
          />
          <input
            className="input-sm"
            value={playerNumber}
            onChange={(e) => setPlayerNumber(e.target.value)}
            placeholder="号码"
          />
          <SubmitButton busy={playerForm.busy}>添加</SubmitButton>
        </form>
        {playerForm.error && <p className="error-msg">{playerForm.error}</p>}
      </div>

      <div className="card">
        <h3>教练邀请</h3>
        <p className="muted">
          生成一个 8 位认证码发给教练，对方在「我的球队」页输入后就能绑定。认证码只能用一次，24 小时过期。
        </p>
        <button className="btn btn-primary" onClick={() => void genCode()}>
          生成认证码
        </button>
        {newCode && (
          <p className="code-reveal">
            新认证码（只显示这一次，赶紧复制）：
            <strong className="code-text">{newCode}</strong>
          </p>
        )}
        {codes.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>生成时间</th>
                <th>过期时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {codes.slice(0, 5).map((c) => (
                <tr key={c.id}>
                  <td>{c.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td>{c.expiresAt ? c.expiresAt.slice(0, 16).replace("T", " ") : "—"}</td>
                  <td>{c.used ? `已使用 ${c.usedAt?.slice(0, 16).replace("T", " ") ?? ""}` : "未使用"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {members.length > 0 && (
          <>
            <h3>已绑定教练</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>昵称</th>
                  <th>绑定时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name}</td>
                    <td>{m.joinedAt.slice(0, 16).replace("T", " ")}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => void unbind(m)}>
                        解绑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {data.players.length === 0 ? (
        <p className="muted">还没有球员，先录入名单。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>号码</th>
              <th>姓名</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.id}>
                <td>{p.number ?? "—"}</td>
                <td>{p.name}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => void renamePlayer(p)}>
                    改名
                  </button>{" "}
                  <button className="btn btn-ghost btn-sm" onClick={() => void removePlayer(p)}>
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
