import { formTitle, POS_ZH } from "../../shared/tactics";
import type { LineupPlayerDTO, TeamLineupDTO } from "../../shared/types";

function playerName(p: LineupPlayerDTO): string {
  const num = p.number ? `#${p.number} ` : "";
  return num + (p.name ?? "已离队");
}

function LineupSide({ label, l }: { label: string; l: TeamLineupDTO | null }) {
  if (!l) {
    return (
      <div className="lu-col lu-none">
        <b>{label}</b>
        <p className="muted">未提交阵容</p>
      </div>
    );
  }
  return (
    <div className="lu-col">
      <b>
        {label} · {l.teamName}
      </b>
      <span className="lu-form">{formTitle(l.form)}</span>
      <ol className="lu-starters">
        {l.starters.map((s) => (
          <li key={s.lid} title={POS_ZH[s.position] ?? s.position}>
            <i>{s.position}</i>
            {playerName(s)}
          </li>
        ))}
      </ol>
      {l.bench.length > 0 && <p className="lu-bench">替补：{l.bench.map(playerName).join("、")}</p>}
      <p className="lu-meta">
        提交于 {l.submittedAt.slice(0, 16).replace("T", " ")}
        {l.submittedBy ? ` · ${l.submittedBy}` : ""}
      </p>
    </div>
  );
}

// 双方提交的战术阵容并排：公开单场页（开赛后）与管理端单场（备案）共用
export function LineupGrid({ home, away }: { home: TeamLineupDTO | null; away: TeamLineupDTO | null }) {
  return (
    <div className="lu-grid">
      <LineupSide label="主队" l={home} />
      <LineupSide label="客队" l={away} />
    </div>
  );
}
