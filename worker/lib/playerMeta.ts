// 球员附加信息（徽章 / 属性）的可插拔来源。
// 当前 player 表只有 id/name/number，这里恒返回空 Map —— UI 按「有 meta 才渲染」处理。
// 将来接 club 平台或本仓新增属性表，只改这一个文件：查库后按 playerId 填 Map 即可。
import type { PlayerMeta } from "../../shared/types";

export async function loadPlayerMeta(
  _db: D1Database,
  _playerIds: number[],
): Promise<Map<number, PlayerMeta>> {
  return new Map();
}
