import { useLocation, useNavigate } from "react-router";
import { useEffect } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { AuthForm, Field, SubmitButton, useSubmit } from "../components/ui";
import { useState, type FormEvent } from "react";
import type { MeResp } from "../../shared/types";

export function Login() {
  const { applyUser, loading, authMode } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // 被 RequireRole 踢过来时带着原路径，登录完送回去
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { busy, error, run } = useSubmit();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

  // OIDC 模式：登录收口到认证中心，本页只负责把人送过去
  useEffect(() => {
    if (!loading && authMode === "oidc") window.location.href = "/api/auth/login";
  }, [loading, authMode]);

  // 认证模式没回来前先等一下，避免表单闪一下又被跳走
  if (loading) {
    return (
      <AuthForm title="登录">
        <p className="hint">加载中…</p>
      </AuthForm>
    );
  }
  if (authMode === "oidc") {
    return (
      <AuthForm title="登录">
        <p className="hint">登录已统一到 WHL 认证中心，正在跳转…</p>
        <p className="hint" style={{ marginTop: 12 }}>
          没有自动跳转？<a href="/api/auth/login">点这里继续</a>
        </p>
      </AuthForm>
    );
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      // 登录接口直接返回用户对象，落地后省一趟 /me 往返
      const me = await api<MeResp>("/api/auth/login", {
        method: "POST",
        body: { name, password },
      });
      applyUser(me);
      navigate(from);
    });
  }

  return (
    <AuthForm title="登录">
      <form onSubmit={onSubmit}>
        <Field label="昵称" value={name} onChange={setName} autoComplete="username" />
        <Field
          label="密码"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        {error && <p className="error-msg">{error}</p>}
        <SubmitButton busy={busy}>登录</SubmitButton>
      </form>
      <p className="hint" style={{ marginTop: 12 }}>
        还没有账号？<a href="/register">用注册码注册</a>
      </p>
    </AuthForm>
  );
}
