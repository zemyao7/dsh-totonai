import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { apiJson } from './api.js'
import type { TokenStore } from './token.js'

export interface PayToolDeps {
  baseURL: string
  requestTimeoutMs: number
  tokenStore: TokenStore
}

interface TierInfo {
  display_name: string
  month_price: number
  year_price: number
  token_quota: number
}

/** 与后端 MEMBER_CONFIG 保持一致的兜底值(/api/package_config 不可用时使用) */
const FALLBACK_TIERS: Record<string, TierInfo> = {
  entry: { display_name: 'Go', month_price: 27, year_price: 307, token_quota: 5_000_000 },
  pro: { display_name: 'Plus', month_price: 77, year_price: 847, token_quota: 25_000_000 },
  ultimate: { display_name: 'Pro Max', month_price: 177, year_price: 2077, token_quota: 50_000_000 },
}

const TIER_TEXT =
  'entry=Go(27元/月,307元/年,500万token/月);' +
  'pro=Plus(77元/月,847元/年,2500万token/月);' +
  'ultimate=Pro Max(177元/月,2077元/年,5000万token/月+10张生图/日)'

/** 价格一律从站点 /api/package_config 实时读取,读不到才用兜底值,避免插件与站点调价不同步 */
async function loadTier(deps: PayToolDeps, level: string): Promise<TierInfo> {
  try {
    const cfg = await apiJson(deps.baseURL, '/api/package_config', { timeoutMs: deps.requestTimeoutMs })
    const p = cfg?.packages?.[level]
    if (p && typeof p.month_price === 'number') {
      return {
        display_name: String(p.display_name ?? level),
        month_price: Number(p.month_price),
        year_price: Number(p.year_price),
        token_quota: Number(p.token_quota ?? 0),
      }
    }
  } catch {
    // 站点不可达时静默回退兜底价格
  }
  return FALLBACK_TIERS[level] ?? { display_name: level, month_price: 0, year_price: 0, token_quota: 0 }
}

function makeOrderNo(): string {
  return `TT${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n >= 10_000) return `${(n / 10_000).toFixed(0)} 万`
  return String(n)
}

/**
 * 账号与充值工具组,严格贴合站点当前真实收款方式(个人收款码 + 备注用户名 + 站长人工开通):
 * - totonai_register   在当前对话里直接注册站点账号(不用打开网页)
 * - totonai_recharge   生成充值单(实时价格),返回收款码链接与应付金额
 * - totonai_pay_claim  用户付款后申报,写入站点核对日志,等待站长开通
 * - totonai_pay_status 查询账号会员是否已开通(读取 /api/user_info)
 */
export function createPayTools(deps: PayToolDeps) {
  const { baseURL, requestTimeoutMs, tokenStore } = deps

  const register = defineTool({
    name: 'totonai_register',
    description:
      '在 ToTonAI 站点注册新账号,直接在当前对话里完成,不需要打开网页。' +
      '注册后为免费档,暂不能调用模型,需要充值开通会员;之后把账号密码填进插件配置即可使用。' +
      '用户说"注册一个账号""帮我开个号"时调用。',
    parameters: {
      username: {
        type: 'string',
        required: true,
        description: '新账号,3-32 位,仅字母、数字、下划线和短横线',
      },
      password: {
        type: 'string',
        required: true,
        description: '密码,至少 6 位',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          username: { type: 'string' },
          msg: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(args, value) {
        if (!value.ok) {
          return textBlock(
            `注册失败:${value.msg || '未知错误'}。用户名需 3-32 位字母/数字/下划线/短横线,密码至少 6 位。`,
          )
        }
        return textBlock(
          [
            `账号 ${value.username} 注册成功(免费档,暂时还不能调用模型)。`,
            '',
            '下一步:打开 DSH 设置 → 插件 → llm-totonai,把这个账号和刚设的密码填进去,重启后就能选模型。',
            '要开通会员,对我说"帮我充值 Go 月卡",我会给你收款码和应付金额。',
          ].join('\n'),
        )
      },
    },
    async execute(args) {
      try {
        const data = await apiJson(baseURL, '/register', {
          method: 'POST',
          body: { username: args.username, password: args.password },
          timeoutMs: requestTimeoutMs,
        })
        return { ok: !!data?.ok, username: String(args.username), msg: String(data?.msg ?? '') }
      } catch (e) {
        return { ok: false, username: String(args.username), msg: String((e as Error)?.message ?? '') }
      }
    },
  })

  const recharge = defineTool({
    name: 'totonai_recharge',
    description:
      `为当前 ToTonAI 账号生成会员充值单,返回收款码链接和应付金额。会员档位:${TIER_TEXT}。` +
      '用户要求开通会员、续费、充值时调用。' +
      '注意:站点使用个人收款码,需用户按金额转账并在备注写明用户名,由站长核对后手动开通(一般5分钟内),没有自动回调。',
    parameters: {
      level: {
        type: 'string',
        enum: ['entry', 'pro', 'ultimate'],
        required: true,
        description: '会员档位:entry(Go)/pro(Plus)/ultimate(Pro Max)',
      },
      period: {
        type: 'string',
        enum: ['month', 'year'],
        required: true,
        description: 'month=月卡,year=年卡',
      },
      pay_type: {
        type: 'string',
        enum: ['wechat', 'alipay'],
        description: '支付方式,默认微信;用户明确要支付宝时传 alipay',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          out_trade_no: { type: 'string' },
          amount: { type: 'number' },
          level: { type: 'string' },
          period: { type: 'string' },
          display_name: { type: 'string' },
          pay_type: { type: 'string' },
          qr_url: { type: 'string' },
          username: { type: 'string' },
          msg: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(args, value) {
        if (!value.ok) {
          return textBlock(`充值单生成失败:${value.msg || '未知错误'}。请确认插件里的 ToTonAI 账号密码正确。`)
        }
        const periodText = value.period === 'year' ? '年卡' : '月卡'
        const payText = value.pay_type === 'alipay' ? '支付宝' : '微信'
        return textBlock(
          [
            `已生成 ${value.display_name ?? ''} ${periodText} 充值单,应付 ¥${value.amount ?? 0},订单号 ${value.out_trade_no ?? ''}`,
            '',
            `1. 用浏览器打开 ${payText}收款码(手机扫码):`,
            value.qr_url ?? '',
            `2. 转账金额 ¥${value.amount ?? 0},付款备注必须填写你的用户名:${value.username ?? '(你的 ToTonAI 用户名)'}`,
            `3. 付款完成后回来说"已付款",我会把这条申报提交给站长`,
            '',
            '站长核对到账后会手动开通,一般 5 分钟内生效。个人收款码没有自动回调,这一步需要人工确认。',
          ].join('\n'),
        )
      },
    },
    async execute(args) {
      const level = String(args.level)
      const period = String(args.period)
      const payType = args.pay_type === 'alipay' ? 'alipay' : 'wechat'
      try {
        const token = await tokenStore.ensure()
        const tier = await loadTier(deps, level)
        const amount = period === 'year' ? tier.year_price : tier.month_price
        let username = ''
        try {
          const info = await apiJson(baseURL, '/api/user_info', { token, timeoutMs: requestTimeoutMs })
          username = String(info?.username ?? '')
        } catch {
          // 用户名拿不到不影响下单,渲染时用占位提示
        }
        return {
          ok: tier.month_price > 0 && amount > 0,
          out_trade_no: makeOrderNo(),
          amount,
          level,
          period,
          display_name: tier.display_name,
          pay_type: payType,
          qr_url: `${baseURL}/qrcode/${payType}`,
          username,
          msg: tier.month_price > 0 ? '' : '未取到该档位价格,请确认站点地址或稍后重试',
        }
      } catch (e) {
        return {
          ok: false,
          out_trade_no: '',
          amount: 0,
          level,
          period,
          display_name: '',
          pay_type: payType,
          qr_url: `${baseURL}/qrcode/${payType}`,
          username: '',
          msg: String((e as Error)?.message ?? ''),
        }
      }
    },
  })

  const payClaim = defineTool({
    name: 'totonai_pay_claim',
    description:
      '用户扫码付款后,把充值申报提交给 ToTonAI 站长核对。' +
      '用户说"已付款""付好了""转过去了"时调用,参数从 totonai_recharge 的返回结果里取。',
    parameters: {
      out_trade_no: {
        type: 'string',
        required: true,
        description: '充值单号,来自 totonai_recharge 返回的 out_trade_no',
      },
      level: {
        type: 'string',
        enum: ['entry', 'pro', 'ultimate'],
        required: true,
        description: '会员档位',
      },
      period: {
        type: 'string',
        enum: ['month', 'year'],
        required: true,
        description: 'month=月卡,year=年卡',
      },
      amount: {
        type: 'number',
        required: true,
        description: '实付金额,来自 totonai_recharge 返回的 amount',
      },
      pay_type: {
        type: 'string',
        enum: ['wechat', 'alipay'],
        description: '实际付款方式,默认微信',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          msg: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(args, value) {
        if (!value.ok) {
          return textBlock(`申报提交失败:${value.msg || '未知错误'}。请稍后重试,或直接联系站长。`)
        }
        return textBlock(
          [
            `已把订单 ${args.out_trade_no} 的付款申报提交给站长,金额 ¥${args.amount}。`,
            '站长核对到账后会手动开通,一般 5 分钟内生效。',
            '',
            '开通后对我说"查一下会员状态",我会读取你的账号确认。',
          ].join('\n'),
        )
      },
    },
    async execute(args) {
      try {
        const token = await tokenStore.ensure()
        const data = await apiJson(baseURL, '/api/pay/manual_notify', {
          method: 'POST',
          token,
          body: {
            level: args.level,
            period: args.period,
            amount: args.amount,
            pay_type: args.pay_type === 'alipay' ? 'alipay' : 'wechat',
            out_trade_no: args.out_trade_no,
          },
          timeoutMs: requestTimeoutMs,
        })
        return { ok: !!data?.ok, msg: String(data?.msg ?? '') }
      } catch (e) {
        return { ok: false, msg: String((e as Error)?.message ?? '') }
      }
    },
  })

  const payStatus = defineTool({
    name: 'totonai_pay_status',
    description:
      '查询当前 ToTonAI 账号的会员状态:档位、总额度、已用额度、是否已开通。' +
      '用户付款后想确认是否开通,或想知道剩余额度时调用。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          active: { type: 'boolean' },
          username: { type: 'string' },
          level: { type: 'string' },
          display_name: { type: 'string' },
          token_quota: { type: 'number' },
          used_token: { type: 'number' },
          msg: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(_args, value) {
        if (!value.ok) {
          return textBlock(`查询失败:${value.msg || '未知错误'}。请确认插件里的账号密码正确。`)
        }
        if (value.active) {
          const quota = Number(value.token_quota ?? 0)
          const used = Number(value.used_token ?? 0)
          const remain = Math.max(0, quota - used)
          return textBlock(
            [
              `账号 ${value.username ?? ''} 已开通 ${value.display_name ?? value.level ?? ''}。`,
              `总额度 ${formatTokens(quota)} token,已用 ${formatTokens(used)} token,剩余约 ${formatTokens(remain)} token。`,
            ].join('\n'),
          )
        }
        return textBlock(
          [
            `账号 ${value.username ?? ''} 当前未开通会员(或还处于免费档)。`,
            '如果刚付款并已申报,请等站长核对,一般 5 分钟内开通后再查一次。',
            '如果还没付款,说"我要充值"即可生成收款码订单。',
          ].join('\n'),
        )
      },
    },
    async execute() {
      try {
        const token = await tokenStore.ensure()
        const data = await apiJson(baseURL, '/api/user_info', { token, timeoutMs: requestTimeoutMs })
        const level = String(data?.level ?? 'free')
        const quota = Number(data?.token_quota ?? 0)
        return {
          ok: !!data?.ok,
          active: level !== 'free' && quota > 0,
          username: String(data?.username ?? ''),
          level,
          display_name: FALLBACK_TIERS[level]?.display_name ?? level,
          token_quota: quota,
          used_token: Number(data?.used_token ?? 0),
          msg: String(data?.msg ?? ''),
        }
      } catch (e) {
        return {
          ok: false,
          active: false,
          username: '',
          level: '',
          display_name: '',
          token_quota: 0,
          used_token: 0,
          msg: String((e as Error)?.message ?? ''),
        }
      }
    },
  })

  return [register, recharge, payClaim, payStatus]
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}
