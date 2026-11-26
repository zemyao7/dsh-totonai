import { execFile } from 'node:child_process'
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
  'http://127.0.0.1:9790',
  'http://127.0.0.1:7899',
  'http://127.0.0.1:10801',
]

/** 常见代理客户端进程名,用来反查它们占了哪些端口 */
const PROXY_PROC = /clash|mihomo|v2ray|xray|sing-box|singbox|nekoray|qv2ray|verge|shadow|trojan|hysteria|tuic|warp/i

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) =>
        resolve(err ? '' : String(stdout ?? '')),
      )
    } catch {
      resolve('')
    }
  })
}

/** 解析 tasklist CSV,取出代理相关进程的 PID */
export function parseProxyPids(tasklistCsv: string): number[] {
  const pids = new Set<number>()
  for (const line of tasklistCsv.split(/\r?\n/)) {
    const cells = (line.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1))
    if (cells.length >= 2 && PROXY_PROC.test(cells[0])) {
      const pid = Number(cells[1])
      if (pid > 0) pids.add(pid)
    }
  }
  return [...pids]
}

/** 解析 tasklist CSV,取出代理相关进程名(给报错文案用) */
export function parseProxyNames(tasklistCsv: string): string[] {
  const names = new Set<string>()
  for (const line of tasklistCsv.split(/\r?\n/)) {
    const cells = (line.match(/"([^"]*)"/g) ?? []).map((s) => s.slice(1, -1))
    if (cells.length >= 2 && PROXY_PROC.test(cells[0])) names.add(cells[0].replace(/\.exe$/i, ''))
  }
  return [...names]
}

/** 解析 netstat 输出,取出指定 PID 正在监听的本地端口 */
export function parseListeningPorts(netstatOut: string, pids: number[]): number[] {
  const want = new Set(pids)
  const ports: number[] = []
  for (const line of netstatOut.split(/\r?\n/)) {
    const m = line
      .trim()
      .match(/^TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\]):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i)
    if (!m) continue
    const pid = Number(m[2])
    const port = Number(m[1])
    if (want.has(pid) && port > 0 && !ports.includes(port)) ports.push(port)
  }
  return ports
}

/** tasklist 结果缓存 5 秒,避免一次扫描里重复起进程 */
let tlCache = { at: 0, text: '' }
async function tasklistText(): Promise<string> {
  if (Date.now() - tlCache.at < 5000 && tlCache.text) return tlCache.text
  const text = await run('tasklist', ['/FO', 'CSV', '/NH'])
  tlCache = { at: Date.now(), text }
  return text
}

/** 从正在运行的代理客户端直接反查端口,mihomo/clash 的端口叫什么名字都能找到 */
export async function discoverProxyPorts(): Promise<number[]> {
  if (process.platform !== 'win32') return []
  const pids = parseProxyPids(await tasklistText())
  if (!pids.length) return []
  return parseListeningPorts(await run('netstat', ['-ano', '-p', 'TCP']), pids)
}

/** 本机正在运行的代理客户端名称,mihomo-windows-386 这类会显示成 mihomo-windows-386 */
export async function listProxyProcs(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  return parseProxyNames(await tasklistText())
}

let autoTask: Promise<ProxyState | null> | null = null
const scans: Array<{ url: string; code: string }> = []
let lastProcs: string[] = []
let lastPorts: number[] = []
let lastFailAt = 0

/** 本机检测到的代理进程与端口,给报错文案和诊断文件用 */
export function envReport(): { procs: string[]; ports: number[] } {
  return { procs: [...lastProcs], ports: [...lastPorts] }
}

/** 最近一次自动探测的结果,错误为空表示该端口可用 */
export function lastScan(): Array<{ url: string; code: string }> {
  return scans.map((s) => ({ ...s }))
}

/** 记录一次直连失败:后台守护据此开始/继续寻找代理 */
export function noteFailure(): void {
  lastFailAt = Date.now()
}

/** 代理还在但连不通(客户关了/换了加速器):退回直连状态,让下一轮重新探测 */
export function markProxyDead(): void {
  if (!state.active) return
  state = { active: false, url: state.url, error: `代理 ${state.url} 已不可用` }
  resetAuto()
}

/** 清掉"已扫描过"的缓存,允许重新探测(代理可能刚被打开或换了端口) */
export function resetAuto(): void {
  autoTask = null
  scans.length = 0
}

/** 用某个代理真的请求一次站点,能通才算可用(避免把无关的本地服务当成代理) */
async function testProxy(url: string): Promise<string> {
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
    return res.status >= 200 && res.status < 500 ? '' : `HTTP ${res.status}`
  } catch (e) {
    const anyE = e as any
    return String(anyE?.cause?.code ?? anyE?.code ?? 'ERR')
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
 * 先按进程反查真实端口(mihomo/clash 把端口改成 9790 这类也能命中),再退回常见端口;
 * 全部端口并行探测,最坏情况也只等一个超时周期。
 */
export async function autoProxy(): Promise<ProxyState | null> {
  if (state.active) return state
  if (autoTask) return autoTask
  autoTask = (async () => {
    const discovered = await discoverProxyPorts()
    lastPorts = [...discovered]
    lastProcs = await listProxyProcs()
    const all = [...new Set([...discovered.map((p) => `http://127.0.0.1:${p}`), ...CANDIDATES])]
    const results = await Promise.all(
      all.map(async (url) => ({ url, code: await testProxy(url) })),
    )
    scans.push(...results)
    const usable = results.find((r) => !r.code)
    if (usable) {
      console.warn('[totonai] 直连失败,自动改用本机代理', usable.url)
      return applyProxy(usable.url)
    }
    console.warn(
      '[totonai] 直连失败,本机代理均不可用',
      results.map((r) => `${r.url} ${r.code}`).join(' | '),
    )
    return null
  })()
  return autoTask
}

/**
 * 后台守护:断网期间每 30 秒重新探测一次,客户事后打开加速器就能自动接上,
 * 不需要重装插件或重启 DSH。只在失败过之后才开始工作,平时完全静默。
 */
export function watchProxy(onRecover: (s: ProxyState) => void, intervalMs = 30_000): () => void {
  const timer = setInterval(() => {
    if (state.active || !lastFailAt) return
    resetAuto()
    void autoProxy().then((got) => {
      if (!got?.active) return
      try {
        onRecover(got)
      } catch {
        // 回调失败不影响代理本身
      }
    })
  }, intervalMs)
  if (typeof (timer as any).unref === 'function') (timer as any).unref()
  return () => clearInterval(timer)
}

/** 给报错文案用的一句话总结:区分"没开加速器"和"端口类型不对"两种情况 */
export function scanSummary(): string {
  if (!scans.length) return ''
  const usable = scans.find((s) => !s.code)
  if (usable) return `已切换代理 ${usable.url} 但仍失败`
  const more = lastProcs.length ? `已探测进程 ${lastProcs.join(',')} 的监听端口` : '未检测到加速器或代理进程'
  const ports = scans.map((s) => new URL(s.url).port).join(',')
  const hint = lastProcs.length
    ? '该端口若是 SOCKS 类型,请在加速器里开启混合/HTTP 端口后点登录'
    : '请先打开你的加速器(Clash/mihomo 等),它会自动接上'
  return `${more},已试 ${ports} 均不可用,${hint}`
}
