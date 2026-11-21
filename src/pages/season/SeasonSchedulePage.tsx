// 赛季排期页（IA 迁移 + 双视图，design-season-scheduler-ui.md §7.1 / §10）：
// 一级管理路由 /admin/seasons/:seasonId/schedule，TopBar 与赛事管理页都有入口。
// 标题区：面包屑 + kicker / h1 / season-meta / status-pill；view-switch（view=calendar|board
// 查询参数）。默认视图 = ./CalendarView.tsx 周卡墙（只看形状）；宽屏总览 = ./BoardView.tsx，
// 承载全部操作（排法预览/应用、公布、恢复、应用建议）。
// 术语按 GLOSSARY.md：轮次安排、排法、第 N 版、必须解决 / 建议调整。
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../../api";
import {
  revisionStatusText,
  seasonNumberFromName,
  tournamentRows,
  useSeasonSchedule,
  violationsBySegment,
  type RevisionDto,
} from "./data";
import { buildLanes, CalendarView } from "./CalendarView";
import { BoardView, ProposalSheet } from "./BoardView";

type View = "calendar" | "board";

/** 最新 revision 的状态文案（GLOSSARY：草稿 / 已保存 / 已公布 / 已恢复） */
function revisionPill(revisions: RevisionDto[]): string {
  if (revisions.length === 0) return "草稿";
  const latest = revisions[0];
  return `${revisionStatusText(latest.status)} · 第 ${latest.revision} 版`;
}

/** /admin/seasons：先问后端当前赛季，再重定向到 /admin/seasons/:id/schedule。 */
export function SeasonScheduleEntry() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ id: number; name: string }>("/api/admin/seasons/current")
      .then((season) => {
        if (alive) navigate(`/admin/seasons/${season.id}/schedule`, { replace: true });
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : "读取当前赛季失败");
      });
    return () => {
      alive = false;
    };
  }, [navigate]);
  return (
    <div className="container">
      <p className="hint">{error ?? "正在进入当前赛季排期…"}</p>
    </div>
  );
}

export function SeasonSchedulePage() {
  const params = useParams();
  // seasonId 来自路由参数；非法 / 缺失时按 1（本地默认赛季）处理。
  const parsed = Number(params.seasonId);
  const seasonId = Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  const [searchParams, setSearchParams] = useSearchParams();
  const view: View = searchParams.get("view") === "board" ? "board" : "calendar";

  const {
    overview,
    preview,
    busy,
    loading,
    msg,
    refresh,
    genPreview,
    commitCandidate,
    applySuggestion,
    publishRevision,
    restoreRevision,
  } = useSeasonSchedule(seasonId);
  const rows = useMemo(() => tournamentRows(overview), [overview]);
  const lanes = useMemo(() => buildLanes(overview), [overview]);
  const violBySeg = useMemo(() => violationsBySegment(overview), [overview]);

  // 赛历视图的选中段（点块展开 inline 详情，再点收起）；切赛季清掉旧选中。
  const [selectedSegmentId, setSelectedSegmentId] = useState<number | null>(null);
  useEffect(() => {
    setSelectedSegmentId(null);
  }, [seasonId]);

  const hardTotal = overview?.violations.filter((v) => v.level === "hard").length ?? 0;
  const seasonNumber = overview ? seasonNumberFromName(overview.season.name, seasonId) : seasonId;
  const latestRevision = overview?.revisions[0] ?? null;
  const publishDisabled =
    busy || latestRevision == null || hardTotal > 0 || latestRevision.assignmentCount === 0;
  const publishTitle =
    latestRevision == null
      ? "还没有可公布的版本"
      : hardTotal > 0
        ? `还有 ${hardTotal} 处时间冲突没解决`
        : latestRevision.assignmentCount === 0
          ? "空版本不能公布"
          : undefined;

  // 排法弹层：预览回来才开（60s 慢求解期间只给 busy 反馈）；commit 成功后 preview 清空 → 弹层关闭
  const [proposalModal, setProposalModal] = useState<"preview" | "save" | null>(null);
  const wantProposals = useRef<"preview" | "save" | null>(null);
  const openProposals = (mode: "preview" | "save") => {
    wantProposals.current = mode;
    void genPreview();
  };
  useEffect(() => {
    if (wantProposals.current && preview) {
      setProposalModal(wantProposals.current);
      wantProposals.current = null;
    }
  }, [preview]);
  // commit 成功会清掉 preview（弹层随之关闭）；失败保留，让用户继续看指标
  useEffect(() => {
    if (proposalModal && !preview) setProposalModal(null);
  }, [preview, proposalModal]);

  // 操作反馈 toast：hook 的 msg 更新即弹（沿用 msg 文案范式），2.6s 自动收起
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    setToast(msg);
    const t = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(t);
  }, [msg]);

  // 排法弹层 Esc 关闭（设计稿 §5：Esc 清选中/关弹层）
  useEffect(() => {
    if (!proposalModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProposalModal(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [proposalModal]);

  return (
    <div className={`container season-schedule${view === "board" ? " season-wide" : ""}`}>
      <nav className="season-breadcrumb" aria-label="面包屑">
        <Link to="/admin">管理台</Link> / 赛季 / <b>{overview ? overview.season.name : `赛季 ${seasonId}`}</b>
      </nav>

      <header className="season-head">
        <div>
          <div className="season-kicker">SEASON {seasonNumber}</div>
          <h1>赛季排期</h1>
          <div className="season-meta">
            {overview && (
              <>
                <span>{overview.season.weeks} 周</span>
                <span aria-hidden="true">·</span>
                <span>{rows.length} 项赛事</span>
                <span aria-hidden="true">·</span>
                <span>{overview.segments.length} 个轮次安排</span>
                <span className="season-status-pill">{revisionPill(overview.revisions)}</span>
                {view === "board" && hardTotal > 0 && (
                  <span className="season-conflict-pill">{hardTotal} 处必须解决</span>
                )}
                {view === "board" && <span>· 宽屏总览</span>}
              </>
            )}
          </div>
        </div>
        <div className="season-head-actions">
          <div className="season-view-switch" aria-label="视图切换">
            <button
              type="button"
              className={view === "calendar" ? "active" : undefined}
              aria-pressed={view === "calendar"}
              onClick={() => setSearchParams({ view: "calendar" })}
            >
              赛历视图
            </button>
            <button
              type="button"
              className={view === "board" ? "active" : undefined}
              aria-pressed={view === "board"}
              onClick={() => setSearchParams({ view: "board" })}
            >
              宽屏总览
            </button>
          </div>
          {view === "calendar" ? (
            <button className="btn" type="button" onClick={() => window.print()}>
              导出赛历图
            </button>
          ) : (
            <>
              <button className="btn" type="button" disabled={busy} onClick={() => openProposals("preview")}>
                看看三套排法
              </button>
              <button className="btn" type="button" disabled={busy} onClick={() => openProposals("save")}>
                保存为新版本
              </button>
              <button
                className="btn primary"
                type="button"
                disabled={publishDisabled}
                title={publishTitle}
                onClick={() => latestRevision && void publishRevision(latestRevision)}
              >
                公布
              </button>
            </>
          )}
        </div>
      </header>

      {msg && <p className="muted">{msg}</p>}

      {/* 加载骨架：保留周卡/矩阵行列结构，不用居中 spinner（设计稿 §5） */}
      {loading && !overview && view === "calendar" && (
        <div className="sk-cal" aria-busy="true" aria-label="加载中">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="sk-week-card">
              <div className="sk-line sk-rail" />
              <div className="sk-days">
                {Array.from({ length: 7 }, (_, d) => (
                  <i key={d} />
                ))}
              </div>
              <div className="sk-line sk-lane" />
            </div>
          ))}
        </div>
      )}
      {loading && !overview && view === "board" && (
        <div className="sk-boardwrap" aria-busy="true" aria-label="加载中">
          <div className="sk-line sk-thead" />
          <div className="sk-line sk-row" />
          <div className="sk-line sk-row" />
        </div>
      )}

      {/* 错误态：总览拉不回来时给一句能指导动作的话 + 重试 */}
      {!loading && !overview && (
        <section className="card season-error">
          <h3>赛季总览加载失败</h3>
          <p className="muted">{msg ?? "网络异常，请稍后重试。"}</p>
          <button className="btn" type="button" onClick={() => void refresh()}>
            重试
          </button>
        </section>
      )}

      {overview && overview.segments.length === 0 && (
        <section className="card season-empty">
          <h3>本赛季还没有轮次安排</h3>
          <p className="muted">先到赛事页生成赛程与开球窗口，回这里看整季形状。</p>
          <Link className="btn" to="/admin">
            去赛事列表
          </Link>
        </section>
      )}

      {overview && rows.length > 0 && view === "calendar" && (
        <CalendarView
          overview={overview}
          lanes={lanes}
          violationsBySegment={violBySeg}
          selectedSegmentId={selectedSegmentId}
          onSelectSegment={setSelectedSegmentId}
        />
      )}

      {overview && rows.length > 0 && view === "board" && (
        <>
          {hardTotal > 0 && (
            <div className="sb-alert" role="alert">
              <strong>{hardTotal} 处时间冲突必须先解决</strong>
              <span>点任意红色格看两场间隔和可挪的时间。</span>
            </div>
          )}
          <p className="sb-note">
            宽屏总览视图：31 列并排，适合 ≥1600px 宽度或需要整体扫 31 周时使用；日常编辑请用
            <button type="button" className="sb-note-link" onClick={() => setSearchParams({ view: "calendar" })}>
              赛历视图（默认工作台）
            </button>
            。
          </p>
          <BoardView
            overview={overview}
            lanes={lanes}
            violationsBySegment={violBySeg}
            busy={busy}
            ops={{ genPreview, commitCandidate, applySuggestion, publishRevision, restoreRevision }}
          />
          {proposalModal && preview && (
            <ProposalSheet
              preview={preview}
              mode={proposalModal}
              busy={busy}
              onCommit={(cand, segmentIds) => commitCandidate(cand, segmentIds)}
              onClose={() => setProposalModal(null)}
            />
          )}
        </>
      )}

      <div className={`season-toast${toast ? " show" : ""}`} role="status">
        {toast}
      </div>
    </div>
  );
}
