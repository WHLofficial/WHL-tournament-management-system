import type { PublicMatchEventDTO } from "../../shared/types";

// 定论口径：赛程内联时间线显示 进球（含点球/乌龙）、红牌、受伤；
// 详情页 showAll 时补上黄牌和点球不进。
// 图标 = ⚽ emoji + 类型角标：点球叠绿点、乌龙叠玫红点、点球不进叠红叉；牌/受伤用 emoji。
type EType = PublicMatchEventDTO["type"];
const BALL_MARK: Partial<Record<EType, string>> = {
  pen_goal: "pen",
  own_goal: "own",
  pen_miss: "miss",
};
const SHOW: Partial<Record<EType, { icon: string; tag?: string }>> = {
  goal: { icon: "⚽" },
  pen_goal: { icon: "⚽", tag: "点球" },
  own_goal: { icon: "⚽", tag: "乌龙" },
  red: { icon: "🟥" },
  injury_minor: { icon: "🩹" },
  injury_major: { icon: "🚑" },
};
const EXTRA: Partial<Record<EType, { icon: string; tag?: string }>> = {
  yellow: { icon: "🟨" },
  pen_miss: { icon: "⚽", tag: "点球不进" },
};

// 事件是否上时间线（详情页 showAll = 全部 8 类）；分享卡与页面共用同一口径
export function eventMeta(type: EType): { icon: string; tag?: string } | null {
  return SHOW[type] ?? EXTRA[type] ?? null;
}

// 中央链条-节点式时间线：中轴贯穿、轴上是素色链环节点；
// 事件图标+分钟+球员信息作为信息块贴在轴旁——主队向左展开、客队向右展开
export function EventTimeline({
  events,
  showAll = false,
}: {
  events: PublicMatchEventDTO[];
  showAll?: boolean;
}) {
  const rows = events.filter((e) => SHOW[e.type] || (showAll && EXTRA[e.type]));
  if (rows.length === 0) return null;
  return (
    <div className="evt-list">
      {rows.map((e) => {
        const meta = SHOW[e.type] ?? EXTRA[e.type]!;
        const mark = BALL_MARK[e.type];
        const info = (
          <span className="evt-info">
            <span className={`evt-icon${mark ? ` evt-ball ${mark}` : ""}`}>{meta.icon}</span>
            <span className="evt-min">{e.minute !== null ? `${e.minute}′` : ""}</span>
            <span className="evt-who">
              {e.playerName}
              {meta.tag && <span className="evt-tag">{meta.tag}</span>}
              {e.assistPlayerName && (
                <span className="evt-assist" title="助攻">
                  👟 {e.assistPlayerName}
                </span>
              )}
            </span>
          </span>
        );
        return (
          <div key={e.id} className={`evt-row ${e.side === "home" ? "evt-home" : "evt-away"}`}>
            {e.side === "home" && info}
            <span className="evt-mid">
              <span className="evt-chain" />
            </span>
            {e.side === "away" && info}
          </div>
        );
      })}
    </div>
  );
}
