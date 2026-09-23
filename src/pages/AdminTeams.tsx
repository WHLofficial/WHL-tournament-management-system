import { useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Page, SubmitButton, useSubmit } from "../components/ui";
import { TeamLogo } from "../components/TeamLogo";
import { fc26TeamName } from "../../shared/fc26Teams";
import type { TeamDTO } from "../../shared/types";

export function AdminTeams() {
  const [teams, setTeams] = useState<TeamDTO[] | null>(null);
  const [gameTeamId, setGameTeamId] = useState("");
  const [name, setName] = useState("");
  const [paste, setPaste] = useState("");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [syncErr, setSyncErr] = useState<{ id: number; message: string } | null>(null);
  const createForm = useSubmit();
  const bulkForm = useSubmit();

  const idNum = Number(gameTeamId);
  const idValid = Number.isInteger(idNum) && idNum > 0;
  // 软校验：填了 ID 就查 EA 队号表给出官方队名；查不到只黄字提醒，不拦建队
  const official = idValid ? fc26TeamName(idNum) : null;
  const unknownId = idValid && official === null;

  async function reload() {
    const data = await api<{ teams: TeamDTO[] }>("/api/admin/teams");
    setTeams(data.teams);
    setLoadErr(null);
  }
  useEffect(() => {
    // 拉失败不能显示成「球队库是空的」：管理员会以为球队被删了
    reload().catch((e: unknown) => {
      setLoadErr(e instanceof Error ? e.message : "加载失败");
      setTeams([]);
    });
  }, []);

  function create(e: React.FormEvent) {
    e.preventDefault();
    void createForm.run(async () => {
      const d = await api<{ team: { id: number; name: string }; clubSyncError: string | null }>(
        "/api/admin/teams",
        { method: "POST", body: { gameTeamId: idNum, name } },
      );
      setGameTeamId("");
      setName("");
      createForm.setError(null);
      // 同步失败不回滚建队，所以这里是提示而不是报错
      setSyncErr(d.clubSyncError ? { id: d.team.id, message: d.clubSyncError } : null);
      await reload();
    });
  }

  function bulk(e: React.FormEvent) {
    e.preventDefault();
    void bulkForm.run(async () => {
      const lines = paste
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length === 0) throw new Error("请先粘贴，每行「游戏球队 ID 队名」");
      const d = await api<{
        created: number;
        skipped: { line: number; reason: string }[];
        clubSyncFailed: { id: number; message: string }[];
      }>("/api/admin/teams/bulk", { method: "POST", body: { lines } });
      let m = `新建 ${d.created} 支球队`;
      if (d.skipped.length > 0) {
        m += `\n跳过 ${d.skipped.length} 行：\n${d.skipped.map((s) => `第 ${s.line} 行：${s.reason}`).join("\n")}`;
      }
      if (d.clubSyncFailed.length > 0) {
        m += `\n同步俱乐部平台失败 ${d.clubSyncFailed.length} 支：${d.clubSyncFailed
          .map((x) => `#${x.id}（${x.message}）`)
          .join("、")}`;
      }
      window.alert(m);
      setPaste("");
      bulkForm.setError(null);
      await reload();
    });
  }

  async function syncRow(team: TeamDTO) {
    setSyncErr(null);
    try {
      await api(`/api/admin/teams/${team.id}/sync-club`, { method: "POST" });
    } catch (err) {
      setSyncErr({ id: team.id, message: err instanceof Error ? err.message : "同步失败" });
    }
  }

  async function remove(team: TeamDTO) {
    if (!window.confirm(`删除球队「${team.name}」？`)) return;
    try {
      await api(`/api/admin/teams/${team.id}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }

  return (
    <Page>
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin">← 赛事管理</Link>
          </p>
          <h2>球队库</h2>
        </div>
      </div>

      <div className="card">
        <h3>新建球队</h3>
        <p className="muted">
          游戏球队 ID 就是游戏内球队编号，也是俱乐部平台的俱乐部号（三处同号）；建完会自动在俱乐部平台建档。
        </p>
        <form onSubmit={create} className="inline-form">
          <input
            value={gameTeamId}
            onChange={(e) => setGameTeamId(e.target.value)}
            onBlur={() => {
              // 队名留空时用官方队名预填，省一次手打
              if (official && name.trim() === "") setName(official);
            }}
            inputMode="numeric"
            placeholder="游戏球队 ID"
            style={{ width: 120 }}
          />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="球队名" />
          <SubmitButton busy={createForm.busy}>创建</SubmitButton>
        </form>
        {idValid && official && <p className="muted">EA 目录：#{idNum} = {official}</p>}
        {unknownId && (
          <p className="warn-msg">EA 队号表里没有 #{idNum}，请确认编号没填错（不在表里也能建队）</p>
        )}
        {createForm.error && <p className="error-msg">{createForm.error}</p>}
      </div>

      <div className="card">
        <h3>批量建队</h3>
        <p className="muted">
          每行「游戏球队 ID 队名」，一次最多 64 支；ID 已占用或队名重复的行会跳过并列出原因。
        </p>
        <form onSubmit={bulk}>
          <textarea
            className="paste-box"
            rows={6}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            placeholder={"1 Arsenal\n2 Aston Villa\n7 Everton"}
          />
          <SubmitButton busy={bulkForm.busy}>批量创建</SubmitButton>
        </form>
        {bulkForm.error && <p className="error-msg">{bulkForm.error}</p>}
      </div>

      {syncErr && (
        <p className="error-msg">
          球队 #{syncErr.id} 同步到俱乐部平台失败：{syncErr.message}（可在该行点「同步」重试）
        </p>
      )}
      {loadErr && <p className="error-msg">球队列表加载失败：{loadErr}</p>}
      {teams === null ? (
        <p className="muted">加载中…</p>
      ) : teams.length === 0 ? (
        loadErr ? null : <p className="muted">球队库是空的。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>游戏 ID</th>
              <th>球队</th>
              <th>名单</th>
              <th>已报名赛事</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {teams.map((t) => (
              <tr key={t.id}>
                <td>{t.id}</td>
                <td>
                  <span className="cell-with-logo">
                    <TeamLogo name={t.name} url={t.logoUrl} size={24} />
                    <Link to={`/admin/teams/${t.id}`}>{t.name}</Link>
                  </span>
                </td>
                <td>{t.playerCount}</td>
                <td>{t.entryCount}</td>
                <td>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="把球队建档重推给俱乐部平台（幂等）"
                    onClick={() => void syncRow(t)}
                  >
                    同步
                  </button>{" "}
                  <button
                    className="btn btn-ghost btn-sm"
                    disabled={t.entryCount > 0}
                    title={t.entryCount > 0 ? "已报名赛事，请先移除报名" : undefined}
                    onClick={() => void remove(t)}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Page>
  );
}
