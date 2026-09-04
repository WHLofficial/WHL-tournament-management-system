import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Page, SubmitButton, useSubmit } from "../components/ui";

export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  // 主动打开时可以关掉回退；强制盖卡没有关闭
  const close = () => (window.history.length > 1 ? navigate(-1) : navigate("/"));
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [done, setDone] = useState(false);
  const form = useSubmit();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void form.run(async () => {
      await api("/api/auth/password", {
        method: "POST",
        body: { oldPassword: oldPw, newPassword: newPw },
      });
      if (forced) {
        // 强制模式下 refresh 完 AppShell 自动撤掉盖卡，无需跳转
        await refresh();
        return;
      }
      setDone(true);
      setOldPw("");
      setNewPw("");
      form.setError(null);
    });
  }

  return (
    <Page>
      <div className="page-head">
        <div>
          <h2>改密码</h2>
        </div>
      </div>

      <div className="card">
        {done ? (
          <>
            <p>密码已改好，下次登录用新密码。</p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setDone(false)}>
                再改一次
              </button>
              {!forced && (
                <button className="btn btn-ghost" onClick={close}>
                  关闭
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="muted">
              {forced
                ? "密码刚被管理员重置，请先设置你的新密码，改完才能继续使用。"
                : "如果密码是被超管重置的临时密码，在这里换成你自己的。"}
            </p>
            <form onSubmit={submit}>
              <label className="field">
                旧密码
                <input
                  type="password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label className="field">
                新密码（至少 8 位，同时包含字母和数字）
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                />
              </label>
              <div style={{ display: "flex", gap: 8 }}>
                <SubmitButton busy={form.busy}>保存新密码</SubmitButton>
                {!forced && (
                  <button type="button" className="btn btn-ghost" onClick={close}>
                    关闭
                  </button>
                )}
              </div>
            </form>
            {form.error && <p className="error-msg">{form.error}</p>}
          </>
        )}
      </div>
    </Page>
  );
}
