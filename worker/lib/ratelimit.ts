// KV 固定窗口限流。KV 是最终一致，窗口边界少量超发对朋友局场景可接受。
export async function rateLimit(
  env: { KV: KVNamespace },
  key: string,
  limit: number,
  windowSec: number,
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  const cur = Number((await env.KV.get(k)) ?? 0);
  if (cur >= limit) return false;
  await env.KV.put(k, String(cur + 1), { expirationTtl: windowSec });
  return true;
}
