import { useEffect, useState } from "react";
import { api } from "../api";
import { SubmitButton, useSubmit } from "./ui";
import type { AnnouncementDTO } from "../../shared/news";

type AdminAnnouncement = AnnouncementDTO & { active: boolean };
type FormEventLike = { preventDefault: () => void };

// 管理端公告卡：同一时刻至多一条上线；发布自动下线旧条；历史永久保留可复激活
export function AnnouncementAdmin() {
  const [list, setList] = useState<AdminAnnouncement[] | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();

  async function reload() {
    const d = await api<{ announcements: AdminAnnouncement[] }>("/api/admin/announcements");
    setList(d.announcements);
  }
  useEffect(() => {
    reload().catch(() => setList([]));
  }, []);

  function submit(e: FormEventLike) {
    e.preventDefault();
    void run(async () => {
      if (!title.trim() || !body.trim()) throw new Error("标题与正文不能为空");
      if (editingId == null) {
        await api("/api/admin/announcements", { method: "POST", body: { title, body } });
        setMsg("公告已发布，旧公告已自动下线");
      } else {
        await api(`/api/admin/announcements/${editingId}`, { method: "PUT", body: { title, body } });
        setMsg("公告已保存");
      }
      setTitle("");
      setBody("");
      setEditingId(null);
      setError(null);
      await reload();
    });
  }

  async function toggle(a: AdminAnnouncement) {
    void run(async () => {
      await api(`/api/admin/announcements/${a.id}`, { method: "PUT", body: { active: !a.active } });
      setMsg(a.active ? "公告已下线" : "公告已上线（其余公告自动下线）");
      await reload();
    });
  }

  return (
    <div className="card">
      <h3>首页公告</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        公告显示在头版首页顶部，同一时刻至多一条；发布新公告会自动下线旧条，历史可复激活。
      </p>
      <form onSubmit={submit}>
        <label className="field">
          标题
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="一句话公告（≤80 字）"
          />
        </label>
        <label className="field">
          正文
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={2000}
            placeholder="补充说明（可空行分段，≤2000 字）"
          />
        </label>
        {error && <p className="error-msg">{error}</p>}
        {msg && <p className="hint">{msg}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          <SubmitButton busy={busy}>{editingId == null ? "发布公告" : "保存修改"}</SubmitButton>
          {editingId != null && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setEditingId(null);
                setTitle("");
                setBody("");
              }}
            >
              取消编辑
            </button>
          )}
        </div>
      </form>

      {list !== null && list.length > 0 && (
        <div className="ann-list">
          {list.map((a) => (
            <div key={a.id} className="ann-item">
              <div className="ann-item-head">
                <span className={`status-badge ${a.active ? "st-live" : ""}`}>{a.active ? "上线中" : "已下线"}</span>
                <strong>{a.title}</strong>
                <span className="muted ann-time">
                  {new Date(a.updatedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <p className="ann-body">{a.body}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    setEditingId(a.id);
                    setTitle(a.title);
                    setBody(a.body);
                  }}
                >
                  编辑
                </button>
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void toggle(a)}>
                  {a.active ? "下线" : "重新上线"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
