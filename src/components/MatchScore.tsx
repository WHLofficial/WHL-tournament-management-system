import type { MatchDTO } from "../../shared/types";

// 双回合总比分：同 slot 另一 leg 也完赛后，以本行主队视角返回 [aggHome, aggAway]
export function computeAgg(m: MatchDTO, roundList: MatchDTO[]): [number, number] | null {
  if (m.leg == null || m.note === "轮空") return null;
  const sib = roundList.find(
    (x) => x.id !== m.id && x.slot === m.slot && x.leg != null && x.note !== "轮空",
  );
  if (!sib) return null;
  const leg1 = m.leg === 1 ? m : sib;
  const leg2 = m.leg === 1 ? sib : m;
  if (
    leg1.scoreHome == null ||
    leg1.scoreAway == null ||
    leg2.scoreHome == null ||
    leg2.scoreAway == null
  ) {
    return null;
  }
  // A = leg1 主队（leg2 主客互换）；A 的总比分 = leg1 主队进球 + leg2 客队进球
  const aggA = leg1.scoreHome + leg2.scoreAway;
  const aggB = leg1.scoreAway + leg2.scoreHome;
  return m.leg === 1 ? [aggA, aggB] : [aggB, aggA];
}

// 比分格：主比分一行，点球 / 双回合总比分放第二行小字，行宽风格与无点球场次一致
export function MatchScore({ m, agg }: { m: MatchDTO; agg: [number, number] | null }) {
  const s = (v: number | null) => (v === null ? "-" : String(v));
  const bye = m.note === "轮空";
  const showPen = !bye && m.penHome !== null && m.penAway !== null;
  return (
    <span className="mr-scorebox">
      <span className="mr-score">{bye ? "轮空" : `${s(m.scoreHome)} : ${s(m.scoreAway)}`}</span>
      {agg && !bye && (
        <span className="mr-sub">
          总比分 {agg[0]}:{agg[1]}
        </span>
      )}
      {showPen && (
        <span className="mr-sub">
          点球 {m.penHome}:{m.penAway}
        </span>
      )}
    </span>
  );
}
