import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { KIND_HOT, KIND_LABEL, ReactionBar, fmtTime, itemHref, type ReactionCounts } from "./Home";
import type { FeedItemDTO } from "../../shared/news";

const PAGE = 30;

// 快讯档案页：全量快讯倒序回看，「加载更多」按 at 游标翻页
export default function NewsPage() {
  const [items, setItems] = useState<FeedItemDTO[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [reactions, setReactions] = useState<Record<string, ReactionCounts>>({});
  const [mine, setMine] = useState<Record<string, Set<string>>>({});
  const [loadErr, setLoadErr] = useState<string | null>(null);

  const react = useCallback(async (itemId: string, emoji: "fire" | "thumb" | "mind" | "cry") => {
    const key = `whl.react.${itemId}`;
    const prev: string[] = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (prev.includes(emoji)) return;
    localStorage.setItem(key, JSON.stringify([...prev, emoji]));
    setMine((m) => ({ ...m, [itemId]: new Set([...(m[itemId] ?? []), emoji]) }));
    setReactions((r) => ({ ...r, [itemId]: { ...r[itemId], [emoji]: (r[itemId]?.[emoji] ?? 0) + 1 } }));
    try {
      const res = await api<{ ok: boolean; cnt: number }>(`/api/interact/reactions/${itemId}`, {
        method: "POST",
        body: { emoji },
      });
      setReactions((r) => ({ ...r, [itemId]: { ...r[itemId], [emoji]: res.cnt } }));
    } catch {
      setReactions((r) => ({
        ...r,
        [itemId]: { ...r[itemId], [emoji]: Math.max(0, (r[itemId]?.[emoji] ?? 1) - 1) },
      }));
    }
  }, []);

  const loadMore = useCallback(
    async (fresh: boolean) => {
      setLoading(true);
      setLoadErr(null);
      try {
        const base = fresh ? [] : items;
        const last = base[base.length - 1];
        const q = last?.at ? `&before=${encodeURIComponent(last.at)}` : "";
        const d = await api<{ items: FeedItemDTO[] }>(`/api/public/feed?limit=${PAGE}${q}`);
        setItems([...base, ...d.items]);
        if (d.items.length === 0) setDone(true);
        const ids = d.items.map((i) => i.id);
        if (ids.length > 0) {
          const r = await api<{ reactions: Record<string, ReactionCounts> }>(
            `/api/interact/reactions?ids=${ids.map(encodeURIComponent).join(",")}`,
          );
          setReactions((prev) => ({ ...prev, ...r.reactions }));
        }
      } catch (e) {
        // 失败不置 done：置了会显示「没有更多了」并收起按钮，用户以为快讯已到底、也没法重试
        setLoadErr(e instanceof Error ? e.message : "加载失败");
      } finally {
        setLoading(false);
      }
    },
    [items],
  );

  useEffect(() => {
    void loadMore(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="container">
      <article className="art">
        <div className="whl-masthead">
          <h2>快讯档案</h2>
          <span className="whl-masthead-date">WHL 头版 · 全部动态</span>
          <Link className="whl-masthead-all" to="/weekly">
            周报 →
          </Link>
        </div>

        <div className="whl-shelf">
          {items.map((i) => (
            <div key={i.id} className="news-item">
              <Link className="news-item-link" to={itemHref(i)}>
                <div className="news-item-top">
                  <span
                    className={`news-kind${KIND_HOT[i.kind] ? " k-hot" : i.kind === "weekly" ? " k-weekly" : ""}`}
                  >
                    {KIND_LABEL[i.kind]}
                  </span>
                  <span className="news-item-title">{i.title}</span>
                  <span className="news-item-time">{fmtTime(i.at)}</span>
                </div>
                {i.paragraphs?.length ? (
                  <div className="news-item-paras">
                    {i.paragraphs.map((p, k) => (
                      <p key={k}>{p}</p>
                    ))}
                  </div>
                ) : (
                  <p className="news-item-body">{i.body}</p>
                )}
              </Link>
              <ReactionBar
                itemId={i.id}
                counts={reactions[i.id]}
                mine={mine[i.id] ?? new Set()}
                onReact={react}
              />
            </div>
          ))}
        </div>

        {items.length === 0 && !loading && !loadErr && <p className="muted">还没有快讯。</p>}
        {loadErr && <p className="error-msg">加载失败：{loadErr}</p>}
        {!done && (
          <div className="pager">
            <button type="button" disabled={loading} onClick={() => void loadMore(false)}>
              {loading ? "加载中…" : "加载更多"}
            </button>
          </div>
        )}
        {done && items.length > 0 && <p className="muted">没有更多了。</p>}

        <p className="art-meta">
          <Link to="/">← WHL 头版</Link>
        </p>
      </article>
    </main>
  );
}
