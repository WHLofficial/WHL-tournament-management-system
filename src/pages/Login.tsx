import { useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { AuthForm, Field, SubmitButton, useSubmit } from "../components/ui";
import { useState, type FormEvent } from "react";
import type { MeResp } from "../../shared/types";

export function Login() {
  const { applyUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // 被 RequireRole 踢过来时带着原路径，登录完送回去
  const from = (location.state as { from?: string } | null)?.from ?? "/";
  const { busy, error, run } = useSubmit();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");

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
