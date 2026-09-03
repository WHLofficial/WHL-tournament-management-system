import { Hono } from "hono";
import type { AppEnv, Bindings } from "../../env";
import {
  DEFAULT_TOURNAMENT_CONFIG,
  type EntryDTO,
  type TournamentDTO,
} from "../../../shared/types";
import { defaultCrossTemplate } from "../../lib/seeding";
import { readStageStandings, buildStandingsStmts } from "../../lib/standings";
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
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at,
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
  }>();
  const tournaments: TournamentDTO[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    format: r.format,
    status: r.status,
    createdAt: r.created_at,
    entryCount: r.entry_count,
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
  if (!format || !(format in DEFAULT_TOURNAMENT_CONFIG)) {
    return c.json({ message: "赛制不合法" }, 400);
  }
  const cfg = DEFAULT_TOURNAMENT_CONFIG[format];
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

  // 按 format 生成阶段结构；group_knockout 的小组行一并建好
  const stmts: D1PreparedStatement[] = [];
  const addStage = (kind: string, sortOrder: number, config: unknown) =>
    stmts.push(
      c.env.DB.prepare(
        "INSERT INTO stage (tournament_id, kind, sort_order, config_json) VALUES (?, ?, ?, ?)"
      ).bind(tid, kind, sortOrder, JSON.stringify(config))
    );
  if (format === "single_elim") {
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
  await c.env.DB.batch(stmts);
  return c.json({ id: tid }, 201);
});

// 详情：赛事 + 阶段 + 小组 + 报名名单
app.get("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const t = await c.env.DB.prepare(
    `SELECT t.id, t.name, t.description, t.format, t.status, t.created_at,
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
    }>();
  if (!t) return c.json({ message: "赛事不存在" }, 404);

  const [stages, groups, entries] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, kind, sort_order, config_json FROM stage WHERE tournament_id = ? ORDER BY sort_order"
    )
      .bind(id)
      .all<{ id: number; kind: "elim" | "round_robin" | "group"; sort_order: number; config_json: string }>(),
    c.env.DB.prepare(
      `SELECT g.id, g.stage_id, g.name, g.sort_order FROM "group" g
       JOIN stage s ON s.id = g.stage_id WHERE s.tournament_id = ?
       ORDER BY s.sort_order, g.sort_order`
    )
      .bind(id)
      .all<{ id: number; stage_id: number; name: string; sort_order: number }>(),
    c.env.DB.prepare(
      `SELECT e.id, e.team_id, e.seed, e.group_id, e.points_deducted, tm.name AS team_name,
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
        player_count: number;
      }>(),
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
    } satisfies TournamentDTO,
    stages: stages.results.map((s) => ({
      id: s.id,
      kind: s.kind,
      sortOrder: s.sort_order,
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
      })
    ),
  };
  return c.json(detail);
});

// GET /:id/standings：小组/循环阶段的积分榜（已按 积分→净胜→进球→相互战绩 排序）
app.get("/:id/standings", async (c) => {
  const id = Number(c.req.param("id"));
  const standings = await readStageStandings(c.env.DB, id);
  return c.json({ standings });
});

app.patch("/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const body = await c.req
    .json<{ name?: string; description?: string; config_json?: Record<string, unknown> }>()
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
  return c.json({ ok: true });
});

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

  if (t.format === "single_elim" || t.format === "round_robin") {
    stmts.push(
      env.DB.prepare(
        "UPDATE stage SET config_json = ? WHERE tournament_id = ?"
      ).bind(JSON.stringify(cfg), tid)
    );
  } else {
    const groupCount = Number(cfg.group_count ?? 4);
    const qualify = Number(cfg.qualify_per_group ?? 2);
    const cross = defaultCrossTemplate(groupCount, qualify);
    stmts.push(
      env.DB.prepare(
        "UPDATE stage SET config_json = ? WHERE tournament_id = ? AND kind = 'group'"
      ).bind(JSON.stringify({ ...cfg, cross }), tid)
    );
    // 淘汰阶段：只更新 source.cross，用户改过的 legs/final_legs/third_place 保留
    const elimStage = await env.DB.prepare(
      "SELECT config_json FROM stage WHERE tournament_id = ? AND kind = 'elim'"
    )
      .bind(tid)
      .first<{ config_json: string }>();
    const elimCfg = (JSON.parse(elimStage?.config_json || "{}") ?? {}) as Record<string, unknown>;
    stmts.push(
      env.DB.prepare(
        "UPDATE stage SET config_json = ? WHERE tournament_id = ? AND kind = 'elim'"
      ).bind(
        JSON.stringify({ ...elimCfg, source: { cross } }),
        tid
      )
    );
    // 组数变化时重建小组行（分组关系一并清空，需重新抽签）
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

// 批量报名：粘贴队名，球队库没有的自动建队
app.post("/:id/entries/bulk", async (c) => {
  const id = Number(c.req.param("id"));
  const guard = await guardRegistration(c.env, id);
  if (guard) return c.json({ message: guard.error }, guard.status);

  const body = await c.req.json<{ names?: string[] }>().catch(() => null);
  const names = [
    ...new Set((body?.names ?? []).map((n) => n.trim()).filter(Boolean)),
  ];
  if (names.length === 0) return c.json({ message: "没有可用的队名" }, 400);
  if (names.length > 64) return c.json({ message: "一次最多报名 64 支球队" }, 400);

  const createdBy = c.get("user")!.id;
  const placeholders = names.map(() => "?").join(",");
  const found = await c.env.DB.prepare(
    `SELECT id, name FROM team WHERE org_id = 1 AND name IN (${placeholders})`
  )
    .bind(...names)
    .all<{ id: number; name: string }>();
  const byName = new Map(found.results.map((r) => [r.name, r.id]));

  const seeded = await c.env.DB.prepare(
    `SELECT tm.name FROM entry e JOIN team tm ON tm.id = e.team_id
     WHERE e.tournament_id = ?`
  )
    .bind(id)
    .all<{ name: string }>();
  const entered = new Set(seeded.results.map((r) => r.name));

  const createTeamStmts: D1PreparedStatement[] = [];
  const newTeams: { name: string; index: number }[] = [];
  names.forEach((name, index) => {
    if (!byName.has(name)) {
      newTeams.push({ name, index });
      createTeamStmts.push(
        c.env.DB.prepare(
          "INSERT INTO team (org_id, name, created_by) VALUES (1, ?, ?)"
        ).bind(name, createdBy)
      );
    }
  });
  if (createTeamStmts.length > 0) {
    const results = await c.env.DB.batch(createTeamStmts);
    results.forEach((r, i) =>
      byName.set(newTeams[i].name, Number(r.meta.last_row_id))
    );
  }

  const seedRow = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(seed), 0) AS max FROM entry WHERE tournament_id = ?"
  )
    .bind(id)
    .first<{ max: number }>();
  let seed = seedRow!.max;

  const entryStmts: D1PreparedStatement[] = [];
  const created: string[] = [];
  for (const name of names) {
    if (entered.has(name)) continue;
    seed += 1;
    entryStmts.push(
      c.env.DB.prepare(
        "INSERT INTO entry (tournament_id, team_id, seed) VALUES (?, ?, ?)"
      ).bind(id, byName.get(name)!, seed)
    );
    created.push(name);
  }
  if (entryStmts.length > 0) await c.env.DB.batch(entryStmts);

  return c.json(
    {
      createdEntries: created.length,
      createdTeams: createTeamStmts.length,
      skippedAlready: names.filter((n) => entered.has(n)),
    },
    201
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

export default app;
