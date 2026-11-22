// 报分后公开 API purge：URL 清单与 best-effort 行为（docs/public-cache-purge.md）。
import { describe, expect, it, vi } from "vitest";
import { publicTournamentUrls, purgePublicUrls } from "../worker/lib/public-cache";

describe("publicTournamentUrls", () => {
  it("覆盖关键规范 URL 与轮次综述", () => {
    const urls = publicTournamentUrls("https://tour.test/", 1, 42, 7, 3);
    expect(urls).toContain("https://tour.test/api/public/tournaments/1/standings");
    expect(urls).toContain("https://tour.test/api/public/tournaments/1/toplists");
    expect(urls).toContain("https://tour.test/api/public/tournaments/1/matches/42");
    expect(urls).toContain("https://tour.test/api/public/tournaments/1/round/7/3");
    expect(urls).toContain("https://tour.test/api/public/matches/42/report");
    expect(urls).toHaveLength(20);
  });

  it("缺 stage/round 时省略轮次综述", () => {
    expect(publicTournamentUrls("https://tour.test", 1, 42)).toHaveLength(19);
  });
});

describe("purgePublicUrls", () => {
  it("缺 token 或 zone 时完全 no-op", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      await purgePublicUrls({}, ["https://x/a"]);
      await purgePublicUrls({ CLOUDFLARE_ZONE_ID: "z" }, ["https://x/a"]);
      await purgePublicUrls({ CLOUDFLARE_PURGE_TOKEN: "t" }, ["https://x/a"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("31 条按 30+1 分两片", async () => {
    const bodies: { files: string[] }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as { files: string[] });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    });
    try {
      await purgePublicUrls(
        { CLOUDFLARE_ZONE_ID: "z", CLOUDFLARE_PURGE_TOKEN: "t" },
        Array.from({ length: 31 }, (_, i) => `https://x/${i}`),
      );
      expect(bodies).toHaveLength(2);
      expect(bodies[0].files).toHaveLength(30);
      expect(bodies[1].files).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("非 2xx 只 warn 不抛", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        purgePublicUrls({ CLOUDFLARE_ZONE_ID: "z", CLOUDFLARE_PURGE_TOKEN: "t" }, ["https://x/a"]),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
