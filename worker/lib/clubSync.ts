// 增量 37：球队建档双向同步（tour ↔ club）的机器通道。
//
// 为什么这里破例开了「推」：增量 33 的 worker/lib/clubRoster.ts 立过一条边界——名册只拉不推，
// 理由是「俱乐部平台不必知道赛事系统的存在，拉的一方负责对账，边界最干净」。那条边界对名册仍然成立
// （名册真源在 club，单向拉取没有歧义），但**球队建档是一次性事件、两侧都可能先发起**：
// 在 club 建俱乐部时 tour 可能还没有这支队，纯拉取要等一小时 cron，而且 tour 读不到 club 的库。
// 所以只对「建档」这一个写动作破例：两侧各开一个 HMAC 验签的入站端点，互相推送。
// 名册、报名、赛果、账目一律不动，仍是单向。
//
// 签名契约与仓内既有口径逐字一致（auth machine.ts / club notify.ts）：
// X-Sign = hex(HMAC-SHA256(secret, "POST|path|ts|raw"))，X-Timestamp 秒级 ±300s。
import type { AppEnv } from "../env";

export const TEAM_UPSERT_PATH = "/api/internal/team-upsert";

const TIMEOUT_MS = 10_000;
const CLOCK_SKEW_S = 300;

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 定长比较，避免用 === 逐字符短路（签名比对不该泄漏前缀命中长度） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type PushResult = { ok: true } | { ok: false; message: string };

/** 把推送结果摊平成响应里的错误文案（成功 null），供调用点直接拼进 JSON */
export function pushError(r: PushResult): string | null {
  return r.ok ? null : r.message;
}

/**
 * 出站：把本仓刚建的球队推给俱乐部平台建档。
 * 失败一律只回报、不抛——本地建队已经落库，同步失败是可重试的旁路（管理端有「同步」按钮，
 * club 侧还有对账页兜底），把整次建队回滚掉只会让管理员连队都建不成。
 */
export async function pushTeamToClub(
  env: AppEnv["Bindings"],
  { id, name, operator }: { id: number; name: string; operator?: number },
): Promise<PushResult> {
  const base = (env.CLUB_API_BASE ?? "").replace(/\/+$/, "");
  const secret = env.TEAM_SYNC_SECRET ?? "";
  if (!base) return { ok: false, message: "未配置 CLUB_API_BASE，无法同步到俱乐部平台" };
  if (!secret) return { ok: false, message: "未配置 TEAM_SYNC_SECRET，无法同步到俱乐部平台" };

  const raw = JSON.stringify(operator === undefined ? { id, name } : { id, name, operator });
  const ts = Math.floor(Date.now() / 1000);
  const sign = await hmacHex(secret, `POST|${TEAM_UPSERT_PATH}|${ts}|${raw}`);

  let res: Response;
  try {
    res = await fetch(`${base}${TEAM_UPSERT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-timestamp": String(ts), "x-sign": sign },
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, message: "俱乐部平台不可达" };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    const message = typeof body?.message === "string" ? body.message : "";
    return { ok: false, message: message || `俱乐部平台拒绝同步（HTTP ${res.status}）` };
  }
  return { ok: true };
}

/**
 * 入站验签，fail-closed：写端点不能像 cron 那样「密钥没配就默认放行」。
 * 返回 unconfigured / reject 由调用点分别给 503 与 403。
 */
export async function verifyTeamSyncSignature(
  env: AppEnv["Bindings"],
  rawBody: string,
  tsHeader: string | undefined,
  signHeader: string | undefined,
): Promise<"ok" | "unconfigured" | "reject"> {
  const secret = env.TEAM_SYNC_SECRET ?? "";
  if (!secret) return "unconfigured";
  const ts = Number(tsHeader);
  if (!signHeader || !Number.isFinite(ts)) return "reject";
  if (Math.abs(Date.now() / 1000 - ts) > CLOCK_SKEW_S) return "reject";
  const expected = await hmacHex(secret, `POST|${TEAM_UPSERT_PATH}|${ts}|${rawBody}`);
  return timingSafeEqual(expected, signHeader) ? "ok" : "reject";
}
