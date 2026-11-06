import { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { TotonAiConfig } from './config.js'
import { TotonAiAdapter } from './adapter.js'
import { TokenStore } from './token.js'
import { createPayTools } from './tools.js'
import { clearCreds, loadCreds, saveCreds } from './creds.js'
import { registerPanel } from './panel.js'

export const name = 'llm-totonai'

export const inject = ['llm']

export { Config }

/** 插件行被 Cordis 加载后的入口 */
export function apply(ctx: Context, config: TotonAiConfig) {
  // 凭证来源优先级:插件配置 > DSH 设置页面板里登录时写入的本机凭证文件
  const stored = loadCreds()
  const effective: TotonAiConfig = {
    ...config,
    username: config.username || stored?.username || '',
    password: config.password || stored?.password || '',
  }

  const tokens = new TokenStore(effective)
  const adapter = new TotonAiAdapter(effective, tokens)

  const disposers: Array<() => void> = [ctx.llm.registerAdapter(['totonai'], adapter)]

  // 注册/充值工具:宿主存在 tools 服务时注册(图形界面/agent 环境),headless 无 tools 时静默跳过
  const tools = (ctx as any).get?.('tools') as
    | { register(definition: unknown): () => void }
    | undefined
  if (tools) {
    for (const tool of createPayTools({
      baseURL: effective.baseURL,
      requestTimeoutMs: effective.requestTimeout * 1000,
      tokenStore: tokens,
    })) {
      disposers.push(tools.register(tool))
    }
  }

  // 设置页面板:宿主有 webServer 时挂自己的 HTTP 路由(登录/注册/余额/充值二维码)
  const ctxAny = ctx as any
  try {
    if (typeof ctxAny.inject === 'function') {
      ctxAny.inject(['webServer'], (webCtx: any) => {
        const dispose = registerPanel(webCtx?.webServer, {
          baseURL: effective.baseURL,
          requestTimeoutMs: effective.requestTimeout * 1000,
          tokenStore: tokens,
          onCredentials(username: string, password: string) {
            saveCreds({ baseURL: effective.baseURL, username, password })
            tokens.setCredentials(username, password)
          },
          onLogout() {
            clearCreds()
            tokens.setCredentials('', '')
          },
        })
        disposers.push(dispose)
      })
    }
  } catch {
    // 纯 CLI 环境没有 webServer:面板不可用,对话能力不受影响
  }

  ctx.on('dispose' as any, () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // 已释放则忽略
      }
    }
  })
}
