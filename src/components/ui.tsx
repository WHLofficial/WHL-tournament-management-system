import { useState, type FormEvent, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { ROLE_LABEL, useAuth } from "../auth";
import { TopBar } from "../components/TopBar";

export function Page({ children }: { children: ReactNode }) {
  return (
    <>
      <TopBar />
      <main className="container">{children}</main>
    </>
  );
}

export function RequireRole({ roles, children }: { roles: string[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Page>加载中…</Page>;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!roles.includes(user.role))
    return (
      <Page>
        <p className="error-msg">需要 {roles.map((r) => ROLE_LABEL[r as keyof typeof ROLE_LABEL] ?? r).join(" / ")}权限。</p>
      </Page>
    );
  return <>{children}</>;
}

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
}) {
  return (
    <label className="field">
      {props.label}
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoComplete={props.autoComplete}
      />
    </label>
  );
}

export function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button className="btn" type="submit" disabled={busy}>
      {busy ? "处理中…" : children}
    </button>
  );
}

export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "出错了，请重试");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

export function AuthForm({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page>
      <div className="card auth-card">
        <h2>{title}</h2>
        {children}
      </div>
    </Page>
  );
}

export type { FormEvent };
