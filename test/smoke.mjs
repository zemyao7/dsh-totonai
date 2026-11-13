/**
 * 冒烟测试:不依赖真实网络,用模拟 fetch 验证四条核心链路:
 *  1. SSE 流 → StreamChunk 块映射(文本/推理/工具调用/结束)
 *  2. DSH 消息 → OpenAI 请求体映射
 *  3. 401 令牌失效 → 自动重登重试
 *  4. 充值工具定义(参数 schema / 支付闭环字段)
 */
import assert from 'node:assert/strict'
import { TotonAiAdapter } from '../lib/adapter.js'
import { TokenStore } from '../lib/token.js'
import { createPayTools } from '../lib/tools.js'

const BASE = 'https://toton.test'
const CONFIG = { baseURL: BASE, username: 'demo', password: 'demo-pass', requestTimeout: 60 }
const LOGIN_BODY = JSON.stringify({ username: 'demo', password: 'demo-pass' })

let fetchCalls = []
const originalFetch = globalThis.fetch

function resetFetch() {
  fetchCalls = []
}

function installFetch(handler) {
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), init: JSON.parse(JSON.stringify(init)) }
    fetchCalls.push(entry)
    return handler(entry)
  }
}

function sseResponse(events) {
  const body =
    events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function okLogin() {
  return jsonResponse(200, { ok: true, token: 'token-abc', is_admin: false })
}

async function collect(adapter, options) {
  const chunks = []
  for await (const c of adapter.stream(options)) chunks.push(c)
  return chunks
}

// ---------- 1. SSE 流 → StreamChunk 块映射 ----------
{
  resetFetch()
  installFetch(() => {
    return sseResponse([
      { choices: [{ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '世界' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ])
  })
  const tokens = new TokenStore(CONFIG)
  tokens.token = 'token-abc'
  tokens.tokenUser = 'demo'
  tokens.expiresAt = Date.now() + 60_000
  const adapter = new TotonAiAdapter(CONFIG, tokens)
  const chunks = await collect(adapter, {
    provider: 'totonai',
    model: 'deepseek/deepseek-v4-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(chunks[0].type, 'block-start')
  assert.equal(chunks[0].blockType, 'text')
  assert.equal(chunks[1].type, 'text-delta')
  assert.equal(chunks[1].text, '你好')
  assert.equal(chunks[2].text, '世界')
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text, '你好世界')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'stop' })
  console.log('PASS 1: SSE -> StreamChunk 文本映射')
}

// ---------- 2. 工具调用增量拼接 ----------
{
  resetFetch()
  installFetch(() => {
    return sseResponse([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'totonai_recharge', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"level":"plus","period"' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"month"}' } }] }, finish_reason: null },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ])
  })
  const tokens = new TokenStore(CONFIG)
  tokens.token = 'token-abc'
  tokens.tokenUser = 'demo'
  tokens.expiresAt = Date.now() + 60_000
  const adapter = new TotonAiAdapter(CONFIG, tokens)
  const chunks = await collect(adapter, {
    provider: 'totonai',
    model: 'openai/gpt-5.4',
    messages: [{ role: 'user', content: [{ type: 'text', text: '充值' }] }],
  })
  const start = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.ok(start, '应有 tool-call block-start')
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta')
  assert.equal(deltas.length, 2)
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(end.block.name, 'totonai_recharge')
  assert.equal(end.block.arguments, '{"level":"plus","period":"month"}')
  const finish = chunks.find((c) => c.type === 'finish')
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
  console.log('PASS 2: 工具调用增量拼接与结束原因')
}

// ---------- 3. DSH 消息 → OpenAI 请求体 ----------
{
  resetFetch()
  installFetch((entry) => {
    if (entry.url === BASE + '/v1/chat/completions') {
      const body = JSON.parse(entry.init.body)
      assert.deepEqual(body.messages, [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '收到', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'foo', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '结果' },
      ])
      assert.equal(body.model, 'openai/gpt-5.4')
      assert.equal(body.stream, true)
      assert.equal(body.max_tokens, 4096)
      assert.equal(body.temperature, 0.7)
      assert.equal(body.tools.length, 1)
      assert.equal(body.tool_choice, 'auto')
    }
    return sseResponse([{ choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] }])
  })
  const tokens = new TokenStore(CONFIG)
  tokens.token = 'token-abc'
  tokens.tokenUser = 'demo'
  tokens.expiresAt = Date.now() + 60_000
  const adapter = new TotonAiAdapter(CONFIG, tokens)
  await collect(adapter, {
    provider: 'totonai',
    model: 'openai/gpt-5.4',
    temperature: 0.7,
    maxTokens: 4096,
    tools: [{ name: 'foo', description: '测试', parameters: { type: 'object' } }],
    messages: [
      { role: 'system', content: [{ type: 'text', text: '你是助手' }] },
      { role: 'user', content: [{ type: 'text', text: '你好' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '收到' },
          { type: 'tool-call', id: 'call_1', name: 'foo', arguments: '{}' },
        ],
      },
      { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '结果' }] },
    ],
  })
  console.log('PASS 3: DSH 消息 -> OpenAI 请求体')
}

// ---------- 4. 401 令牌失效自动重登 ----------
{
  resetFetch()
  let chatAttempts = 0
  installFetch((entry) => {
    if (entry.url === BASE + '/login') {
      if (entry.init.body === LOGIN_BODY) return okLogin()
      return jsonResponse(401, { ok: false, msg: '账号或密码错误' })
    }
    // chat:第一次 401,第二次 200
    chatAttempts += 1
    if (chatAttempts === 1) return jsonResponse(401, { ok: false, msg: '密钥错误,请重新登录' })
    return sseResponse([{ choices: [{ index: 0, delta: { content: '重试成功' }, finish_reason: null }] }])
  })
  const tokens = new TokenStore(CONFIG)
  const adapter = new TotonAiAdapter(CONFIG, tokens)
  const chunks = await collect(adapter, {
    provider: 'totonai',
    model: 'openai/gpt-5.4',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  assert.equal(chatAttempts, 2, '401 后应重试一次')
  const textEnd = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(textEnd.block.text, '重试成功')
  assert.ok(fetchCalls.some((c) => c.url === BASE + '/login'), '应触发重新登录')
  console.log('PASS 4: 401 自动重登重试')
}

// ---------- 5. 充值工具定义与真实收款链路 ----------
{
  resetFetch()
  installFetch((entry) => {
    if (entry.url === BASE + '/api/package_config') {
      return jsonResponse(200, {
        ok: true,
        packages: {
          pro: { display_name: 'Plus', month_price: 77, year_price: 847, token_quota: 40_000_000 },
        },
        topups: {
          topup_10: { display_name: '加油包 500万 token', price: 10, tokens: 5_000_000 },
        },
        topup_valid_days: 90,
        free_trial: 300_000,
      })
    }
    if (entry.url === BASE + '/api/user_info') {
      return jsonResponse(200, {
        ok: true,
        username: 'demo',
        level: 'free',
        token_quota: 0,
        used_token: 0,
        quota_total: 0,
        quota_remaining: 0,
        bonus_token: 0,
        bonus_used: 0,
        bonus_expire_ts: 0,
      })
    }
    if (entry.url === BASE + '/api/pay/manual_notify') {
      return jsonResponse(200, { ok: true, msg: '已记录,请等待管理员开通' })
    }
    if (entry.url === BASE + '/register') {
      return jsonResponse(200, { ok: true, msg: '注册成功,请登录' })
    }
    return jsonResponse(404, { ok: false, msg: 'unexpected ' + entry.url })
  })
  const tokens = new TokenStore(CONFIG)
  tokens.token = 'token-abc'
  tokens.tokenUser = 'demo'
  tokens.expiresAt = Date.now() + 60_000
  const tools = createPayTools({ baseURL: BASE, requestTimeoutMs: 60_000, tokenStore: tokens })
  assert.equal(tools.length, 5)
  const [register, recharge, topup, payClaim, payStatus] = tools

  // 5.0 对话内注册:调站点 /register,不需要打开网页
  assert.equal(register.name, 'totonai_register')
  assert.deepEqual(register.parameters.required, ['username', 'password'])
  const reg = await register.execute({ username: 'newbie_01', password: '123456' })
  assert.equal(reg.ok, true)
  const regCall = fetchCalls.find((c) => c.url === BASE + '/register')
  assert.ok(regCall, '应调用站点注册接口')
  assert.equal(JSON.parse(regCall.init.body).username, 'newbie_01')

  // 5.1 工具定义
  assert.equal(recharge.name, 'totonai_recharge')
  assert.equal(recharge.parameters.type, 'object')
  assert.equal(recharge.parameters.properties.level.enum.join(','), 'entry,pro,ultimate')
  assert.equal(recharge.parameters.properties.period.enum.join(','), 'month,year')
  assert.deepEqual(recharge.parameters.required, ['level', 'period'])
  assert.equal(payClaim.name, 'totonai_pay_claim')
  assert.deepEqual(payClaim.parameters.required, ['out_trade_no', 'level', 'period', 'amount'])
  assert.equal(payStatus.name, 'totonai_pay_status')

  // 5.2 下单:价格从 /api/package_config 实时读取,给出收款码链接,且绝不调用码支付接口
  const order = await recharge.execute({ level: 'pro', period: 'month' })
  assert.equal(order.ok, true)
  assert.equal(order.amount, 77)
  assert.equal(order.display_name, 'Plus')
  assert.equal(order.qr_url, BASE + '/qrcode/wechat')
  assert.equal(order.username, 'demo')
  assert.ok(order.out_trade_no.startsWith('TT'), '应生成站点订单号')
  assert.ok(
    !fetchCalls.some((c) => c.url.includes('/api/pay/create')),
    '个人收款码模式下不得调用码支付 /api/pay/create',
  )

  // 5.2b 加油包:只加额度、不改权限,价格与 token 数实时读取站点
  assert.equal(topup.name, 'totonai_topup')
  assert.deepEqual(topup.parameters.required, ['pack'])
  assert.equal(topup.parameters.properties.pack.enum.join(','), 'topup_10,topup_30,topup_50,topup_100')
  const topupOrder = await topup.execute({ pack: 'topup_10' })
  assert.equal(topupOrder.ok, true)
  assert.equal(topupOrder.amount, 10)
  assert.equal(topupOrder.tokens, 5_000_000)
  assert.equal(topupOrder.level, 'topup_10')
  assert.equal(topupOrder.qr_url, BASE + '/qrcode/wechat')
  assert.equal(topupOrder.username, 'demo')

  // 5.3 申报:走现有 /api/pay/manual_notify,带 Bearer 令牌与订单号
  const claim = await payClaim.execute({
    out_trade_no: order.out_trade_no,
    level: 'pro',
    period: 'month',
    amount: 77,
    pay_type: 'wechat',
  })
  assert.equal(claim.ok, true)
  const notifyCall = fetchCalls.find((c) => c.url === BASE + '/api/pay/manual_notify')
  assert.ok(notifyCall, '应调用人工充值申报接口')
  assert.equal(notifyCall.init.headers.authorization, 'Bearer token-abc')
  const notifyBody = JSON.parse(notifyCall.init.body)
  assert.equal(notifyBody.out_trade_no, order.out_trade_no)
  assert.equal(notifyBody.amount, 77)
  assert.equal(notifyBody.pay_type, 'wechat')

  // 5.4 查状态:读 /api/user_info,free 档判为未开通
  const status = await payStatus.execute({})
  assert.equal(status.ok, true)
  assert.equal(status.active, false)
  assert.equal(status.username, 'demo')
  console.log('PASS 5: 充值工具定义与真实收款链路(实时价格/收款码/申报/查状态)')
}

// ---------- 6. 设置页面板动作(登录/注册/报价/状态/申报/退出) ----------
{
  resetFetch()
  let saved = null
  let loggedOut = false
  installFetch((entry) => {
    if (entry.url === BASE + '/login') {
      if (entry.init.body === LOGIN_BODY) return okLogin()
      return jsonResponse(401, { ok: false, msg: '账号或密码错误' })
    }
    if (entry.url === BASE + '/register') {
      return jsonResponse(200, { ok: true, msg: '注册成功,请登录' })
    }
    if (entry.url === BASE + '/api/user_info') {
      return jsonResponse(200, { ok: true, username: 'demo', level: 'free', token_quota: 0, used_token: 0 })
    }
    if (entry.url === BASE + '/api/package_config') {
      return jsonResponse(200, {
        ok: true,
        packages: { pro: { display_name: 'Plus', month_price: 77, year_price: 847, token_quota: 25_000_000 } },
      })
    }
    if (entry.url === BASE + '/api/pay/manual_notify') {
      return jsonResponse(200, { ok: true, msg: '已记录,请等待管理员开通' })
    }
    return jsonResponse(404, { ok: false, msg: 'unexpected ' + entry.url })
  })
  const { handlePanelAction } = await import('../lib/panel.js')
  // 用空凭据的 TokenStore 模拟"刚装插件、还没登录"的状态
  const tokens = new TokenStore({ baseURL: BASE, username: '', password: '', requestTimeout: 60 })
  const deps = {
    baseURL: BASE,
    requestTimeoutMs: 60_000,
    tokenStore: tokens,
    onCredentials(username, password) {
      saved = { username, password }
      tokens.setCredentials(username, password)
    },
    onLogout() {
      loggedOut = true
      tokens.setCredentials('', '')
    },
  }

  // 6.1 未登录:status 直接返回 loggedIn=false,不触发任何站点请求
  const s0 = await handlePanelAction(deps, { action: 'status' })
  assert.equal(s0.ok, true)
  assert.equal(s0.loggedIn, false)
  assert.equal(fetchCalls.length, 0)

  // 6.2 登录成功:写回凭据
  const login = await handlePanelAction(deps, { action: 'login', username: 'demo', password: 'demo-pass' })
  assert.equal(login.ok, true)
  assert.equal(saved.username, 'demo')

  // 6.3 登录态 status:读 /api/user_info
  const status = await handlePanelAction(deps, { action: 'status' })
  assert.equal(status.ok, true)
  assert.equal(status.loggedIn, true)
  assert.equal(status.username, 'demo')
  assert.equal(status.active, false)
  assert.ok(status.qr.wechat.endsWith('/qrcode/wechat'))

  // 6.4 报价:透传站点 packages
  const quote = await handlePanelAction(deps, { action: 'quote' })
  assert.equal(quote.ok, true)
  assert.equal(quote.packages.pro.month_price, 77)

  // 6.5 我已付款:带 Bearer 令牌提交申报
  const claim = await handlePanelAction(deps, {
    action: 'claim',
    level: 'pro',
    period: 'month',
    amount: 77,
    pay_type: 'wechat',
    out_trade_no: 'TTDEMO',
  })
  assert.equal(claim.ok, true)
  const notifyCall = fetchCalls.filter((c) => c.url === BASE + '/api/pay/manual_notify').pop()
  assert.equal(notifyCall.init.headers.authorization, 'Bearer token-abc')
  assert.equal(JSON.parse(notifyCall.init.body).out_trade_no, 'TTDEMO')

  // 6.6 注册并自动登录;6.7 退出登录
  const reg = await handlePanelAction(deps, { action: 'register', username: 'newbie_01', password: '123456' })
  assert.equal(reg.ok, false, '模拟接口未返回 token 时注册应报错而不是假装成功')
  const out = await handlePanelAction(deps, { action: 'logout' })
  assert.equal(out.ok, true)
  assert.equal(loggedOut, true)
  console.log('PASS 6: 设置页面板动作(登录/状态/报价/申报/退出)')
}

globalThis.fetch = originalFetch
console.log('\nALL SMOKE TESTS PASSED')
