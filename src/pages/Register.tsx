import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { AuthForm, Field, SubmitButton, useSubmit } from "../components/ui";
import type { MeResp } from "../../shared/types";

export function Register() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { busy, error, run } = useSubmit();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [signupCode, setSignupCode] = useState("");
  const [email, setEmail] = useState("");

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (password !== password2) throw new Error("两次输入的密码不一致");
      await api<MeResp>("/api/auth/register", {
        method: "POST",
        body: { name, password, signupCode: signupCode.trim(), email: email.trim() || undefined },
      });
      await refresh();
      navigate("/");
    });
  }

  return (
    <AuthForm title="注册">
      <form onSubmit={onSubmit}>
        <Field label="昵称" value={name} onChange={setName} autoComplete="username" />
        <Field
          label="密码（至少 8 位，同时包含字母和数字）"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
        />
        <Field
          label="确认密码"
          type="password"
          value={password2}
          onChange={setPassword2}
          autoComplete="new-password"
        />
        <Field
          label="注册码（找管理员要；第一个注册的账号不需要）"
          value={signupCode}
          onChange={setSignupCode}
          placeholder="8 位注册码"
        />
        <Field label="邮箱（选填）" type="email" value={email} onChange={setEmail} />
        {error && <p className="error-msg">{error}</p>}
        <SubmitButton busy={busy}>注册</SubmitButton>
      </form>
      <p className="hint" style={{ marginTop: 12 }}>
        已有账号？<a href="/login">去登录</a>
      </p>
    </AuthForm>
  );
}
