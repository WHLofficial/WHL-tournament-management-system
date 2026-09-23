// 增量 37：EA FC26 球队目录（建队时的软校验用）。
// 目录与俱乐部平台 web/assets/ref/team.json 是同一份 EA 队号表（增量 17 起 club 侧就在用它）：
// 建队时填了「游戏球队 ID」就查这张表，把官方队名显示出来供核对。
// 只软校验不硬拦——EA 队号表本就有空号（缺 6、16…），且将来版本会新增球队，
// 硬校验会把合法的自建球队挡在门外（自建队正是本仓存在的理由）。
import teamRef from "./fc26Teams.json";

export interface Fc26TeamRef {
  id: number;
  name: string;
}

const REF = teamRef as Fc26TeamRef[];

// EA 队号表里有重号项（同一 id 出现多次），首次出现即为准
const BY_ID = new Map<number, string>();
for (const t of REF) {
  if (!BY_ID.has(t.id)) BY_ID.set(t.id, t.name);
}

/** 游戏球队 ID → EA 官方队名；目录里没有则 null */
export function fc26TeamName(id: number): string | null {
  return BY_ID.get(id) ?? null;
}

/** 该游戏球队 ID 是否在 EA 目录里（不在只是提醒，不阻断建队） */
export function isKnownFc26Team(id: number): boolean {
  return BY_ID.has(id);
}
