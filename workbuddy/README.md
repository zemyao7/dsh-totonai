# ToTonAI 接入 WorkBuddy（Windows）

把 ToTonAI 中转站的模型接进 WorkBuddy。**不用点「添加模型」、不用手填 JSON、不用改配置文件路径**，双击一次搞定。

- 站点：https://www.toton.pro
- 这个目录只服务 WorkBuddy；仓库里其它目录是 DSH 插件，两者互不影响。

---

## 用法（3 步）

**第 1 步：拿 Key**

登录 https://www.toton.pro ，点头像 → 「我的 API Key」 → 点 **复制**。

> 想一步到位：用网页上那个「下载 WorkBuddy 接入包」，那个包已经把 Key 写进去了，下载后双击直接生效，本页第 1 步可以跳过。

**第 2 步：跑脚本**

下载本目录里的 `ToTonAI-WorkBuddy.cmd`，双击运行。

- 脚本会**自动从剪贴板读 Key**（上一步如果点了复制，这里什么都不用做）；没读到就提示你把 Key 粘进去回车。
- 若弹出「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」。
- 黑窗口跑到出现 `成功：已写入 ...\models.json` 就成功了，按任意键关闭。

**第 3 步：在 WorkBuddy 里选模型**

打开 WorkBuddy → 设置 → 模型。列表里已经出现全部 ToTonAI 模型（不用点添加模型、不用填 Key），选一个（名字形如 `openai/gpt-6-luna`）直接对话。

---

## 它会改什么

只改 `%USERPROFILE%\.workbuddy\models.json`：

- 改之前自动备份成 `models.json.bak-toton-<时间戳>`；
- 只覆盖 `url` 里含 `toton.pro` 的条目，**你原有的其它自定义模型不会丢**；
- 写入的条目格式：`vendor: "Custom"`、`url: https://www.toton.pro/v1/chat/completions`、`apiKey`、`supportsToolCall: true`。

## 排障

| 现象 | 原因 / 处理 |
| --- | --- |
| 提示「拉不到模型清单」 | 本机 VPN / 代理拦了。关掉代理，或在代理里把 `www.toton.pro` 设为直连，再双击一次。脚本会自动重试 3 次。 |
| 提示「Key 已失效(401)」 | 回站点重新复制 Key，或改用网页上的含 Key 接入包。 |
| 某个模型发消息一直转圈 / 报错 | 上游那一刻资源繁忙（502），换一个模型再试即可。 |
| 选完模型对话仍 10~16 秒「已取消」 | models.json 里的条目格式被旧脚本写坏了，重新跑一次本脚本即可修复。 |
| 中文乱码 | 用 PowerShell 5.1 及以上；脚本本身以 UTF-8 传入，正常不会乱码。 |

## 没有 Windows curl 怎么办

脚本优先用 `C:\Windows\System32\curl.exe`（Win10 1803+ 自带），没有则自动回落到 PowerShell 的 `Invoke-RestMethod`。

## 更新日志

- 2026-11-08：改成单文件自包含（脚本编码进 `.cmd`），压缩包预览里直接双击也能跑；新增失败自动重试与 401 单独提示。
