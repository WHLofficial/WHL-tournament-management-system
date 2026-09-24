import { Hono } from "hono";
import type { AppEnv, Bindings } from "../../env";
import {
  DEFAULT_TOURNAMENT_CONFIG,
  type EntryDTO,
  type PlayerDTO,
  type TournamentDTO,
} from "../../../shared/types";
import { defaultCrossTemplate } from "../../lib/seeding";
import { pushError, pushTeamToClub } from "../../lib/clubSync";
import { BULK_MAX, parseBulkLine } from "../../lib/teamBulk";
import {
  getTiebreakers,
  normalizeTiebreakers,
  readStageStandings,
  buildStandingsStmts,
} from "../../lib/standings";
import { buildStats } from "../../lib/topstats";
import {
  getSuspensionConfig,
  normalizeSuspensionInput,
  computeSuspensions,
  buildToplistsWithSuspension,
} from "../../lib/suspension";
import type { SuspensionConfig } from "../../../shared/types";
import { listTournamentActiveInjuries, listTournamentTeamInjuries } from "../../lib/injury";
import type { RankZoneSettings } from "../../../shared/types";
import {
  parseRankZoneSettings,
  validateRankZoneSettings,
} from "../../../shared/rankZones";
import { deleteImage, mediaUrl, saveImage } from "../../lib/media";
import { putDefaultCover } from "../../lib/defaultCover";
import { requireSuperadmin } from "../../middleware/auth";

type Status = TournamentDTO["status"];
const ALLOWED: Record<Status, Status[]> = {
  draft: ["registering"],
  registering: ["draft", "running"],
  running: ["archived"],
  archived: [],
};

const app = new Hono<AppEnv>();

// ---------- 赛事 ----------

app.get("/", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at, t.cover_key,
       (SELECT COUNT(*) FROM entry e WHERE e.tournament_id = t.id) AS entry_count
     FROM tournament t ORDER BY t.created_at DESC`
  ).all<{
    id: number;
    name: string;
    description: string | null;
    format: TournamentDTO["format"];
    status: Status;
    created_at: string;
    entry_count: number;
    cover_key: string | null;
  }>();
  const tournaments: TournamentDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    format: r.format,
    status: r.status,
    createdAt: r.created_at,
    entryCount: r.entry_count,
    coverUrl: mediaUrl(r.cover_key),
  }));
  return c.json({ tournaments });
});

app.post("/", async (c) => {
  const body = await c.req
    .json<{ name?: string; description?: string; format?: string }>()
    .catch(() => null);
  const name = body?.name?.trim();
  const format = body?.format as TournamentDTO["format"] | undefined;
  if (!name || name.length > 64) {
    return c.json({ message: "赛事名不能为空，且不超过 64 字" }, 400);
  }
  if (!format || (format !== "custom" && !(format in DEFAULT_TOURNAMENT_CONFIG))) {
    return c.json({ message: "赛制不合法" }, 400);
  }
  const cfg = DEFAULT_TOURNAMENT_CONFIG[format] ?? {};
  const r = await c.env.DB.prepare(
    "INSERT INTO tournament (org_id, name, description, format, status, config_json, created_by) VALUES (1, ?, ?, ?, 'draft', ?, ?)"
  )
    .bind(
      name,
      body?.description?.trim() || null,
      format,
      JSON.stringify(cfg),
      c.get("user")!.id
    )
    .run();
  const tid = Number(r.meta.last_row_id);

  // 按 format 生成阶段结构；custom = 空白编排，不建任何阶段，由管理员在编排页自建；
  // group_knockout 的小组行一并建好
  const stmts: D1PreparedStatement[] = [];
  const addStage = (kind: string, sortOrder: number, config: unknown) =>
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO stage (tournament_id, kind, sort_order, config_json) VALUES (?, ?, ?, ?)"
      ).bind(tid, kind, sortOrder, JSON.stringify(config))
    );
  if (format === "custom") {
    // 空白编排：什么都不建
  } else if (format === "single_elim") {
    addStage("elim", 1, cfg);
  } else if (format === "round_robin") {
    addStage("round_robin", 1, cfg);
  } else {
    const gc = cfg as { group_count?: number; qualify_per_group?: number };
    const groupCount = gc.group_count ?? 4;
    const q = gc.qualify_per_group ?? 2;
    const cross = defaultCrossTemplate(groupCount, q);
    addStage("group", 1, { ...cfg, cross });
    addStage("elim", 2, { legs: 1, source: { cross } });
    for (let i = 0; i < groupCount; i++) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO "group" (stage_id, name, sort_order)
           SELECT id, ?1, ?2 FROM stage WHERE tournament_id = ?3 AND kind = 'group'`
        ).bind(String.fromCharCode(65 + i), i, tid)
      );
    }
  }
  if (stmts.length > 0) await c.env.DB.batch(stmts);

  // 默认封面：创建时按赛事名生成一次，之后改名不重生成；生成失败不影响建赛
  try {
    const key = await putDefaultCover(c.env, tid, name);
    await c.env.DB.prepare("UPDATE tournament SET cover_key = ? WHERE id = ?").bind(key, tid).run();
  } catch {}

  return c.json({ id: tid }, 201);
});

// 详情：赛事 + 阶段 + 小组 + 报名名单
app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at, t.cover_key, t.config_json,
       (SELECT COUNT(*) FROM entry e WHERE e.tournament_id = t.id) AS entry_count
     FROM tournament t WHERE t.id = ?`
  )
    .bind(id)
    .first<{
      id: number;
      name: string;
      description: string | null;
      format: TournamentDTO["format"];
      status: Status;
      created_at: string;
      entry_count: number;
      cover_key: string | null;
      config_json: string | null;
    }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);

  const [stages, groups, entries, tiebreakers] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, kind, sort_order, name, config_json FROM stage WHERE tournament_id = ? ORDER BY sort_order"
    )
      .bind(id)
      .all<{ id: number; kind: "elim" | "round_robin" | "group"; sort_order: number; name: string | null; config_json: string }>(),
    c.env.DB.prepare(
      `SELECT g.id, g.stage_id, g.name, g.sort_order FROM "group" g
       JOIN stage s ON s.id = g.stage_id WHERE s.tournament_id = ?
       ORDER BY s.sort_order, g.sort_order`
    )
      .bind(id)
      .all<{ id: number; stage_id: number; name: string; sort_order: number }>(),
    c.env.DB.prepare(
      `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name, tm.logo_key,
         (SELECT COUNT(*) FROM player p WHERE p.team_id = e.team_id) AS player_count
       FROM entry e JOIN team tm ON tm.id = e.team_id
       WHERE e.tournament_id = ? ORDER BY e.seed`
    )
      .bind(id)
      .all<{
        id: number;
        team_id: number;
        seed: number;
        group_id: number | null;
        points_deducted: number;
        team_name: string;
        logo_key: string | null;
        player_count: number;
      }>(),
    getTiebreakers(c.env.DB, id),
  ]);

  const detail = {
    tournament: {
      id: t.id,
      name: t.name,
      description: t.description,
      format: t.format,
      status: t.status,
      createdAt: t.created_at,
      entryCount: t.entry_count,
      coverUrl: mediaUrl(t.cover_key),
    } satisfies TournamentDTO,
    stages: stages.results.map((s) => ({
      id: s.id,
      kind: s.kind,
      sortOrder: s.sort_order,
      name: s.name,
      config: JSON.parse(s.config_json || "{}"),
    })),
    groups: groups.results.map((g) => ({
      id: g.id,
      stageId: g.stage_id,
      name: g.name,
      sortOrder: g.sort_order,
    })),
    entries: entries.results.map(
      (e): EntryDTO => ({
        id: e.id,
        teamId: e.team_id,
        teamName: e.team_name,
        seed: e.seed,
        groupId: e.group_id,
        playerCount: e.player_count,
        pointsDeducted: e.points_deducted,
        teamLogoUrl: mediaUrl(e.logo_key),
      })
    ),
    tiebreakers,
    rankZones: parseRankZoneSettings(t.config_json),
  };
  return c.json(detail);
});

// GET /:id/standings：小组/循环阶段的积分榜（已按 积分→净胜→进球→相互战绩 排序）
app.get("/:id/standings", async (c) => {
  const id = Number(c.req.param("id"));
  const standings = await readStageStandings(c.env.DB, id);
  const t = await c.env.DB.prepare("SELECT config_json FROM tournament WHERE id = ?")
    .bind(id)
    .first<{ config_json: string | null }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);
  return c.json({
    standings,
    rankZones: parseRankZoneSettings(t.config_json),
  });
});

app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{
      name?: string;
      description?: string;
      config_json?: Record<string, unknown>;
      tiebreakers?: unknown;
      rankZones?: unknown;
    }>()
    .catch(() => null);
  if (body?.name !== undefined) {
    const name = body.name.trim();
    if (!name || name.length > 64) {
      return c.json({ message: "赛事名不能为空，且不超过 64 字" }, 400);
    }
    await c.env.DB.prepare("UPDATE tournament SET name = ? WHERE id = ?")
      .bind(name, id)
      .run();
  }
  if (body?.description !== undefined) {
    await c.env.DB.prepare(
      "UPDATE tournament SET description = ? WHERE id = ?"
    )
      .bind(body.description.trim() || null, id)
      .run();
  }
  if (body?.config_json !== undefined) {
    const sync = await syncStageConfigs(c.env, id, body.config_json);
    if (sync !== true) return c.json({ message: sync }, 400);
  }
  // 同分规则：只动 tournament.config_json.tiebreakers，不经 syncStageConfigs——
  // 它影响排名口径而非赛制，开赛后也允许改
  if (body?.tiebreakers !== undefined) {
    const chain = normalizeTiebreakers(body.tiebreakers);
    const row = await c.env.DB.prepare(
      "SELECT config_json FROM tournament WHERE id = ?"
    )
      .bind(id)
      .first<{ config_json: string | null }>();
    if (!row) return c.json({ message: "赛事不存在" }, 404);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = (JSON.parse(row.config_json || "{}") ?? {}) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    cfg.tiebreakers = chain;
    await c.env.DB.prepare("UPDATE tournament SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify(cfg), id)
      .run();
  }
  // 排名段标记：只动 tournament.config_json.rankZones / rankZoneStyle，不经 syncStageConfigs——
  // 纯展示配置，开赛后也允许改
  if (body?.rankZones !== undefined) {
    const zones = validateRankZoneSettings(body.rankZones);
    if (typeof zones === "string") return c.json({ message: zones }, 400);
    const scopeErr = await checkRankZoneScope(c.env, id, zones.zones);
    if (scopeErr) return c.json({ message: scopeErr }, 400);
    const row = await c.env.DB.prepare(
      "SELECT config_json FROM tournament WHERE id = ?"
    )
      .bind(id)
      .first<{ config_json: string | null }>();
    if (!row) return c.json({ message: "赛事不存在" }, 404);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = (JSON.parse(row.config_json || "{}") ?? {}) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    cfg.rankZoneStyle = zones.style;
    cfg.rankZones = zones.zones;
    await c.env.DB.prepare("UPDATE tournament SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify(cfg), id)
      .run();
  }
  return c.json({ ok: true });
});

// 排名段标记的 scope 引用必须属于本赛事（stage/group 存在性）
async function checkRankZoneScope(
  env: Bindings,
  tid: number,
  zones: RankZoneSettings["zones"]
): Promise<string | null> {
  const stageIds = new Set(
    zones.filter((z) => z.scope.kind === "stage").map((z) => (z.scope as { stageId: number }).stageId)
  );
  const groupIds = new Set(
    zones.filter((z) => z.scope.kind === "group").map((z) => (z.scope as { groupId: number }).groupId)
  );
  for (const sid of stageIds) {
    const row = await env.DB.prepare(
      "SELECT id FROM stage WHERE id = ? AND tournament_id = ?"
    )
      .bind(sid, tid)
      .first();
    if (!row) return "排名段标记引用了不属于本赛事的阶段";
  }
  for (const gid of groupIds) {
    const row = await env.DB.prepare(
      `SELECT g.id FROM "group" g JOIN stage s ON s.id = g.stage_id
       WHERE g.id = ? AND s.tournament_id = ?`
    )
      .bind(gid, tid)
      .first();
    if (!row) return "排名段标记引用了不属于本赛事的小组";
  }
  return null;
}

// 赛制参数改动（legs/loops/组数/出线数）同步到各阶段 config；
// 已有开打或完赛场次时拒绝，避免赛中被改赛制
async function syncStageConfigs(
  env: Bindings,
  tid: number,
  patch: Record<string, unknown>
): Promise<true | string> {
  const t = await env.DB.prepare(
    "SELECT format, config_json FROM tournament WHERE id = ?"
  )
    .bind(tid)
    .first<{ format: TournamentDTO["format"]; config_json: string }>();
  if (!t) return "赛事不存在";
  const started =
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM match WHERE stage_id IN
           (SELECT id FROM stage WHERE tournament_id = ?) AND status IN ('live','finished')`
      )
        .bind(tid)
        .first<{ n: number }>()
    )?.n ?? 0;
  if (started > 0) return "已有开打或完赛的场次，不能修改赛制参数";

  const base = JSON.parse(t.config_json || "{}") as Record<string, unknown>;
  const cfg = { ...base, ...patch };
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE tournament SET config_json = ? WHERE id = ?").bind(
      JSON.stringify(cfg),
      tid
    ),
  ];

  // 按阶段类型定向应用可改字段（不再按赛事 format 全量覆盖——
  // 多阶段混搭时改循环赛参数不会污染小组赛配置）
  const KEY_BY_KIND: Record<string, string[]> = {
    elim: ["legs", "final_legs", "third_place"],
    round_robin: ["loops"],
    group: ["group_count", "group_size", "loops", "qualify_per_group"],
  };
  const merge = (existing: string | null, keys: string[]): Record<string, unknown> => {
    const cur = (JSON.parse(existing || "{}") ?? {}) as Record<string, unknown>;
    for (const k of keys) if (k in patch) cur[k] = patch[k];
    return cur;
  };

  const stages = await env.DB.prepare(
    "SELECT id, kind, config_json FROM stage WHERE tournament_id = ?"
  )
    .bind(tid)
    .all<{
      id: number;
      kind: "elim" | "round_robin" | "group";
      config_json: string | null;
    }>();
  let hasGroup = false;
  for (const st of stages.results ?? []) {
    const keys = KEY_BY_KIND[st.kind];
    if (!keys) continue;
    const merged = merge(st.config_json, keys);
    if (st.kind === "group") {
      hasGroup = true;
      // 组数/出线数变化时重算跨组模板（组行重建在下面处理）
      if ("group_count" in patch || "qualify_per_group" in patch) {
        merged.cross = defaultCrossTemplate(
          Number(merged.group_count ?? 4),
          Number(merged.qualify_per_group ?? 2)
        );
      }
    }
    stmts.push(
      env.DB.prepare("UPDATE stage SET config_json = ? WHERE id = ?").bind(
        JSON.stringify(merged),
        st.id
      )
    );
  }
  // 淘汰阶段：赛事有小组赛时其跨组对阵跟随模板（纯 single_elim 没有来源，不动）
  if (hasGroup && "group_count" in patch) {
    const elimStage = await env.DB.prepare(
      "SELECT config_json FROM stage WHERE tournament_id = ? AND kind = 'elim'"
    )
      .bind(tid)
      .first<{ config_json: string | null }>();
    const elimCfg = (JSON.parse(elimStage?.config_json || "{}") ?? {}) as Record<string, unknown>;
    const src = (elimCfg.source ?? {}) as Record<string, unknown>;
    stmts.push(
      env.DB.prepare(
        "UPDATE stage SET config_json = ? WHERE tournament_id = ? AND kind = 'elim'"
      ).bind(
        JSON.stringify({
          ...elimCfg,
          source: {
            ...src,
            cross: defaultCrossTemplate(
              Number(patch.group_count),
              Number(patch.qualify_per_group ?? 2)
            ),
          },
        }),
        tid
      )
    );
  }
  // 组数变化时重建小组行（分组关系一并清空，需重新抽签；该组未开赛场次级联清除）
  if ("group_count" in patch) {
    const groupCount = Number(patch.group_count);
    const oldCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM "group" g JOIN stage s ON s.id = g.stage_id
       WHERE s.tournament_id = ? AND s.kind = 'group'`
    )
      .bind(tid)
      .first<{ n: number }>();
    if ((oldCount?.n ?? 0) !== groupCount) {
      const groupStage = await env.DB.prepare(
        "SELECT id FROM stage WHERE tournament_id = ? AND kind = 'group'"
      )
        .bind(tid)
        .first<{ id: number }>();
      if (groupStage) {
        stmts.push(
          env.DB.prepare(
            'UPDATE entry SET group_id = NULL WHERE group_id IN (SELECT id FROM "group" WHERE stage_id = ?)'
          ).bind(groupStage.id)
        );
        stmts.push(
          env.DB.prepare('DELETE FROM "group" WHERE stage_id = ?').bind(groupStage.id)
        );
        for (let i = 0; i < groupCount; i++) {
          stmts.push(
            env.DB.prepare(
              'INSERT INTO "group" (stage_id, name, sort_order) VALUES (?, ?, ?)'
            ).bind(groupStage.id, String.fromCharCode(65 + i), i)
          );
        }
      }
    }
  }
  await env.DB.batch(stmts);
  return true;
}

// 状态机：draft → registering → (draft | running) → archived
app.post("/:id/transition", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ to?: string }>().catch(() => null);
  const to = body?.to as Status | undefined;
  const t = await c.env.DB.prepare(
    "SELECT status FROM tournament WHERE id = ?"
  )
    .bind(id)
    .first<{ status: Status }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);
  if (!to || !ALLOWED[t.status].includes(to)) {
    return c.json({ message: `不能从「${t.status}」切换到「${to ?? "?"}」` }, 400);
  }
  await c.env.DB.prepare("UPDATE tournament SET status = ? WHERE id = ?")
    .bind(to, id)
    .run();
  return c.json({ ok: true });
});

app.delete("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    "SELECT status FROM tournament WHERE id = ?"
  )
    .bind(id)
    .first<{ status: Status }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);
  if (t.status === "running" || t.status === "archived") {
    return c.json({ message: "进行中或已归档的赛事不能删除，只能归档保留" }, 409);
  }
  await c.env.DB.prepare("DELETE FROM tournament WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------- 报名 ----------

async function guardRegistration(env: Bindings, id: number) {
  const t = await env.DB.prepare(
    "SELECT status FROM tournament WHERE id = ?"
  )
    .bind(id)
    .first<{ status: Status }>();
  if (!t) return { error: "赛事不存在", status: 404 as const };
  if (t.status !== "draft" && t.status !== "registering") {
    return { error: "开赛后不能改动报名名单", status: 409 as const };
  }
  return null;
}

// 单队报名
app.post("/:id/entries", async (c) => {
  const id = Number(c.req.param("id"));
  const guard = await guardRegistration(c.env, id);
  if (guard) return c.json({ message: guard.error }, guard.status);

  const body = await c.req.json<{ teamId?: number }>().catch(() => null);
  const teamId = Number(body?.teamId);
  if (!teamId) return c.json({ message: "请选择球队" }, 400);
  const team = await c.env.DB.prepare("SELECT id FROM team WHERE id = ?")
    .bind(teamId)
    .first();
  if (!team) return c.json({ message: "球队不存在" }, 404);

  const dup = await c.env.DB.prepare(
    "SELECT id FROM entry WHERE tournament_id = ? AND team_id = ?"
  )
    .bind(id, teamId)
    .first();
  if (dup) return c.json({ message: "该球队已在本赛事中" }, 409);

  const seedRow = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(seed), 0) + 1 AS next FROM entry WHERE tournament_id = ?"
  )
    .bind(id)
    .first<{ next: number }>();
  await c.env.DB.prepare(
    "INSERT INTO entry (tournament_id, team_id, seed) VALUES (?, ?, ?)"
  )
    .bind(id, teamId, seedRow!.next)
    .run();
  return c.json({ ok: true }, 201);
});

// 批量报名（增量 37）：每行「游戏球队 ID 队名」。
// 队号是真身（= 本仓 team.id = 俱乐部平台 clubs.id），球队库里没有这个 ID 就按它建队
// 并推给俱乐部平台建档；库里已有该 ID 时以库里的队名为准（行里的名字只用于新建）。
app.post("/:id/entries/bulk", async (c) => {
  const id = Number(c.req.param("id"));
  const guard = await guardRegistration(c.env, id);
  if (guard) return c.json({ message: guard.error }, guard.status);

  const body = await c.req.json<{ lines?: unknown }>().catch(() => null);
  const lines = (Array.isArray(body?.lines) ? body.lines.map((l) => String(l).trim()) : []).filter(Boolean);
  if (lines.length === 0) return c.json({ message: "没有可用的行" }, 400);
  if (lines.length > BULK_MAX) return c.json({ message: `一次最多报名 ${BULK_MAX} 支球队` }, 400);

  const skipped: { line: number; reason: string }[] = [];
  const parsed: { id: number; name: string; line: number }[] = [];
  const seenId = new Set<number>();
  const seenName = new Set<string>();
  lines.forEach((line, i) => {
    const n = i + 1;
    const p = parseBulkLine(line);
    if ("error" in p) return void skipped.push({ line: n, reason: p.error });
    if (seenId.has(p.id)) return void skipped.push({ line: n, reason: `本批内 ID #${p.id} 重复` });
    if (seenName.has(p.name)) return void skipped.push({ line: n, reason: `本批内队名「${p.name}」重复` });
    seenId.add(p.id);
    seenName.add(p.name);
    parsed.push({ ...p, line: n });
  });

  const ids = parsed.map((p) => p.id);
  const known = ids.length
    ? (await c.env.DB.prepare(`SELECT id, name FROM team WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: number; name: string }>()).results
    : [];
  const knownById = new Map(known.map((r) => [r.id, r.name]));

  // 行里的名字与库里不一致：登记照做，但回报出来（改名不联动，别让人以为改掉了）
  const nameMismatch = parsed
    .filter((p) => knownById.has(p.id) && knownById.get(p.id) !== p.name)
    .map((p) => ({ id: p.id, name: knownById.get(p.id)!, input: p.name }));

  // 待建的队：先排掉队名已被别的球队占用的行，否则整批 batch 会因唯一约束一起失败
  const candidates = parsed.filter((p) => !knownById.has(p.id));
  const candNames = candidates.map((p) => p.name);
  const takenNameRows = candNames.length
    ? (await c.env.DB.prepare(`SELECT name FROM team WHERE org_id = 1 AND name IN (${candNames.map(() => "?").join(",")})`).bind(...candNames).all<{ name: string }>()).results
    : [];
  const takenNames = new Set(takenNameRows.map((r) => r.name));
  const toCreate = candidates.filter((p) => {
    if (takenNames.has(p.name)) return void skipped.push({ line: p.line, reason: `队名「${p.name}」已属于另一支球队` }), false;
    return true;
  });

  const createdBy = c.get("user")!.id;
  if (toCreate.length > 0) {
    await c.env.DB.batch(
      toCreate.map((p) =>
        c.env.DB.prepare("INSERT INTO team (id, org_id, name, created_by) VALUES (?, 1, ?, ?)").bind(p.id, p.name, createdBy),
      ),
    );
  }

  const seeded = await c.env.DB.prepare(
    "SELECT team_id FROM entry WHERE tournament_id = ?"
  )
    .bind(id)
    .all<{ team_id: number }>();
  const entered = new Set(seeded.results.map((r) => r.team_id));

  const seedRow = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(seed), 0) AS max FROM entry WHERE tournament_id = ?"
  )
    .bind(id)
    .first<{ max: number }>();
  let seed = seedRow!.max;

  const entryStmts: D1PreparedStatement[] = [];
  const created: number[] = [];
  for (const p of parsed) {
    if (entered.has(p.id)) continue;
    if (!knownById.has(p.id) && !toCreate.some((t) => t.id === p.id)) continue; // 队没建成，报名也跳过
    seed += 1;
    entryStmts.push(
      c.env.DB.prepare("INSERT INTO entry (tournament_id, team_id, seed) VALUES (?, ?, ?)").bind(id, p.id, seed),
    );
    created.push(p.id);
  }
  if (entryStmts.length > 0) await c.env.DB.batch(entryStmts);

  // 新建的队推给俱乐部平台建档（并行；失败只回报，不回滚已建的队与报名）
  const pushed = await Promise.all(
    toCreate.map(async (p) => ({
      id: p.id,
      error: pushError(await pushTeamToClub(c.env, { id: p.id, name: p.name, operator: createdBy })),
    })),
  );

  skipped.sort((a, b) => a.line - b.line);
  return c.json(
    {
      createdEntries: created.length,
      createdTeams: toCreate.length,
      skippedAlready: parsed.filter((p) => entered.has(p.id)).map((p) => p.id),
      skipped,
      nameMismatch,
      clubSyncFailed: pushed.filter((x) => x.error !== null).map((x) => ({ id: x.id, message: x.error })),
    },
    201,
  );
});

// 移除报名（有比赛引用则拒绝）
app.delete("/:id/entries/:entryId", async (c) => {
  const id = Number(c.req.param("id"));
  const entryId = Number(c.req.param("entryId"));
  const guard = await guardRegistration(c.env, id);
  if (guard) return c.json({ message: guard.error }, guard.status);

  const ref = await c.env.DB.prepare(
    "SELECT id FROM match WHERE home_entry_id = ? OR away_entry_id = ? LIMIT 1"
  )
    .bind(entryId, entryId)
    .first();
  if (ref) {
    return c.json({ message: "该球队已有比赛记录，不能移除" }, 409);
  }
  await c.env.DB.prepare("DELETE FROM entry WHERE id = ? AND tournament_id = ?")
    .bind(entryId, id)
    .run();
  return c.json({ ok: true });
});

// 扣分（仅超管）：entry 级赛事扣分，写入后重算本赛事所有积分阶段
app.patch(
  "/:id/entries/:entryId/deduction",
  requireSuperadmin,
  async (c) => {
    const id = Number(c.req.param("id"));
    const entryId = Number(c.req.param("entryId"));
    const body = await c.req.json<{ points?: unknown }>().catch(() => null);
    const points = Number(body?.points);
    if (!Number.isInteger(points) || points < 0 || points > 999) {
      return c.json({ message: "扣分必须是不超过 999 的非负整数（0 表示清除）" }, 400);
    }
    const entry = await c.env.DB.prepare(
      "SELECT id FROM entry WHERE id = ? AND tournament_id = ?"
    )
      .bind(entryId, id)
      .first();
    if (!entry) return c.json({ message: "报名不存在" }, 404);

    await c.env.DB.prepare(
      "UPDATE entry SET points_deducted = ? WHERE id = ?"
    )
      .bind(points, entryId)
      .run();
    const stages = await c.env.DB.prepare(
      `SELECT id FROM stage WHERE tournament_id = ? AND kind != 'elim'`
    )
      .bind(id)
      .all<{ id: number }>();
    const stmts = (
      await Promise.all(
        (stages.results ?? []).map((s) => buildStandingsStmts(c.env.DB, s.id))
      )
    ).flat();
    if (stmts.length > 0) await c.env.DB.batch(stmts);
    return c.json({ ok: true });
  }
);

// ---------- 榜单与数据统计（复用公开计算；草稿赛事管理端也要能看） ----------
app.get(
  "/:id/toplists",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    return c.json(await buildToplistsWithSuspension(c.env.DB, id));
  }
);

// 伤停动态（榜单 tab 板块）：与公开端同口径，草稿赛事管理端也要能看
app.get(
  "/:id/injuries",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    return c.json({ groups: await listTournamentActiveInjuries(c.env.DB, id) });
  }
);

// ---------- 比赛 tab 的按队数据（增量 40） ----------
// 前端原来逐队打 `?teamId=` / `teams/:id`：12~20 队的赛事就是 12~20 次请求（每次一轮往返）。
// 这两个端点一次给齐全部参赛队、按 team_id 分组；行读与逐队调用相当（名单反而更省，
// 少了每队一次的 team 行读取），省下来的是请求数与往返。
// 排序表达式与 teams.ts 的单队名单逐字一致，避免优化器静默不用 idx_player_team。
export const TOURNAMENT_TEAM_PLAYERS_SQL = `SELECT id, team_id, name, number
   FROM player
  WHERE team_id IN (SELECT team_id FROM entry WHERE tournament_id = ?)
  ORDER BY team_id, (number IS NULL), CAST(number AS INTEGER), number, id`;

app.get("/:id/team-players", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);
  const rows = await c.env.DB.prepare(TOURNAMENT_TEAM_PLAYERS_SQL)
    .bind(id)
    .all<{ id: number; team_id: number; name: string; number: string | null }>();
  const playersByTeam: Record<string, PlayerDTO[]> = {};
  for (const r of rows.results ?? []) {
    (playersByTeam[r.team_id] ??= []).push({ id: r.id, name: r.name, number: r.number });
  }
  return c.json({ playersByTeam });
});

app.get("/:id/team-injuries", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
    .bind(id)
    .first<{ id: number }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);
  return c.json({
    injuriesByTeam: Object.fromEntries(await listTournamentTeamInjuries(c.env.DB, id)),
  });
});

// ---------- 停赛规则 ----------
// GET /:id/suspensions：配置 + 每球员停赛/黄牌累积状态（纯派生实时计算）
app.get(
  "/:id/suspensions",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    const config = await getSuspensionConfig(c.env.DB, id);
    const players = await computeSuspensions(c.env.DB, id, config);
    return c.json({ config, players });
  }
);

// PUT /:id/suspensions：存停赛参数（yellowResetAt 只能由 reset-yellows 写，此处保留原值）
app.put(
  "/:id/suspensions",
  async (c) => {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    const norm = normalizeSuspensionInput(body);
    if (!norm) return c.json({ message: "停赛场数与黄牌阈值须为 0-10 的整数" }, 400);
    const row = await c.env.DB.prepare("SELECT config_json FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ config_json: string | null }>();
    if (!row) return c.json({ message: "赛事不存在" }, 404);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = (JSON.parse(row.config_json || "{}") ?? {}) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    const prev = (cfg.suspension ?? {}) as Partial<SuspensionConfig>;
    const next: SuspensionConfig = {
      ...norm,
      yellowResetAt: typeof prev.yellowResetAt === "string" ? prev.yellowResetAt : null,
    };
    cfg.suspension = next;
    await c.env.DB.prepare("UPDATE tournament SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify(cfg), id)
      .run();
    return c.json({ ok: true, config: next });
  }
);

// POST /:id/suspensions/reset-yellows：手动清零黄牌累积——记时间戳锚点，
// 锚点后的黄牌重新计数；已触发的停赛继续执行
app.post(
  "/:id/suspensions/reset-yellows",
  async (c) => {
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare("SELECT config_json FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ config_json: string | null }>();
    if (!row) return c.json({ message: "赛事不存在" }, 404);
    let cfg: Record<string, unknown> = {};
    try {
      cfg = (JSON.parse(row.config_json || "{}") ?? {}) as Record<string, unknown>;
    } catch {
      cfg = {};
    }
    const prev = { ...{ redBan: 2, red2yBan: 1, yellowThreshold: 3 }, ...(cfg.suspension ?? {}) } as SuspensionConfig;
    // 保留毫秒：与 match_event.created_at（毫秒精度）做字典序比较，截秒会同秒内误判先后
    const now = new Date().toISOString();
    cfg.suspension = { ...prev, yellowResetAt: now };
    await c.env.DB.prepare("UPDATE tournament SET config_json = ? WHERE id = ?")
      .bind(JSON.stringify(cfg), id)
      .run();
    return c.json({ ok: true, yellowResetAt: now });
  }
);

// GET /:id/audit?matchId=：比赛域审计留痕（开赛/终场/改判/弃权/事件增删），倒序最多 100 条；
// 传 matchId 只看单场（争议场核查的主要用法），不传看整届
app.get(
  "/:id/audit",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    const matchId = Number(c.req.query("matchId")) || null;
    const rows = await c.env.DB.prepare(
      `SELECT a.id, a.action, a.target_id, a.detail_json, a.created_at, u.name AS actor_name
       FROM audit_log a
       JOIN match m ON m.id = a.target_id
       JOIN stage s ON s.id = m.stage_id
       LEFT JOIN user u ON u.id = a.actor_user_id
       WHERE a.target_type = 'match' AND s.tournament_id = ? ${matchId ? "AND a.target_id = ?" : ""}
       ORDER BY a.id DESC
       LIMIT 100`
    )
      .bind(...(matchId ? [id, matchId] : [id]))
      .all<{
        id: number; action: string; target_id: number; detail_json: string | null;
        created_at: string; actor_name: string | null;
      }>();
    const entries = (rows.results ?? []).map((r) => ({
      id: r.id,
      action: r.action,
      targetMatchId: r.target_id,
      actorName: r.actor_name,
      detailJson: r.detail_json,
      createdAt: r.created_at,
    }));
    return c.json({ entries });
  }
);

app.get(
  "/:id/stats",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT id FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ id: number }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    return c.json(await buildStats(c.env.DB, id));
  }
);

// 上传赛事封面：png/jpg/webp ≤1MB；key 版本化，旧对象删除
app.put(
  "/:id/cover",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT cover_key FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ cover_key: string | null }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    const res = await saveImage(c, "tournament", id);
    if (!res.ok) return c.json({ message: res.message }, res.status);
    await c.env.DB.prepare("UPDATE tournament SET cover_key = ? WHERE id = ?").bind(res.key, id).run();
    await deleteImage(c, t.cover_key);
    return c.json({ coverUrl: mediaUrl(res.key) });
  }
);

// 删除封面：清掉自定义图后回到默认模板（按当前赛事名重新生成）
app.delete(
  "/:id/cover",
  async (c) => {
    const id = Number(c.req.param("id"));
    const t = await c.env.DB.prepare("SELECT cover_key, name FROM tournament WHERE id = ?")
      .bind(id)
      .first<{ cover_key: string | null; name: string }>();
    if (!t) return c.json({ message: "赛事不存在" }, 404);
    await c.env.DB.prepare("UPDATE tournament SET cover_key = NULL WHERE id = ?").bind(id).run();
    await deleteImage(c, t.cover_key);
    let coverUrl: string | null = null;
    try {
      const key = await putDefaultCover(c.env, id, t.name);
      await c.env.DB.prepare("UPDATE tournament SET cover_key = ? WHERE id = ?").bind(key, id).run();
      coverUrl = mediaUrl(key);
    } catch {}
    return c.json({ ok: true, coverUrl });
  }
);

export default app;
