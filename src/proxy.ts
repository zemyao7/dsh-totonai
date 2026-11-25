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
