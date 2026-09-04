import { useEffect, useRef, useState } from "react";
import { downloadCanvas } from "../lib/share";

// 分享预览弹窗：绘制分享卡 + 保存图片 / 复制链接
export function ShareDialog({
  open,
  onClose,
  title,
  url,
  draw,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  url: string;
  draw: (canvas: HTMLCanvasElement) => Promise<void> | void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setErr(null);
    const c = canvasRef.current;
    if (!c) return;
    Promise.resolve(drawRef.current(c)).catch(() => setErr("生成分享图失败"));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setErr("复制失败，请手动复制地址栏链接");
    }
  };

  const save = () => {
    const c = canvasRef.current;
    if (c) downloadCanvas(c, `${title}.png`);
  };

  return (
    <div className="share-dialog-mask" onClick={onClose}>
      <div className="share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="share-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <canvas ref={canvasRef} className="share-canvas" />
        {err && <p className="error-msg">{err}</p>}
        <div className="share-actions">
          <button type="button" className="btn" onClick={save}>
            保存图片
          </button>
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? "已复制" : "复制链接"}
          </button>
        </div>
      </div>
    </div>
  );
}
