import Schema from '@deepseek-ai/schemastery'

/** 插件运行配置:ToTonAI 站点地址 + 账号密码。账号密码仅保存在本机,用于换取访问令牌,不会下发到任何模型调用。 */
export interface TotonAiConfig {
  /** 站点地址,不带末尾斜杠,例如 https://www.toton.pro */
  baseURL: string
  /** ToTonAI 账号;留空时使用插件面板里登录过的账号 */
  username: string
  /** ToTonAI 密码;留空时使用插件面板里登录过的密码 */
  password: string
  /** 非流式请求超时秒数(登录/支付/查单) */
  requestTimeout: number
}

export const Config = Schema.object({
  baseURL: Schema.string()
    .default('https://www.toton.pro')
    .description('ToTonAI 站点地址(不带末尾斜杠)'),
  username: Schema.string()
    .default('')
    .description('ToTonAI 账号;也可以在 DSH 设置页的 ToTonAI 面板里直接登录'),
  password: Schema.string()
    .default('')
    .description('ToTonAI 密码;仅存本机,用于登录换令牌'),
  requestTimeout: Schema.number()
    .default(180)
    .description('非流式请求超时(秒)'),
})
