// 给 dsh-repo/lib/index.js(esbuild 单文件包)打同一个来源校验补丁
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'C:\\AI\\dsh-plugin\\dsh-repo\\lib\\index.js'
const raw = readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

// 1) 在 sameOrigin 之前插入辅助函数 + 替换实现
const start = lines.findIndex((l) => l.startsWith('function sameOrigin(req)'))
if (start < 0) throw new Error('找不到 sameOrigin')

let end = start + 1
while (end < lines.length && lines[end] !== '}') end++

const IMPL = [
  '/** 取 authority 的主机名:保留 IPv6 方括号,丢掉端口 */',
  'function hostnameOf(authority) {',
  '  const lower = String(authority).toLowerCase();',
  "  if (lower.startsWith('[')) {",
  "    const end = lower.indexOf(']');",
  '    return end > 0 ? lower.slice(0, end + 1) : lower;',
  '  }',
  "  const colon = lower.indexOf(':');",
  '  return colon >= 0 ? lower.slice(0, colon) : lower;',
  '}',
  '/** 取 authority 的端口:没写端口返回空串 */',
  'function portOf(authority) {',
  '  const lower = String(authority).toLowerCase();',
  "  if (lower.startsWith('[')) {",
  "    const end = lower.indexOf(']');",
  "    const rest = end > 0 ? lower.slice(end + 1) : '';",
  "    return rest.startsWith(':') ? rest.slice(1) : '';",
  '  }',
  "  const colon = lower.indexOf(':');",
  '  return colon >= 0 ? lower.slice(colon + 1) : \'\';',
  '}',
  'function isLoopbackName(name) {',
  '  const n = String(name).toLowerCase();',
  "  return n === '127.0.0.1' || n === 'localhost' || n === '[::1]';",
  '}',
  '/** 403 时把参与校验的头写进提示与日志 */',
  'function originDetail(req) {',
  '  const headers = (req && req.headers) || {};',
  "  const origin = String(headers.origin || '(无)') || '(空)';",
  "  const host = String(headers.host || '(无)') || '(空)';",
  "  const xfh = String(headers['x-forwarded-host'] || '');",
  "  return xfh ? 'Origin=' + origin + ' Host=' + host + ' X-Forwarded-Host=' + xfh : 'Origin=' + origin + ' Host=' + host;",
  '}',
  '/** 只接受同源调用,规则对齐 DSH 核心 fence 与 dshmarket */',
  'function sameOrigin(req) {',
  '  const headers = (req && req.headers) || {};',
  "  if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false;",
  '  const rawOrigin = headers.origin;',
  '  if (rawOrigin === undefined || rawOrigin === null) return true;',
  '  const origin = String(rawOrigin);',
  "  if (!origin || origin === 'null') return false;",
  '  let u;',
  '  try {',
  '    u = new URL(origin);',
  '  } catch {',
  '    return false;',
  '  }',
  "  const host = String(headers.host || hostOf(req) || '');",
  '  if (!host) return true;',
  '  if (u.host === host) return true;',
  "  const forwarded = String(headers['x-forwarded-host'] || '').toLowerCase();",
  '  if (forwarded && u.host === forwarded) return true;',
  '  if (isLoopbackName(hostnameOf(host)) && isLoopbackName(u.hostname)) {',
  "    if (u.port === '') return true;",
  '    return portOf(host) === u.port;',
  '  }',
  '  return false;',
  '}',
]

lines.splice(start, end - start + 1, ...IMPL)

// 2) 换掉 403 那一行(单行 if,没有花括号)
const gateIdx = lines.findIndex((l) => l.includes('!sameOrigin(req)'))
if (gateIdx < 0) throw new Error('找不到 403 分支')
lines[gateIdx] =
  '            if (!sameOrigin(req)) {' +
  eol +
  '              console.warn("[totonai] 来源校验失败", originDetail(req));' +
  eol +
  "              return writeJson(res, 403, fail(`来源校验失败:${originDetail(req)}。若 DSH 是经反向代理/隧道访问的,请让代理保留原始 Host 并转发 X-Forwarded-Host;本机访问请升级到 0.1.17 修复 Chrome 省略回环端口的误判`, \"ORIGIN\"));" +
  eol +
  '            }'

writeFileSync(file, lines.join(eol), 'utf8')
console.log('lib/index.js: 已打补丁')
