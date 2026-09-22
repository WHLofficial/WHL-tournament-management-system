import { Fragment, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api } from "../api";
import { Page, SubmitButton, useSubmit } from "../components/ui";
import { TeamLogo } from "../components/TeamLogo";
import { InjuryRegPanel } from "../components/InjuryRegPanel";
import type { InjuryListResp, InjuryStatusDTO, PlayerDTO } from "../../shared/types";

interface TeamDetail {
  team: { id: number; name: string; logoUrl: string | null };
  players: PlayerDTO[];
}

interface AuthCodeRow {
  id: number;
  expiresAt: string | null;
  used: boolean;
  usedAt: string | null;
  createdAt: string;
}

interface MemberRow {
  userId: number;
  name: string;
  joinedAt: string;
}

export function TeamDetailPage() {
  const { id } = useParams();
  const teamId = Number(id);
  const [data, setData] = useState<TeamDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [codes, setCodes] = useState<AuthCodeRow[]>([]);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [members, setMembers] = useState<MemberRow[]>([]);
  // 伤停登记（该队全量，含已伤愈的存档记录）
  const [injuries, setInjuries] = useState<InjuryStatusDTO[]>([]);
  const [injOpen, setInjOpen] = useState<number | null>(null);
  const [injBusy, setInjBusy] = useState(false);
  const [injMsg, setInjMsg] = useState<string | null>(null);
  const [name, setName] = useState("");
  const editForm = useSubmit();

  async function reload() {
    try {
      const d = await api<TeamDetail>(`/api/admin/teams/${teamId}`);
      setData(d);
      setName(d.team.name);
      const [cs, ms, inj] = await Promise.all([
        api<{ codes: AuthCodeRow[] }>(`/api/admin/teams/${teamId}/auth-codes`),
        api<{ members: MemberRow[] }>(`/api/admin/teams/${teamId}/members`),
        api<InjuryListResp>(`/api/admin/injuries?teamId=${teamId}`),
      ]);
      setCodes(cs.codes);
      setMembers(ms.members);
      setInjuries(inj.injuries);
    } catch {
      setMissing(true);
    }
  }

  // 伤停登记操作用：与比赛页同款 busy/提示语义
  async function injAct(fn: () => Promise<string | null>) {
    setInjBusy(true);
    setInjMsg(null);
    try {
      const note = await fn();
      if (note) setInjMsg(note);
    } catch (e) {
      setInjMsg(e instanceof Error ? e.message : "操作失败");
    } finally {
      setInjBusy(false);
    }
  }

  async function genCode() {    try {
      const r = await api<{ code: string }>(`/api/admin/teams/${teamId}/auth-codes`, {
        method: "POST",
        body: { expiresInHours: 24 },
      });
      setNewCode(r.code);
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "生成失败");
    }
  }

  async function unbind(m: MemberRow) {
    if (!window.confirm(`将「${m.name}」移出球队？`)) return;
    try {
      await api(`/api/admin/teams/${teamId}/members/${m.userId}`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "解绑失败");
    }
  }

  async function uploadLogo(file: File) {
    try {
      await api(`/api/admin/teams/${teamId}/logo`, {
        method: "PUT",
        body: file,
        contentType: file.type || "application/octet-stream",
      });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "上传失败");
    }
  }

  async function removeLogo() {
    try {
      await api(`/api/admin/teams/${teamId}/logo`, { method: "DELETE" });
      await reload();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "删除失败");
    }
  }
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId]);

  if (missing)
    return (
      <Page>
        <p className="error-msg">球队不存在。</p>
        <Link to="/admin/teams">返回球队库</Link>
      </Page>
    );
  if (!data) return <Page>加载中…</Page>;

  function rename(e: React.FormEvent) {
    e.preventDefault();
    void editForm.run(async () => {
      await api(`/api/admin/teams/${teamId}`, { method: "PATCH", body: { name } });
      editForm.setError(null);
      await reload();
    });
  }

  // 增量 33：名单改为只读（真源在俱乐部平台，由定时同步拉进来），
  // 录入 / 批量导入 / 改名改号 / 删除四个写入口已从后端一并下线。

  return (
    <Page>
      <div className="page-head">
        <div>
          <p className="muted">
            <Link to="/admin/teams">← 球队库</Link>
          </p>
          <h2>{data.team.name}</h2>
        </div>
      </div>

      <div className="card">
        <h3>队徽</h3>
        <div className="logo-row">
          <TeamLogo name={data.team.name} url={data.team.logoUrl} size={56} />
          <label className="btn btn-ghost logo-upload-btn">
            {data.team.logoUrl ? "更换队徽" : "上传队徽"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadLogo(f);
                e.target.value = "";
              }}
            />
          </label>
          {data.team.logoUrl && (
            <button type="button" className="btn btn-ghost" onClick={() => void removeLogo()}>
              删除
            </button>
          )}
          <span className="muted">png / jpg / webp，不超过 1MB；没传就显示首字色块</span>
        </div>
      </div>

      <div className="card">
        <h3>队名</h3>
        <form onSubmit={rename} className="inline-form">
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <SubmitButton busy={editForm.busy}>保存</SubmitButton>
        </form>
        {editForm.error && <p className="error-msg">{editForm.error}</p>}
      </div>

      <div className="card">
        <h3>伤停登记</h3>
        <p className="muted">
          登记挂在比赛页的伤病事件上（一条伤病事件对应一条登记）。这里可以改伤名、备注、缺阵场次，或者撤销登记。
        </p>
        {injMsg && <p className="banner">{injMsg}</p>}
        {injuries.length === 0 ? (
          <p className="muted">还没有伤停登记。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>球员</th>
                <th>伤情</th>
                <th>受伤那一场</th>
                <th>缺阵</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {injuries.map((inj) => {
                const done = inj.misses.filter((x) => x.status === "finished").length;
                const rest = inj.misses.length - done;
                return (
                  <Fragment key={inj.id}>
                    <tr>
                      <td>{inj.playerName}</td>
                      <td>
                        {inj.severity === "minor" ? "轻伤" : "重伤"}
                        {inj.injuryName ? ` · ${inj.injuryName}` : ""}
                        {inj.note ? `（${inj.note}）` : ""}
                      </td>
                      <td>{inj.fromLabel}</td>
                      <td>
                        {inj.misses.length === 0
                          ? "未勾缺阵场次"
                          : rest > 0
                            ? `还缺 ${rest} 场 / 共 ${inj.misses.length} 场（伤愈 ${inj.recoverPercent}%）`
                            : `缺阵 ${inj.misses.length} 场已走完（已伤愈）`}
                      </td>
                      <td>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={injBusy}
                          onClick={() => setInjOpen(injOpen === inj.id ? null : inj.id)}
                        >
                          {injOpen === inj.id ? "收起" : "改登记"}
                        </button>
                      </td>
                    </tr>
                    {injOpen === inj.id && (
                      <tr>
                        <td colSpan={5}>
                          <InjuryRegPanel
                            eventId={null}
                            teamId={inj.teamId}
                            severity={inj.severity}
                            playerName={inj.playerName}
                            existing={inj}
                            busy={injBusy}
                            act={injAct}
                            onSaved={() => void reload()}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3>教练邀请</h3>
        <p className="muted">
          生成一个 8 位认证码发给教练，对方在「我的球队」页输入后就能绑定。认证码只能用一次，24 小时过期。
        </p>
        <button className="btn btn-primary" onClick={() => void genCode()}>
          生成认证码
        </button>
        {newCode && (
          <p className="code-reveal">
            新认证码（只显示这一次，赶紧复制）：
            <strong className="code-text">{newCode}</strong>
          </p>
        )}
        {codes.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>生成时间</th>
                <th>过期时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {codes.slice(0, 5).map((c) => (
                <tr key={c.id}>
                  <td>{c.createdAt.slice(0, 16).replace("T", " ")}</td>
                  <td>{c.expiresAt ? c.expiresAt.slice(0, 16).replace("T", " ") : "—"}</td>
                  <td>{c.used ? `已使用 ${c.usedAt?.slice(0, 16).replace("T", " ") ?? ""}` : "未使用"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {members.length > 0 && (
          <>
            <h3>已绑定教练</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>昵称</th>
                  <th>绑定时间</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.userId}>
                    <td>{m.name}</td>
                    <td>{m.joinedAt.slice(0, 16).replace("T", " ")}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => void unbind(m)}>
                        解绑
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card">
        <h3>名单</h3>
        <p className="muted">
          名单由俱乐部平台同步，这里只读。球员的姓名（FC26 存档派生）与球衣号都以俱乐部平台为准：
          签约、解约、定号、改号请到俱乐部平台操作，改动会在下一次同步（每小时一次）后出现在这里。
        </p>
        {data.players.length === 0 ? (
          <p className="muted">还没有球员。签约之后，下一次同步会把名单带过来。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>号码</th>
                <th>姓名</th>
              </tr>
            </thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.id}>
                  <td>{p.number ?? "—"}</td>
                  <td>{p.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
