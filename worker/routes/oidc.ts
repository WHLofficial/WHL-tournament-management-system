// 统一认证接入（迁移步骤②，auth 项目 PRD P0-7，tour 降级）：OIDC RP 端点。
// 配置 OIDC_ISSUER + OIDC_CLIENT_ID 即切换 OIDC 模式；未配置 = 兼容模式，
// 这些端点一律 404（登录/注册/改密走本站原表单），双模式在 session.ts 里互斥切换。
// 流程：authorize（PKCE S256，scope 只带 openid）→ 回调验签建本地会话
// → 登出先吊销本地行，浏览器再跳认证中心 end_session → back-channel 按 sid 吊销。
// 不调 userinfo：过渡期 sub 即 tour user id，姓名/角色现查本库 user 表（账号真源仍在 tour，
// 步骤③才收口），不信任令牌声明。
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { jwtVerify, type JWTPayload } from "jose";
import type { AppEnv } from "../env";
import { sha256Hex } from "../lib/crypto";
import {
  BACKCHANNEL_LOGOUT_EVENT,
  OIDC_SESSION_COOKIE,
  OIDC_TEMP_COOKIE,
  SESSION_TTL_SECONDS,
  b64urlDecode,
  b64urlEncode,
  isOidc,
  jwksFor,
  pkceChallenge,
  randomB64url,
  timingSafeEq,
} from "../lib/oidc";

type OidcAppEnv = AppEnv & { Bindings: { OIDC_ISSUER: string; OIDC_CLIENT_ID: string } };

function isOidcMode(env: AppEnv["Bindings"]): env is OidcAppEnv["Bindings"] {
  return isOidc(env);
}

// 回跳地址跟随当前请求源（本地 8797 / 线上 whleague.win 皆成立），必须与 auth 侧
// app 表 redirect_uris 白名单逐字一致。OIDC_REDIRECT_ORIGIN 仅为本地联调兜底：
// wrangler dev 对 custom_domain 路由会把 request.url 重写成无端口的域名形式
// （生产是 https，无此问题），万一 tour 以后声明 routes 可用环境变量盖回来。
function siteOrigin(c: { req: { url: string }; env: { OIDC_REDIRECT_ORIGIN?: string } }): string {
  return c.env.OIDC_REDIRECT_ORIGIN || new URL(c.req.url).origin;
}

function callbackUri(c: { req: { url: string }; env: { OIDC_REDIRECT_ORIGIN?: string } }): string {
  return siteOrigin(c) + "/api/auth/callback";
}

// ---------- 发起登录 ----------

const oidcRoutes = new Hono<OidcAppEnv>();

oidcRoutes.get("/login", async (c) => {
  if (!isOidcMode(c.env)) return c.json({ error: "not_found" }, 404);
  const state = randomB64url(16);
  const nonce = randomB64url(16);
  const verifier = randomB64url(32);
  // state/nonce/verifier 中转 10 分钟（防 CSRF 用 state，防重放用 nonce，防截码用 PKCE）
  setCookie(c, OIDC_TEMP_COOKIE, b64urlEncode(JSON.stringify({ state, nonce, verifier })), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
    secure: true, // __Host- 前缀强制；本地 127.0.0.1 属可信源
  });
  const q = new URLSearchParams({
    response_type: "code",
    client_id: c.env.OIDC_CLIENT_ID,
    redirect_uri: callbackUri(c),
    scope: "openid",
    state,
    nonce,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
  });
  return c.redirect(`${c.env.OIDC_ISSUER}/authorize?${q}`, 302);
});

// ---------- 回调建会话 ----------

type TempState = { state: string; nonce: string; verifier: string };

function parseTemp(raw: string): TempState | null {
  try {
    const t: unknown = JSON.parse(b64urlDecode(raw));
    if (
      typeof t !== "object" ||
      t === null ||
      typeof (t as TempState).state !== "string" ||
      typeof (t as TempState).nonce !== "string" ||
      typeof (t as TempState).verifier !== "string"
    ) {
      return null;
    }
    return t as TempState;
  } catch {
    return null;
  }
}

oidcRoutes.get("/callback", async (c) => {
  if (!isOidcMode(c.env)) return c.json({ error: "not_found" }, 404);
  const { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: clientId } = c.env;

  // RFC 9207：auth 回跳带 iss，先核对响应来自配的这个认证中心
  const iss = c.req.query("iss");
  if (iss !== undefined && iss !== issuer) {
    return c.json({ error: "oidc_iss_mismatch", message: "登录响应来源不对，请重新登录" }, 400);
  }

  const tempRaw = getCookie(c, OIDC_TEMP_COOKIE);
  const temp = tempRaw ? parseTemp(tempRaw) : null;
  if (!temp || !timingSafeEq(c.req.query("state") ?? "", temp.state)) {
    return c.json({ error: "oidc_state_invalid", message: "登录状态已失效，请重新登录" }, 400);
  }

  const code = c.req.query("code");
  if (!code) return c.json({ error: "oidc_no_code", message: "登录被取消或未完成，请重试" }, 400);

  // code 换票（公开 client，无 secret，凭 PKCE 自证）；非 200 一律 502，不向用户区分细节
  const tokenRes = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUri(c),
      client_id: clientId,
      code_verifier: temp.verifier,
    }),
  });
  const tokens = tokenRes.ok
    ? ((await tokenRes.json().catch(() => null)) as { id_token?: unknown } | null)
    : null;
  if (!tokens || typeof tokens.id_token !== "string") {
    return c.json({ error: "oidc_token_error", message: "认证中心换票失败，请稍后重试" }, 502);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(tokens.id_token, jwksFor(issuer), {
      issuer,
      audience: clientId,
      algorithms: ["RS256"],
    }));
  } catch {
    return c.json({ error: "oidc_verify_error", message: "登录凭证校验失败，请重新登录" }, 502);
  }
  if (!timingSafeEq(typeof payload.nonce === "string" ? payload.nonce : "", temp.nonce)) {
    return c.json({ error: "oidc_verify_error", message: "登录凭证校验失败，请重新登录" }, 502);
  }
  // sub 必须是数字串（过渡期 = tour user id，步骤③收口后即 auth 账号 id）；sid 供登出联动
  if (
    typeof payload.sub !== "string" ||
    !/^\d+$/.test(payload.sub) ||
    typeof payload.sid !== "string" ||
    !payload.sid
  ) {
    return c.json({ error: "oidc_claim_error", message: "登录凭证不完整，请重新登录" }, 502);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare("DELETE FROM oidc_session WHERE expires_at < ?").bind(now).run();
  const token = randomB64url(32);
  await c.env.DB.prepare(
    "INSERT INTO oidc_session (token_hash, sub, auth_sid, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(
      await sha256Hex(token),
      payload.sub,
      payload.sid,
      now,
      new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString(),
    )
    .run();

  setCookie(c, OIDC_SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
    secure: true, // __Host- 前缀强制；本地 127.0.0.1 属可信源
  });
  deleteCookie(c, OIDC_TEMP_COOKIE, { path: "/", secure: true });
  return c.redirect("/", 302);
});

// ---------- back-channel 登出通知（认证中心服务器间直呼，无 cookie） ----------

oidcRoutes.post("/backchannel-logout", async (c) => {
  if (!isOidcMode(c.env)) return c.json({ error: "not_found" }, 404);
  const form = await c.req.formData().catch(() => null);
  const token = form?.get("logout_token");
  if (typeof token !== "string" || !token) {
    return c.json({ error: "bad_request", message: "需要 logout_token" }, 400);
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, jwksFor(c.env.OIDC_ISSUER), {
      issuer: c.env.OIDC_ISSUER,
      audience: c.env.OIDC_CLIENT_ID,
      algorithms: ["RS256"],
    }));
  } catch {
    return c.json({ error: "bad_request", message: "logout_token 校验失败" }, 400);
  }
  const events = payload.events;
  if (typeof events !== "object" || events === null || !(BACKCHANNEL_LOGOUT_EVENT in events)) {
    return c.json({ error: "bad_request", message: "logout_token 缺少登出事件" }, 400);
  }
  if (payload.nonce !== undefined) {
    return c.json({ error: "bad_request", message: "logout_token 不应携带 nonce" }, 400);
  }
  if (typeof payload.sid !== "string" || !payload.sid) {
    return c.json({ error: "bad_request", message: "logout_token 缺少 sid" }, 400);
  }

  await c.env.DB.prepare(
    "UPDATE oidc_session SET revoked_at = ? WHERE auth_sid = ? AND revoked_at IS NULL",
  )
    .bind(new Date().toISOString(), payload.sid)
    .run();
  // 规范要求：成功回 200 空体（未知 sid 也算成功），失败回 400
  return c.body(null, 200);
});

export default oidcRoutes;
