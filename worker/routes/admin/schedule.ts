import { Hono } from "hono";
import type { AppEnv } from "../../env";
import { requireAdmin } from "../../middleware/auth";
import { mediaUrl } from "../../lib/media";
import type { MatchDTO } from "../../../shared/types";
import {
  buildCrossPlan,
  buildElimPlan,
  defaultCrossTemplate,
  drawGroups,
  roundRobinSchedule,
  shuffle,
  type PlanMatch,
} from "../../lib/seeding";
import { getTiebreakers, readStandings, type StandRow } from "../../lib/standings";

const app = new Hono<AppEnv>();
app.use("*", requireAdmin);

type StageRow = {
  id: number;
  tournament_id: number;
  kind: "elim" | "round_robin" | "group";
  config_json: string | null;
  sort_order: number;
};

type EntryRow = { id: number; seed: number | null; group_id: number | null };

// 载入并校验赛事/阶段归属；任何阶段存在已开打或已完赛的场次时禁止重排/重抽
async function loadStage(
  db: D1Database,
  tid: number,
  stageId: number
): Promise<{ stage: StageRow; started: number }> {
  const stage = await db.prepare(
    "SELECT id, tournament_id, kind, config_json, sort_order FROM stage WHERE id = ? AND tournament_id = ?"
  )
    .bind(stageId, tid)
    .first<StageRow>();
  if (!stage) throw new HttpError(404, "阶段不存在");
  const started =
    (
      await db.prepare(
        "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status IN ('live','finished')"
      )
        .bind(stageId)
        .first<{ n: number }>()
    )?.n ?? 0;
  return { stage, started };
}

class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

const fail = (c: { json: Function }, status: number, message: string) =>
  c.json({ message }, status);

// ---------- 阶段结构管理（灵活多阶段：仅 draft/registering 可增删） ----------

const KINDS = ["elim", "round_robin", "group"] as const;

// 阶段结构调整只在未开赛时允许；running/archived 一律拒绝
async function structEditable(db: D1Database, tid: number) {
  const t = await db
    .prepare("SELECT id, status FROM tournament WHERE id = ?")
    .bind(tid)
    .first<{ id: number; status: string }>();
  if (!t) throw new HttpError(404, "赛事不存在");
  if (t.status !== "draft" && t.status !== "registering") {
    throw new HttpError(409, "赛事已开赛或已归档，不能再调整阶段结构");
  }
  return t;
}

type AddStageBody = {
  kind?: (typeof KINDS)[number];
  legs?: number;
  finalLegs?: number;
  thirdPlace?: boolean;
  loops?: number;
  groupCount?: number;
  groupSize?: number;
  qualifyPerGroup?: number;
  source?: { take?: number; from?: number; to?: number; fromStage?: number; cross?: string[] };
};

app.post("/:id/stages", async (c) => {
  const tid = Number(c.req.param("id"));
  const body = await c.req.json<AddStageBody>().catch(() => null);
  if (!body?.kind || !KINDS.includes(body.kind)) {
    return fail(c, 400, "赛制类型不合法");
  }
  try {
    await structEditable(c.env.DB, tid);
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }

  const cur = await c.env.DB.prepare(
    "SELECT MAX(sort_order) AS mx, COUNT(*) AS n FROM stage WHERE tournament_id = ?"
  )
    .bind(tid)
    .first<{ mx: number | null; n: number }>();
  const isFirst = (cur?.n ?? 0) === 0;
  const sortOrder = (cur?.mx ?? 0) + 1;

  if (body.kind === "group" && !isFirst) {
    return fail(c, 400, "分组赛只能作为第一阶段");
  }
  const take = typeof body.source?.take === "number" ? Math.floor(body.source.take) : null;
  const rangeFrom =
    typeof body.source?.from === "number" ? Math.floor(body.source.from) : null;
  const rangeTo = typeof body.source?.to === "number" ? Math.floor(body.source.to) : null;
  const fromStage =
    typeof body.source?.fromStage === "number" ? Math.floor(body.source.fromStage) : null;
  const cross = body.source?.cross?.map((s) => String(s).trim()).filter(Boolean) ?? [];
  if ((take !== null || rangeFrom !== null || cross.length > 0) && isFirst) {
    return fail(c, 400, "第一阶段直接使用全部报名队，不需要取人规则");
  }
  if (body.kind !== "elim" && cross.length > 0) {
    return fail(c, 400, "跨组对阵模板只能用于淘汰赛阶段");
  }
  if (take !== null && (take < 2 || take > 64)) {
    return fail(c, 400, "取人名额需在 2 到 64 之间");
  }
  // 名次区间取人：from/to 至少给一对，区间至少覆盖 2 个名次
  if ((rangeFrom !== null || rangeTo !== null) && (rangeFrom === null || rangeTo === null)) {
    return fail(c, 400, "名次区间需要同时填起点和终点");
  }
  if (rangeFrom !== null && rangeTo !== null) {
    if (rangeFrom < 1) return fail(c, 400, "名次区间起点从第 1 名开始");
    if (rangeTo - rangeFrom + 1 < 2) {
      return fail(c, 400, "名次区间至少要覆盖 2 个名次，否则凑不出一场比赛");
    }
    if (rangeTo > 128) return fail(c, 400, "名次区间终点不能超过 128");
  }
  if (fromStage !== null) {
    const src = await c.env.DB.prepare(
      "SELECT id, kind, sort_order FROM stage WHERE id = ? AND tournament_id = ?"
    )
      .bind(fromStage, tid)
      .first<{ id: number; kind: string; sort_order: number }>();
    if (!src) return fail(c, 400, "取人来源阶段不存在");
    if (isFirst || src.sort_order >= sortOrder) {
      return fail(c, 400, "取人来源阶段必须排在当前阶段之前");
    }
    if (src.kind === "elim") {
      return fail(c, 400, "取人来源不能是淘汰赛阶段（淘汰赛没有名次）");
    }
  }

  const source = cross.length > 0
    ? { cross }
    : take !== null
      ? { take }
      : rangeFrom !== null && rangeTo !== null
        ? { from: rangeFrom, to: rangeTo, ...(fromStage !== null ? { fromStage } : {}) }
        : undefined;

  let config: Record<string, unknown>;
  if (body.kind === "elim") {
    config = {
      legs: body.legs === 2 ? 2 : 1,
      final_legs: body.finalLegs === 2 ? 2 : body.finalLegs === 1 ? 1 : undefined,
      third_place: !!body.thirdPlace,
      ...(source ? { source } : {}),
    };
  } else if (body.kind === "round_robin") {
    config = { loops: body.loops === 2 ? 2 : 1, ...(source ? { source } : {}) };
  } else {
    const groupCount = Math.min(Math.max(Math.floor(Number(body.groupCount) || 4), 2), 8);
    // 每组队数：容量参考（抽签不能超过 组数 × 每组队数），不强制每组满员
    const groupSize = Math.min(Math.max(Math.floor(Number(body.groupSize) || 4), 2), 16);
    const q = Math.min(
      Math.max(Math.floor(Number(body.qualifyPerGroup) || 2), 1),
      8
    );
    config = {
      group_count: groupCount,
      group_size: groupSize,
      loops: body.loops === 2 ? 2 : 1,
      qualify_per_group: q,
      cross: defaultCrossTemplate(groupCount, q),
    };
  }

  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      "INSERT INTO stage (tournament_id, kind, sort_order, config_json) VALUES (?, ?, ?, ?)"
    ).bind(tid, body.kind, sortOrder, JSON.stringify(config)),
  ];
  // 分组赛（必为首阶段）连同 A、B、C… 组行一次建好；借 SELECT 回填 stage id
  if (body.kind === "group") {
    const groupCount = (config.group_count as number) ?? 4;
    for (let i = 0; i < groupCount; i++) {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO "group" (stage_id, name, sort_order)
           SELECT id, ?1, ?2 FROM stage WHERE tournament_id = ?3 AND kind = 'group'`
        ).bind(String.fromCharCode(65 + i), i, tid)
      );
    }
  }
  const results = await c.env.DB.batch(stmts);
  const stageId = Number(results[0].meta.last_row_id);
  return c.json({ ok: true, stageId, sortOrder }, 201);
});

app.delete("/:id/stages/:stageId", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  try {
    await structEditable(c.env.DB, tid);
    const { stage, started } = await loadStage(c.env.DB, tid, stageId);
    if (started > 0) {
      return fail(c, 409, "该阶段已有开打或完赛的场次，不能删除");
    }
    await c.env.DB.prepare("DELETE FROM stage WHERE id = ?").bind(stage.id).run();
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  return c.json({ ok: true });
});

// 阶段改名：纯显示用途，随时可改；空值 = 清除恢复默认赛制名
app.patch("/:id/stages/:stageId/name", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const stage = await c.env.DB.prepare(
    "SELECT id FROM stage WHERE id = ? AND tournament_id = ?"
  )
    .bind(stageId, tid)
    .first<{ id: number }>();
  if (!stage) return fail(c, 404, "阶段不存在");
  const body = (await c.req.json<{ name?: unknown }>().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length > 30) return fail(c, 400, "阶段名最多 30 个字");
  await c.env.DB.prepare("UPDATE stage SET name = ? WHERE id = ?")
    .bind(name === "" ? null : name, stageId)
    .run();
  return c.json({ ok: true, name: name === "" ? null : name });
});

// ---------- 自动生成阶段赛程 ----------

app.post("/:id/stages/:stageId/generate", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const env = c.env;
  let stage: StageRow;
  let started: number;
  try {
    ({ stage, started } = await loadStage(env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (started > 0) {
    return fail(c, 409, "该阶段已有开打或完赛的场次，不能重新生成");
  }

  const entries = await env.DB.prepare(
    "SELECT id, seed, group_id FROM entry WHERE tournament_id = ? ORDER BY seed"
  )
    .bind(tid)
    .all<EntryRow>();
  const list = entries.results ?? [];

  // 重生成 = 清空该阶段全部未开打的场次后重建
  const del = env.DB.prepare("DELETE FROM match WHERE stage_id = ?").bind(stageId);
  const stmts: D1PreparedStatement[] = [del];
  const insertMatch =
    "INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)";
  let rounds = 0;
  let created = 0;
  let balanced: boolean | undefined;

  if (stage.kind === "elim") {
    if (list.length < 2) return fail(c, 400, "报名不足 2 支，无法生成对阵");
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as {
      legs?: number;
      final_legs?: number;
      third_place?: boolean;
      source?: { cross?: string | string[]; take?: number; from?: number; to?: number; fromStage?: number };
    };
    const rawCross = cfg.source?.cross;
    // cross 兼容 string[]（正常存储形态）与逗号分隔 string
    const crossTokens = Array.isArray(rawCross)
      ? rawCross.map((s) => String(s).trim()).filter(Boolean)
      : typeof rawCross === "string"
        ? rawCross.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [];
    const planOpts = {
      legs: (cfg.legs === 2 ? 2 : 1) as 1 | 2,
      finalLegs: (cfg.final_legs === 2 ? 2 : cfg.final_legs === 1 ? 1 : undefined) as 1 | 2 | undefined,
      thirdPlace: !!cfg.third_place,
    };
    let plan: { matches: PlanMatch[]; rounds: number };
    if (crossTokens.length > 0) {
      try {
        plan = await buildCrossStagePlan(env, tid, stageId, crossTokens, planOpts);
      } catch (e) {
        if (e instanceof HttpError) return fail(c, e.status, e.message);
        throw e;
      }
    } else if (cfg.source?.take || cfg.source?.from != null) {
      // 名次取人：从来源阶段积分榜取前 N 名（take）或第 from..to 名，按名次设种子
      let pool: EntryRow[];
      try {
        pool = await takeRangePool(env, tid, stageId, cfg.source);
      } catch (e) {
        if (e instanceof HttpError) return fail(c, e.status, e.message);
        throw e;
      }
      if (pool.length < 2) return fail(c, 400, "取人后不足 2 支，无法生成对阵");
      plan = buildElimPlan(pool.length, planOpts);
      rounds = plan.rounds;
      for (const m of plan.matches) {
        const home = m.home !== null && m.home <= pool.length ? pool[m.home - 1].id : null;
        const away = m.away !== null && m.away <= pool.length ? pool[m.away - 1].id : null;
        const isBye = home !== null && away === null;
        stmts.push(
          env.DB.prepare(insertMatch).bind(
            stageId, m.round, m.slot, m.leg ?? null, home, away, isBye ? home : null, m.note ?? null
          )
        );
        created++;
      }
      await env.DB.batch(stmts);
      return c.json({ created, rounds, source: "topN" });
    } else {
      plan = buildElimPlan(list.length, planOpts);
    }
    rounds = plan.rounds;
    // seed 路径 home/away 是种子号需映射成 entry；cross 路径已是 entry id（null=待晋级器填充）
    const directIds = crossTokens.length > 0;
    for (const m of plan.matches) {
      const home = directIds
        ? m.home
        : m.home !== null && m.home <= list.length
          ? list[m.home - 1].id
          : null;
      const away = directIds
        ? m.away
        : m.away !== null && m.away <= list.length
          ? list[m.away - 1].id
          : null;
      // 轮空场：pending + 预填 winner，避免 finished 挡住重生成；note 沿用 plan（轮空/季军赛）
      const isBye = home !== null && away === null;
      stmts.push(
        env.DB.prepare(insertMatch).bind(
          stageId,
          m.round,
          m.slot,
          m.leg ?? null,
          home,
          away,
          isBye ? home : null,
          m.note ?? null
        )
      );
      created++;
    }
  } else if (stage.kind === "round_robin") {
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as {
      loops?: number;
      source?: { take?: number; from?: number; to?: number; fromStage?: number };
    };
    let poolList = list;
    if (cfg.source?.take || cfg.source?.from != null) {
      try {
        poolList = await takeRangePool(env, tid, stageId, cfg.source);
      } catch (e) {
        if (e instanceof HttpError) return fail(c, e.status, e.message);
        throw e;
      }
    }
    if (poolList.length < 2) return fail(c, 400, "报名不足 2 支，无法生成赛程");
    poolList = shuffle(poolList);
    const sched = roundRobinSchedule(poolList.length, cfg.loops === 2 ? 2 : 1);
    balanced = sched.balanced;
    rounds = sched.matches.reduce((mx, m) => Math.max(mx, m.round), 0);
    const slotOf = new Map<number, number>(); // 轮内序号
    for (const m of sched.matches) {
      const slot = (slotOf.get(m.round) ?? 0) + 1;
      slotOf.set(m.round, slot);
      stmts.push(
        env.DB.prepare(insertMatch).bind(
          stageId,
          m.round,
          slot,
          null,
          poolList[m.home].id,
          poolList[m.away].id,
          null,
          null
        )
      );
      created++;
    }
  } else {
    // group：每组独立循环；未抽签或某组不足 2 队时跳过该组
    const groups = await env.DB.prepare(
      'SELECT id, name FROM "group" WHERE stage_id = ? ORDER BY sort_order'
    )
      .bind(stageId)
      .all<{ id: number; name: string }>();
    const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { loops?: number };
    const loops = cfg.loops === 2 ? 2 : 1;
    const byGroup = new Map<number, EntryRow[]>();
    for (const e of list) {
      if (e.group_id == null) continue;
      const arr = byGroup.get(e.group_id) ?? [];
      arr.push(e);
      byGroup.set(e.group_id, arr);
    }
    const skipped: string[] = [];
    for (const g of groups.results ?? []) {
      const members = shuffle(byGroup.get(g.id) ?? []);
      if (members.length < 2) {
        skipped.push(g.name);
        continue;
      }
      const sched = roundRobinSchedule(members.length, loops);
      rounds = Math.max(rounds, sched.matches.reduce((mx, m) => Math.max(mx, m.round), 0));
      const slotOf = new Map<number, number>();
      for (const m of sched.matches) {
        const slot = (slotOf.get(m.round) ?? 0) + 1;
        slotOf.set(m.round, slot);
        stmts.push(
          env.DB.prepare(insertMatch).bind(
            stageId,
            m.round,
            slot,
            null,
            members[m.home].id,
            members[m.away].id,
            null,
            null
          )
        );
        created++;
      }
    }
    if (created === 0) {
      return fail(c, 400, "先抽签分组（且每组至少 2 队）才能生成小组赛程");
    }
    await env.DB.batch(stmts);
    return c.json({ created, rounds, skippedGroups: skipped });
  }

  await env.DB.batch(stmts);
  return c.json({ created, rounds, balanced });
});

// ---------- 小组抽签 ----------

app.post("/:id/stages/:stageId/draw", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  let stage: StageRow;
  let started: number;
  try {
    ({ stage, started } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (stage.kind !== "group") return fail(c, 400, "只有小组赛阶段支持抽签");
  if (started > 0) return fail(c, 409, "该阶段已有开打或完赛的场次，不能重新抽签");

  const groups = await c.env.DB.prepare(
    'SELECT id, name FROM "group" WHERE stage_id = ? ORDER BY sort_order'
  )
    .bind(stageId)
    .all<{ id: number; name: string }>();
  const groupRows = groups.results ?? [];
  if (groupRows.length === 0) return fail(c, 400, "该阶段没有小组");

  const entries = await c.env.DB.prepare(
    "SELECT id FROM entry WHERE tournament_id = ?"
  )
    .bind(tid)
    .all<{ id: number }>();
  const entryIds = (entries.results ?? []).map((e) => e.id);
  if (entryIds.length < groupRows.length * 2) {
    return fail(
      c,
      400,
      `报名 ${entryIds.length} 支不足 ${groupRows.length} 组每组 2 队，无法抽签`
    );
  }
  // 配置了每组队数（group_size）时按容量校验；旧赛事没配过沿用现状
  const gcfg = (JSON.parse(stage.config_json || "{}") ?? {}) as {
    group_size?: number;
  };
  const groupSize = gcfg.group_size;
  if (groupSize && entryIds.length > groupRows.length * groupSize) {
    return fail(
      c,
      400,
      `报名 ${entryIds.length} 队超出 ${groupRows.length} 组 × ${groupSize} 队的容量，请先调整组数或每组队数`
    );
  }

  const byName = drawGroups(entryIds, groupRows.length); // Map entryId -> 组名
  const groupIdByName = new Map(groupRows.map((g) => [g.name, g.id]));
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare("UPDATE entry SET group_id = NULL WHERE tournament_id = ?").bind(tid),
  ];
  for (const [entryId, name] of byName) {
    const gid = groupIdByName.get(name);
    if (gid == null) continue;
    stmts.push(
      c.env.DB.prepare("UPDATE entry SET group_id = ? WHERE id = ?").bind(gid, entryId)
    );
  }
  await c.env.DB.batch(stmts);

  const result: Record<string, number[]> = {};
  for (const g of groupRows) result[g.name] = [];
  for (const [entryId, name] of byName) {
    (result[name] ??= []).push(entryId);
  }
  return c.json({ assigned: byName.size, groups: result });
});

// 手动分组：单队划入某组（groupId=null 移出未分组）；与抽签写同一个 group_id 字段
app.patch("/:id/stages/:stageId/entries/:entryId/group", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const entryId = Number(c.req.param("entryId"));
  let stage: StageRow;
  let started: number;
  try {
    ({ stage, started } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  if (stage.kind !== "group") return fail(c, 400, "只有小组赛阶段支持手动分组");

  const body = (await c.req.json().catch(() => ({}))) as { groupId?: number | null };
  const groupId = body.groupId == null ? null : Number(body.groupId);
  if (groupId != null && !Number.isInteger(groupId)) {
    return fail(c, 400, "groupId 必须是小组 id 或 null");
  }

  const entry = await c.env.DB.prepare(
    "SELECT id, group_id FROM entry WHERE id = ? AND tournament_id = ?"
  )
    .bind(entryId, tid)
    .first<{ id: number; group_id: number | null }>();
  if (!entry) return fail(c, 404, "参赛球队不存在");

  // 原地不动直接返回，避免容量守卫误伤「点了自己所在组」
  if (entry.group_id === groupId) return c.json({ ok: true });

  let groupName = "";
  if (groupId != null) {
    const group = await c.env.DB.prepare(
      'SELECT id, name FROM "group" WHERE id = ? AND stage_id = ?'
    )
      .bind(groupId, stageId)
      .first<{ id: number; name: string }>();
    if (!group) return fail(c, 400, "小组不存在或不属于该阶段");
    groupName = group.name;
  }

  if (started > 0) {
    const busy =
      (
        await c.env.DB.prepare(
          "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status IN ('live','finished') AND (home_entry_id = ? OR away_entry_id = ?)"
        )
          .bind(stageId, entryId, entryId)
          .first<{ n: number }>()
      )?.n ?? 0;
    if (busy > 0) {
      return fail(c, 409, "该队已有开打或完赛的场次，不能调整分组");
    }
  }

  // 容量条件写进 UPDATE 的 WHERE 原子判定：并发请求同时挤同一组时只有一个能写入
  const gcfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { group_size?: number };
  const groupSize = gcfg.group_size ?? null;
  const upd = await c.env.DB.prepare(
    "UPDATE entry SET group_id = ?1 WHERE id = ?2 AND (?3 IS NULL OR ?4 IS NULL OR (SELECT COUNT(*) FROM entry WHERE group_id = ?1) < ?4)"
  )
    .bind(groupId, entryId, groupId, groupSize)
    .run();
  if (!upd.meta.changes) {
    const name = groupName || "目标";
    return fail(
      c,
      400,
      groupSize
        ? `${name} 组已满（每组最多 ${groupSize} 队）`
        : `${name} 组不存在或球队状态已变化`
    );
  }

  // 挪组后原组内对阵不再成立：清掉该队在本阶段的未开打场次（与重新抽签语义一致）
  await c.env.DB.prepare(
    "DELETE FROM match WHERE stage_id = ? AND status = 'pending' AND (home_entry_id = ? OR away_entry_id = ?)"
  )
    .bind(stageId, entryId, entryId)
    .run();
  return c.json({ ok: true, groupId, groupName });
});

// ---------- 手动落场（仅循环/小组阶段；淘汰赛由晋级器填充） ----------
// 守卫单场与批量共用：null = 通过；extraPairIds = 同批已检查过的其它场队伍
// （批量场景库里还没插入，批次内互斥由调用方先查，这里只防与已有场次冲突）
async function guardMatch(
  db: D1Database,
  tid: number,
  stage: StageRow,
  round: number,
  homeEntryId: number,
  awayEntryId: number,
  extraPairIds: number[] = []
): Promise<string | null> {
  if (stage.kind === "elim") {
    return "淘汰赛对阵由晋级器按结果填充，不支持手动落场";
  }
  const cfg = (JSON.parse(stage.config_json || "{}") ?? {}) as { loops?: number };
  const loops = cfg.loops === 2 ? 2 : 1;

  const e1 = await db
    .prepare("SELECT id, group_id FROM entry WHERE id = ? AND tournament_id = ?")
    .bind(homeEntryId, tid)
    .first<{ id: number; group_id: number | null }>();
  const e2 = await db
    .prepare("SELECT id, group_id FROM entry WHERE id = ? AND tournament_id = ?")
    .bind(awayEntryId, tid)
    .first<{ id: number; group_id: number | null }>();
  if (!e1 || !e2) return "参赛队伍不存在";

  if (stage.kind === "group") {
    if (e1.group_id == null || e1.group_id !== e2.group_id) {
      return "小组赛只能在同组球队之间落场";
    }
  }

  // 一轮一支队只踢一场（含同批已检查的队，防与库里已有场次冲突）
  const allIds = [homeEntryId, awayEntryId, ...extraPairIds];
  const ph = allIds.map(() => "?").join(",");
  const dup = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM match
       WHERE stage_id = ? AND round = ?
         AND (home_entry_id IN (${ph}) OR away_entry_id IN (${ph}))`
    )
    .bind(stage.id, round, ...allIds, ...allIds)
    .first<{ n: number }>();
  if ((dup?.n ?? 0) > 0) return "本轮已有其中一支球队的比赛";
  const played = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM match
       WHERE stage_id = ?
         AND ((home_entry_id = ? AND away_entry_id = ?) OR (home_entry_id = ? AND away_entry_id = ?))`
    )
    .bind(stage.id, homeEntryId, awayEntryId, awayEntryId, homeEntryId)
    .first<{ n: number }>();
  if ((played?.n ?? 0) >= loops) {
    return loops === 1 ? "两队在本阶段已交手过" : "两队交手次数已达上限（双循环）";
  }
  return null;
}

app.post("/:id/stages/:stageId/matches", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const body = await c.req.json().catch(() => null as null);
  const round = Number(body?.round);
  const homeEntryId = Number(body?.homeEntryId);
  const awayEntryId = Number(body?.awayEntryId);
  if (!Number.isInteger(round) || round < 1) {
    return fail(c, 400, "轮次必须是正整数");
  }
  if (!Number.isInteger(homeEntryId) || !Number.isInteger(awayEntryId)) {
    return fail(c, 400, "请选择主队和客队");
  }
  if (homeEntryId === awayEntryId) {
    return fail(c, 400, "主客队不能是同一支队伍");
  }

  let stage: StageRow;
  try {
    ({ stage } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
  const why = await guardMatch(c.env.DB, tid, stage, round, homeEntryId, awayEntryId);
  if (why) {
    const conflict = why.includes("本轮") || why.includes("交手");
    return fail(c, conflict ? 409 : 400, why);
  }

  const r = await c.env.DB.prepare(
    `INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status)
     VALUES (?, ?, (SELECT COALESCE(MAX(slot), 0) + 1 FROM match WHERE stage_id = ? AND round = ?), ?, ?, 'pending')`
  )
    .bind(stageId, round, stageId, round, homeEntryId, awayEntryId)
    .run();
  return c.json({ id: r.meta.last_row_id }, 201);
});

// 批量落场：一次提交多场（前端手动排赛攒批），逐场守卫 + 批次内互查，
// 全部通过才落库；任何一场不过整批拒绝并报出场次
app.post("/:id/stages/:stageId/matches/bulk", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  const body = await c.req
    .json<{ round?: unknown; pairs?: Array<{ homeEntryId?: unknown; awayEntryId?: unknown }> }>()
    .catch(() => null);
  const round = Number(body?.round);
  const pairs = body?.pairs;
  if (!Number.isInteger(round) || round < 1) {
    return fail(c, 400, "轮次必须是正整数");
  }
  if (!Array.isArray(pairs) || pairs.length < 2 || pairs.length > 24) {
    return fail(c, 400, "一次提交 2 到 24 场比赛");
  }

  let stage: StageRow;
  try {
    ({ stage } = await loadStage(c.env.DB, tid, stageId));
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }

  // 先做基本校验 + 批次内互斥（一队在本批只能出现一场）
  const clean: Array<{ home: number; away: number }> = [];
  const seen = new Map<number, number>();
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i] ?? {};
    const home = Number(p.homeEntryId);
    const away = Number(p.awayEntryId);
    if (!Number.isInteger(home) || !Number.isInteger(away)) {
      return fail(c, 400, `第 ${i + 1} 场：请选择主队和客队`);
    }
    if (home === away) {
      return fail(c, 400, `第 ${i + 1} 场：主客队不能是同一支队伍`);
    }
    for (const id of [home, away]) {
      const prev = seen.get(id);
      if (prev !== undefined) {
        return fail(c, 400, `第 ${i + 1} 场：该队已在本批第 ${prev} 场出场`);
      }
    }
    clean.push({ home, away });
    seen.set(home, i + 1);
    seen.set(away, i + 1);
  }

  // 逐场守卫（带上同批先前的队做互查）；任一不过整批拒
  const extra: number[] = [];
  for (let i = 0; i < clean.length; i++) {
    const { home, away } = clean[i];
    const why = await guardMatch(c.env.DB, tid, stage, round, home, away, extra);
    if (why) return fail(c, 400, `第 ${i + 1} 场：${why}`);
    extra.push(home, away);
  }

  const mx = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(slot), 0) AS m FROM match WHERE stage_id = ? AND round = ?"
  )
    .bind(stageId, round)
    .first<{ m: number }>();
  let slot = (mx?.m ?? 0) + 1;
  const stmts = clean.map((p) =>
    c.env.DB.prepare(
      `INSERT INTO match (stage_id, round, slot, home_entry_id, away_entry_id, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`
    ).bind(stageId, round, slot++, p.home, p.away)
  );
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, created: clean.length, round });
});

// ---------- 场次查询（全赛事，前端按阶段过滤）与删除 ----------

app.get("/:id/matches", async (c) => {
  const tid = Number(c.req.param("id"));
  type MatchRow = {
    id: number; stage_id: number; round: number; slot: number; leg: number | null;
    home_entry_id: number | null; away_entry_id: number | null;
    home_team_name: string | null; away_team_name: string | null;
    home_logo_key: string | null; away_logo_key: string | null;
    score_home: number | null; score_away: number | null;
    pen_home: number | null; pen_away: number | null;
    status: MatchDTO["status"]; winner_entry_id: number | null; note: string | null;
  };
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.stage_id, m.round, m.slot, m.leg,
       m.home_entry_id, m.away_entry_id,
       ht.name AS home_team_name, at.name AS away_team_name,
       ht.logo_key AS home_logo_key, at.logo_key AS away_logo_key,
       m.score_home, m.score_away, m.pen_home, m.pen_away,
       m.status, m.winner_entry_id, m.note
     FROM match m
     JOIN stage s ON s.id = m.stage_id
     LEFT JOIN entry he ON he.id = m.home_entry_id
     LEFT JOIN team ht ON ht.id = he.team_id
     LEFT JOIN entry ae ON ae.id = m.away_entry_id
     LEFT JOIN team at ON at.id = ae.team_id
     WHERE s.tournament_id = ?
     ORDER BY s.sort_order, m.round, m.slot, m.leg`
  )
    .bind(tid)
    .all<MatchRow>();
  // live 场的比分以 goal 事件实时累计为准（score 列终场确认才落）
  const liveIds = (rows.results ?? []).filter((r) => r.status === "live").map((r) => r.id);
  const liveGoals = new Map<string, number>();
  for (const mid of liveIds) {
    const g = await c.env.DB.prepare(
      `SELECT entry_id, COUNT(*) AS n FROM match_event
       WHERE match_id = ? AND type = 'goal' GROUP BY entry_id`
    )
      .bind(mid)
      .all<{ entry_id: number; n: number }>();
    for (const row of g.results ?? []) liveGoals.set(`${mid}:${row.entry_id}`, row.n);
  }
  const matches: MatchDTO[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    stageId: r.stage_id,
    round: r.round,
    slot: r.slot,
    leg: r.leg,
    homeEntryId: r.home_entry_id,
    awayEntryId: r.away_entry_id,
    homeTeamName: r.home_team_name,
    awayTeamName: r.away_team_name,
    homeLogoUrl: mediaUrl(r.home_logo_key),
    awayLogoUrl: mediaUrl(r.away_logo_key),
    scoreHome:
      r.status === "live"
        ? liveGoals.get(`${r.id}:${r.home_entry_id}`) ?? 0
        : r.score_home,
    scoreAway:
      r.status === "live"
        ? liveGoals.get(`${r.id}:${r.away_entry_id}`) ?? 0
        : r.score_away,
    penHome: r.pen_home,
    penAway: r.pen_away,
    status: r.status,
    winnerEntryId: r.winner_entry_id,
    note: r.note,
  }));
  return c.json({ matches });
});

app.delete("/:id/matches/:matchId", async (c) => {
  const tid = Number(c.req.param("id"));
  const matchId = Number(c.req.param("matchId"));
  const m = await c.env.DB.prepare(
    `SELECT m.id, m.status FROM match m JOIN stage s ON s.id = m.stage_id
     WHERE m.id = ? AND s.tournament_id = ?`
  )
    .bind(matchId, tid)
    .first<{ id: number; status: MatchDTO["status"] }>();
  if (!m) return fail(c, 404, "比赛不存在");
  if (m.status !== "pending") {
    return fail(c, 409, "只有未开打的比赛可以删除");
  }
  await c.env.DB.prepare("DELETE FROM match WHERE id = ?").bind(matchId).run();
  return c.json({ ok: true });
});

// ---------- 跨组淘汰：由小组赛名次取人 ----------
// 守卫：小组赛程已生成且全部完赛；按 积分>净胜>进球>seed 排组内名次，
// 解析 cross 模板（如 "A1-B2,B1-A2"）得到首轮配对，交给 buildCrossPlan 出计划。
// scoring.ts 的 finish 事务在小组收官自动生成淘汰赛时也复用此函数。
export async function buildCrossStagePlan(
  env: { DB: D1Database },
  tid: number,
  stageId: number,
  crossTokens: string[],
  opts: { legs: 1 | 2; finalLegs?: 1 | 2; thirdPlace: boolean }
): Promise<{ matches: PlanMatch[]; rounds: number }> {
  const groupStage = await env.DB.prepare(
    `SELECT id, config_json FROM stage
     WHERE tournament_id = ? AND kind = 'group'
       AND sort_order < (SELECT sort_order FROM stage WHERE id = ?)
     ORDER BY sort_order DESC LIMIT 1`
  )
    .bind(tid, stageId)
    .first<{ id: number; config_json: string | null }>();
  if (!groupStage)
    throw new HttpError(400, "该阶段配置了跨组对阵，但赛事没有更早的小组赛阶段");

  const st = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM match WHERE stage_id = ? GROUP BY status"
  )
    .bind(groupStage.id)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((st.results ?? []).map((r) => [r.status, r.n]));
  if (!byStatus.get("finished") && !byStatus.get("pending") && !byStatus.get("live")) {
    throw new HttpError(400, "请先生成小组赛程，再生成淘汰赛对阵");
  }
  if ((byStatus.get("pending") ?? 0) + (byStatus.get("live") ?? 0) > 0) {
    throw new HttpError(400, "小组赛尚未全部完赛，不能生成淘汰赛对阵");
  }

  const gcfg = (JSON.parse(groupStage.config_json || "{}") ?? {}) as {
    group_count?: number;
    qualify_per_group?: number;
  };
  const qualify = gcfg.qualify_per_group ?? 2;
  if (qualify !== 2) throw new HttpError(400, "跨组对阵暂仅支持每组出线 2 队");

  const groups = await env.DB.prepare(
    'SELECT id, name FROM "group" WHERE stage_id = ?'
  )
    .bind(groupStage.id)
    .all<{ id: number; name: string }>();
  const groupName = new Map((groups.results ?? []).map((g) => [g.id, g.name]));

  // 组内名次：走权威积分榜（同分链可配置，与积分榜页同序）
  const chain = await getTiebreakers(env.DB, tid);
  const ranked = await readStandings(env.DB, groupStage.id, chain);

  // rank: 组名 -> 名次 -> entry id（每组只取前 qualify 名）
  const rank = new Map<string, Map<number, number>>();
  const seen = new Map<number, number>();
  for (const row of ranked) {
    const taken = seen.get(row.groupId ?? 0) ?? 0;
    seen.set(row.groupId ?? 0, taken + 1);
    if (taken + 1 > qualify) continue;
    const name = row.groupId != null ? groupName.get(row.groupId) : undefined;
    if (!name) continue;
    if (!rank.has(name)) rank.set(name, new Map());
    rank.get(name)!.set(taken + 1, row.entryId);
  }

  const resolve = (token: string): number => {
    const m = /^([A-Pa-p])([1-9])$/.exec(token.trim());
    if (!m) throw new HttpError(400, `无法识别跨组位置"${token}"，模板应为 组字母+名次，如 A1`);
    const name = m[1].toUpperCase();
    const pos = Number(m[2]);
    const hit = rank.get(name)?.get(pos);
    if (hit === undefined)
      throw new HttpError(400, `小组 ${name} 的第 ${pos} 名不存在，检查跨组模板与出线名额`);
    return hit;
  };

  const pairs: Array<[number | null, number | null]> = [];
  for (const token of crossTokens) {
    const seg = token.trim();
    if (!seg) continue;
    const mm = /^([^-\s]+)\s*-\s*([^-\s]+)$/.exec(seg);
    if (!mm) throw new HttpError(400, `跨组对阵格式错误："${seg}"`);
    pairs.push([resolve(mm[1]), resolve(mm[2])]);
  }
  if (pairs.length < 2) throw new HttpError(400, "跨组对阵至少需要两场");
  return buildCrossPlan(pairs, opts);
}

// ---------- 名次取人 ----------

// 名次区间取人：从来源阶段（source.fromStage 指定，缺省 = 上一阶段）的积分榜取
// 第 from..to 名（含端点）。排名读权威 standing 表（含扣分与相互战绩），与积分榜页同序。
// 返回按名次排列的 EntryRow[]，pool 内 seed = 名次（区间内第 1 名 → seed 1）。
export async function takeRangePool(
  env: { DB: D1Database },
  tid: number,
  stageId: number,
  src: { take?: number; from?: number; to?: number; fromStage?: number }
): Promise<EntryRow[]> {
  const cur = await env.DB.prepare("SELECT sort_order FROM stage WHERE id = ?")
    .bind(stageId)
    .first<{ sort_order: number }>();
  if (!cur) throw new HttpError(404, "阶段不存在");

  let srcStage: { id: number; kind: string } | null;
  if (src.fromStage) {
    srcStage = await env.DB.prepare(
      "SELECT id, kind FROM stage WHERE id = ? AND tournament_id = ? AND sort_order < ?"
    )
      .bind(src.fromStage, tid, cur.sort_order)
      .first<{ id: number; kind: string }>();
    if (!srcStage) throw new HttpError(400, "取人来源阶段不存在");
  } else {
    srcStage = await env.DB.prepare(
      `SELECT id, kind FROM stage
       WHERE tournament_id = ?
         AND sort_order < (SELECT sort_order FROM stage WHERE id = ?)
       ORDER BY sort_order DESC LIMIT 1`
    )
      .bind(tid, stageId)
      .first<{ id: number; kind: string }>();
    if (!srcStage) throw new HttpError(400, "该阶段是第一阶段，不能配置取人规则");
  }
  if (srcStage.kind === "elim") {
    throw new HttpError(400, "取人来源不能是淘汰赛阶段（淘汰赛没有名次）");
  }
  const st = await env.DB.prepare(
    "SELECT status, COUNT(*) AS n FROM match WHERE stage_id = ? GROUP BY status"
  )
    .bind(srcStage.id)
    .all<{ status: string; n: number }>();
  const byStatus = new Map((st.results ?? []).map((r) => [r.status, r.n]));
  if ((byStatus.get("pending") ?? 0) + (byStatus.get("live") ?? 0) > 0 || !byStatus.get("finished")) {
    throw new HttpError(400, "取人来源阶段尚未全部完赛，还不能按名次取人生成");
  }

  const from = src.from ?? 1;
  const to = src.to ?? src.take ?? from;
  const chain = await getTiebreakers(env.DB, tid);
  const ranked = await readStandings(env.DB, srcStage.id, chain);
  // 跨组取人：组内名次优先（所有小组第一先进），同名次内按 积分 → 同分链
  // （跨组没有相互战绩可比较，跳过 h2h）→ 种子位兜底。
  // 例：4 组取前 6 = 全部小组第一 + 2 个最好的小组第二。
  if (srcStage.kind === "group") {
    const nonH2h = chain.filter((t) => t !== "h2h");
    const cmp = (a: StandRow, b: StandRow): number => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.pts !== b.pts) return b.pts - a.pts;
      for (const t of nonH2h) {
        const va = t === "gd" ? a.goalsFor - a.goalsAgainst : a.goalsFor;
        const vb = t === "gd" ? b.goalsFor - b.goalsAgainst : b.goalsFor;
        if (va !== vb) return vb - va;
      }
      return a.seed - b.seed;
    };
    ranked.sort(cmp);
  }
  if (ranked.length === 0) {
    throw new HttpError(400, "来源阶段还没有积分榜数据，先生成并完赛它的赛程");
  }
  if (from < 1 || to < from) {
    throw new HttpError(400, "名次区间不合法");
  }
  if (to > ranked.length) {
    throw new HttpError(
      400,
      `来源阶段共 ${ranked.length} 支队，取不到第 ${from} 到第 ${to} 名`
    );
  }
  return ranked.slice(from - 1, to).map((r, i) => ({
    id: r.entryId,
    seed: i + 1,
    group_id: r.groupId,
  }));
}

// ---------- 收官自动晋级 ----------
// 某阶段全部完赛时，扫描其后所有尚未生成场次的阶段：凡"生效取人来源"正是刚完赛
// 这一阶段的（fromStage 指定，或默认取紧邻上一阶段），就按其规则自动生成赛程。
// 这样并列阶段（如第 1-4 名进 B、第 5-8 名进 C，都取自 A）会在 A 收官时同时生成。
// cross 模板沿用旧语义：只由紧邻上一阶段收官触发（来源组在 buildCrossStagePlan 内解析）。
// 返回待执行的 INSERT 语句（调用方与积分重算合并为一个 batch）；无事发生返回空数组。
export async function buildAutoFillStmts(
  env: { DB: D1Database },
  tid: number,
  prevStageId: number
): Promise<D1PreparedStatement[]> {
  const fin = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status != 'finished'"
  )
    .bind(prevStageId)
    .first<{ n: number }>();
  if ((fin?.n ?? 0) !== 0) return [];

  const prev = await env.DB.prepare(
    "SELECT id, kind, sort_order FROM stage WHERE id = ? AND tournament_id = ?"
  )
    .bind(prevStageId, tid)
    .first<{ id: number; kind: string; sort_order: number }>();
  if (!prev) return [];

  const stages = (
    await env.DB.prepare(
      "SELECT id, kind, sort_order, config_json FROM stage WHERE tournament_id = ? ORDER BY sort_order"
    )
      .bind(tid)
      .all<StageRow>()
  ).results ?? [];

  const immediatePrevOf = (sortOrder: number) =>
    [...stages]
      .filter((s) => s.sort_order < sortOrder)
      .sort((a, b) => b.sort_order - a.sort_order)[0] ?? null;

  const stmts: D1PreparedStatement[] = [];

  for (const next of stages) {
    if (next.sort_order <= prev.sort_order) continue;
    const hasAny = await env.DB.prepare("SELECT COUNT(*) AS n FROM match WHERE stage_id = ?")
      .bind(next.id)
      .first<{ n: number }>();
    if ((hasAny?.n ?? 0) > 0) continue;

    const cfg = (JSON.parse(next.config_json || "{}") ?? {}) as {
      loops?: number;
      legs?: number;
      final_legs?: number;
      third_place?: boolean;
      source?: { take?: number; from?: number; to?: number; fromStage?: number; cross?: string[] | string };
    };
    const planOpts = {
      legs: (cfg.legs === 2 ? 2 : 1) as 1 | 2,
      finalLegs: (cfg.final_legs === 2 ? 2 : cfg.final_legs === 1 ? 1 : undefined) as 1 | 2 | undefined,
      thirdPlace: !!cfg.third_place,
    };
    const slotOf = new Map<number, number>(); // RR 计划无 slot，按轮内自增；elim 计划自带
    const pushPlan = (
      matches: Array<{
        round: number;
        slot?: number;
        leg?: number | null;
        home: number | null;
        away: number | null;
        note?: string | null;
      }>,
      direct: boolean,
      pool: EntryRow[]
    ) => {
      for (const pm of matches) {
        const slot = pm.slot ?? (slotOf.get(pm.round) ?? 0) + 1;
        slotOf.set(pm.round, slot);
        const home = direct
          ? pm.home
          : pm.home !== null && pm.home <= pool.length
            ? pool[pm.home - 1].id
            : null;
        const away = direct
          ? pm.away
          : pm.away !== null && pm.away <= pool.length
            ? pool[pm.away - 1].id
            : null;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, winner_entry_id, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(
            next.id,
            pm.round,
            slot,
            pm.leg ?? null,
            home,
            away,
            home != null && away == null ? home : null,
            pm.note ?? null
          )
        );
      }
    };

    const raw = cfg.source?.cross;
    const tokens = Array.isArray(raw)
      ? raw.map((s) => String(s).trim()).filter(Boolean)
      : typeof raw === "string"
        ? raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
        : [];

    if (tokens.length > 0 && next.kind === "elim") {
      if (immediatePrevOf(next.sort_order)?.id !== prev.id) continue;
      try {
        const plan = await buildCrossStagePlan(env, tid, next.id, tokens, planOpts);
        pushPlan(plan.matches, true, []);
      } catch {
        // 来源组未就绪等守卫拦截：静默跳过，手动生成会给明确报错
      }
      continue;
    }

    const take = cfg.source?.take;
    const hasRange = cfg.source?.from != null;
    if (!take && !hasRange) continue;
    // 来源阶段：fromStage 指定，或默认紧邻上一阶段；必须是刚完赛的 prev 才由本次触发
    const srcStage = cfg.source?.fromStage
      ? stages.find(
          (s) => s.id === cfg.source!.fromStage && s.sort_order < next.sort_order
        ) ?? null
      : immediatePrevOf(next.sort_order);
    if (!srcStage || srcStage.id !== prev.id) continue;
    if (srcStage.kind === "elim") continue; // 淘汰赛无名次可取；手动生成按钮会给明确报错
    // 来源阶段必须全部完赛（fromStage 指向更早阶段时额外校验）
    const unfinished = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM match WHERE stage_id = ? AND status != 'finished'"
    )
      .bind(srcStage.id)
      .first<{ n: number }>();
    if ((unfinished?.n ?? 0) !== 0) continue;

    let pool: EntryRow[];
    try {
      pool = await takeRangePool(env, tid, next.id, cfg.source!);
    } catch {
      continue; // 区间越界等守卫未过：静默跳过
    }
    if (pool.length < 2) continue;
    if (next.kind === "elim") {
      pushPlan(buildElimPlan(pool.length, planOpts).matches, false, pool);
    } else if (next.kind === "round_robin") {
      const sched = roundRobinSchedule(pool.length, cfg.loops === 2 ? 2 : 1);
      // 淘汰赛分支要用原序做种子位映射，洗牌只用于循环赛分支的映射数组
      const mixed = shuffle(pool);
      // roundRobinSchedule 的 home/away 是 0-based 队号，+1 对齐 pushPlan 的 1-based 种子位
      pushPlan(
        sched.matches.map((m) => ({ round: m.round, home: m.home + 1, away: m.away + 1 })),
        false,
        mixed
      );
    }
  }
  return stmts;
}

app.delete("/:id/stages/:stageId/matches", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  try {
    const { stage, started } = await loadStage(c.env.DB, tid, stageId);
    if (started > 0) {
      return fail(c, 409, "该阶段已有开打或完赛的场次，不能一键清除");
    }
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM match WHERE stage_id = ?")
      .bind(stage.id)
      .first<{ n: number }>();
    if ((n?.n ?? 0) === 0) return c.json({ ok: true, deleted: 0 });
    await c.env.DB.prepare("DELETE FROM match WHERE stage_id = ?").bind(stage.id).run();
    return c.json({ ok: true });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

// 补全双循环：以第一循环（前 k 轮，偶数队 k=n-1、奇数队 k=n）为镜像源生成第二循环，
// 主客对调、轮次对称翻转（第 m 轮 → 第 2k+1-m 轮）。只接受第一循环完整（各队互赛
// 恰好一场）的阶段；第二循环已有 live/finished 时拒绝覆盖，pending 的直接清掉重排。
app.post("/:id/stages/:stageId/complete-double", async (c) => {
  const tid = Number(c.req.param("id"));
  const stageId = Number(c.req.param("stageId"));
  try {
    const { stage } = await loadStage(c.env.DB, tid, stageId);
    if (stage.kind !== "round_robin") {
      return fail(c, 400, "补全双循环只适用于循环赛阶段");
    }
    const rows = await c.env.DB.prepare(
      `SELECT id, round, slot, home_entry_id, away_entry_id, status
       FROM match WHERE stage_id = ? ORDER BY round, slot`
    )
      .bind(stage.id)
      .all<{
        id: number;
        round: number;
        slot: number;
        home_entry_id: number | null;
        away_entry_id: number | null;
        status: string;
      }>();
    const all = rows.results ?? [];

    const teamSet = new Set<number>();
    for (const m of all) {
      if (m.home_entry_id != null) teamSet.add(m.home_entry_id);
      if (m.away_entry_id != null) teamSet.add(m.away_entry_id);
    }
    const n = teamSet.size;
    if (n < 2) return fail(c, 400, "阶段里还没有比赛，先生成赛程再补全双循环");

    const k = n % 2 === 0 ? n - 1 : n;
    const maxRound = all.reduce((mx, m) => Math.max(mx, m.round), 0);
    if (maxRound < k) {
      return fail(c, 400, `第一循环不完整：至少需要 ${k} 轮，当前只有 ${maxRound} 轮`);
    }

    const pairKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const first: typeof all = [];
    const seen = new Set<string>();
    for (const m of all) {
      if (m.round > k) break;
      if (m.home_entry_id == null || m.away_entry_id == null) continue;
      const key = pairKey(m.home_entry_id, m.away_entry_id);
      if (seen.has(key)) {
        return fail(c, 400, "第一循环存在重复交手，无法镜像生成第二循环");
      }
      seen.add(key);
      first.push(m);
    }
    const expect = (n * (n - 1)) / 2;
    if (seen.size !== expect) {
      return fail(
        c,
        400,
        `第一循环不完整：${n} 支队单循环应有 ${expect} 场互赛，当前只有 ${seen.size} 场`
      );
    }

    const second = all.filter((m) => m.round > k);
    if (second.some((m) => m.status === "live" || m.status === "finished")) {
      return fail(c, 409, "第二循环已有开打或完赛的场次，不能覆盖重排");
    }

    const stmts: D1PreparedStatement[] = second.map((m) =>
      c.env.DB.prepare("DELETE FROM match WHERE id = ?").bind(m.id)
    );
    const insertStmt =
      "INSERT INTO match (stage_id, round, slot, leg, home_entry_id, away_entry_id, status, winner_entry_id, note) VALUES (?, ?, ?, NULL, ?, ?, 'pending', NULL, NULL)";
    for (const m of first) {
      stmts.push(
        c.env.DB.prepare(insertStmt).bind(
          stage.id,
          2 * k + 1 - m.round,
          m.slot,
          m.away_entry_id,
          m.home_entry_id
        )
      );
    }
    if (stmts.length > 0) await c.env.DB.batch(stmts);
    return c.json({ ok: true, created: first.length, deleted: second.length });
  } catch (e) {
    if (e instanceof HttpError) return fail(c, e.status, e.message);
    throw e;
  }
});

export default app;
