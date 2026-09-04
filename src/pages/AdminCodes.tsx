import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { Page, SubmitButton, useSubmit } from "../components/ui";

type SignupCodeRow = {
  id: number;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  createdAt: string;
};

function fmt(t: string | null) {
  if (!t) return "不限";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

// 注册码状态：看次数与过期时间，明码不可回查
function codeStatus(r: SignupCodeRow) {
  const expired = r.expiresAt !== null && new Date(r.expiresAt).getTime() < Date.now();
  if (expired) return "已过期";
  if (r.maxUses !== null && r.usedCount >= r.maxUses) return "已用完";
  return "可用";
}

export function AdminCodes() {
  const { user } = useAuth();
  const isSuper = user?.role === "superadmin";
  const [rows, setRows] = useState<SignupCodeRow[] | null>(null);
  const [maxUses, setMaxUses] = useState("1");
  const [hours, setHours] = useState("24");
  const [newCode, setNewCode] = useState<string | null>(null);
  const [allowOpen, setAllowOpen] = useState<boolean | null>(null);
  const [toggleErr, setToggleErr] = useState<string | null>(null);
  const gen = useSubmit();

  async function load() {
    const [d, s] = await Promise.all([
      api<{ codes: SignupCodeRow[] }>("/api/admin/signup-codes"),
      api<{ allowOpenReg: boolean }>("/api/admin/org-settings"),
    ]);
    setRows(d.codes);
    setAllowOpen(s.allowOpenReg);
  }

  useEffect(() => {
    load().catch(() => setRows([]));
  }, []);

  async function toggleOpen(checked: boolean) {
    const prev = allowOpen;
    setAllowOpen(checked);
    try {
      await api("/api/admin/org-settings", {
        method: "PUT",
        body: { allowOpenReg: checked },
      });
      setToggleErr(null);
    } catch (err) {
      setAllowOpen(prev);
      setToggleErr(err instanceof Error ? err.message : "保存失败");
    }
  }

  function generate(e: React.FormEvent) {
    e.preventDefault();
    void gen.run(async () => {
      const d = await api<{ code: string }>("/api/admin/signup-codes", {
        method: "POST",
        body: {
          maxUses: maxUses === "" ? null : Number(maxUses),
          expiresInHours: hours === "" ? null : Number(hours),
        },
      });
      setNewCode(d.code);
      await load();
    });
  }

  return (
    <Page>
      <div className="page-head">
        <h2>注册码</h2>
      </div>
      <p className="hint">
        注册码选填：有码注册可直接绑队；开关打开后没码也能注册，会建「观众」账号（锁定绑队，需在账号管理解锁）。
        明码只在生成时显示一次，库里的哈希查不回来——发给要注册的人就行。
      </p>

      <div className="card">
        <h3>无码注册</h3>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="checkbox"
            checked={allowOpen ?? false}
            disabled={allowOpen === null || !isSuper}
            onChange={(e) => void toggleOpen(e.target.checked)}
          />
          允许无注册码注册（观众号，锁定绑队，账号管理里可解锁）
        </label>
        {!isSuper && <p className="muted">开关仅超管可改。</p>}
        {toggleErr && <p className="error-msg">{toggleErr}</p>}
      </div>

      <div className="card">
        <h3>生成注册码</h3>
        <form className="inline-form" onSubmit={generate}>
          <label>
            可用次数{" "}
            <input
              className="input"
              type="number"
              min="1"
              style={{ width: "5em" }}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
              placeholder="不限"
            />
          </label>
          <label>
            有效期（小时）{" "}
            <input
              className="input"
              type="number"
              min="1"
              style={{ width: "5em" }}
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              placeholder="不限"
            />
          </label>
          <SubmitButton busy={gen.busy}>生成</SubmitButton>
        </form>
        {gen.error && <p className="error-msg">{gen.error}</p>}
        {newCode && (
          <p className="code-reveal">
            新注册码（只显示这一次，赶紧复制）：
            <strong className="code-text">{newCode}</strong>
          </p>
        )}
      </div>

      <div className="card">
        <h3>最近生成的注册码</h3>
        {rows === null ? (
          <p className="muted">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">还没有生成过注册码。</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>生成时间</th>
                <th>已用 / 上限</th>
                <th>过期时间</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmt(r.createdAt)}</td>
                  <td>
                    {r.usedCount} / {r.maxUses ?? "不限"}
                  </td>
                  <td>{fmt(r.expiresAt)}</td>
                  <td>{codeStatus(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}