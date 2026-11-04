// 0033 迁移：球员归属履历表。读端（P3）全部押在「一人一条开放窗口」上，
// 这里的约束必须在 SQLite 真库上验过，不能只靠设计文档。

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyMigrations, sqlAll, sqlGet } from "./d1";

const dir = fileURLToPath(new URL("../migrations/", import.meta.url));

// 种子只对迁移执行时已存在的球员生效：先在 0032 的库上造数据，再单独跑 0033
function dbBefore0033(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (f >= "0033") continue;
    sqlite.exec(readFileSync(dir + f, "utf8"));
  }
  return sqlite;
}

function run0033(sqlite: DatabaseSync): void {
  const f = readdirSync(dir).find((f) => f.startsWith("0033"));
  if (!f) throw new Error("migrations 里找不到 0033");
  sqlite.exec(readFileSync(dir + f, "utf8"));
}

function seedTeamAndPlayers(sqlite: DatabaseSync, legacyTeamColumn = false): void {
  sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (1, 1, '甲队')");
  sqlite.exec("INSERT INTO team (id, org_id, name) VALUES (2, 1, '乙队')");
  // legacyTeamColumn 只在「迁移到 0032 为止」的库上用；全量迁移后的 player 已无归属列
  if (legacyTeamColumn) {
    sqlite.exec(
      "INSERT INTO player (id, team_id, name, created_at) VALUES (11, 1, '张三', '2026-01-02T03:04:05.000Z')",
    );
    sqlite.exec(
      "INSERT INTO player (id, team_id, name, created_at) VALUES (12, 2, '李四', '2026-02-03T04:05:06.000Z')",
    );
    return;
  }
  sqlite.exec("INSERT INTO player (id, name, created_at) VALUES (11, '张三', '2026-01-02T03:04:05.000Z')");
  sqlite.exec("INSERT INTO player (id, name, created_at) VALUES (12, '李四', '2026-02-03T04:05:06.000Z')");
}

function openWindow(sqlite: DatabaseSync, playerId: number, teamId: number, joinedAt = "2026-03-01T00:00:00.000Z"): void {
  sqlite
    .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at) VALUES (?, ?, ?)")
    .run(playerId, teamId, joinedAt);
}

describe("0033 player_team_history", () => {
  it("建表、player.history_synced_at 与四个索引都在", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);

    const cols = sqlAll<{ name: string }>(sqlite, "PRAGMA table_info(player_team_history)").map((c) => c.name);
    expect(cols).toEqual(["id", "player_id", "team_id", "joined_at", "left_at", "source", "created_at"]);

    const playerCols = sqlAll<{ name: string }>(sqlite, "PRAGMA table_info(player)").map((c) => c.name);
    expect(playerCols).toContain("history_synced_at");

    const indexes = sqlAll<{ name: string }>(sqlite, "SELECT name FROM sqlite_master WHERE type = 'index'").map(
      (i) => i.name,
    );
    for (const name of ["uq_pth_open_player", "idx_pth_open_team", "idx_pth_player", "idx_pth_team"]) {
      expect(indexes).toContain(name);
    }
  });

  it("一人至多一条开放窗口；关窗后可开新窗（转会），历史行保留", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    seedTeamAndPlayers(sqlite);

    openWindow(sqlite, 11, 1);
    expect(() => openWindow(sqlite, 11, 2)).toThrow(/UNIQUE constraint failed/);

    sqlite.exec("UPDATE player_team_history SET left_at = '2026-06-01T00:00:00.000Z' WHERE player_id = 11");
    openWindow(sqlite, 11, 2, "2026-06-02T00:00:00.000Z");

    const rows = sqlAll<{ team_id: number; left_at: string | null }>(
      sqlite,
      "SELECT team_id, left_at FROM player_team_history WHERE player_id = 11 ORDER BY joined_at",
    );
    expect(rows).toEqual([
      { team_id: 1, left_at: "2026-06-01T00:00:00.000Z" },
      { team_id: 2, left_at: null },
    ]);
  });

  it("source 只接受四种取值，默认 sync", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    seedTeamAndPlayers(sqlite);

    openWindow(sqlite, 11, 1);
    expect(
      sqlGet<{ source: string }>(sqlite, "SELECT source FROM player_team_history WHERE player_id = 11")?.source,
    ).toBe("sync");

    expect(() =>
      sqlite
        .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (?, ?, ?, ?)")
        .run(12, 2, "2026-03-01T00:00:00.000Z", "bogus"),
    ).toThrow(/CHECK constraint failed/);
  });

  it("种子按迁移前 player 行的归属建开放窗口，joined_at 取 created_at，不写 history_synced_at", () => {
    const sqlite = dbBefore0033();
    seedTeamAndPlayers(sqlite, true);
    run0033(sqlite);

    const rows = sqlAll<{ player_id: number; team_id: number; joined_at: string; left_at: string | null; source: string }>(
      sqlite,
      "SELECT player_id, team_id, joined_at, left_at, source FROM player_team_history ORDER BY player_id",
    );
    expect(rows).toEqual([
      { player_id: 11, team_id: 1, joined_at: "2026-01-02T03:04:05.000Z", left_at: null, source: "seed" },
      { player_id: 12, team_id: 2, joined_at: "2026-02-03T04:05:06.000Z", left_at: null, source: "seed" },
    ]);

    const flagged = sqlAll<{ id: number }>(sqlite, "SELECT id FROM player WHERE history_synced_at IS NOT NULL");
    expect(flagged).toEqual([]);
  });

  it("删球员或删队级联删履历", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    seedTeamAndPlayers(sqlite);
    openWindow(sqlite, 11, 1);
    openWindow(sqlite, 12, 2);

    sqlite.exec("DELETE FROM player WHERE id = 11");
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_team_history")?.n).toBe(1);

    sqlite.exec("DELETE FROM team WHERE id = 2");
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_team_history")?.n).toBe(0);
  });
});

describe("0035 删归属列", () => {
  it("列与旧索引都消失，履历保留；回滚时可按开放窗口回填可空列", () => {
    const sqlite = new DatabaseSync(":memory:");
    applyMigrations(sqlite);
    seedTeamAndPlayers(sqlite);
    openWindow(sqlite, 11, 1);
    openWindow(sqlite, 12, 2);

    const playerCols = sqlAll<{ name: string }>(sqlite, "PRAGMA table_info(player)").map((c) => c.name);
    expect(playerCols).not.toContain("team_id");
    const indexes = sqlAll<{ name: string }>(sqlite, "SELECT name FROM sqlite_master WHERE type = 'index'").map(
      (i) => i.name,
    );
    expect(indexes).not.toContain("idx_player_team");
    expect(sqlGet<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM player_team_history")?.n).toBe(2);

    // 回滚 smoke：加回可空列 → 用开放窗口回填 → 旧索引可重建
    sqlite.exec("ALTER TABLE player ADD COLUMN team_id INTEGER");
    sqlite.exec(
      `UPDATE player SET team_id = (
         SELECT h.team_id FROM player_team_history h
         WHERE h.player_id = player.id AND h.left_at IS NULL
         ORDER BY h.joined_at DESC, h.id DESC LIMIT 1
       )`,
    );
    sqlite.exec("CREATE INDEX idx_player_team ON player(team_id)");
    expect(sqlAll(sqlite, "SELECT id, team_id FROM player ORDER BY id")).toEqual([
      { id: 11, team_id: 1 },
      { id: 12, team_id: 2 },
    ]);
  });
});
