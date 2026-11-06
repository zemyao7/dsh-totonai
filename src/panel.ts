import { ApiError, apiJson } from './api.js'
import type { TokenStore } from './token.js'

/** 面板 HTTP 路由:挂在 dsh 的 webServer 上,同源请求,先过 dsh 自己的登录 */
export const PANEL_PATH = '/api-totonai/panel'

const TIER_NAMES: Record<string, string> = { entry: 'Go', pro: 'Plus', ultimate: 'Pro Max' }

export interface PanelDeps {
  baseURL: string
  requestTimeoutMs: number
  tokenStore: TokenStore
  /** 面板登录/注册成功后写本机凭证并更新令牌管理器 */
  onCredentials(username: string, password: string): void | Promise<void>
  /** 面板退出登录:清本机凭据 */
  onLogout(): void | Promise<void>
}

type PanelResult = { ok: boolean; code?: string; msg?: string; [key: string]: unknown }

const fail = (msg: string, code = 'ERROR'): PanelResult => ({ ok: false, code, msg })

/** 面板动作入口:纯函数式,方便单元测试与 HTTP 层复用 */
export async function handlePanelAction(deps: PanelDeps, body: any): Promise<PanelResult> {
  const action = String(body?.action ?? '')
  try {
    switch (action) {
      case 'status':
        return await doStatus(deps)
      case 'login':
        return await doLogin(deps, body)
      case 'register':
        return await doRegister(deps, body)
      case 'quote':
        return await doQuote(deps)
      case 'claim':
        return await doClaim(deps, body)
      case 'logout':
        await deps.onLogout()
        return { ok: true, msg: '已退出登录' }
      default:
        return fail(`未知操作:${action || '(空)'}`, 'BAD_ACTION')
    }
  } catch (e) {
    if (e instanceof ApiError) {
      return fail(e.message, e.status === 401 ? 'AUTH' : 'API')
    }
    return fail(e instanceof Error ? e.message : String(e), 'ERROR')
  }
}

async function doStatus(deps: PanelDeps): Promise<PanelResult> {
  if (!deps.tokenStore.hasCredentials) {
    return { ok: true, loggedIn: false, baseURL: deps.baseURL }
  }
  const token = await deps.tokenStore.ensure()
  const info = await apiJson(deps.baseURL, '/api/user_info', { token, timeoutMs: deps.requestTimeoutMs })
  if (!info?.ok) {
    return { ok: true, loggedIn: false, baseURL: deps.baseURL, msg: String(info?.msg ?? '未登录') }
  }
  const level = String(info.level ?? 'free')
  const quota = Number(info.token_quota ?? 0)
  const used = Number(info.used_token ?? 0)
  return {
    ok: true,
    loggedIn: true,
    username: String(info.username ?? deps.tokenStore.currentUser),
    level,
    displayName: TIER_NAMES[level] ?? level,
    active: level !== 'free' && quota > 0,
    tokenQuota: quota,
    usedToken: used,
    remainToken: Math.max(0, quota - used),
    baseURL: deps.baseURL,
    qr: {
      wechat: `${deps.baseURL}/qrcode/wechat`,
      alipay: `${deps.baseURL}/qrcode/alipay`,
    },
  }
}

async function doLogin(deps: PanelDeps, body: any): Promise<PanelResult> {
  const username = String(body?.username ?? '').trim()
  const password = String(body?.password ?? '')
  if (!username || !password) return fail('账号和密码不能为空', 'BAD_INPUT')
  const data = await apiJson(deps.baseURL, '/login', {
    method: 'POST',
    body: { username, password },
    timeoutMs: deps.requestTimeoutMs,
  })
  if (!data?.ok || !data.token) return fail(String(data?.msg ?? '账号或密码错误'), 'AUTH')
  await deps.onCredentials(username, password)
  return { ok: true, msg: '登录成功', loggedIn: true, username }
}

async function doRegister(deps: PanelDeps, body: any): Promise<PanelResult> {
  const username = String(body?.username ?? '').trim()
  const password = String(body?.password ?? '')
  if (!username || !password) return fail('账号和密码不能为空', 'BAD_INPUT')
  const data = await apiJson(deps.baseURL, '/register', {
    method: 'POST',
    body: { username, password },
    timeoutMs: deps.requestTimeoutMs,
  })
  if (!data?.ok) return fail(String(data?.msg ?? '注册失败'), 'REGISTER')
  // 注册成功直接登录,省掉用户再输一遍
  return doLogin(deps, { username, password })
}

async function doQuote(deps: PanelDeps): Promise<PanelResult> {
  const cfg = await apiJson(deps.baseURL, '/api/package_config', { timeoutMs: deps.requestTimeoutMs })
  return { ok: true, packages: cfg?.packages ?? {} }
}

async function doClaim(deps: PanelDeps, body: any): Promise<PanelResult> {
  const level = String(body?.level ?? '')
  const period = String(body?.period ?? '')
  const amount = Number(body?.amount ?? 0)
  if (!level || !period || !(amount > 0)) return fail('订单参数不完整', 'BAD_INPUT')
  const token = await deps.tokenStore.ensure()
  const data = await apiJson(deps.baseURL, '/api/pay/manual_notify', {
    method: 'POST',
    token,
    body: {
      level,
      period,
      amount,
      pay_type: body?.pay_type === 'alipay' ? 'alipay' : 'wechat',
      out_trade_no: String(body?.out_trade_no ?? ''),
    },
    timeoutMs: deps.requestTimeoutMs,
  })
  return { ok: !!data?.ok, msg: String(data?.msg ?? ''), out_trade_no: String(body?.out_trade_no ?? '') }
}

/**
 * 把面板路由挂到 dsh webServer。服务不存在(纯 CLI 运行)时返回空清理函数。
 * 所有注册与处理都包在 try/catch:面板坏了不能影响 dsh 本身。
 */
export function registerPanel(ws: any, deps: PanelDeps): () => void {
  if (!ws || typeof ws.register !== 'function') return () => {}
  const disposers: Array<() => void> = []
  try {
    disposers.push(
      ws.register({
        kind: 'exact',
        path: PANEL_PATH,
        handler: async (req: any, res: any) => {
          try {
            if (!sameOrigin(req)) return writeJson(res, 403, fail('来源校验失败', 'ORIGIN'))
            if (String(req?.method ?? '').toUpperCase() !== 'POST') {
              return writeJson(res, 405, fail('只接受 POST', 'METHOD'))
            }
            let body: any
            try {
              body = await readJson(req)
            } catch {
              return writeJson(res, 400, fail('请求格式错误', 'BAD_JSON'))
            }
            const out = await handlePanelAction(deps, body)
            writeJson(res, 200, out)
          } catch (e) {
            writeJson(res, 500, fail(e instanceof Error ? e.message : String(e), 'PANEL'))
          }
        },
      }),
    )
  } catch {
    // 注册失败(宿主版本差异)时面板不可用,但对话与模型能力不受影响
  }
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 已释放则忽略
      }
    }
  }
}

/** 只接受同源调用:有 Origin 时必须与 Host 一致 */
function sameOrigin(req: any): boolean {
  const origin = String(req?.headers?.origin ?? '')
  if (!origin) return true
  const host = String(req?.headers?.host ?? hostOf(req))
  try {
    const u = new URL(origin)
    return !host || u.host === host
  } catch {
    return false
  }
}

function hostOf(req: any): string {
  try {
    return String(req?.headers?.host ?? '')
  } catch {
    return ''
  }
}

async function readJson(req: any): Promise<any> {
  if (typeof req?.json === 'function') {
    const value = await req.json()
    return value ?? {}
  }
  if (req?.body && typeof req.body === 'object') return req.body
  const chunks: any[] = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks.map((c: any) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c))))).toString(
    'utf8',
  )
  return JSON.parse(text || '{}')
}

function writeJson(res: any, status: number, data: unknown): void {
  const text = JSON.stringify(data)
  try {
    if (typeof res?.writeHead === 'function') {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(text)
      return
    }
    if (typeof res?.setHeader === 'function') {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(text)
    }
  } catch {
    // 写响应失败不影响处理流程
  }
}
