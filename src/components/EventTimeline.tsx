import type { PublicMatchEventDTO } from "../../shared/types";
import { CardIcon } from "./Cards";

// 定论口径：赛程内联时间线显示 进球（含点球/乌龙）、红牌、受伤；
// 详情页 showAll 时补上黄牌和点球不进。
// 图标 = ⚽ emoji + 类型角标：点球叠绿点、乌龙叠玫红点、点球不进叠红叉；
// 牌类用 CSS 画的红黄牌（打样定稿 C 方案），injury 用 emoji；icon 保留 emoji 字符串供分享卡降级。
type EType = PublicMatchEventDTO["type"];
type CardKind = "red" | "yellow" | "red_2y";
const BALL_MARK: Partial<Record<EType, string>> = {
  pen_goal: "pen",
  own_goal: "own",
  pen_miss: "miss",
};
const SHOW: Partial<Record<EType, { icon: string; card?: CardKind; tag?: string }>> = {
  goal: { icon: "⚽" },
  pen_goal: { icon: "⚽", tag: "点球" },
  own_goal: { icon: "⚽", tag: "乌龙" },
  red: { icon: "🟥", card: "red" },
  red_2y: { icon: "🟨🟥", card: "red_2y", tag: "两黄变红" },
  injury_minor: { icon: "🩹" },
  injury_major: { icon: "🚑" },
};
const EXTRA: Partial<Record<EType, { icon: string; card?: CardKind; tag?: string }>> = {
  yellow: { icon: "🟨", card: "yellow" },
  pen_miss: { icon: "⚽", tag: "点球不进" },
};

// 事件是否上时间线（详情页 showAll = 全部 9 类）；分享卡与页面共用同一口径
export function eventMeta(
  type: EType
): { icon: string; card?: CardKind; tag?: string } | null {
  return SHOW[type] ?? EXTRA[type] ?? null;
}

// 乌龙显示在受益方（球算进对方球门那侧），与赛程页事件摘要口径一致
export function timelineSide(e: PublicMatchEventDTO): "home" | "away" {
  return e.type === "own_goal" ? (e.side === "home" ? "away" : "home") : e.side;
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
            <span className={`evt-icon${mark ? ` evt-ball ${mark}` : ""}`}>
              {meta.card ? <CardIcon kind={meta.card} /> : meta.icon}
            </span>
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
        const side = timelineSide(e);
        return (
          <div key={e.id} className={`evt-row ${side === "home" ? "evt-home" : "evt-away"}`}>
            {side === "home" && info}
            <span className="evt-mid">
              <span className="evt-chain" />
            </span>
            {side === "away" && info}
          </div>
        );
      })}
    </div>
  );
}
