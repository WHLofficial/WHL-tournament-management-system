import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../api";
import { TeamLogo } from "../components/TeamLogo";
import { ShareButton } from "../components/ShareButton";
import { drawTableCard } from "../lib/share";
import type { StageStandingDTO, RankZone, RankZoneSettings } from "../../shared/types";
import { formatRankRange, matchRankZone, zonesForTable } from "../../shared/rankZones";

// 积分榜：小组/循环阶段各一张表，行序已由后端排好（积分→净胜→进球→相互战绩）。
// 管理端挂在「积分榜」tab；公开页直接复用 <StandingsTables>。
// rankZones：排名段标记配置（色条/分隔线两种样式），不传 = 无标记。
export default function StandingsTab({ tournamentId }: { tournamentId: number }) {
  const [standings, setStandings] = useState<StageStandingDTO[] | null>(null);
  const [rankZones, setRankZones] = useState<RankZoneSettings | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ standings: StageStandingDTO[]; rankZones: RankZoneSettings | null }>(
      `/api/admin/tournaments/${tournamentId}/standings`
    )
      .then((b) => {
        setStandings(b.standings);
        setRankZones(b.rankZones ?? null);
      })
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : "加载积分榜失败"));
  }, [tournamentId]);

  if (err) return <p className="error-msg card">{err}</p>;
  if (standings === null) return <p className="muted card">加载中…</p>;
  if (standings.length === 0)
    return <p className="muted card">还没有积分榜。循环赛或小组赛阶段产生比分后，这里会自动出现排名。</p>;

  return <StandingsTables standings={standings} rankZones={rankZones} />;
}

export function StandingsTables({
  standings,
  share,
  rankZones,
}: {
  standings: StageStandingDTO[];
  share?: { tournamentName: string; url: string; coverUrl?: string | null } | null;
  rankZones?: RankZoneSettings | null;
}) {
  const stageTitle = { group: "小组赛", round_robin: "循环赛" } as const;
  const zoneStyle = rankZones?.style ?? "strip";
  const zones = rankZones?.zones ?? [];
  return (
    <>
      {standings.map((st) => {
        // 阶段显示名：管理员自定义名优先（编排页改名后积分榜跟随），否则按赛制默认
        const stageName = st.name || stageTitle[st.kind];
        const allRows = st.groups.flatMap((g) => g.rows.map((r) => ({ g, r })));
        const multi = st.groups.length > 1;
        // 分组榜分享卡每组独立小节（组标+自带表头），不再用「组」列
        const columns = ["#", "球队", "赛", "胜", "平", "负", "进", "失", "净", "积分"];
        const colWidths = [0.6, 2.2, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9, 1.1];
        const rowStr = (r: (typeof allRows)[number]["r"]) => [
          String(r.rank),
          r.teamName,
          String(r.played),
          String(r.won),
          String(r.drawn),
          String(r.lost),
          String(r.goalsFor),
          String(r.goalsAgainst),
          String(r.goalsFor - r.goalsAgainst),
          String(r.pts),
        ];
        const tableRows = allRows.map(({ r }) => rowStr(r));
        const groupBlocks = st.groups.map((g) => ({
          label: `${g.name || "-"} 组`,
          rows: g.rows.map(rowStr),
        }));
        // 排名段标记在分享卡里的数据（跟随赛事展示样式设置）
        const stageZoneColors = (rowColors: (string | null)[], leg: { color: string; name: string; range: string }[], dividers: { afterRow: number; color: string; name: string }[]) =>
          share && zones.length > 0 ? { style: zoneStyle, rowColors, legend: leg, dividers } : undefined;
        const zoneLegendForStage = zonesForTable(
          zones,
          st.stageId,
          st.groups.map((g) => g.groupId).filter((id): id is number => id != null),
        ).map((z) => ({ color: z.color, name: z.name, range: formatRankRange(z.from, z.to) }));
        const zoneRowColors = allRows.map(({ g, r }) =>
          matchRankZone(r.rank, zones, st.stageId, g.groupId)?.color ?? null,
        );
        const zoneDividers: { afterRow: number; color: string; name: string }[] = [];
        if (zoneStyle === "divider") {
          let offset = 0;
          for (const g of st.groups) {
            const applicable = zonesForTable(
              zones,
              st.stageId,
              g.groupId != null ? [g.groupId] : [],
            );
            g.rows.forEach((r, i) => {
              const isLast = i === g.rows.length - 1;
              for (const z of applicable) {
                if (z.to === r.rank || (isLast && z.to > r.rank)) {
                  zoneDividers.push({ afterRow: offset + i, color: z.color, name: z.name });
                }
              }
            });
            offset += g.rows.length;
          }
        }
        return (
        <section key={st.stageId} className="standings-stage">
          <h3 className="stage-head">
            <span>{stageName}</span>
            {share && tableRows.length > 0 && (
              <ShareButton
                title={`分享「${stageName}积分榜」`}
                url={share.url}
                draw={(c) =>
                  drawTableCard(c, {
                    tournamentName: share.tournamentName,
                    title: `${stageName}积分榜`,
                    coverUrl: share.coverUrl ?? null,
                    columns,
                    colWidths,
                    nameCol: 1,
                    rows: multi ? undefined : tableRows,
                    groups: multi ? groupBlocks : undefined,
                    zones: stageZoneColors(zoneRowColors, zoneLegendForStage, zoneDividers),
                    url: share.url,
                  })
                }
              />
            )}
          </h3>
          <div className={st.groups.length > 1 ? "standings-grid" : ""}>
            {st.groups.map((g) => (
              <RankZoneTable
                key={g.groupId ?? 0}
                stageId={st.stageId}
                group={g}
                zoneStyle={zoneStyle}
                zones={zones}
              />
            ))}
          </div>
        </section>
        );
      })}
      <p className="muted standings-note">
        * 积分：胜 3、平 1、负 0；平局后点球决胜的点球胜者记 2 分、负者记 1 分。排名依次比较积分、净胜球、进球数、相互战绩。
      </p>
    </>
  );
}

// 单张积分表：排名段渲染（strip=左缘色条+图例；divider=区间分隔线）与普通行共用一套列。
function RankZoneTable({
  stageId,
  group,
  zoneStyle,
  zones,
}: {
  stageId: number;
  group: StageStandingDTO["groups"][number];
  zoneStyle: "strip" | "divider";
  zones: RankZone[];
}) {
  const applicable = zonesForTable(
    zones,
    stageId,
    group.groupId != null ? [group.groupId] : [],
  );
  const bodyRows: ReactNode[] = [];
  group.rows.forEach((r, i) => {
    const isLast = i === group.rows.length - 1;
    if (zoneStyle === "strip") {
      const z = matchRankZone(r.rank, zones, stageId, group.groupId);
      bodyRows.push(
        <tr
          key={r.entryId}
          data-zone={z ? z.id : undefined}
          style={z ? ({ "--zone-color": z.color } as CSSProperties) : undefined}
        >
          <td className="num">{r.rank}</td>
          <td className="team-col">
            <span className="cell-with-logo">
              <TeamLogo name={r.teamName} url={r.teamLogoUrl} size={20} />
              {r.teamName}
            </span>
          </td>
          <td className="num">{r.played}</td>
          <td className="num">{r.won}</td>
          <td className="num">{r.drawn}</td>
          <td className="num">{r.lost}</td>
          <td className="num">{r.goalsFor}</td>
          <td className="num">{r.goalsAgainst}</td>
          <td className="num">{r.goalsFor - r.goalsAgainst}</td>
          <td className="num pts">
            {r.pts}
            {r.pointsDeducted > 0 && (
              <span className="deduct" title={`被扣 ${r.pointsDeducted} 分`}>
                −{r.pointsDeducted}
              </span>
            )}
          </td>
        </tr>,
      );
    } else {
      bodyRows.push(
        <tr key={r.entryId}>
          <td className="num">{r.rank}</td>
          <td className="team-col">
            <span className="cell-with-logo">
              <TeamLogo name={r.teamName} url={r.teamLogoUrl} size={20} />
              {r.teamName}
            </span>
          </td>
          <td className="num">{r.played}</td>
          <td className="num">{r.won}</td>
          <td className="num">{r.drawn}</td>
          <td className="num">{r.lost}</td>
          <td className="num">{r.goalsFor}</td>
          <td className="num">{r.goalsAgainst}</td>
          <td className="num">{r.goalsFor - r.goalsAgainst}</td>
          <td className="num pts">
            {r.pts}
            {r.pointsDeducted > 0 && (
              <span className="deduct" title={`被扣 ${r.pointsDeducted} 分`}>
                −{r.pointsDeducted}
              </span>
            )}
          </td>
        </tr>,
      );
      // 分隔线跟随名次区间末行：范围超出本表行数时画在最后一行之后
      for (const z of applicable) {
        if (z.to === r.rank || (isLast && z.to > r.rank)) {
          bodyRows.push(
            <tr key={`${r.entryId}-div-${z.id}`} className="standings-divider">
              <td colSpan={10}>
                <div className="standings-divider-line" style={{ borderTopColor: z.color }}>
                  <span className="standings-divider-label" style={{ background: z.color }}>
                    {z.name}
                  </span>
                </div>
              </td>
            </tr>,
          );
        }
      }
    }
  });
  return (
    <table className="standings-table">
      {group.name && <caption>{group.name} 组</caption>}
      <thead>
        <tr>
          <th className="num">#</th>
          <th className="team-col">球队</th>
          <th className="num">赛</th>
          <th className="num">胜</th>
          <th className="num">平</th>
          <th className="num">负</th>
          <th className="num">进</th>
          <th className="num">失</th>
          <th className="num">净</th>
          <th className="num">
            积分<span className="pen-hint">*</span>
          </th>
        </tr>
      </thead>
      <tbody>{bodyRows}</tbody>
      {zoneStyle === "strip" && applicable.length > 0 && (
        <tfoot>
          <tr>
            <td colSpan={10}>
              <div className="standings-legend">
                {applicable.map((z) => (
                  <span key={z.id}>
                    <i style={{ background: z.color }} />
                    {z.name}（{formatRankRange(z.from, z.to)}）
                  </span>
                ))}
              </div>
            </td>
          </tr>
        </tfoot>
      )}
    </table>
  );
}
