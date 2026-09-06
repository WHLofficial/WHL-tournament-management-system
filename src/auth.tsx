import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";
import type { MeResp } from "../shared/types";

interface AuthState {
  user: MeResp | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** 登录接口已返回完整用户对象时直接落地，省一趟 /me 往返 */
  applyUser: (u: MeResp) => void;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => {},
  applyUser: () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeResp | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setUser(await api<MeResp>("/api/auth/me"));
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
  }

  function applyUser(u: MeResp) {
    setUser(u);
    setLoading(false);
  }

  useEffect(() => {
    void refresh();
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, refresh, applyUser, logout }}>
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
