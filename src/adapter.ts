import {
  LlmAdapter,
  LlmError,
  ToolCallId,
  attributionHeaders,
  type ContentBlock,
  type FinishReason,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { ApiError, apiJson } from './api.js'
import type { TotonAiConfig } from './config.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, TOTONAI_MODELS } from './models.js'
import type { TokenStore } from './token.js'

/** 中转站 Chat Completions 端点(OpenAI 兼容) */
const CHAT_PATH = '/v1/chat/completions'

/** 档位可用模型集合的缓存时长(毫秒):模型选择器会被反复调用,避免每次都打接口 */
const ACCESS_CACHE_MS = 60_000

/**
 * 带工具调用(tools)时会被上游直接拒绝的模型(实测得到,固定 400)。
 * 这类模型在 DSH / Codex 等带工具的客户端里无法使用,只能在网页端纯聊天场景用。
 */
const TOOLS_UNSUPPORTED_MODEL_IDS = ['openai/gpt-5-mini']

const TOOLS_UNSUPPORTED_NOTE =
  '该模型带工具调用时会被上游拒绝(HTTP 400),在 DSH 这类客户端里无法使用;请到 www.toton.pro 网页端使用,或改用其他模型。'

function markUnsupported(m: LlmModelInfo): LlmModelInfo {
  return { ...m, name: `${m.name} · 仅网页可用`, description: TOOLS_UNSUPPORTED_NOTE }
}

/**
 * ToTonAI 中转站适配器。
 *
 * 请求映射:DSH 的对话消息 → OpenAI Chat Completions 流式请求;
 * 响应映射:SSE 事件流 → DSH 的 StreamChunk 块协议。
 * 鉴权统一使用 /login 换取的 Bearer 令牌,401 时自动重登重试一次。
 */
export class TotonAiAdapter extends LlmAdapter {
  /** 当前账号可用模型集合缓存;ids 为 null 表示不限制(未登录/全放行/接口异常) */
  private accessCache: { user: string; ids: Set<string> | null; at: number } | null = null

  constructor(
    private readonly config: TotonAiConfig,
    private readonly tokens: TokenStore,
  ) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: 'ToTonAI' }
  }

  async listModels(): Promise<LlmModelInfo[]> {
    const allow = await this.allowedModelIds()
    if (!allow) {
      // 未登录或不限制(全放行):不判档位,但"带工具必挂"的模型仍要标出来
      return TOTONAI_MODELS.map((m) =>
        TOOLS_UNSUPPORTED_MODEL_IDS.includes(m.id) ? markUnsupported(m) : m,
      )
    }
    // 全部模型都出现在选择器里(方便用户看到站点能力),无权限的追加「需升级」标记。
    // DSH 的 LlmModelInfo 没有 disabled 字段,无法真置灰,只能用名称标记。
    return TOTONAI_MODELS.map((m) => {
      if (TOOLS_UNSUPPORTED_MODEL_IDS.includes(m.id)) return markUnsupported(m)
      if (allow.has(m.id)) return m
      return {
        ...m,
        name: `${m.name} · 需升级`,
        description: '当前会员档位不含该模型,升级套餐后即可调用。',
      }
    })
  }

  /**
   * 读取当前账号的可用模型集合,只把有权限的模型暴露给 DSH 的模型选择器。
   * 返回 null 表示不限制:未登录、接口异常或账号为 "*" 全放行模式。
   * 结果缓存 60 秒;遇到 403 时缓存会被清空以便立刻刷新。
   */
  private async allowedModelIds(): Promise<Set<string> | null> {
    const user = this.tokens.currentUser
    const now = Date.now()
    if (this.accessCache && this.accessCache.user === user && now - this.accessCache.at < ACCESS_CACHE_MS) {
      return this.accessCache.ids
    }
    let ids: Set<string> | null = null
    try {
      if (this.tokens.hasCredentials) {
        const token = await this.tokens.ensure()
        const info = await apiJson(this.config.baseURL, '/api/user_info', { token, timeoutMs: 15_000 })
        const am = info?.allow_models
        if (Array.isArray(am)) ids = new Set(am.map((x: unknown) => String(x)))
        else if (am === '*') ids = null
      }
    } catch {
      ids = null
    }
    this.accessCache = { user, ids, at: now }
    return ids
  }

  async resolveModel(
    _provider: string,
    model: string,
  ): Promise<LlmResolvedModelInfo> {
    const entry = TOTONAI_MODELS.find((m) => m.id === model)
    if (!entry) {
      throw new LlmError(`未知模型: ${model}`, 'NO_MODEL')
    }
    return {
      ...entry,
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const body = buildRequestBody(options)
    let token = await this.tokens.ensure()
    try {
      for await (const chunk of this.requestStream(options, token, body)) {
        yield chunk
      }
    } catch (e) {
      // 令牌失效:清空缓存重新登录,只重试一次
      if (e instanceof ApiError && e.status === 401) {
        this.tokens.invalidate()
        token = await this.tokens.ensure()
        for await (const chunk of this.requestStream(options, token, body)) {
          yield chunk
        }
        return
      }
      throw e
    }
  }

  private async *requestStream(
    options: GenerateOptions,
    token: string,
    body: Record<string, unknown>,
  ): AsyncGenerator<StreamChunk> {
    const url = this.config.baseURL + CHAT_PATH
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...attributionHeaders(),
    }

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options.signal,
      })
    } catch (e) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      throw new LlmError(`无法连接 ToTonAI 站点: ${e instanceof Error ? e.message : String(e)}`, 'NETWORK')
    }

    if (!res.ok) {
      let detail = ''
      try {
        detail = (await res.text()).slice(0, 400)
      } catch {
        /* 忽略读取失败 */
      }
      if (res.status === 401) throw new ApiError('令牌失效', 401)
      if (res.status === 403) {
        // 档位不含该模型:清掉缓存,下次打开模型选择器就按最新权限重新过滤
        this.accessCache = null
        throw new LlmError(
          `当前档位不包含模型 ${String(body.model ?? '')}:它在模型选择器里标着「需升级」。在 DSH 设置 → ToTonAI 面板升级套餐后即可调用。`,
          'NO_MODEL',
          { status: 403 },
        )
      }
      throw new LlmError(`ToTonAI 请求失败(${res.status}): ${detail}`, 'BAD_GATEWAY', { status: res.status })
    }
    // 上游错误经常被网关以 200 + 普通 JSON(而非 SSE)返回,这里必须识破:
    // 否则前端会拿到一个没有任何 data: 行的流,只显示"已完成"却没有输出。
    const ctype = res.headers.get('content-type') ?? ''
    if (!ctype.includes('event-stream')) {
      let raw = ''
      try {
        raw = (await res.text()).slice(0, 600)
      } catch {
        /* 忽略读取失败 */
      }
      let msg = raw
      try {
        const j = JSON.parse(raw)
        msg = String(j?.error?.message ?? j?.msg ?? raw)
      } catch {
        /* 非 JSON,原样用 */
      }
      throw new LlmError(
        `上游拒绝了这次请求:${msg.slice(0, 300)}。请换一个模型重试,或稍后再试。`,
        'BAD_GATEWAY',
        { status: res.status },
      )
    }
    if (!res.body) {
      throw new LlmError('ToTonAI 返回了空响应体', 'BAD_GATEWAY', { status: res.status })
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let nextBlockIndex = 0
    let textBlock: { index: number; parts: string[] } | null = null
    let reasoningBlock: { index: number; parts: string[] } | null = null
    const toolBlocks = new Map<number, { index: number; id: string; name: string; parts: string[] }>()
    let usage: TokenUsage | undefined
    let finishReason: string | undefined

    try {
      let streamEnded = false
      while (!streamEnded) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const rawLine of lines) {
          const line = rawLine.trim()
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let evt: any
          try {
            evt = JSON.parse(payload)
          } catch {
            continue
          }
          // 网关用 SSE 帧转述上游错误时,直接抛出来,别当成"空回复"吞掉
          if (evt && typeof evt === 'object' && evt.error) {
            const em = evt.error as any
            const text = String(em?.message ?? (typeof em === 'string' ? em : JSON.stringify(em)))
            throw new LlmError(`上游错误: ${text.slice(0, 300)}`, 'BAD_GATEWAY', { status: res.status })
          }
          if (!evt || !Array.isArray(evt.choices) || evt.choices.length === 0) {
            // 部分网关流式末尾会推 usage-only 帧
            if (evt?.usage) usage = mapUsage(evt.usage)
            continue
          }
          const choice = evt.choices[0]
          const delta = choice.delta ?? {}

          // 可见文本
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            if (!textBlock) {
              const index = nextBlockIndex++
              textBlock = { index, parts: [] }
              yield { type: 'block-start', index, blockType: 'text' }
            }
            textBlock.parts.push(delta.content)
            yield { type: 'text-delta', index: textBlock.index, text: delta.content }
          }

          // 推理内容(DeepSeek 等推理模型)
          const reason = delta.reasoning_content
          if (typeof reason === 'string' && reason.length > 0) {
            if (!reasoningBlock) {
              const index = nextBlockIndex++
              reasoningBlock = { index, parts: [] }
              yield { type: 'block-start', index, blockType: 'reasoning' }
            }
            reasoningBlock.parts.push(reason)
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reason }
          }

          // 工具调用
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              if (!tc || typeof tc !== 'object') continue
              const callIndex = typeof tc.index === 'number' ? tc.index : 0
              let entry = toolBlocks.get(callIndex)
              if (!entry) {
                const index = nextBlockIndex++
                entry = { index, id: tc.id ?? '', name: tc.function?.name ?? '', parts: [] }
                toolBlocks.set(callIndex, entry)
                yield { type: 'block-start', index, blockType: 'tool-call' }
              }
              if (typeof tc.id === 'string' && tc.id) entry.id = tc.id
              if (typeof tc.function?.name === 'string' && tc.function.name) entry.name = tc.function.name
              const deltaArgs = tc.function?.arguments ?? ''
              if (typeof deltaArgs === 'string' && deltaArgs.length > 0) {
                entry.parts.push(deltaArgs)
                yield {
                  type: 'tool-call-delta',
                  index: entry.index,
                  id: ToolCallId(entry.id),
                  name: entry.name || undefined,
                  argumentsDelta: deltaArgs,
                }
              }
            }
          }

          // 流末尾 usage
          if (evt.usage) usage = mapUsage(evt.usage)

          // 结束原因
          if (choice.finish_reason) {
            finishReason = choice.finish_reason
            streamEnded = true
            break
          }
        }
      }
    } catch (e) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: '请求已取消', code: 'ABORTED' } } }
        return
      }
      if (e instanceof LlmError) throw e
      throw new LlmError(`ToTonAI 流式响应中断: ${e instanceof Error ? e.message : String(e)}`, 'STREAM_ERROR')
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 已释放则忽略 */
      }
    }

    // 收尾:关闭所有未结束的输出块
    if (!textBlock && !reasoningBlock && toolBlocks.size === 0) {
      throw new LlmError(
        '上游返回了空回复(既没有文字也没有工具调用)。请换一个模型重试,常见原因是该模型在上游渠道异常。',
        'BAD_GATEWAY',
        { status: res.status },
      )
    }
    if (textBlock) {
      yield {
        type: 'block-end',
        index: textBlock.index,
        block: { type: 'text', text: textBlock.parts.join('') },
      }
    }
    if (reasoningBlock) {
      yield {
        type: 'block-end',
        index: reasoningBlock.index,
        block: { type: 'reasoning', text: reasoningBlock.parts.join('') },
      }
    }
    for (const entry of toolBlocks.values()) {
      yield {
        type: 'block-end',
        index: entry.index,
        block: { type: 'tool-call', id: ToolCallId(entry.id), name: entry.name, arguments: entry.parts.join('') },
      }
    }
    if (usage) yield { type: 'usage', usage }
    yield { type: 'finish', reason: mapFinishReason(finishReason) }
  }
}

/** DSH 对话消息 → OpenAI Chat Completions 请求体 */
function buildRequestBody(options: GenerateOptions): Record<string, unknown> {
  const messages: Record<string, unknown>[] = []
  for (const msg of options.messages) {
    if (msg.role === 'system') {
      const text = contentToText(msg.content)
      if (text) messages.push({ role: 'system', content: text })
    } else if (msg.role === 'developer') {
      // developer 消息主要是工具增删标记;文本并入 system,兼容各网关
      const text = contentToText(msg.content)
      if (text) messages.push({ role: 'system', content: text })
    } else if (msg.role === 'user') {
      messages.push({ role: 'user', content: contentToText(msg.content) || '' })
    } else if (msg.role === 'assistant') {
      const text = contentToText(msg.content)
      const toolCalls = msg.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: b.arguments } }))
      const m: Record<string, unknown> = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) m.tool_calls = toolCalls
      messages.push(m)
    } else if (msg.role === 'tool') {
      messages.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: contentToText(msg.content) || '',
      })
    }
  }

  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    // OpenAI 兼容代理仅在 stream_options.include_usage=true 时返回流式 usage。
    // 后端据此用真实 prompt/completion tokens 计费；若无 usage 会退回近似估算。
    stream_options: { include_usage: true },
  }
  if (typeof options.temperature === 'number') body.temperature = options.temperature
  if (typeof options.maxTokens === 'number') body.max_tokens = options.maxTokens
  if (options.stop && options.stop.length > 0) body.stop = options.stop
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    body.tool_choice = 'auto'
  }
  return body
}

/** 内容块 → 纯文本(图片/文件按占位符处理,推理与工具块不回传) */
function contentToText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'image':
        parts.push('[图片]')
        break
      case 'file':
        parts.push('[文件]')
        break
      case 'reasoning':
      case 'tool-call':
      case 'tool-addition':
      case 'tool-removal':
        break
    }
  }
  return parts.join('\n')
}

/** 上游 usage → DSH TokenUsage(按 DSH 约定,缓存命中从输入中扣除) */
function mapUsage(u: any): TokenUsage {
  const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0
  const completionTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0
  const cached = u.prompt_tokens_details?.cached_tokens
  const cacheReadTokens = typeof cached === 'number' && cached > 0 ? cached : undefined
  return {
    inputTokens: Math.max(0, promptTokens - (cacheReadTokens ?? 0)),
    outputTokens: completionTokens,
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
  }
}

/** OpenAI finish_reason → DSH FinishReason */
function mapFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' }
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return { kind: 'stop' }
  }
}
