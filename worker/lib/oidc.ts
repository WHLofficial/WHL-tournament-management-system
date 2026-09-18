// OIDC RP 侧小件（统一认证迁移步骤②，auth 项目 PRD P0-7，tour 降级）：
// 随机码 / 常数时间比较 / JWKS 缓存。签发侧在 auth 服务，这里只做客户端。
import { createRemoteJWKSet } from "jose";

// 两个 cookie 都用 __Host- 前缀：强制 Secure + 无 Domain + Path=/，
// 兄弟子域（Domain=whleague.win）撒的 cookie 无法覆盖——单系统被攻破不殃及会话。
// 127.0.0.1 属浏览器可信源，本地 http 开发同样能收 Secure cookie。
export const OIDC_SESSION_COOKIE = "__Host-tour_session";
// authorize 跳转前的 state/nonce/verifier 中转（10 分钟寿命，登录完成后即删）
export const OIDC_TEMP_COOKIE = "__Host-tour_oidc";
// 静默同步探测（prompt=none，进站即探测）的冷却标记：无会话访客 60 秒内不重复探测
// （60 秒足够打断「探测→回跳→再探测」循环；取长会摁住「别处刚登录回来」的同步）
export const OIDC_PROBE_COOKIE = "__Host-tour_probe";
export const PROBE_COOLDOWN_SECONDS = 60;

/** 只接受站内相对路径，防开放跳转与头部注入（静默探测的回跳地址） */
export function safeReturn(v: unknown): string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.includes("\\") || /[\r\n\t]/.test(v)) return "/";
  return v.slice(0, 512);
}

export const SESSION_TTL_SECONDS = 7 * 24 * 3600;

/** OIDC 模式 = AUTH_MODE 显式配 "oidc"（增量 9 显式化，TECH_DESIGN §9.1）+ 两项连接变量齐备；
 *  未配 AUTH_MODE = 兼容模式（共享 KV 会话）。不再靠 OIDC_ISSUER 的有无隐式判定——
 *  vars 随 wrangler.jsonc 一起部署，杜绝「忘配/半配悄悄改行为」。 */
export interface OidcEnv {
  AUTH_MODE: string;
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
}

export function isOidc(env: Partial<OidcEnv> | undefined): env is OidcEnv {
  return Boolean(env?.AUTH_MODE === "oidc" && env?.OIDC_ISSUER && env?.OIDC_CLIENT_ID);
}

/** base64url 随机串（32 字节 = 43 字符，也是合法的 PKCE verifier） */
export function randomB64url(bytes = 32): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlEncode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64urlDecode(s: string): string {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** PKCE S256 challenge：base64url(sha256(verifier))，恒 43 字符 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 常数时间字符串比较（state/nonce 校验用） */
export function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// JWKS 客户端按 issuer 缓存（jose 自带 30s 刷新冷却与 key 按 kid 命中）
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/jwks.json`));
    jwksCache.set(issuer, jwks);
  }
  return jwks;
}

export const BACKCHANNEL_LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
