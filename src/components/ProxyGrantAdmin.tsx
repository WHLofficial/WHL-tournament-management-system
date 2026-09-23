import { useEffect, useState } from "react";
import { api } from "../api";
import { useSubmit } from "./ui";
import type {
  AdminProxyGrantDTO,
  MatchDTO,
  ProxyGrantCandidateDTO,
  ProxyMatchSidesDTO,
  TournamentDTO,
} from "../../shared/types";

const STAGE_ZH: Record<string, string> = { elim: "淘汰赛", round_robin: "循环赛", group: "小组赛" };

function stageText(kind: string | undefined, name: string | null): string {
  return name ?? (kind ? STAGE_ZH[kind] ?? kind : "");
}

function matchLabel(m: MatchDTO): string {
  return `${stageText(m.stageKind, m.stageName ?? null)} 第${m.round}轮${m.leg ? ` · 第${m.leg}回合` : ""} · ${
    m.homeTeamName ?? "待定"
  } vs ${m.awayTeamName ?? "待定"}`;
}

function grantLabel(g: AdminProxyGrantDTO): string {
  return `${g.tournamentName} ${stageText(undefined, g.stageName)} 第${g.round}轮 · ${g.teamName} vs ${
    g.opponentName ?? "待定"
  }`;
}

// 管理员把「替某队交某一场阵容」的权限临时授给另一个账号。
// 精确到单场：比赛一开打授权自然失效，所以不需要设有效期；撤销即恢复本队教练提交。
export function ProxyGrantAdmin({ tournaments }: { tournaments: TournamentDTO[] }) {
  const [tid, setTid] = useState<number | null>(null);
  const [matches, setMatches] = useState<MatchDTO[] | null>(null);
  const [mid, setMid] = useState<number | null>(null);
  const [sides, setSides] = useState<ProxyMatchSidesDTO | null>(null);
  const [accounts, setAccounts] = useState<ProxyGrantCandidateDTO[] | null>(null);
  const [grants, setGrants] = useState<AdminProxyGrantDTO[]>([]);
  const [teamSel, setTeamSel] = useState<number | null>(null);
  const [acctSel, setAcctSel] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // 四处拉失败都会被读成「这里本来就是空的」：账号候选空了像没人可授权、比赛空了像该赛事没比赛、
  // 授权列表空了像从没授过权、两队信息没了像你还没选比赛——所以每处各留一条可见的失败信息
  const [acctErr, setAcctErr] = useState<string | null>(null);
  const [grantsErr, setGrantsErr] = useState<string | null>(null);
  const [matchErr, setMatchErr] = useState<string | null>(null);
  const [sidesErr, setSidesErr] = useState<string | null>(null);
  const { busy, error, setError, run } = useSubmit();

  async function reloadGrants() {
    const b = await api<{ grants: AdminProxyGrantDTO[] }>("/api/admin/proxy-grants");
    setGrants(b.grants ?? []);
    setGrantsErr(null);
  }
  async function reloadSides(matchId: number) {
    setSides(await api<ProxyMatchSidesDTO>(`/api/admin/proxy-grants/match/${matchId}`));
    setSidesErr(null);
  }

  useEffect(() => {
    api<{ accounts: ProxyGrantCandidateDTO[] }>("/api/admin/proxy-grants/context")
      .then((b) => {
        setAccounts(b.accounts ?? []);
        setAcctErr(null);
      })
      .catch((e: unknown) => {
        setAccounts([]);
        setAcctErr(e instanceof Error ? e.message : "加载失败");
      });
    reloadGrants().catch((e: unknown) => {
      setGrants([]);
      setGrantsErr(e instanceof Error ? e.message : "加载失败");
    });
  }, []);

  // 只有未开打、且不是轮空的场次才谈得上代打
  useEffect(() => {
    setMid(null);
    setSides(null);
    setTeamSel(null);
    setAcctSel(null);
    setDone(null);
    if (tid == null) {
      setMatches(null);
      return;
    }
    let dead = false;
    setMatchErr(null);
    api<{ matches: MatchDTO[] }>(`/api/admin/tournaments/${tid}/matches`)
      .then((b) => {
        if (dead) return;
        setMatches((b.matches ?? []).filter((m) => m.status === "pending" && m.note !== "轮空"));
      })
      .catch((e: unknown) => {
        if (dead) return;
        setMatches([]);
        setMatchErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      dead = true;
    };
  }, [tid]);

  // 队 id 拿不到在有授权的场次里只能靠猜队名，所以单开一个接口取两队与已有授权
  useEffect(() => {
    if (mid == null) return;
    let dead = false;
    setSidesErr(null);
    api<ProxyMatchSidesDTO>(`/api/admin/proxy-grants/match/${mid}`)
      .then((b) => {
        if (dead) return;
        setSides(b);
        setTeamSel(b.homeTeamId);
        setAcctSel(null);
      })
      .catch((e: unknown) => {
        if (dead) return;
        setSides(null);
        setSidesErr(e instanceof Error ? e.message : "加载失败");
      });
    return () => {
      dead = true;
    };
  }, [mid]);

  function pickTeamSide(v: string) {
    const id = v ? Number(v) : null;
    setTeamSel(id);
    // 本来就绑这一队的账号会被后端拒（那是本队教练，不需要代打），直接不进候选
    if (acctSel != null && accounts?.some((a) => a.userId === acctSel && a.teamId === id)) setAcctSel(null);
  }

  function addGrant() {
    if (sides == null) {
      setError("先选一场比赛");
      return;
    }
    if (teamSel == null || acctSel == null) {
      setError("先选好被代打的球队和代打账号");
      return;
    }
    void run(async () => {
      await api("/api/admin/proxy-grants", {
        method: "POST",
        body: { matchId: sides.matchId, teamId: teamSel, granteeUserId: acctSel },
      });
      setDone(`已授权：本场「${teamSel === sides.homeTeamId ? sides.homeTeamName : sides.awayTeamName}」的阵容可由该账号代交，比赛开打前有效。`);
      setError(null);
      setAcctSel(null);
      await reloadSides(sides.matchId);
      await reloadGrants();
    });
  }

  function revoke(g: AdminProxyGrantDTO) {
    void run(async () => {
      await api(`/api/admin/proxy-grants/${g.id}`, { method: "DELETE" });
      setDone("已撤销：该账号不能再代打这一场，本队教练恢复提交。");
      setError(null);
      if (sides != null && sides.matchId === g.matchId) await reloadSides(g.matchId);
      await reloadGrants();
    });
  }

  const cands = (accounts ?? []).filter((a) => teamSel == null || a.teamId !== teamSel);
  const sidesList = [
    { id: sides?.homeTeamId ?? null, name: sides?.homeTeamName ?? null, tag: "主队" },
    { id: sides?.awayTeamId ?? null, name: sides?.awayTeamName ?? null, tag: "客队" },
  ].filter((s) => s.id != null);

  return (
    <div className="card">
      <h3>阵容代打授权</h3>
      <p className="muted">
        授权后，被选中的账号可在战术板上临时替该队递交本场阵容；被代打那队的教练在这段时间内不能提交。
        比赛一开打授权自动失效，也可以随时撤销。
      </p>

      <div className="proxy-form">
        <label className="field">
          赛事
          <select value={tid ?? ""} onChange={(e) => setTid(e.target.value ? Number(e.target.value) : null)}>
            <option value="">选择赛事…</option>
            {tournaments.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          比赛
          <select
            value={mid ?? ""}
            disabled={tid == null}
            onChange={(e) => setMid(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{matches == null ? "先选赛事" : "选择比赛…"}</option>
            {(matches ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {matchLabel(m)}
                {boundHint(m.id, grants)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          被代打球队
          <select value={teamSel ?? ""} disabled={sides == null} onChange={(e) => pickTeamSide(e.target.value)}>
            <option value="">{sides == null ? "先选比赛" : "选择球队…"}</option>
            {sidesList.map((s) => (
              <option key={s.id} value={String(s.id)}>
                {s.tag} {s.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          代打账号
          <select
            value={acctSel ?? ""}
            disabled={sides == null}
            onChange={(e) => setAcctSel(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">{accounts == null ? "读取中…" : "选择账号…"}</option>
            {cands.map((a) => (
              <option key={a.userId} value={a.userId}>
                {a.name}
                {a.teamName ? `（${a.teamName}）` : "（未绑队）"}
              </option>
            ))}
          </select>
        </label>

        <button className="btn" disabled={busy || sides == null} onClick={addGrant}>
          {busy ? "处理中…" : "授权代打"}
        </button>
      </div>

      {matchErr && <p className="error-msg">比赛列表加载失败：{matchErr}</p>}
      {sidesErr && <p className="error-msg">该场两队信息加载失败：{sidesErr}，请重新选一次比赛</p>}
      {acctErr && <p className="error-msg">代打账号候选加载失败：{acctErr}</p>}
      {grantsErr && <p className="error-msg">授权列表加载失败：{grantsErr}</p>}
      {matches != null && matches.length === 0 && !matchErr && (
        <p className="muted">该赛事当前没有待开的比赛。</p>
      )}
      {error && <p className="error-msg">{error}</p>}
      {done && <p className="ok-msg">{done}</p>}

      {grants.length === 0 ? (
        grantsErr ? null : <p className="muted">还没有代打授权。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>比赛</th>
              <th>被代打球队</th>
              <th>代打账号</th>
              <th>授权人</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.id}>
                <td>{grantLabel(g)}</td>
                <td>
                  {g.teamName}
                  <span className="muted">{g.side === "home" ? "（主）" : "（客）"}</span>
                  {g.submitted && <span className="muted"> · 已有阵容</span>}
                </td>
                <td>
                  {g.granteeName ?? `#${g.granteeUserId}`}
                  {g.granteeTeamName && <span className="muted">（{g.granteeTeamName}）</span>}
                </td>
                <td>{g.grantedByName ?? `#${g.grantedBy}`}</td>
                <td>
                  {g.active ? (
                    <span className="status-badge st-running">生效中</span>
                  ) : (
                    <span className="status-badge">{g.revokedAt ? "已撤销" : "已失效（已开打）"}</span>
                  )}
                </td>
                <td>
                  {g.active && (
                    <button className="btn btn-sm" disabled={busy} onClick={() => revoke(g)}>
                      撤销
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// 列表里已有授权的比赛给个提示（含已撤销/已失效的，避免重复授权）
function boundHint(matchId: number, grants: AdminProxyGrantDTO[]): string {
  const n = grants.filter((g) => g.matchId === matchId && !g.revokedAt).length;
  if (n === 0) return "";
  return `（已授权${n > 1 ? ` ×${n}` : ""}）`;
}
