import { useEffect, useRef, useState } from "react";
import { ShareDialog } from "./ShareDialog";

export type RoundShareMode = "full" | "first" | "second";

const MENU_LABEL: Record<RoundShareMode, string> = {
  full: "整轮（首回合 + 次回合）",
  first: "仅首回合",
  second: "仅次回合",
};

const TITLE_SUFFIX: Partial<Record<RoundShareMode, string>> = {
  first: "首回合",
  second: "次回合",
};

// 轮次分享入口：两回合轮次先选整轮/仅首回合/仅次回合，再打开预览弹窗。
// 非两回合轮次不显示菜单，点击直接出整轮卡。
export function RoundShareButton({
  title,
  url,
  draw,
  twoLeg,
}: {
  title: string;
  url: string;
  draw: (canvas: HTMLCanvasElement, mode: RoundShareMode) => Promise<void> | void;
  twoLeg: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState<RoundShareMode | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const open = (next: RoundShareMode) => {
    setMenuOpen(false);
    setMode(next);
  };

  const suffix = mode ? TITLE_SUFFIX[mode] : undefined;

  return (
    <>
      <div className="share-menu-wrap" ref={wrapRef}>
        <button
          type="button"
          className="share-btn"
          onClick={() => (twoLeg ? setMenuOpen((v) => !v) : open("full"))}
        >
          分享
        </button>
        {menuOpen && twoLeg && (
          <div className="share-menu" role="menu">
            {(["full", "first", "second"] as const).map((m) => (
              <button key={m} type="button" role="menuitem" onClick={() => open(m)}>
                {MENU_LABEL[m]}
              </button>
            ))}
          </div>
        )}
      </div>
      <ShareDialog
        open={mode != null}
        onClose={() => setMode(null)}
        title={suffix ? `${title} · ${suffix}` : title}
        url={url}
        draw={(c) => draw(c, mode ?? "full")}
      />
    </>
  );
}
