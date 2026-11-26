// 从 dsh-repo/lib/index.js 抽出补丁后的校验逻辑，跑同一套矩阵
import { readFileSync } from 'node:fs'

const text = readFileSync('C:\\AI\\dsh-plugin\\dsh-repo\\lib\\index.js', 'utf8')
const start = text.indexOf('/** 取 authority 的主机名')
const end = text.indexOf('function hostOf(req)')
if (start < 0 || end < 0) throw new Error('补丁段落没找到')
const snippet = text.slice(start, end)
const { sameOrigin } = await import('data:text/javascript,' + encodeURIComponent(snippet + '\nexport { sameOrigin };'))

const cases = [
  ['A Chrome151 回环省略端口', { origin: 'http://127.0.0.1', host: '127.0.0.1:57905' }, true],
  ['B 反代 + XFH', { origin: 'https://dsh.example.com', host: '127.0.0.1:57905', 'x-forwarded-host': 'dsh.example.com' }, true],
  ['B2 反代 无 XFH', { origin: 'https://dsh.example.com', host: '127.0.0.1:57905' }, false],
  ['C 反代保留 Host', { origin: 'https://dsh.example.com', host: 'dsh.example.com' }, true],
  ['D Origin 空值', { origin: '', host: '127.0.0.1:57905' }, false],
  ['E Origin null', { origin: 'null', host: '127.0.0.1:57905' }, false],
  ['F localhost/127 同端口', { origin: 'http://localhost:57905', host: '127.0.0.1:57905' }, true],
  ['F2 端口不同', { origin: 'http://localhost:6000', host: '127.0.0.1:57905' }, false],
  ['G 桌面端剥离 Origin/Host', {}, true],
  ['H 同源', { origin: 'http://127.0.0.1:57905', host: '127.0.0.1:57905' }, true],
  ['I 跨站', { origin: 'https://evil.com', host: '127.0.0.1:57905', 'sec-fetch-site': 'cross-site' }, false],
  ['K 公网带端口一致', { origin: 'https://dsh.example.com:8443', host: 'dsh.example.com:8443' }, true],
]

let ok = true
for (const [name, headers, expect] of cases) {
  const got = sameOrigin({ headers })
  const pass = got === expect
  if (!pass) ok = false
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(26)} 期望=${expect} 实际=${got}`)
}
console.log(ok ? '全部通过' : '有失败用例')
