import { LlmError } from '@deepseek-ai/dsh-llm'
import { ApiError, apiJson } from './api.js'
import type { TotonAiConfig } from './config.js'

/** 后端令牌有效期(秒):7 天 */
const SERVER_TOKEN_TTL_MS = 7 * 24 * 3600 * 1000
/** 提前 24 小时静默续期,避免到期被 401 打断对话 */
const RENEW_EARLY_MS = 24 * 3600 * 1000

/**
 * 账号令牌管理器:用账号密码调用 /login 换取 Bearer 令牌,进程内缓存,
 * 过期前自动重新登录。上游 API Key 永不进入本插件。
 *
 * 账号密码来源有两个:插件配置字段,以及设置页面板登录后写入的本机凭证文件。
 * 面板登录成功时调用 setCredentials 立即生效,不需要重启 DSH。
 */
export class TokenStore {
  private token = ''
  private tokenUser = ''
  private expiresAt = 0
  private username: string
  private password: string

  constructor(private readonly config: TotonAiConfig) {
    this.username = config.username
    this.password = config.password
  }

  /** 面板登录/注册成功后更新凭据,并让下一次调用重新登录 */
  setCredentials(username: string, password: string): void {
    this.username = username
    this.password = password
    this.token = ''
    this.tokenUser = ''
    this.expiresAt = 0
  }

  get hasCredentials(): boolean {
    return !!this.username && !!this.password
  }

  get currentUser(): string {
    return this.username
  }

  /** 取一个可用令牌;缓存过期或强制时自动重新登录 */
  async ensure(force = false): Promise<string> {
    const { baseURL } = this.config
    const username = this.username
    const password = this.password
    if (!username || !password) {
      throw new LlmError('尚未登录 ToTonAI:请在 DSH 设置页的 ToTonAI 面板里登录', 'AUTH')
    }
    if (!force && this.token && this.tokenUser === username && Date.now() < this.expiresAt) {
      return this.token
    }
    try {
      const data = await apiJson(baseURL, '/login', {
        method: 'POST',
        body: { username, password },
        timeoutMs: this.config.requestTimeout * 1000,
      })
      if (!data?.ok || !data.token) {
        throw new ApiError(data?.msg ?? '登录失败', 401)
      }
      this.token = String(data.token)
      this.tokenUser = username
      this.expiresAt = Date.now() + SERVER_TOKEN_TTL_MS - RENEW_EARLY_MS
      return this.token
    } catch (e) {
      if (e instanceof ApiError) {
        throw new LlmError(`ToTonAI 登录失败: ${e.message}`, 'AUTH', { status: e.status })
      }
      const msg = e instanceof Error ? e.message : String(e)
      throw new LlmError(`无法连接 ToTonAI 站点(${baseURL}): ${msg}`, 'NETWORK')
    }
  }

  /** 令牌失效(如遇 401)时清空,下次调用自动重登 */
  invalidate(): void {
    this.token = ''
    this.expiresAt = 0
  }
}
