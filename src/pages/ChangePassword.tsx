import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { Page, SubmitButton, useSubmit } from "../components/ui";

export function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { refresh, authMode, authHome } = useAuth();
  const navigate = useNavigate();
  // 主动打开时可以关掉回退；强制盖卡没有关闭
  const goBack = () => (window.history.length > 1 ? navigate(-1) : navigate("/"));
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const form = useSubmit();

  // OIDC 模式：密码统一在认证中心管理（auth 改完写回本库并清 must_change_pw，盖卡自动消失）
  if (authMode === "oidc") {
    return (
      <Page>
        <div className="page-head">
          <div>
            <h2>改密码</h2>
          </div>
        </div>
        <div className="card">
          <p className="muted">
            {forced
              ? "密码刚被管理员重置，请到统一认证中心设置新密码，改完回到本站即可继续。"
              : "密码统一在认证中心管理，跳转后即可修改。"}
          </p>
          <a className="btn" href={authHome ? `${authHome}/password` : "/"}>
            去认证中心改密码
          </a>
        </div>
      </Page>
    );
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    void form.run(async () => {
      await api("/api/auth/password", {
        method: "POST",
        body: { oldPassword: oldPw, newPassword: newPw },
      });
      if (forced) {
        // 被重置场景：改完回主页（refresh 让盖卡自动消失）
        await refresh();
        navigate("/");
        return;
      }
      // 主动改密：改完回原页面
      goBack();
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
              <button type="button" className="btn btn-ghost" onClick={goBack}>
                关闭
              </button>
            )}
          </div>
        </form>
        {form.error && <p className="error-msg">{form.error}</p>}
      </div>
    </Page>
  );
}
