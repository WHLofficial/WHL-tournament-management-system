import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Page } from "../components/ui";

// 增量 10（PRD P1-3）：审计日志查询。数据真源在认证中心 audit_log，本页经
// /api/admin/audit（worker 侧转发 auth /api/admin/audit/query）只读检索：
// 按账号 / 事件类型 / 时间窗筛选，id 倒序游标分页（「加载更多」）。

interface AuditEvent {
  id: number;
  accountId: number | null;
  event: string;
  detail: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
}

/** 常见事件提示（datalist，可自由输入；事件全集见 auth 仓 PERMISSIONS.md） */
const EVENT_HINTS = [
  "login.ok", "login.fail", "login.rate_limited", "register.ok", "register.rate_limited",
  "pw.change", "pw.reset", "pw.rehash", "logout", "session.revoke",
  "role.grant", "role.revoke", "perm.grant", "perm.revoke",
  "account.disable", "account.enable", "account.unlock",
  "signup_code.create", "org.open_reg", "bind.claim", "team.bind", "team.unbind",
];

const fmt = (t: string) => t.slice(0, 19).replace("T", " ");

/** datetime-local 值 → ISO；空/非法返回 null（不进筛选） */
const toIso = (v: string): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const detailText = (d: Record<string, unknown> | null) => {
  if (!d) return "—";
  const s = JSON.stringify(d);
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
};

export function AuditLog() {
  const [account, setAccount] = useState("");
  const [event, setEvent] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const query = useCallback(
    async (nextCursor: number | null) => {
      setBusy(true);
      setError(null);
      try {
        const p = new URLSearchParams();
        if (account.trim()) p.set("account", account.trim());
        if (event.trim()) p.set("event", event.trim());
        const sinceIso = toIso(since);
        if (sinceIso) p.set("since", sinceIso);
        const untilIso = toIso(until);
        if (untilIso) p.set("until", untilIso);
        if (nextCursor !== null) p.set("cursor", String(nextCursor));
        const d = await api<{ events: AuditEvent[]; nextCursor: number | null }>(
          `/api/admin/audit${p.toString() ? `?${p}` : ""}`,
        );
        setEvents((prev) => (nextCursor === null ? d.events : [...(prev ?? []), ...d.events]));
        setCursor(d.nextCursor);
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : "查询失败，请稍后再试");
      } finally {
        setBusy(false);
      }
    },
    [account, event, since, until],
  );

  // 首屏拉一次；改筛选条件只在点「查询」时生效，避免每敲一个字打一次后端
  const runFirstPage = useCallback(() => void query(null), [query]);
  useEffect(() => {
    runFirstPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Page>
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事管理</Link>
          </p>
          <h2>审计日志</h2>
        </div>
      </div>

      <div className="card">
        <p className="muted">
          统一认证中心记录的安全事件（登录、改密、授权变更、强制下线等），只读。账号 ID 见「账号管理」。
        </p>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            runFirstPage();
          }}
        >
          <input
            className="input-sm"
            type="number"
            min={1}
            placeholder="账号 ID"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            style={{ width: 110 }}
          />
          <input
            className="input-sm"
            list="audit-events"
            placeholder="事件类型（可留空）"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            style={{ width: 190 }}
          />
          <datalist id="audit-events">
            {EVENT_HINTS.map((k) => (
              <option key={k} value={k} />
            ))}
          </datalist>
          <label>
            从{" "}
            <input className="input-sm" type="datetime-local" value={since} onChange={(e) => setSince(e.target.value)} />
          </label>
          <label>
            到{" "}
            <input className="input-sm" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </label>
          <button className="btn btn-sm" type="submit" disabled={busy}>
            查询
          </button>
        </form>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {events === null ? (
        <p className="muted">{busy ? "查询中…" : ""}</p>
      ) : events.length === 0 ? (
        <p className="muted">没有符合条件的记录。</p>
      ) : (
        <div className="card">
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>事件</th>
                <th>账号</th>
                <th>IP</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{fmt(e.createdAt)}</td>
                  <td>
                    <code>{e.event}</code>
                  </td>
                  <td>{e.accountId ?? "—"}</td>
                  <td>{e.ip ?? "—"}</td>
                  <td className="muted" title={e.detail ? JSON.stringify(e.detail) : undefined}>
                    {detailText(e.detail)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {cursor !== null ? (
            <p>
              <button className="btn btn-ghost btn-sm" type="button" disabled={busy} onClick={() => void query(cursor)}>
                加载更多
              </button>
            </p>
          ) : null}
        </div>
      )}
    </Page>
  );
}
