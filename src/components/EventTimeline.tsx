import type { PublicMatchEventDTO } from "../../shared/types";

// 进球类用足球圆点同形不同色：进球=草皮绿、点球进球=比赛日橙、乌龙=红；
// 点球不进 = 橙球打叉。红黄牌/受伤沿用 emoji。
// 定论口径：赛程内联时间线显示 进球（含点球/乌龙）、红牌、受伤；
// 详情页 showAll 时补上黄牌和点球未中。
const BALL = new Set(["goal", "pen_goal", "own_goal", "pen_miss"]);
const BASE: Partial<Record<PublicMatchEventDTO["type"], { icon: string; tag?: string }>> = {
  goal: { icon: "" },
  pen_goal: { icon: "", tag: "点球" },
  own_goal: { icon: "", tag: "乌龙" },
  red: { icon: "🟥" },
  injury_minor: { icon: "🩹" },
  injury_major: { icon: "🚑" },
};
const EXTRA: Partial<Record<PublicMatchEventDTO["type"], { icon: string; tag?: string }>> = {
  yellow: { icon: "🟨" },
  pen_miss: { icon: "", tag: "点球不进" },
};

// 事件时间线：主队事件左对齐、客队右对齐，与上方比分行的主客位置对应
export function EventTimeline({
  events,
  showAll = false,
}: {
  events: PublicMatchEventDTO[];
  showAll?: boolean;
}) {
  const rows = events.filter((e) => BASE[e.type] || (showAll && EXTRA[e.type]));
  if (rows.length === 0) return null;
  return (
    <div className="evt-list">
      {rows.map((e) => {
        const meta = BASE[e.type] ?? EXTRA[e.type]!;
        return (
          <div key={e.id} className={`evt-row ${e.side === "home" ? "evt-home" : "evt-away"}`}>
            <span className="evt-min">{e.minute !== null ? `${e.minute}′` : ""}</span>
            <span className="evt-icon">
              {BALL.has(e.type) ? (
                <span
                  className={`evt-ball b-${e.type === "pen_miss" ? "pen_goal" : e.type}${e.type === "pen_miss" ? " evt-miss" : ""}`}
                  aria-hidden
                />
              ) : (
                meta.icon
              )}
            </span>
            <span className="evt-who">
              {e.playerName ?? "—"}
              {meta.tag && <span className="evt-tag">{meta.tag}</span>}
              {e.assistPlayerName && (
                <span className="evt-assist">（助攻 {e.assistPlayerName}）</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
