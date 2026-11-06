import assert from 'node:assert/strict'

// 模拟 dsh web 客户端的 ModuleLoader,验证 client bundle 能加载并注册设置页分区。
// 不渲染组件(hooks 需要真实 React),只验证协议与注册参数。
const registrations = []

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
}

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      assert.equal(spec.id, 'totonai', 'ModuleLoader id 必须为 totonai')
      const mod = spec.factory((name) => (name === 'react' ? fakeReact : {}))
      assert.equal(mod.name, 'llm-totonai')
      assert.deepEqual(mod.inject, ['slots'])
      assert.equal(typeof mod.apply, 'function')
      const ctx = {
        slots: {
          inject(service, fn) {
            assert.equal(service, 'settings.section')
            fn()
          },
          register(options, component) {
            registrations.push({ options, component })
          },
        },
      }
      mod.apply(ctx)
    },
  },
}
globalThis.document = { documentElement: { lang: 'zh' } }
// Node 22 的 navigator 是只读 getter,只能 defineProperty 覆盖
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
globalThis.fetch = async () => ({ json: async () => ({ ok: true }) })

await import('../client/index.js')

assert.equal(registrations.length, 1, '应当只注册一个设置页分区')
assert.equal(registrations[0].options.name, 'settings.section')
assert.equal(registrations[0].options.id, 'totonai')
assert.equal(registrations[0].options.order, 30)
assert.equal(registrations[0].options.label(), 'ToTonAI')
assert.equal(typeof registrations[0].component, 'function')

console.log('PASS 7: client bundle 加载 + 设置页分区注册(slots 协议)')
