import type { Role } from "../shared/types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  /** 可选：会话 cookie 的 Domain 属性（如 ".example.com"），供同主域子系统共享登录态；不配则 host-only */
  COOKIE_DOMAIN?: string;
  /** 统一认证中心（迁移步骤②，auth 项目 PRD P0-7）：配置即 OIDC 模式；不配 = 兼容模式（共享 KV 会话） */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  /** 本地联调兜底：wrangler dev 对 custom_domain 路由会重写 request.url 的 origin，用环境变量盖回真实源 */
  OIDC_REDIRECT_ORIGIN?: string;
};

export type SessionUser = { id: number; name: string; role: Role; locked: boolean; mustChangePassword: boolean };

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: SessionUser | null };
};
