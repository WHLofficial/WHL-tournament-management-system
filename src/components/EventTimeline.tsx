import type { PublicMatchEventDTO } from "../../shared/types";

// 定论口径：赛程内联时间线显示 进球（含点球/乌龙）、红牌、受伤；
// 详情页 showAll 时补上黄牌和点球不进。
// 进球类节点 = SVG 足球：进球=经典黑白、点球=绿、乌龙=玫红、点球不进=绿球打叉；
// 红黄牌/受伤沿用 emoji。
type EType = PublicMatchEventDTO["type"];
const BALL: Partial<Record<EType, { ball: string; pattern: string; tag?: string }>> = {
  goal: { ball: "#f4f6f3", pattern: "#1a2420" },
  pen_goal: { ball: "#0e7a46", pattern: "#f4f6f3", tag: "点球" },
  own_goal: { ball: "#e64980", pattern: "#f4f6f3", tag: "乌龙" },
  pen_miss: { ball: "#0e7a46", pattern: "#f4f6f3", tag: "点球不进" },
};
const SHOW: Partial<Record<EType, { icon?: string; tag?: string }>> = {
  goal: { icon: "" },
  pen_goal: { tag: "点球" },
  own_goal: { tag: "乌龙" },
  red: { icon: "🟥" },
  injury_minor: { icon: "🩹" },
  injury_major: { icon: "🚑" },
};
const EXTRA: Partial<Record<EType, { icon?: string; tag?: string }>> = {
  yellow: { icon: "🟨" },
  pen_miss: { tag: "点球不进" },
};

// 经典足球：圆 + 中央五边形 + 五条缝线
function Ball({ ball, pattern, missed }: { ball: string; pattern: string; missed?: boolean }) {
  return (
    <svg className="evt-ball" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
      <circle cx="8" cy="8" r="6.6" fill={ball} stroke="rgba(26,36,32,.35)" strokeWidth="0.8" />
      <polygon points="8,5 10.85,7.07 9.76,10.43 6.24,10.43 5.15,7.07" fill={pattern} />
      <g stroke={pattern} strokeWidth="0.8" strokeLinecap="round">
        <line x1="8" y1="5" x2="8" y2="2.2" />
        <line x1="10.85" y1="7.07" x2="13.4" y2="6.2" />
        <line x1="9.76" y1="10.43" x2="11.3" y2="12.9" />
        <line x1="6.24" y1="10.43" x2="4.7" y2="12.9" />
        <line x1="5.15" y1="7.07" x2="2.6" y2="6.2" />
      </g>
      {missed && (
        <g stroke="#fff" strokeWidth="1.6" strokeLinecap="round">
          <line x1="5" y1="5" x2="11" y2="11" />
          <line x1="11" y1="5" x2="5" y2="11" />
        </g>
      )}
    </svg>
  );
}

// 中央链条-节点式时间线：中轴贯穿，节点坐轴上；主队内容向左展开、客队向右展开
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
        const tag = BALL[e.type]?.tag ?? EXTRA[e.type]?.tag;
        const who = (
          <span className="evt-who">
            {e.playerName ?? "—"}
            {tag && <span className="evt-tag">{tag}</span>}
            {e.assistPlayerName && (
              <span className="evt-assist">（助攻 {e.assistPlayerName}）</span>
            )}
          </span>
        );
        return (
          <div key={e.id} className={`evt-row ${e.side === "home" ? "evt-home" : "evt-away"}`}>
            {e.side === "home" && who}
            <span className="evt-mid">
              <span className="evt-min">{e.minute !== null ? `${e.minute}′` : ""}</span>
              {BALL[e.type] ? (
                <Ball
                  ball={BALL[e.type]!.ball}
                  pattern={BALL[e.type]!.pattern}
                  missed={e.type === "pen_miss"}
                />
              ) : (
                <span className="evt-node">{(SHOW[e.type] ?? EXTRA[e.type])!.icon}</span>
              )}
            </span>
            {e.side === "away" && who}
          </div>
        );
      })}
    </div>
  );
}
