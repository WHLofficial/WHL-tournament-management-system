import { useState } from "react";
import { ShareDialog } from "./ShareDialog";

// 分享入口按钮：点开预览弹窗。draw 生成 800×1000 分享卡。
export function ShareButton({
  label = "分享",
  title,
  url,
  draw,
}: {
  label?: string;
  title: string;
  url: string;
  draw: (canvas: HTMLCanvasElement) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="share-btn" onClick={() => setOpen(true)}>
        {label}
      </button>
      <ShareDialog open={open} onClose={() => setOpen(false)} title={title} url={url} draw={draw} />
    </>
  );
}
