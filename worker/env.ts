import type { Role } from "../shared/types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  /** 可选：会话 cookie 的 Domain 属性（如 ".example.com"），供同主域子系统共享登录态；不配则 host-only */
  COOKIE_DOMAIN?: string;
};

export type SessionUser = { id: number; name: string; role: Role; locked: boolean; mustChangePassword: boolean };

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: SessionUser | null };
};
