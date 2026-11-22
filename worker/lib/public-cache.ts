// 报分成功后的公开 API 缓存 purge（best-effort）。
// 设计见 docs/public-cache-purge.md：只清「报分后必然变化」的规范 URL，
// 查询变体（?stageId=&round= 等）靠 60s/300s TTL 兜底；未配 token/zone 完全 no-op。
import type { Bindings } from "../env";

const PURGE_BATCH = 30;

/** 一场比赛终场后需要主动失效的公开 URL（origin 不含尾斜杠）。 */
export function publicTournamentUrls(
  origin: string,
  tournamentId: number,
  matchId: number,
  stageId?: number,
  round?: number,
): string[] {
  const base = `${origin.replace(/\/+$/, "")}/api/public`;
  const t = `${base}/tournaments/${tournamentId}`;
  const m = `${t}/matches/${matchId}`;
  const urls = [
    // 300s 组
    `${base}/tournaments`,
    t,
    `${t}/standings`,
    `${t}/toplists`,
    `${t}/injuries`,
    `${t}/stats`,
    `${base}/home?limit=16`,
    `${base}/weekly`,
    // 60s 组
    `${base}/live`,
    `${base}/recent`,
    `${base}/upcoming`,
    `${t}/matches`,
    `${t}/matches/rounds`,
    `${t}/matches/summary`,
    m,
    `${m}/h2h`,
    `${m}/lineup`,
    `${m}/lineup-stats`,
    `${base}/matches/${matchId}/report`,
  ];
  if (stageId != null && round != null) {
    urls.push(`${t}/round/${stageId}/${round}`);
  }
  return urls;
}

/**
 * 按 Cloudflare Cache Purge API 清缓存。token/zone 缺一即 no-op；
 * 失败只 console.warn，不重试、不阻断报分。
 */
export async function purgePublicUrls(
  env: Pick<Bindings, "CLOUDFLARE_ZONE_ID" | "CLOUDFLARE_PURGE_TOKEN">,
  urls: string[],
): Promise<void> {
  const zone = env.CLOUDFLARE_ZONE_ID;
  const token = env.CLOUDFLARE_PURGE_TOKEN;
  if (!zone || !token || urls.length === 0) return;

  const unique = [...new Set(urls)];
  for (let i = 0; i < unique.length; i += PURGE_BATCH) {
    const files = unique.slice(i, i + PURGE_BATCH);
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zone)}/purge_cache`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ files }),
        },
      );
      const body = (await res.json().catch(() => null)) as { success?: boolean } | null;
      if (!res.ok || body?.success === false) {
        console.warn(
          `[public-cache] purge failed status=${res.status} files=${files.length}`,
        );
      }
    } catch (e) {
      console.warn(`[public-cache] purge error files=${files.length}`, e);
    }
  }
}
