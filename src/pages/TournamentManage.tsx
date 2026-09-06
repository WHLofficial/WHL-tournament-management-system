import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api";
import ScheduleTab from "./ScheduleTab";
import MatchesTab from "./MatchesTab";
import StandingsTab from "./StandingsTab";
import { Toplists } from "../components/Toplists";
import { StatsDashboard } from "../components/StatsDashboard";
import { SubmitButton, useSubmit } from "../components/ui";
import { useAuth } from "../auth";
import { FORMAT_LABEL, NEXT_ACTIONS, STATUS_LABEL } from "../labels";
import type {
  EntryDTO,
  TeamDTO,
  TournamentDetailDTO,
  TournamentStatus,
  SuspensionConfig,
  SuspensionsResp,
} from "../../shared/types";

// 同分规则下拉的选项；value 对应后端 TiebreakerKey，none 表示这一级不启用
const TB_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "gd", label: "净胜球" },
  { value: "gf", label: "进球数" },
  { value: "h2h", label: "相互战绩" },
  { value: "none", label: "不启用" },
];

type Tab = "entries" | "schedule" | "matches" | "standings" | "toplists" | "stats" | "settings";

export function TournamentManage() {
  const { id } = useParams();
  const tournamentId = Number(id);
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TournamentDetailDTO | null>(null);
  const [missing, setMissing] = useState(false);
  const [tab, setTab] = useState<Tab>("entries");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function reload() {
    try {
      setDetail(await api<TournamentDetailDTO>(`/api/admin/tournaments/${tournamentId}`));
    } catch {
      setMissing(true);
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournamentId]);

  async function transition(to: TournamentStatus, confirm?: string) {
    if (confirm && !window.confirm(confirm)) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await api(`/api/admin/tournaments/${tournamentId}/transition`, {
        method: "POST",
        body: { to },
      });
      await reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setActionBusy(false);
    }
  }

  if (missing)
    return (
      <div className="container">
        <p className="error-msg">赛事不存在。</p>
        <Link to="/admin">返回赛事列表</Link>
      </div>
    );
  if (!detail) return <div className="container">加载中…</div>;

  const t = detail.tournament;
  const actions = NEXT_ACTIONS[t.status];

  return (
    <div className="container">
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事列表</Link>
          </p>
          <h2>
            {t.name} <span className={`status-badge st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          </h2>
          <p className="muted">
            {FORMAT_LABEL[t.format]} · {t.entryCount} 支球队
          </p>
        </div>
        <div className="btn-col">
          {actions.map((a) => (
            <button
              key={a.to}
              className="btn"
              disabled={actionBusy}
              onClick={() => void transition(a.to, a.confirm)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {actionError && <p className="error-msg">{actionError}</p>}

      <nav className="tabs">
        {(
          [
            ["entries", `报名 (${detail.entries.length})`],
            ["schedule", "编排"],
            ["matches", "比赛"],
            ["standings", "积分榜"],
            ["toplists", "榜单"],
            ["stats", "数据"],
            ["settings", "设置"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            className={`tab${tab === key ? " tab-active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "entries" && <EntriesTab detail={detail} reload={reload} />}
      {tab === "schedule" && <ScheduleTab detail={detail} reload={reload} />}
      {tab === "matches" && <MatchesTab detail={detail} reload={reload} />}
      {tab === "standings" && <StandingsTab tournamentId={detail.tournament.id} />}
      {tab === "toplists" && <Toplists tid={detail.tournament.id} base="/api/admin" />}
      {tab === "stats" && <StatsDashboard tid={detail.tournament.id} base="/api/admin" />}
      {tab === "settings" && <SettingsTab detail={detail} reload={reload} onDeleted={() => navigate("/admin")} />}
    </div>
  );
}

function EntriesTab({ detail, reload }: { detail: TournamentDetailDTO; reload: () => Promise<void> }) {
  const t = detail.tournament;
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const editable = t.status === "draft" || t.status === "registering";
  const [paste, setPaste] = useState("");
  const [teams, setTeams] = useState<TeamDTO[]>([]);
  const [teamId, setTeamId] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();

  useEffect(() => {
    api<{ teams: TeamDTO[] }>("/api/admin/teams")
      .then((d) => setTeams(d.teams))
      .catch(() => setTeams([]));
  }, []);

  const entered = useMemo(() => new Set(detail.entries.map((e) => e.teamId)), [detail.entries]);
  const available = teams.filter((tm) => !entered.has(tm.id));

  function parseNames(text: string): string[] {
    return text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function bulkEnter(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      const names = parseNames(paste);
      if (names.length === 0) throw new Error("请先粘贴队名，每行一个");
      const d = await api<{
        createdEntries: number;
        createdTeams: number;
        skippedAlready: string[];
      }>(`/api/admin/tournaments/${t.id}/entries/bulk`, { method: "POST", body: { names } });
      let m = `新增报名 ${d.createdEntries} 支，新建球队 ${d.createdTeams} 支`;
      if (d.skippedAlready.length > 0) m += `；已在赛事中跳过：${d.skippedAlready.join("、")}`;
      setMsg(m);
      setPaste("");
      await reload();
    });
  }

  function addOne(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      if (!teamId) throw new Error("请选择球队");
      await api(`/api/admin/tournaments/${t.id}/entries`, {
        method: "POST",
        body: { teamId: Number(teamId) },
      });
      setTeamId("");
      setMsg(null);
      await reload();
    });
  }

  async function removeEntry(entry: EntryDTO) {
    if (!window.confirm(`把「${entry.teamName}」移出本赛事？`)) return;
    try {
      await api(`/api/admin/tournaments/${t.id}/entries/${entry.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "移除失败");
    }
  }

  return (
    <div>
      {!editable && (
        <p className="hint">已开赛：报名球队锁定；球员名单不受限，可随时在球队页调整（转会、新增）。</p>
      )}
      <div className="card">
        <h3>批量报名</h3>
        <p className="muted">从球队库批量报名；球队库里没有的队名会自动建队。每行一个队名。</p>
        <form onSubmit={bulkEnter}>
          <textarea
            className="paste-box"
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"红狼队\n蓝鲨队\n雷霆队"}
            disabled={!editable}
          />
          <SubmitButton busy={busy}>批量报名</SubmitButton>
        </form>
      </div>

      <div className="card">
        <h3>从球队库添加</h3>
        <form onSubmit={addOne} className="inline-form">
          <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!editable}>
            <option value="">选择球队…</option>
            {available.map((tm) => (
              <option key={tm.id} value={tm.id}>
                {tm.name}
              </option>
            ))}
          </select>
          <SubmitButton busy={busy}>添加</SubmitButton>
        </form>
      </div>

      {msg && <p className="hint">{msg}</p>}
      {error && <p className="error-msg">{error}</p>}

      {detail.entries.length === 0 ? (
        <p className="muted">还没有球队报名。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>球队</th>
              <th>名单人数</th>
              {isSuper && <th>扣分</th>}
              {editable && <th></th>}
            </tr>
          </thead>
          <tbody>
            {detail.entries.map((e) => (
              <tr key={e.id}>
                <td>{e.seed}</td>
                <td>
                  <Link to={`/admin/teams/${e.teamId}`}>{e.teamName}</Link>
                </td>
                <td>{e.playerCount}</td>
                {isSuper && <DeductCell key={e.pointsDeducted} entry={e} tid={t.id} reload={reload} />}
                {editable && (
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => void removeEntry(e)}>
                      移除
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SettingsTab({
  detail,
  reload,
  onDeleted,
}: {
  detail: TournamentDetailDTO;
  reload: () => Promise<void>;
  onDeleted: () => void;
}) {
  const t = detail.tournament;
  const [name, setName] = useState(t.name);
  const [description, setDescription] = useState(t.description ?? "");
  const { busy, error, setError, run } = useSubmit();

  // 同分规则：三个优先级下拉，"none" = 这一级不启用
  const tbForm = useSubmit();
  const [tbError, setTbError] = useState<string | null>(null);
  const [tb, setTb] = useState<[string, string, string]>(() => {
    const c = detail.tiebreakers ?? ["gd", "gf", "h2h"];
    return [c[0] ?? "none", c[1] ?? "none", c[2] ?? "none"];
  });

  function save(e: React.FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(`/api/admin/tournaments/${t.id}`, {
        method: "PATCH",
        body: { name, description },
      });
      setError(null);
      await reload();
    });
  }

  function saveTiebreakers() {
    const chain: string[] = [];
    let stopped = false;
    for (const p of tb) {
      if (p === "none") {
        stopped = true;
        continue;
      }
      if (stopped) {
        setTbError("某一级选了「不启用」，后面的优先级也必须选「不启用」");
        return;
      }
      if (chain.includes(p)) {
        setTbError("同一规则不能重复启用");
        return;
      }
      chain.push(p);
    }
    setTbError(null);
    void tbForm.run(async () => {
      await api(`/api/admin/tournaments/${t.id}`, {
        method: "PATCH",
        body: { tiebreakers: chain },
      });
      await reload();
    });
  }

  async function remove() {
    if (!window.confirm(`删除赛事「${t.name}」？此操作不可恢复。`)) return;
    try {
      await api(`/api/admin/tournaments/${t.id}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  async function uploadCover(file: File) {
    try {
      await api(`/api/admin/tournaments/${t.id}/cover`, {
        method: "PUT",
        body: file,
        contentType: file.type || "application/octet-stream",
      });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "上传失败");
    }
  }

  async function removeCover() {
    try {
      await api(`/api/admin/tournaments/${t.id}/cover`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <div className="card">
      <h3>基本信息</h3>
      <form onSubmit={save}>
        <label className="field">
          赛事名称
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          简介（可选）
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {error && <p className="error-msg">{error}</p>}
        <SubmitButton busy={busy}>保存</SubmitButton>
      </form>
      <hr className="divider" />
      <h3>同分规则</h3>
      <p className="muted">
        两队积分相同时，按下面的顺序比较排名；积分始终排第一，全都比不出来就按报名种子位。
        开赛后也可以改，立刻影响积分榜名次与阶段晋级。
      </p>
      <div className="tb-row">
        {(["第 1 优先级", "第 2 优先级", "第 3 优先级"] as const).map((label, i) => (
          <label className="field" key={label}>
            {label}
            <select
              value={tb[i]}
              onChange={(e) =>
                setTb((prev) => {
                  const next = [...prev] as [string, string, string];
                  next[i] = e.target.value;
                  return next;
                })
              }
            >
              {TB_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {(tbForm.error ?? tbError) && (
        <p className="error-msg">{tbForm.error ?? tbError}</p>
      )}
      <button
        type="button"
        className="btn"
        disabled={tbForm.busy}
        onClick={saveTiebreakers}
      >
        保存同分规则
      </button>
      <hr className="divider" />
      <SuspensionCard tid={t.id} />
      <hr className="divider" />
      <h3>封面图</h3>
      <div className="logo-row">
        {t.coverUrl ? (
          <img className="cover-thumb" src={t.coverUrl} alt={`${t.name} 封面`} />
        ) : (
          <span className="cover-thumb cover-empty">暂无封面</span>
        )}
        <label className="btn btn-ghost logo-upload-btn">
          {t.coverUrl ? "更换封面" : "上传封面"}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadCover(f);
              e.target.value = "";
            }}
          />
        </label>
        {t.coverUrl && (
          <button type="button" className="btn btn-ghost" onClick={() => void removeCover()}>
            恢复默认封面
          </button>
        )}
        <span className="muted">显示在赛事列表与公开页头部；png / jpg / webp，不超过 1MB；删除自定义封面会回到默认模板</span>
      </div>
      <hr className="divider" />
      <h3>危险操作</h3>
      <p className="muted">只能删除草稿或报名中的赛事；进行中/已归档的赛事会永久保留。</p>
      <button className="btn btn-danger" onClick={() => void remove()}>
        删除赛事
      </button>
    </div>
  );
}

// 停赛规则卡：参数存 config_json.suspension；软约束——录入时只警告不拦截。
// 两黄变一红的说明：同场第二张黄牌由系统自动生成事件，停赛档位独立于直红。
function SuspensionCard({ tid }: { tid: number }) {
  const [cfg, setCfg] = useState<SuspensionConfig | null>(null);
  const [redBan, setRedBan] = useState("2");
  const [red2yBan, setRed2yBan] = useState("1");
  const [yellowThreshold, setYellowThreshold] = useState("3");
  const { busy, error, setError, run } = useSubmit();
  // 清零两击确认：首击进入待确认态，3 秒内再击才执行；照终场确认的防误触模式
  const [arm, setArm] = useState(false);
  const armTimer = useRef<number | null>(null);
  const [resetMsg, setResetMsg] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api<SuspensionsResp>(`/api/admin/tournaments/${tid}/suspensions`)
      .then((b) => {
        if (!on) return;
        setCfg(b.config);
        setRedBan(String(b.config.redBan));
        setRed2yBan(String(b.config.red2yBan));
        setYellowThreshold(String(b.config.yellowThreshold));
      })
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [tid]);

  useEffect(() => {
    return () => {
      if (armTimer.current) window.clearTimeout(armTimer.current);
    };
  }, []);

  function save() {
    const vals = [redBan, red2yBan, yellowThreshold].map((v) => Number(v));
    if (vals.some((n) => !Number.isInteger(n) || n < 0 || n > 10)) {
      setError("停赛场数与阈值须为 0-10 的整数");
      return;
    }
    void run(async () => {
      const b = await api<{ config: SuspensionConfig }>(
        `/api/admin/tournaments/${tid}/suspensions`,
        {
          method: "PUT",
          body: { redBan: vals[0], red2yBan: vals[1], yellowThreshold: vals[2] },
        },
      );
      setCfg(b.config);
      setError(null);
    });
  }

  function resetYellows() {
    if (!arm) {
      setArm(true);
      if (armTimer.current) window.clearTimeout(armTimer.current);
      armTimer.current = window.setTimeout(() => setArm(false), 3000);
      return;
    }
    if (armTimer.current) window.clearTimeout(armTimer.current);
    setArm(false);
    void run(async () => {
      const b = await api<{ yellowResetAt: string }>(
        `/api/admin/tournaments/${tid}/suspensions/reset-yellows`,
        { method: "POST" },
      );
      setCfg((prev) => (prev ? { ...prev, yellowResetAt: b.yellowResetAt } : prev));
      setResetMsg("已清零：之后的黄牌从 0 重新累计，已生效的停赛继续执行");
      setError(null);
    });
  }

  return (
    <>
      <h3>停赛规则</h3>
      <p className="muted">
        红黄牌自动累计停赛：直红与两黄变一红按下方设置的场数停赛；同场第二张黄牌自动记为两黄变一红；
        累积黄牌达到阈值停 1 场并重新计数。录事件时对停赛球员只警告不拦截（软约束），
        每打一场比赛消耗 1 场停赛，轮空不消耗。
      </p>
      <div className="tb-row">
        <label className="field">
          直红停赛场数
          <input
            className="input"
            type="number"
            min="0"
            max="10"
            value={redBan}
            onChange={(e) => setRedBan(e.target.value)}
          />
        </label>
        <label className="field">
          两黄变一红停赛场数
          <input
            className="input"
            type="number"
            min="0"
            max="10"
            value={red2yBan}
            onChange={(e) => setRed2yBan(e.target.value)}
          />
        </label>
        <label className="field">
          累积黄牌停赛阈值（0 = 不启用）
          <input
            className="input"
            type="number"
            min="0"
            max="10"
            value={yellowThreshold}
            onChange={(e) => setYellowThreshold(e.target.value)}
          />
        </label>
      </div>
      {error && <p className="error-msg">{error}</p>}
      <div className="logo-row">
        <button type="button" className="btn" disabled={busy} onClick={save}>
          保存停赛规则
        </button>
        <button
          type="button"
          className={arm ? "btn btn-danger" : "btn btn-ghost"}
          disabled={busy}
          onClick={resetYellows}
        >
          {arm ? "再点一次确认清零" : "清零黄牌累计"}
        </button>
        {cfg?.yellowResetAt && (
          <span className="muted">上次清零：{new Date(cfg.yellowResetAt).toLocaleString("zh-CN")}</span>
        )}
      </div>
      {resetMsg && <p className="muted">{resetMsg}</p>}
    </>
  );
}

// 超管专属：单队扣分编辑，0 表示清除；保存后后端会重算积分榜
function DeductCell({ entry, tid, reload }: { entry: EntryDTO; tid: number; reload: () => Promise<void> }) {
  const [v, setV] = useState<string | null>(null);
  const { busy, error, run } = useSubmit();
  const shown = v ?? (entry.pointsDeducted > 0 ? String(entry.pointsDeducted) : "");
  return (
    <td>
      <span className="deduct-edit">
        <input
          className="input"
          type="number"
          min="0"
          max="999"
          style={{ width: "4.5em" }}
          value={shown}
          placeholder="0"
          onChange={(e) => setV(e.target.value)}
        />
        <button
          className="btn btn-sm"
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const n = shown === "" ? 0 : Number(shown);
              if (!Number.isInteger(n) || n < 0) throw new Error("扣分必须是非负整数");
              await api(`/api/admin/tournaments/${tid}/entries/${entry.id}/deduction`, {
                method: "PATCH",
                body: { points: n },
              });
              setV(null);
              await reload();
            })
          }
        >
          {busy ? "…" : "保存"}
        </button>
      </span>
      {error && <span className="error-text">{error}</span>}
    </td>
  );
}
