// 队徽/封面图共用：类型与大小校验、R2 写入（key 版本化防缓存）、旧对象清理
export const MAX_IMAGE_BYTES = 1024 * 1024; // 1MB

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export type SaveResult =
  | { ok: true; key: string }
  | { ok: false; status: 413 | 415; message: string };

export async function saveImage(
  c: { req: { header(name: string): string | undefined; arrayBuffer(): Promise<ArrayBuffer> }; env: { MEDIA: R2Bucket } },
  kind: "team" | "tournament",
  id: number,
): Promise<SaveResult> {
  const contentType = (c.req.header("Content-Type") ?? "").split(";")[0].trim();
  const ext = EXT_BY_TYPE[contentType];
  if (!ext) {
    return { ok: false, status: 415, message: "仅支持 png / jpg / webp 图片" };
  }
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength === 0) {
    return { ok: false, status: 415, message: "文件为空" };
  }
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, message: "图片不能超过 1MB" };
  }
  // 按文件头魔数二次校验，只认真实图片字节（Content-Type 可被伪造）
  const b = new Uint8Array(buf);
  const head = (n: number) => Array.from(b.slice(0, n)).join(",");
  const magicOk =
    (contentType === "image/png" && head(4) === "137,80,78,71") ||
    (contentType === "image/jpeg" && head(3) === "255,216,255") ||
    (contentType === "image/webp" &&
      head(4) === "82,73,70,70" &&
      String.fromCharCode(...b.slice(8, 12)) === "WEBP");
  if (!magicOk) {
    return { ok: false, status: 415, message: "文件内容不是有效的图片" };
  }
  // 版本化 key：换图即换 URL，客户端缓存天然失效
  const key = `${kind}/${id}/${Date.now()}.${ext}`;
  await c.env.MEDIA.put(key, buf, { httpMetadata: { contentType } });
  return { ok: true, key };
}

export async function deleteImage(c: { env: { MEDIA: R2Bucket } }, key: string | null): Promise<void> {
  if (key) await c.env.MEDIA.delete(key);
}

export const mediaUrl = (key: string | null | undefined): string | null =>
  key ? `/api/media/${key}` : null;
