import { ProxyAgent, fetch as undiciFetch } from 'undici'

/**
 * 插件内全局代理:DSH 的 Node 进程不会读 Windows 系统代理/PAC,
 * 受限网络里浏览器能开网页、插件却连不上,就是差这一层。
 * 配置了 proxy 后,把 globalThis.fetch 换成走 ProxyAgent 的实现,
 * 登录、查余额、对话流式请求全部自动走代理。
 */
export interface ProxyState {
  active: boolean
  url: string
  error: string
}

let state: ProxyState = { active: false, url: '', error: '' }

/** 代理地址优先级:显式配置 > HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量 */
export function resolveProxy(configProxy: string): string {
  const explicit = String(configProxy ?? '').trim()
  if (explicit) return explicit
  const env =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ''
  const value = String(env).trim()
  // 系统里常见的 no_proxy 不影响这里:只对本站点流量生效,不做例外判断
  return value
}

/** 启用代理,幂等;代理写错时只记录状态不抛异常,插件本身照常加载 */
export function applyProxy(proxy: string): ProxyState {
  const raw = String(proxy ?? '').trim()
  if (!raw) return state
  if (state.active && state.url === raw) return state
  try {
    if (!/^http:\/\//i.test(raw) && !/^https:\/\//i.test(raw)) {
      throw new Error(`代理地址需以 http:// 或 https:// 开头(当前:${raw});SOCKS 代理请用其 HTTP 端口`)
    }
    const agent = new ProxyAgent(raw)
    globalThis.fetch = ((input: any, init?: any) =>
      undiciFetch(input, { ...(init ?? {}), dispatcher: agent })) as typeof fetch
    state = { active: true, url: raw, error: '' }
    console.warn('[totonai] 已启用代理', raw)
  } catch (e) {
    state = { active: false, url: raw, error: e instanceof Error ? e.message : String(e) }
    console.warn('[totonai] 代理配置无效', state.error)
  }
  return state
}

export function proxyState(): ProxyState {
  return { ...state }
}

/** 本机最常见代理端口:Clash 7890/7897、v2rayN 10809、nekoray 2080、通用 1080/8080/8888 */
const CANDIDATES = [
  'http://127.0.0.1:7890',
  'http://127.0.0.1:7897',
  'http://127.0.0.1:10809',
  'http://127.0.0.1:2080',
  'http://127.0.0.1:1080',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8888',
  'http://127.0.0.1:7891',
]

let autoTask: Promise<ProxyState | null> | null = null

/** 用某个代理真的请求一次站点,能通才算可用(避免把无关的本地服务当成代理) */
async function testProxy(url: string): Promise<boolean> {
  let agent: ProxyAgent | null = null
  try {
    agent = new ProxyAgent(url)
    const res = await undiciFetch('https://www.toton.pro/api/package_config', {
      dispatcher: agent,
      signal: AbortSignal.timeout(4000),
    })
    try {
      await res.body?.cancel()
    } catch {
      // 关流失败不影响判定
    }
    return res.status >= 200 && res.status < 500
  } catch {
    return false
  } finally {
    try {
      await agent?.close()
    } catch {
      // 关闭失败忽略
    }
  }
}

/**
 * 直连失败后自动找一个能用的本地代理并接管。
 * 只在第一次失败时扫描,结果缓存:找到就切换,找不到就不再重复试(避免每次登录都等一轮)。
 */
export async function autoProxy(): Promise<ProxyState | null> {
  if (state.active) return state
  if (autoTask) return autoTask
  autoTask = (async () => {
    for (const candidate of CANDIDATES) {
      if (await testProxy(candidate)) {
        console.warn('[totonai] 直连失败,自动改用本机代理', candidate)
        return applyProxy(candidate)
      }
    }
    console.warn('[totonai] 直连失败,且本机没有可用的常见代理端口')
    return null
  })()
  return autoTask
}
