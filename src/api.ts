export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T>(
  path: string,
  opts?: { method?: string; body?: unknown; contentType?: string; timeoutMs?: number },
): Promise<T> {
  const raw = opts?.body instanceof Blob;
  // 微信弱网下 fetch 可能长时间挂起：默认 15s 超时，Blob 上传放宽到 60s
  const timeoutMs = opts?.timeoutMs ?? (raw ? 60000 : 15000);
  // 极老内核没有 AbortController：退化为不设超时（维持原有行为），不让全部请求崩掉
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? window.setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await fetch(path, {
      method: opts?.method ?? "GET",
      headers:
        opts?.body !== undefined
          ? { "Content-Type": opts.contentType ?? "application/json" }
          : undefined,
      body:
        opts?.body === undefined
          ? undefined
          : raw
            ? (opts.body as Blob)
            : JSON.stringify(opts.body),
      credentials: "same-origin",
      signal: ctrl?.signal,
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (data ?? {}) as { message?: string; code?: string };
      // 用着网站时密码被重置：陈旧会话收到此 403 就硬跳改密码页，不弹错误
      if (res.status === 403 && err.code === "password_change_required") {
        window.location.href = "/password";
        throw new ApiError("密码刚被重置，请先设置新密码", res.status, err.code);
      }
      throw new ApiError(err.message ?? `请求失败（${res.status}）`, res.status, err.code ?? "error");
    }
    return data as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError("网络超时，请重试", 0, "timeout");
    }
    throw e;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}
