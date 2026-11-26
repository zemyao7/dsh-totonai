import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { autoProxy, envReport, lastScan, markProxyDead, noteFailure, proxyState, scanSummary } from './proxy.js'

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

/**
 * 传输层错误(连不上、被重置、证书不信任)。与 ApiError 区分开:
 * 前者是"到不了站点",后者是"站点明确回了错误码"。
 */
export class NetError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail: string,
  ) {
    super(message)
    this.name = 'NetError'
  }
}

export interface ApiRequestOptions {
  method?: string
  token?: string
  body?: unknown
  timeoutMs?: number
  signal?: AbortSignal
}

/** 把常见的底层错误码翻译成一眼能看懂的原因 */
const HINTS: Record<string, string> = {
  ENOTFOUND: '域名解析失败,检查 DNS 或代理设置',
  EAI_AGAIN: '域名解析暂时失败,DNS 不稳定或被劫持',
  ECONNRESET: '连接被重置,常见于加速器、安全软件的 HTTPS 扫描或运营商拦截',
  ECONNREFUSED: '连接被拒绝,端口不通',
  ETIMEDOUT: '连接超时',
  UND_ERR_CONNECT_TIMEOUT: '连接超时',
  UND_ERR_SOCKET: '连接被异常关闭',
  UND_ERR_HEADERS_TIMEOUT: '响应超时',
  EHOSTUNREACH: '网络不可达',
  ENETUNREACH: '网络不可达',
  ABORT_ERR: '请求超时',
  CERT_HAS_EXPIRED: '站点证书已过期',
  SELF_SIGNED_CERT_IN_CHAIN: '证书链含自签名证书,通常是安全软件或企业网关做了 HTTPS 中间人',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证站点证书,通常是 HTTPS 中间人',
  DEPTH_ZERO_SELF_SIGNED_CERT: '自签名证书,通常是 HTTPS 中间人',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配,通常是 HTTPS 中间人',
  ERR_SSL_WRONG_VERSION_NUMBER: 'TLS 版本不匹配,通常是中间人',
}

/** 顺着 cause 链找到最底层的错误码 */
function pickCode(e: any): string {
  let cur: any = e
  for (let i = 0; i < 6 && cur; i++) {
    const raw = cur.code ?? cur.errno
    if (typeof raw === 'string' && raw) {
      const code = raw.toUpperCase()
      if (code !== 'ERR_INVALID_ARG_TYPE' && code !== 'UND_ERR_INVALID_ARG') return code
    }
    if (typeof cur === 'string') break
    cur = cur.cause
  }
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'ABORT_ERR'
  return ''
}

/** 把任意异常整理成 NetError,保留 URL、错误码与耗时 */
function toNetError(e: any, url: string, elapsedMs: number): NetError {
  const code = pickCode(e) || 'NETWORK'
  const hint = HINTS[code] ?? ''
  const base = `连不上 ToTonAI: ${code}${hint ? ` - ${hint}` : ''}`
  return new NetError(base, code, `${url} ${elapsedMs}ms ${String(e?.message ?? e)}`)
}

/** www 与裸域互换,给被 DNS 特例/分流误伤的用户留一条备份路径 */
function alternates(baseURL: string): string[] {
  try {
    const u = new URL(baseURL)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return []
    const host = u.hostname
    const other = host.startsWith('www.') ? host.slice(4) : `www.${host}`
    if (!other || other.split('.').some((part) => !part)) return []
    const clone = new URL(baseURL)
    clone.hostname = other
    return [clone.toString().replace(/\/+$/, '')]
  } catch {
    return []
  }
}

/** 付款通知这类写操作绝不重试,避免重复下单 */
function retryable(method: string, path: string): boolean {
  if (method.toUpperCase() === 'GET') return true
  return !path.startsWith('/api/pay')
}

/** 读自己的版本号:lib/*.js 与 package.json 同属包根下一层,打包后同样成立 */
function pkgVersion(): string {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    return String(JSON.parse(raw)?.version ?? '')
  } catch {
    return ''
  }
}

/** 网络失败时落一份诊断文件,用户直接把这个文件发给客服即可,不必敲命令 */
function writeDiagnose(data: Record<string, unknown>): void {
  try {
    const dir = join(homedir(), '.dsh-totonai')
    mkdirSync(dir, { recursive: true })
    const lines = Object.entries(data).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    writeFileSync(join(dir, 'diagnose.txt'), lines.join('\n'), 'utf8')
  } catch {
    // 写不进去不影响报错
  }
}

/**
 * 请求 ToTonAI 后端 JSON 接口。所有请求都带 DSH 归属头(user-agent),
 * 鉴权优先使用 Authorization: Bearer <token>(与后端 /login 换取的令牌一致)。
 * 传输失败时按候选域名重试一次,并把最底层错误码写进报错文案与日志。
 */
export async function apiJson(
  baseURL: string,
  path: string,
  opts: ApiRequestOptions = {},
): Promise<any> {
  const { method = 'GET', token, body, timeoutMs = 60_000, signal } = opts
  const absolute = path.startsWith('http')
  const base = baseURL.replace(/\/+$/, '')
  const targets = absolute ? [path] : [base, ...alternates(base)].map((b) => `${b}${path}`)

  const headers: Record<string, string> = { ...attributionHeaders() }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`

  let lastError: NetError | null = null
  const tried: string[] = []
  const details: string[] = []
  let autoTried = false

  for (let i = 0; i < targets.length; i++) {
    const url = targets[i]
    const started = Date.now()
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
    } catch (e) {
      // 站点明确回了错误码:不再换域名,直接抛给调用方
      if (e instanceof ApiError) throw e
      const err = toNetError(e, url, Date.now() - started)
      const host = (() => {
        try {
          return new URL(url).host
        } catch {
          return url
        }
      })()
      tried.push(`${host} -> ${err.code}`)
      details.push(err.detail)
      console.warn('[totonai] 网络请求失败', {
        url,
        method,
        code: err.code,
        elapsedMs: Date.now() - started,
        detail: err.detail,
        cause: (e as any)?.cause,
      })
      lastError = err
      // 之前接管的代理现在连不通了(客户关了加速器或换了端口):退回直连,交给下一轮重新探测
      markProxyDead()
      noteFailure()
      // 超时不换域名重试:再等一轮只会让用户多等一个超时周期
      if (err.code === 'ABORT_ERR') break
      if (!retryable(method, path)) break
      // 直连不通时,自动找本机代理端口接管,然后用同一个地址再试一次
      if (!autoTried) {
        autoTried = true
        const proxied = await autoProxy()
        if (proxied?.active) {
          tried.push(`经代理 ${proxied.url}`)
          i--
          continue
        }
      }
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onOuterAbort)
    }
  }

  if (!lastError) throw new NetError('连不上 ToTonAI: 未知网络错误', 'NETWORK', path)
  // 换过域名时把两条路径都写出来,用户截图即可定位是哪一段不通
  const suffix = tried.length > 1 ? ` (已尝试 ${tried.join(' / ')})` : ''
  const summary = scanSummary()
  const message = `${lastError.message}${suffix}${summary ? ` [${summary}]` : ''}`
  writeDiagnose({
    time: new Date().toISOString(),
    version: pkgVersion(),
    url: lastError.detail,
    code: lastError.code,
    base: baseURL,
    proxy: proxyState(),
    env: envReport(),
    scan: lastScan(),
    tried,
  })
  throw new NetError(message, lastError.code, details.join(' | '))
}
