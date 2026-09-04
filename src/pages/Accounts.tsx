import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Page } from "../components/ui";
import { ROLE_LABEL, useAuth } from "../auth";

type Role = "coach" | "admin" | "superadmin";

const ROLE_TEXT = ROLE_LABEL;

interface Account {
  id: number;
  name: string;
  email: string | null;
  role: Role;
  locked: boolean;
  createdAt: string;
  teamId: number | null;
  teamName: string | null;
}

export function Accounts() {
  const { user } = useAuth();
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [resetPw, setResetPw] = useState<{ name: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const d = await api<{ accounts: Account[] }>("/api/admin/accounts");
    setAccounts(d.accounts);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  async function changeRole(a: Account, role: Role) {
    if (role === a.role) return;
    try {
      await api(`/api/admin/accounts/${a.id}/role`, { method: "PATCH", body: { role } });
      setError(null);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "修改失败");
      await load();
    }
  }

  async function resetPassword(a: Account) {
    if (!window.confirm(`重置「${a.name}」的密码？将生成一个临时密码，旧密码立即失效。`)) return;
    try {
      const r = await api<{ tempPassword: string }>(`/api/admin/accounts/${a.id}/reset-password`, {
        method: "POST",
      });
      setResetPw({ name: a.name, password: r.tempPassword });
      setError(null);
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "重置失败");
    }
  }

  async function unlock(a: Account) {
    if (!window.confirm(`解锁「${a.name}」？解锁后就能凭认证码绑定球队。`)) return;
    try {
      await api(`/api/admin/accounts/${a.id}/unlock`, { method: "POST" });
      setError(null);
      await load();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "解锁失败");
    }
  }

  return (
    <Page>
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事管理</Link>
          </p>
          <h2>账号管理</h2>
        </div>
      </div>

      <div className="card">
        <p className="muted">
          找回密码：点「重置密码」生成临时密码发给对方，对方登录后自己在右上角「改密码」里换成新密码。
        </p>
        {resetPw && (
          <p className="code-reveal">
            「{resetPw.name}」的临时密码（只显示这一次，赶紧复制发给对方）：
            <strong className="code-text">{resetPw.password}</strong>
          </p>
        )}
        {error && <p className="error-msg">{error}</p>}
        {accounts === null ? (
          <p>加载中…</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>昵称</th>
                <th>邮箱</th>
                <th>角色</th>
                <th>绑定球队</th>
                <th>注册时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => {
                const locked = a.role === "superadmin" || a.id === user?.id;
                return (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td className="muted">{a.email ?? "—"}</td>
                    <td>
                      {a.locked ? (
                        "观众（锁定）"
                      ) : locked ? (
                        ROLE_TEXT[a.role]
                      ) : (
                        <select
                          value={a.role}
                          onChange={(e) => void changeRole(a, e.target.value as Role)}
                        >
                          <option value="coach">教练</option>
                          <option value="admin">管理员</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {a.teamId && a.teamName ? (
                        <Link to={`/admin/teams/${a.teamId}`}>{a.teamName}</Link>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="muted">{a.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td>
                      {a.locked && (
                        <button className="btn btn-ghost" onClick={() => void unlock(a)}>
                          解锁
                        </button>
                      )}
                      {a.role !== "superadmin" && (
                        <button className="btn btn-ghost" onClick={() => void resetPassword(a)}>
                          重置密码
                        </button>
                      )}
                      {a.role === "superadmin" && !a.locked && <span className="muted">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
