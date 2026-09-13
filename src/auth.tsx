import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { MeEnvelope, MeResp } from "../shared/types";

interface AuthState {
  user: MeResp | null;
  loading: boolean;
  /** 认证模式（统一认证迁移步骤②）：oidc = 入口指向认证中心；shared = 本站表单 */
  authMode: "oidc" | "shared";
  /** 认证中心地址，authMode=oidc 时非空 */
  authHome: string | null;
  refresh: () => Promise<void>;
  /** 登录接口已返回完整用户对象时直接落地，省一趟 /me 往返（仅兼容模式路径） */
  applyUser: (u: MeResp) => void;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  authMode: "shared",
  authHome: null,
  refresh: async () => {},
  applyUser: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState<AuthState["authMode"]>("shared");
  const [authHome, setAuthHome] = useState<string | null>(null);

  async function refresh() {
    try {
      // 后端把 user 与认证模式一起下发；对旧后端容错（缺字段按兼容模式处理）
      const d = await api<MeEnvelope>("/api/auth/me");
      setUser(d.user);
      setAuthMode(d.authMode ?? "shared");
      setAuthHome(d.authHome ?? null);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    if (authMode === "oidc") {
      // 本地行已在 POST 里吊销；跟着返回的 redirect 跳认证中心 end_session 联动全生态
      const r = await api<{ ok: boolean; redirect?: string }>("/api/auth/logout", {
        method: "POST",
      }).catch(() => null);
      setUser(null);
      if (r?.redirect) window.location.href = r.redirect;
      return;
    }
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }

  function applyUser(u: MeResp) {
    setUser(u);
    setAuthMode("shared");
    setAuthHome(null);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, authMode, authHome, refresh, applyUser, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}

export const ROLE_LABEL: Record<MeResp["role"], string> = {
  superadmin: "超管",
  admin: "管理员",
  coach: "教练",
};
