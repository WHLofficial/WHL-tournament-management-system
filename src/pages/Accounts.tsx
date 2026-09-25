import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Page } from "../components/ui";
import { useAuth } from "../auth";

// v2.0.0：账号真源在认证中心（auth）。本页只出界面——列表/角色/权限点/会话/停用全部经
// /api/admin/accounts/* 转发给 auth，本仓不再有自己的 user 表可写。

interface RoleRef {
  key: string;
  name: string;
}

interface Account {
  id: number;
  name: string;
  email: string | null;
  /** 观众号（无码注册）：仍可登录，但解锁前不能绑队 */
  locked: boolean;
  mustChangePassword: boolean;
  /** 停用：登录被拒、会话全吊销。与 locked 无关 */
  disabled: boolean;
  isSuper: boolean;
  createdAt: string;
  roles: RoleRef[];
  teamId: number | null;
  teamName: string | null;
}

interface SessionRow {
  /** 会话指纹（token_hash 前段），只用于定位，反推不出会话 token */
  sessionHash: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string | null;
  ip: string | null;
}

interface Detail {
  account: Account;
  roles: RoleRef[];
  grants: { key: string; description: string | null; grantedAt: string }[];
  sessions: SessionRow[];
  qq: string | null;
}

interface Catalog {
  apps: { clientId: string; name: string }[];
  roles: { id: number; appId: string | null; key: string; name: string }[];
  permissions: { id: number; appId: string; key: string; description: string | null }[];
  rolePermissions: { roleId: number; permissionId: number }[];
}

const APP_LABEL: Record<string, string> = { tour: "赛事", guess: "竞猜", club: "俱乐部", "": "全局" };
const appName = (id: string | null) => APP_LABEL[id ?? ""] ?? id ?? "全局";

const fmt = (t: string | null) => (t ? t.slice(0, 16).replace("T", " ") : "—");

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export function Accounts() {
  const { user } = useAuth();
  const [q, setQ] = useState("");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [cat, setCat] = useState<Catalog | null>(null);
  const [selId, setSelId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [roleDraft, setRoleDraft] = useState<string[]>([]);
  const [grantDraft, setGrantDraft] = useState<string[]>([]);
  const [tempPw, setTempPw] = useState<{ name: string; password: string; sessionsRevoked: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(keyword = q) {
    const d = await api<{ accounts: Account[] }>(
      `/api/admin/accounts${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`,
    );
    setAccounts(d.accounts);
  }

  async function open(id: number) {
    setSelId(id);
    setNotice(null);
    const d = await api<Detail>(`/api/admin/accounts/${id}`);
    setDetail(d);
    setRoleDraft(d.roles.map((r) => r.key));
    setGrantDraft(d.grants.map((g) => g.key));
  }

  useEffect(() => {
    void Promise.all([load(""), api<Catalog>("/api/admin/accounts/catalog").then(setCat)]).catch((e) =>
      setError(errText(e, "加载失败")),
    );
    // 只在首次挂载时拉一次目录（目录是静态的，auth 侧还缓存 60s）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 包一层：统一忙态、错误文案，成功后按需刷新 */
  async function run(fn: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e, fallback));
    } finally {
      setBusy(false);
    }
  }

  async function saveRoles() {
    if (selId === null) return;
    await run(async () => {
      const r = await api<{ changed: boolean }>(`/api/admin/accounts/${selId}/roles`, {
        method: "PATCH",
        body: { roles: roleDraft },
      });
      setNotice(r.changed ? "角色已更新（对方下次调用时生效）" : "角色没有变化");
      await Promise.all([open(selId), load()]);
    }, "保存角色失败");
  }

  async function saveGrants() {
    if (selId === null) return;
    await run(async () => {
      const r = await api<{ changed: boolean }>(`/api/admin/accounts/${selId}/grants`, {
        method: "PUT",
        body: { permissions: grantDraft },
      });
      setNotice(r.changed ? "额外权限已更新" : "额外权限没有变化");
      await open(selId);
    }, "保存权限失败");
  }

  async function resetPassword(a: Account) {
    if (!window.confirm(`重置「${a.name}」的密码？\n会生成临时密码，旧密码立即失效，且该账号所有登录（含其他设备、各系统）立即被踢下线。`))
      return;
    await run(async () => {
      const r = await api<{ tempPassword: string; sessionsRevoked: number }>(
        `/api/admin/accounts/${a.id}/reset-password`,
        { method: "POST" },
      );
      setTempPw({ name: a.name, password: r.tempPassword, sessionsRevoked: r.sessionsRevoked });
      setNotice(null);
      await Promise.all([load(), selId === a.id ? open(a.id) : Promise.resolve()]);
    }, "重置失败");
  }

  async function unlock(a: Account) {
    if (!window.confirm(`解锁「${a.name}」？解锁后就能凭认证码绑定球队。`)) return;
    await run(async () => {
      await api(`/api/admin/accounts/${a.id}/unlock`, { method: "POST" });
      await Promise.all([load(), selId === a.id ? open(a.id) : Promise.resolve()]);
    }, "解锁失败");
  }

  async function toggleDisable(a: Account) {
    const next = !a.disabled;
    if (
      next &&
      !window.confirm(`停用「${a.name}」？\n停用后对方无法登录，且所有会话（含各系统）立即失效。`)
    )
      return;
    await run(async () => {
      const r = await api<{ changed: boolean; sessionsRevoked: number }>(`/api/admin/accounts/${a.id}/disable`, {
        method: "POST",
        body: { disabled: next },
      });
      setNotice(
        r.changed
          ? next
            ? `已停用（顺带吊销 ${r.sessionsRevoked} 个会话）`
            : "已启用"
          : "状态没有变化",
      );
      await Promise.all([load(), selId === a.id ? open(a.id) : Promise.resolve()]);
    }, "操作失败");
  }

  async function revokeSessions(a: Account, sessionHash?: string) {
    const tip = sessionHash ? "把这条登录踢下线？" : `把「${a.name}」的全部登录踢下线？`;
    if (!window.confirm(tip)) return;
    await run(async () => {
      const r = await api<{ revoked: number }>(`/api/admin/accounts/${a.id}/sessions/revoke`, {
        method: "POST",
        body: sessionHash ? { sessionHash } : {},
      });
      setNotice(`已吊销 ${r.revoked} 个会话`);
      if (selId === a.id) await open(a.id);
    }, "强制下线失败");
  }

  // 角色带来的权限点（只读展示）+ 额外授予的权限点 = 有效权限
  const derivedPerms = new Set<string>();
  if (cat && detail) {
    const roleIds = new Set(
      cat.roles.filter((r) => detail.roles.some((d) => d.key === (r.appId === null ? r.key : `${r.appId}.${r.key}`))).map((r) => r.id),
    );
    for (const rp of cat.rolePermissions) if (roleIds.has(rp.roleId)) derivedPerms.add(String(rp.permissionId));
  }
  const permKeyOfId = new Map((cat?.permissions ?? []).map((p) => [String(p.id), p.key]));
  const derivedKeys = [...derivedPerms].map((id) => permKeyOfId.get(id) ?? id);
  const effectiveKeys = [...new Set([...derivedKeys, ...grantDraft])].sort();

  const toggle = (arr: string[], key: string, on: boolean) =>
    on ? [...new Set([...arr, key])] : arr.filter((k) => k !== key);

  const groupBy = <T,>(rows: T[], appOf: (r: T) => string | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = appOf(r) ?? "";
      m.set(k, [...(m.get(k) ?? []), r]);
    }
    return [...m.entries()].sort((a, b) => (a[0] === "" ? -1 : b[0] === "" ? 1 : a[0].localeCompare(b[0])));
  };

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
          账号真源在统一认证中心，这里的每个动作都会直接落到认证中心。找回密码：点「重置密码」生成临时密码发给对方，
          对方登录后会被要求先改密码（顺带把旧登录全部踢下线）。
        </p>
        {tempPw && (
          <p className="code-reveal">
            「{tempPw.name}」的临时密码（只显示这一次，赶紧复制发给对方；已顺带吊销 {tempPw.sessionsRevoked} 个会话）：
            <strong className="code-text">{tempPw.password}</strong>
          </p>
        )}
        {notice && <p className="hint">{notice}</p>}
        {error && <p className="error-msg">{error}</p>}

        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => load(q), "加载失败");
          }}
        >
          <input
            className="input-sm"
            placeholder="按昵称或邮箱搜"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="btn btn-sm" type="submit" disabled={busy}>
            搜索
          </button>
          {q && (
            <button
              className="btn btn-ghost btn-sm"
              type="button"
              onClick={() => {
                setQ("");
                void run(() => load(""), "加载失败");
              }}
            >
              清空
            </button>
          )}
        </form>

        {accounts === null ? (
          <p>加载中…</p>
        ) : accounts.length === 0 ? (
          <p className="muted">没有匹配的账号。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>昵称</th>
                <th>邮箱</th>
                <th>角色</th>
                <th>绑定球队</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className={selId === a.id ? "row-sel" : undefined}>
                  <td>{a.name}</td>
                  <td className="muted">{a.email ?? "—"}</td>
                  <td>
                    {a.roles.length ? (
                      <span className="chips">
                        {a.roles.map((r) => (
                          <span key={r.key} className="badge">
                            {r.name}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">无角色</span>
                    )}
                  </td>
                  <td>
                    {a.teamId && a.teamName ? <Link to={`/admin/teams/${a.teamId}`}>{a.teamName}</Link> : "—"}
                  </td>
                  <td>
                    {a.disabled && <span className="badge st-locked">已停用</span>}
                    {a.locked && <span className="badge">观众号</span>}
                    {a.mustChangePassword && <span className="badge">待改密</span>}
                    {!a.disabled && !a.locked && !a.mustChangePassword && <span className="muted">正常</span>}
                  </td>
                  <td>
                    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => open(a.id), "加载详情失败")}>
                      管理
                    </button>
                    {a.locked && (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void unlock(a)}>
                        解锁
                      </button>
                    )}
                    {!a.isSuper && (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resetPassword(a)}>
                        重置密码
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && cat && (
        <div className="card">
          <div className="page-head">
            <h3>
              {detail.account.name}
              {detail.account.isSuper && <span className="badge">超级管理员</span>}
              {detail.account.disabled && <span className="badge st-locked">已停用</span>}
            </h3>
            <div className="btn-col">
              {detail.account.id !== user?.id && !detail.account.isSuper && (
                <button
                  className={`btn btn-sm${detail.account.disabled ? "" : " btn-danger"}`}
                  disabled={busy}
                  onClick={() => void toggleDisable(detail.account)}
                >
                  {detail.account.disabled ? "启用账号" : "停用账号"}
                </button>
              )}
              {detail.account.id !== user?.id && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void resetPassword(detail.account)}>
                  重置密码
                </button>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setDetail(null)}>
                收起
              </button>
            </div>
          </div>
          <p className="muted">
            注册 {fmt(detail.account.createdAt)}
            {detail.account.email ? ` · ${detail.account.email}` : ""}
            {detail.qq ? ` · QQ ${detail.qq}` : ""}
            {detail.account.id === user?.id ? " · （这是你自己，不能停用或重置自己）" : ""}
            {detail.account.isSuper ? " · 超级管理员的角色与密码不能在管理台改动" : ""}
          </p>

          <h4>角色</h4>
          <p className="muted">
            勾选即生效（可多选叠加）。角色决定各系统的功能权限：「赛事」「竞猜」「俱乐部」各自独立，全局角色对所有系统生效。
          </p>
          {groupBy(cat.roles, (r) => r.appId).map(([app, roles]) => (
            <div className="perm-group" key={app}>
              <strong>{appName(app || null)}</strong>
              <div className="chips">
                {roles.map((r) => {
                  const key = r.appId === null ? r.key : `${r.appId}.${r.key}`;
                  const locked = key === "superadmin";
                  return (
                    <label className="perm-item" key={key} title={key}>
                      <input
                        type="checkbox"
                        checked={roleDraft.includes(key)}
                        disabled={locked || busy}
                        onChange={(e) => setRoleDraft((cur) => toggle(cur, key, e.target.checked))}
                      />
                      {r.name}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="btn-col">
            <button className="btn btn-sm" disabled={busy} onClick={() => void saveRoles()}>
              保存角色
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRoleDraft(detail.roles.map((r) => r.key))}>
              撤销改动
            </button>
          </div>

          <h4>额外权限点</h4>
          <p className="muted">
            一般不用动：角色已经带了对应的权限点。这里只用于「角色给不了、但这个人需要一个」的例外；
            勾选为追加，取消勾选只撤掉额外追加的那部分，角色带来的权限不受影响。
          </p>
          {groupBy(cat.permissions, (p) => p.appId).map(([app, perms]) => (
            <div className="perm-group" key={app}>
              <strong>{appName(app || null)}</strong>
              <div className="chips">
                {perms.map((p) => {
                  const fromRole = derivedKeys.includes(p.key);
                  return (
                    <label className="perm-item" key={p.key} title={`${p.key}${p.description ? ` · ${p.description}` : ""}`}>
                      <input
                        type="checkbox"
                        checked={fromRole || grantDraft.includes(p.key)}
                        disabled={fromRole || busy || detail.account.isSuper}
                        onChange={(e) => setGrantDraft((cur) => toggle(cur, p.key, e.target.checked))}
                      />
                      {p.description ?? p.key}
                      {fromRole && <span className="muted">（角色已有）</span>}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="btn-col">
            <button
              className="btn btn-sm"
              disabled={busy || detail.account.isSuper}
              onClick={() => void saveGrants()}
            >
              保存额外权限
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setGrantDraft(detail.grants.map((g) => g.key))}>
              撤销改动
            </button>
            <span className="muted">
              当前有效权限 {effectiveKeys.length} 个（角色 {derivedKeys.length} + 额外 {grantDraft.length}）
            </span>
          </div>

          <h4>活跃登录</h4>
          {detail.sessions.length === 0 ? (
            <p className="muted">当前没有活跃登录。</p>
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>登录 IP</th>
                    <th>登录时间</th>
                    <th>最后活跃</th>
                    <th>过期时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.sessions.map((s) => (
                    <tr key={s.sessionHash}>
                      <td className="muted">{s.ip ?? "—"}</td>
                      <td className="muted">{fmt(s.createdAt)}</td>
                      <td className="muted">{fmt(s.lastSeenAt)}</td>
                      <td className="muted">{fmt(s.expiresAt)}</td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => void revokeSessions(detail.account, s.sessionHash)}
                        >
                          强制下线
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="btn-col">
                <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void revokeSessions(detail.account)}>
                  全部踢下线
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </Page>
  );
}
