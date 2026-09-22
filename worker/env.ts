import type { Role } from "../shared/types";

export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  /** 增量 7：认证中心库（whl-auth）只读绑定——team 目录/绑定关系派生读；写通道走 lib/authClient */
  AUTH_DB?: D1Database;
  /** 增量 7：机器通道 HMAC 密钥（与 auth 服务端 BIND_SECRET 同值），发码/烧码/解绑验签用 */
  AUTH_BIND_SECRET?: string;
  /** 可选：会话 cookie 的 Domain 属性（如 ".example.com"），供同主域子系统共享登录态；不配则 host-only */
  COOKIE_DOMAIN?: string;
  /** 统一认证中心（迁移步骤②，auth 项目 PRD P0-7）：配置即 OIDC 模式；不配 = 兼容模式（共享 KV 会话） */
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  /** 本地联调兜底：wrangler dev 对 custom_domain 路由会重写 request.url 的 origin，用环境变量盖回真实源 */
  OIDC_REDIRECT_ORIGIN?: string;
  /** 增量 33：俱乐部平台基址（如 https://club.whleague.win）。名册同步从它的 /api/squads 拉一线队快照；
   *  不配 = 同步整体跳过（本地 dev 默认不配，免得开发和测试时去够生产） */
  CLUB_API_BASE?: string;
};

export type SessionUser = {
  id: number;
  name: string;
  role: Role;
  locked: boolean;
  mustChangePassword: boolean;
  /** 统一认证步骤③（auth P0-10）：OIDC 模式 = userinfo 下发的权限点；兼容模式 = []（判定走旧角色） */
  permissions: string[];
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: { user: SessionUser | null };
};
