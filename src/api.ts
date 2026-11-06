import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/** 与 ToTonAI 后端交互时的 HTTP 错误 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface ApiRequestOptions {
  method?: string
  token?: string
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * 请求 ToTonAI 后端 JSON 接口。所有请求都带 DSH 归属头(user-agent),
 * 鉴权优先使用 Authorization: Bearer <token>(与后端 /login 换取的令牌一致)。
 */
export async function apiJson(
  baseURL: string,
  path: string,
  opts: ApiRequestOptions = {},
): Promise<any> {
  const { method = 'GET', token, body, timeoutMs = 60_000, signal } = opts
  const url = path.startsWith('http') ? path : `${baseURL}${path}`

  const headers: Record<string, string> = { ...attributionHeaders() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onOuterAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }

  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let data: any = null
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      throw new ApiError(data?.msg ?? `HTTP ${res.status}`, res.status)
    }
    return data
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
}
