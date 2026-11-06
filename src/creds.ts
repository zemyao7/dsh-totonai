import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 本机凭证文件目录:仅当前用户可读,不进入插件包、不进入对话 */
const CRED_DIR = join(homedir(), '.dsh-totonai')
const CRED_FILE = join(CRED_DIR, 'creds.json')

export interface StoredCreds {
  baseURL?: string
  username: string
  password: string
}

/** 读取面板登录写入的凭证;不存在或损坏时返回 null */
export function loadCreds(): StoredCreds | null {
  try {
    const raw = readFileSync(CRED_FILE, 'utf8')
    const parsed = JSON.parse(raw) as StoredCreds
    if (parsed && typeof parsed.username === 'string' && typeof parsed.password === 'string') {
      return parsed
    }
  } catch {
    // 文件不存在或不可读:静默回退到插件配置
  }
  return null
}

/** 保存凭证(权限 600);Windows 上 chmod 不生效但不报错 */
export function saveCreds(creds: StoredCreds): void {
  mkdirSync(CRED_DIR, { recursive: true })
  writeFileSync(CRED_FILE, JSON.stringify(creds, null, 2), { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(CRED_FILE, 0o600)
  } catch {
    // Windows 不支持该权限位,忽略
  }
}

/** 退出登录:清空凭据但保留文件(下次仍可用插件配置里的账号) */
export function clearCreds(): void {
  try {
    writeFileSync(CRED_FILE, JSON.stringify({ username: '', password: '' }, null, 2), { encoding: 'utf8' })
  } catch {
    // 写不进去不影响退出登录的内存状态
  }
}

export const credPath = CRED_FILE
