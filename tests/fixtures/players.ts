// 名单相关测试的共享夹具：插一名球员 + 一条开放窗口。
// 阶段 A 仍双写 player.team_id；0035 才删列。
import type { DatabaseSync } from "node:sqlite";

export function insertPlayerWithWindow(
  sqlite: DatabaseSync,
  p: { id: number; teamId: number; name: string; number?: string | null; createdAt?: string; joinedAt?: string },
): void {
  const createdAt = p.createdAt ?? "2026-01-01T00:00:00.000Z";
  sqlite
    .prepare("INSERT INTO player (id, team_id, name, number, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(p.id, p.teamId, p.name, p.number ?? null, createdAt);
  sqlite
    .prepare("INSERT INTO player_team_history (player_id, team_id, joined_at, source) VALUES (?, ?, ?, 'seed')")
    .run(p.id, p.teamId, p.joinedAt ?? createdAt);
}
