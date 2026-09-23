export class ApiError extends Error {
  status: number;
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 服务端约定每个错误响应都带中文 message（worker/index.ts 的 onError 兜底 500 也带）。
// 但边缘自己产生的错误没有 JSON 体（Cloudflare 超时/错误页是 HTML），res.json() 拿不到东西，
// 此时只能按状态码给一句能指导动作的话——否则用户只看到「请求失败（504）」，
// 既不知道是什么问题、也不知道该不该重试。状态码留在文案里，便于用户报错时定位。
function fallbackMessage(status: number): string {
  if (status >= 500) return `服务暂时不可用（${status}），请稍后重试`;
  if (status === 404) return "内容不存在或已被删除";
  if (status === 401) return "登录已过期，请重新登录";
  if (status === 403) return "没有权限执行此操作";
  return `请求失败（${status}）`;
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
      throw new ApiError(err.message ?? fallbackMessage(res.status), res.status, err.code ?? "error");
    }
    return data as T;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError("网络超时，请重试", 0, "timeout");
    }
    // fetch 抛 TypeError = 请求没发出去或响应没拿到（断网、DNS、TLS、被中断）。WebKit 的文案是
    // "Load failed"、Chromium 是 "Failed to fetch"，原样抛出去就会把英文糊到界面上，
    // 所以统一换中文，并用 status 0 让调用方认出这是网络问题而非服务端拒绝
    if (e instanceof TypeError) {
      throw new ApiError("网络异常，请检查网络后重试", 0, "network");
    }
    throw e;
  } finally {
    if (timer) window.clearTimeout(timer);
  }
}
