/* global window, document, fetch, navigator */
// plugin/client: DSH 设置页 → ToTonAI 分区(登录/注册、会员状态、充值二维码、我已付款)
// 手写单文件 bundle,无构建链,由 dsh web 客户端的 ModuleLoader 注入。
// 硬约束:任何异常只 console.warn,界面挂掉也不能影响 dsh 设置页本身。
window.__ModuleLoader__.load({
  id: 'dsh-totonai',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const useState = React.useState
    const useEffect = React.useEffect
    const h = React.createElement

    const isZh = () => {
      const l = (document.documentElement.lang || navigator.language || 'zh').toLowerCase()
      return l.startsWith('zh')
    }
    const L = (zh, en) => (isZh() ? zh : en)

    async function call(action, payload) {
      const r = await fetch('/api-totonai/panel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
      })
      const j = await r.json().catch(() => ({ ok: false, msg: '接口返回异常' }))
      return j && typeof j === 'object' ? j : { ok: false, msg: '接口返回异常' }
    }

    const C = {
      text: 'var(--dsw-alias-label-primary, inherit)',
      sub: 'var(--dsw-alias-label-secondary, #888)',
      faint: 'var(--dsw-alias-label-tertiary, #999)',
      border: 'var(--dsw-alias-border-l3, rgba(127,127,127,.25))',
      layer: 'var(--dsw-alias-bg-layer-1, transparent)',
      ok: 'var(--dsw-alias-state-success-primary, #1a7f37)',
      warn: 'var(--dsw-alias-state-warn-primary, #b7791f)',
      err: 'var(--dsw-alias-state-error-primary, #cf222e)',
    }
    const S = {
      wrap: { margin: '0 0 28px', maxWidth: 720 },
      h: { fontSize: 15, fontWeight: 600, margin: '0 0 4px', color: C.text },
      note: { fontSize: 12, color: C.sub, margin: '0 0 14px', lineHeight: 1.6 },
      card: { border: '1px solid ' + C.border, borderRadius: 10, background: C.layer, padding: '14px 16px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      label: { fontSize: 12, color: C.sub, marginBottom: 4, display: 'block' },
      input: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid ' + C.border, background: 'transparent', color: C.text, outline: 'none' },
      btn: { padding: '8px 14px', fontSize: 13, borderRadius: 8, border: '1px solid ' + C.border, background: 'transparent', color: C.text, cursor: 'pointer' },
      btnPrimary: { padding: '8px 14px', fontSize: 13, borderRadius: 8, border: '1px solid ' + C.text, background: C.text, color: 'var(--dsw-alias-bg-base, #fff)', cursor: 'pointer' },
      qr: { display: 'block', width: 176, height: 176, margin: '12px auto', objectFit: 'contain', borderRadius: 8 },
      kv: { fontSize: 12, color: C.sub, lineHeight: 1.9 },
    }

    function tok(n) {
      const v = Number(n || 0)
      if (v >= 10000) return (v / 10000).toFixed(0) + ' 万'
      return String(v)
    }

    function Notice(props) {
      if (!props.text) return null
      const color = props.kind === 'error' ? C.err : props.kind === 'ok' ? C.ok : C.warn
      return h('div', { style: { fontSize: 12, lineHeight: 1.6, marginTop: 8, color: color } }, props.text)
    }

    function AuthForm(props) {
      const tabState = useState('login')
      const tab = tabState[0]
      const setTab = tabState[1]
      const uState = useState('')
      const username = uState[0]
      const setUsername = uState[1]
      const pState = useState('')
      const password = pState[0]
      const setPassword = pState[1]
      const bState = useState(false)
      const busy = bState[0]
      const setBusy = bState[1]
      const eState = useState('')
      const err = eState[0]
      const setErr = eState[1]

      const submit = async () => {
        if (busy) return
        setErr('')
        setBusy(true)
        try {
          const r = await call(tab, { username: String(username).trim(), password: password })
          if (!r.ok) {
            setErr(r.msg || L('操作失败', 'Failed'))
            return
          }
          props.onDone(r)
        } catch (e) {
          setErr(String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: S.card }, [
        h('div', { key: 'tabs', style: S.row }, [
          h('button', { key: 'a', type: 'button', style: tab === 'login' ? S.btnPrimary : S.btn, onClick: () => setTab('login') }, L('登录', 'Sign in')),
          h('button', { key: 'b', type: 'button', style: tab === 'register' ? S.btnPrimary : S.btn, onClick: () => setTab('register') }, L('注册新账号', 'Create account')),
        ]),
        h('div', { key: 'u', style: { marginTop: 12 } }, [
          h('label', { key: 'l', style: S.label }, L('ToTonAI 账号', 'ToTonAI account')),
          h('input', { key: 'i', style: S.input, value: username, placeholder: L('3-32 位字母/数字/下划线', '3-32 letters/digits'), onChange: (e) => setUsername(e.target.value), autoComplete: 'username' }),
        ]),
        h('div', { key: 'p', style: { marginTop: 10 } }, [
          h('label', { key: 'l', style: S.label }, L('密码', 'Password')),
          h('input', { key: 'i', style: S.input, type: 'password', value: password, placeholder: L('至少 6 位', 'min 6 characters'), onChange: (e) => setPassword(e.target.value), autoComplete: 'current-password' }),
        ]),
        h('div', { key: 'act', style: { marginTop: 14 } }, [
          h('button', { key: 's', type: 'button', style: busy ? Object.assign({}, S.btnPrimary, { opacity: 0.6 }) : S.btnPrimary, disabled: busy, onClick: submit }, busy ? L('处理中…', 'Working…') : tab === 'login' ? L('登录', 'Sign in') : L('注册并登录', 'Create & sign in')),
        ]),
        h(Notice, { key: 'err', text: err, kind: 'error' }),
        h('div', { key: 'tip', style: { fontSize: 12, color: C.faint, marginTop: 10, lineHeight: 1.6 } }, L('账号密码只保存在这台电脑(~/.dsh-totonai/creds.json),不上传、不写进对话。', 'Credentials stay on this machine only (~/.dsh-totonai/creds.json).')),
      ])
    }

    function AccountCard(props) {
      const d = props.data || {}
      const refreshingState = useState(false)
      const refreshing = refreshingState[0]
      const setRefreshing = refreshingState[1]
      return h('div', { style: S.card }, [
        h('div', { key: 'hd', style: S.row }, [
          h('div', { key: 'u', style: { fontSize: 13, fontWeight: 600, color: C.text } }, d.username || ''),
          h('div', { key: 'lv', style: { fontSize: 12, padding: '2px 8px', borderRadius: 999, border: '1px solid ' + C.border, color: d.active ? C.ok : C.warn } }, d.active ? d.displayName || d.level : L('未开通', 'Inactive')),
        ]),
        d.active
          ? h('div', { key: 'kv', style: Object.assign({}, S.kv, { marginTop: 8 }) }, [
              h('div', { key: 'a' }, L('总额度 ', 'Quota ') + tok(d.tokenQuota) + ' token'),
              h('div', { key: 'b' }, L('已用 ', 'Used ') + tok(d.usedToken) + ' token · ' + L('剩余 ', 'Left ') + tok(d.remainToken) + ' token'),
            ])
          : h('div', { key: 'kv', style: Object.assign({}, S.kv, { marginTop: 8 }) }, L('当前是免费档,充值后即可调用模型。', 'Free tier: recharge to unlock models.')),
        h('div', { key: 'act', style: { marginTop: 10, display: 'flex', gap: 8 } }, [
          h('button', { key: 'r', type: 'button', style: S.btn, disabled: refreshing, onClick: async () => { setRefreshing(true); try { await props.onRefresh() } finally { setRefreshing(false) } } }, refreshing ? L('刷新中…', 'Refreshing…') : L('刷新状态', 'Refresh')),
          h('button', { key: 'o', type: 'button', style: S.btn, onClick: props.onLogout }, L('退出登录', 'Sign out')),
        ]),
      ])
    }

    function RechargeCard(props) {
      const data = props.data || {}
      const packages = props.quote || {}
      const pickState = useState({ level: 'pro', period: 'month', pay_type: 'wechat' })
      const pick = pickState[0]
      const setPick = pickState[1]
      const orderState = useState(null)
      const order = orderState[0]
      const setOrder = orderState[1]
      const claimState = useState({ busy: false, msg: '', kind: 'warn' })
      const claim = claimState[0]
      const setClaim = claimState[1]

      const levels = ['entry', 'pro', 'ultimate']
      const cur = packages[pick.level] || {}
      const amount = pick.period === 'year' ? Number(cur.year_price || 0) : Number(cur.month_price || 0)
      const qrUrl = (data.baseURL || '') + '/qrcode/' + pick.pay_type

      const start = () => {
        const no = 'TT' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase()
        setOrder({
          out_trade_no: no,
          amount: amount,
          level: pick.level,
          period: pick.period,
          display_name: cur.display_name || pick.level,
          pay_type: pick.pay_type,
        })
        setClaim({ busy: false, msg: '', kind: 'warn' })
      }

      const claimPay = async () => {
        if (!order || claim.busy) return
        setClaim({ busy: true, msg: '', kind: 'warn' })
        try {
          const r = await call('claim', order)
          setClaim({ busy: false, msg: r.ok ? L('已提交核对,等站长开通(一般 5 分钟内)。', 'Submitted. The owner will activate it, usually within 5 minutes.') : r.msg || L('提交失败', 'Failed'), kind: r.ok ? 'ok' : 'error' })
        } catch (e) {
          setClaim({ busy: false, msg: String((e && e.message) || e), kind: 'error' })
        }
      }

      return h('div', { style: S.card }, [
        h('div', { key: 'h', style: { fontSize: 13, fontWeight: 600, marginBottom: 10, color: C.text } }, L('开通 / 续费会员', 'Membership')),
        h('div', { key: 'lv', style: Object.assign({}, S.row, { flexWrap: 'wrap' }) }, levels.map((k) => {
          const p = packages[k] || {}
          const on = pick.level === k
          return h('div', {
            key: k,
            role: 'button',
            tabIndex: 0,
            style: Object.assign({ flex: '1 1 150px', padding: '10px 12px', borderRadius: 10, cursor: 'pointer', border: '1px solid ' + (on ? C.text : C.border), background: on ? 'rgba(127,127,127,.10)' : 'transparent', color: C.text }, {}),
            onClick: () => setPick(Object.assign({}, pick, { level: k })),
          }, [
            h('div', { key: 'n', style: { fontSize: 13, fontWeight: 600 } }, p.display_name || k),
            h('div', { key: 'p', style: { fontSize: 12, color: C.sub, marginTop: 4 } }, '¥' + (p.month_price || 0) + L(' / 月', ' / mo') + ' · ' + tok(p.token_quota) + ' token'),
          ])
        })),
        h('div', { key: 'per', style: Object.assign({}, S.row, { marginTop: 10 }) }, [
          h('button', { key: 'm', type: 'button', style: pick.period === 'month' ? S.btnPrimary : S.btn, onClick: () => setPick(Object.assign({}, pick, { period: 'month' })) }, L('月卡', 'Monthly')),
          h('button', { key: 'y', type: 'button', style: pick.period === 'year' ? S.btnPrimary : S.btn, onClick: () => setPick(Object.assign({}, pick, { period: 'year' })) }, L('年卡', 'Yearly')),
          h('button', { key: 'w', type: 'button', style: pick.pay_type === 'wechat' ? S.btnPrimary : S.btn, onClick: () => setPick(Object.assign({}, pick, { pay_type: 'wechat' })) }, L('微信', 'WeChat')),
          h('button', { key: 'a', type: 'button', style: pick.pay_type === 'alipay' ? S.btnPrimary : S.btn, onClick: () => setPick(Object.assign({}, pick, { pay_type: 'alipay' })) }, L('支付宝', 'Alipay')),
        ]),
        order
          ? h('div', { key: 'ord', style: { marginTop: 12 } }, [
              h('div', { key: 'amt', style: { fontSize: 13, color: C.text } }, L('应付 ', 'Amount ') + '¥' + order.amount + ' · ' + (order.display_name || '') + ' · ' + L('订单号 ', 'Order ') + order.out_trade_no),
              h('img', { key: 'qr', src: qrUrl, alt: L('收款码', 'QR code'), style: S.qr }),
              h('div', { key: 'tip', style: { fontSize: 12, color: C.warn, lineHeight: 1.7 } }, L('付款备注务必填写你的用户名:', 'Put your username in the payment note: ') + (data.username || '')),
              h('div', { key: 'act', style: { marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' } }, [
                h('button', { key: 'c', type: 'button', style: claim.busy ? Object.assign({}, S.btnPrimary, { opacity: 0.6 }) : S.btnPrimary, disabled: claim.busy, onClick: claimPay }, claim.busy ? L('提交中…', 'Submitting…') : L('我已付款', 'I have paid')),
                h('button', { key: 'r', type: 'button', style: S.btn, onClick: props.onRefresh }, L('刷新状态', 'Refresh')),
              ]),
              h(Notice, { key: 'm', text: claim.msg, kind: claim.kind }),
            ])
          : h('div', { key: 'go', style: { marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' } }, [
              h('button', { key: 'b', type: 'button', style: S.btnPrimary, disabled: !(amount > 0), onClick: start }, (L('生成收款码,应付 ', 'Pay ') + '¥' + amount)),
              h('div', { key: 't', style: { fontSize: 12, color: C.faint } }, L('个人收款码,付款后由站长核对开通', 'Manual activation after payment')),
            ]),
        h('div', { key: 'note', style: { fontSize: 12, color: C.faint, marginTop: 12, lineHeight: 1.7 } }, L('价格实时读取站点配置。个人收款码没有自动回调,开通由站长人工确认,这不是故障。', 'Prices come from the site config. Personal QR codes have no callback; activation is manual by design.')),
      ])
    }

    function SettingsSection() {
      const st = useState({ loading: true, loggedIn: false })
      const state = st[0]
      const setState = st[1]
      const q = useState(null)
      const quote = q[0]
      const setQuote = q[1]
      const msgState = useState('')
      const msg = msgState[0]
      const setMsg = msgState[1]

      const loadStatus = async () => {
        setMsg('')
        try {
          const r = await call('status')
          if (!r.ok) {
            setState({ loading: false, loggedIn: false })
            setMsg(r.msg || L('读取状态失败', 'Failed to load'))
            return
          }
          setState(Object.assign({ loading: false }, r))
        } catch (e) {
          setState({ loading: false, loggedIn: false })
          setMsg(String((e && e.message) || e))
        }
      }

      const loadQuote = async () => {
        try {
          const r = await call('quote')
          if (r.ok) setQuote(r.packages || null)
        } catch (e) {
          // 价格读取失败时前端用空表,充值区按钮会禁用
        }
      }

      useEffect(() => {
        void loadStatus()
        void loadQuote()
      }, [])

      if (state.loading) {
        return h('div', { style: S.wrap }, h('div', { style: S.note }, L('加载中…', 'Loading…')))
      }

      const header = [
        h('div', { key: 'h', style: S.h }, 'ToTonAI'),
        h('div', { key: 'n', style: S.note }, L('账号登录、会员状态与充值都在这里完成;模型在会话的模型选择器里使用。', 'Account, membership and recharge all live here. Models are picked in the chat composer.')),
      ]

      if (!state.loggedIn) {
        return h('div', { style: S.wrap }, header.concat([
          h(AuthForm, { key: 'form', onDone: async () => { await loadStatus() } }),
          h(Notice, { key: 'm', text: msg, kind: 'error' }),
        ]))
      }

      return h('div', { style: S.wrap }, header.concat([
        h(AccountCard, { key: 'acct', data: state, onRefresh: loadStatus, onLogout: async () => { await call('logout'); await loadStatus() } }),
        h(RechargeCard, { key: 'pay', data: state, quote: quote, onRefresh: loadStatus }),
        h(Notice, { key: 'm', text: msg, kind: 'error' }),
      ]))
    }

    const name = 'dsh-totonai'
    // 用到 slots 服务必须先声明,否则 ctx.slots 读不到
    const inject = ['slots']
    function apply(ctx) {
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'dsh-totonai', order: 30, label: () => 'ToTonAI' }, SettingsSection),
        )
      } catch (error) {
        console.warn('[totonai] 设置页注册失败', error)
      }
    }

    module.exports = { name, inject, apply }
    return module.exports
  },
})
