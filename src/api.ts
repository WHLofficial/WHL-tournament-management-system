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
  opts?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(path, {
    method: opts?.method ?? "GET",
    headers: opts?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
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
}
