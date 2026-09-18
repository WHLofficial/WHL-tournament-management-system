import { useState } from "react";
import { ASSIGN_LABEL, formTitle, POS_ZH } from "../../shared/tactics";
import type { LineupAssignDTO, LineupPlayerDTO, TeamLineupDTO } from "../../shared/types";

function playerName(p: LineupPlayerDTO): string {
  const num = p.number ? `#${p.number} ` : "";
  return num + (p.name ?? "已离队");
}

// 队长与定位球清单：教练端赛前回显、管理端备案、公开端开赛后三处共用。
// 顺序由后端按 ASSIGN_GROUPS 排好（队长在最前），这里只负责画。
export function AssignList({ assign }: { assign: LineupAssignDTO[] }) {
  if (!assign || assign.length === 0) return null;
  return (
    <ul className="lu-assign">
      {assign.map((a) => (
        <li key={a.key} className={a.starter ? "" : "off"}>
          <i>{ASSIGN_LABEL[a.key] ?? a.key}</i>
          <span>
            {a.number ? `#${a.number} ` : ""}
            {a.name ?? "已离队"}
          </span>
          {!a.starter && <span className="lu-assign-off">已不在首发</span>}
          {(a.meta?.badges ?? []).map((b) => (
            <span className="lu-chip" key={b}>
              {b}
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

// 战术码备案展示：仅管理端路径传入 code，公开端不渲染
function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    const done = () => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(code).then(done, () => {});
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = code;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      /* 忽略 */
    }
    document.body.removeChild(ta);
  }
  return (
    <p className="lu-code">
      <code>{code}</code>
      <button type="button" className="btn btn-sm" onClick={copy}>
        {copied ? "已复制" : "复制"}
      </button>
    </p>
  );
}

function LineupSide({ label, l, code }: { label: string; l: TeamLineupDTO | null; code?: string }) {
  if (!l) {
    return (
      <div className="lu-col lu-none">
        <b>{label}</b>
        <p className="muted">未提交阵容</p>
      </div>
    );
  }
  const capPid = l.assign?.find((a) => a.key === "captain")?.playerId ?? null;
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
            {capPid != null && s.playerId === capPid && (
              <span className="lu-cap" title="队长">
                C
              </span>
            )}
          </li>
        ))}
      </ol>
      {l.bench.length > 0 && <p className="lu-bench">替补：{l.bench.map(playerName).join("、")}</p>}
      <AssignList assign={l.assign ?? []} />
      <p className="lu-meta">
        提交于 {l.submittedAt.slice(0, 16).replace("T", " ")}
        {l.submittedBy ? ` · ${l.submittedBy}` : ""}
        {l.viaProxy && <span className="proxy-badge">代打</span>}
      </p>
      {code && <CodeChip code={code} />}
    </div>
  );
}

// 双方提交的战术阵容并排：公开单场页（开赛后）与管理端单场（备案）共用
// homeCode/awayCode 仅管理端备案路径传入，公开端不带（战术码不对公开端展示）
export function LineupGrid({
  home,
  away,
  homeCode,
  awayCode,
}: {
  home: TeamLineupDTO | null;
  away: TeamLineupDTO | null;
  homeCode?: string;
  awayCode?: string;
}) {
  return (
    <div className="lu-grid">
      <LineupSide label="主队" l={home} code={homeCode} />
      <LineupSide label="客队" l={away} code={awayCode} />
    </div>
  );
}
