import { useEffect, useRef, useState } from "react";
import { downloadCanvas } from "../lib/share";

// 分享预览弹窗：绘制分享卡 + 保存/转发 + 复制链接
// 微信内置浏览器不支持 <a download>，预览必须用 <img>（长按可保存/转发/识别二维码）；
// canvas 保留为隐藏的绘制源，转换成 dataURL 后展示 img
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
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [canShareFiles, setCanShareFiles] = useState(false);
  // 微信内置浏览器（Android X5 / iOS WKWebView）没有下载与地址栏，靠长按图片保存
  const isWeChat = /MicroMessenger/i.test(navigator.userAgent);

  useEffect(() => {
    if (!open) return;
    setImgSrc(null);
    setCopied(false);
    setCopyFallback(false);
    setErr(null);
    const c = canvasRef.current;
    if (!c) return;
    Promise.resolve(drawRef.current(c))
      .then(() => setImgSrc(c.toDataURL("image/png")))
      .catch(() => setErr("生成分享图失败"));
  }, [open]);

  // 系统分享面板（带图片文件）的可用性探测一次即可
  useEffect(() => {
    if (!open || !imgSrc) return;
    let dead = false;
    void (async () => {
      try {
        const blob = await new Promise<Blob | null>((res) =>
          canvasRef.current?.toBlob(res, "image/png"),
        );
        if (dead || !blob) return;
        const file = new File([blob], `${title}.png`, { type: "image/png" });
        if (!dead) setCanShareFiles(!!navigator.canShare?.({ files: [file] }));
      } catch {
        /* 探测失败按不可用处理 */
      }
    })();
    return () => {
      dead = true;
    };
  }, [open, imgSrc, title]);

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
      // 微信里没有地址栏可手动复制，展示链接本体供长按/选中复制
      setCopyFallback(true);
    }
  };

  const save = async () => {
    const c = canvasRef.current;
    if (!c) return;
    try {
      const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
      if (blob) {
        const file = new File([blob], `${title}.png`, { type: "image/png" });
        if (navigator.canShare?.({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      }
    } catch (e) {
      // 用户在系统分享面板点了取消，不算失败
      if (e instanceof DOMException && e.name === "AbortError") return;
    }
    downloadCanvas(c, `${title}.png`);
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
        <canvas ref={canvasRef} className="share-canvas" hidden={!!imgSrc} />
        {imgSrc && <img className="share-canvas" src={imgSrc} alt={title} />}
        {err && <p className="error-msg">{err}</p>}
        {isWeChat && <p className="hint share-wx-hint">长按上方图片即可保存或转发给朋友</p>}
        {copyFallback && (
          <input
            className="input"
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="分享链接"
          />
        )}
        <div className="share-actions">
          {(canShareFiles || !isWeChat) && (
            <button type="button" className="btn" onClick={save}>
              {canShareFiles ? "转发 / 保存" : "保存图片"}
            </button>
          )}
          <button type="button" className="btn btn-primary" onClick={copy}>
            {copied ? "已复制" : "复制链接"}
          </button>
        </div>
      </div>
    </div>
  );
}
