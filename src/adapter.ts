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
import { ApiError } from './api.js'
import type { TotonAiConfig } from './config.js'
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, TOTONAI_MODELS } from './models.js'
import type { TokenStore } from './token.js'

/** 中转站 Chat Completions 端点(OpenAI 兼容) */
const CHAT_PATH = '/v1/chat/completions'

/**
 * ToTonAI 中转站适配器。
 *
 * 请求映射:DSH 的对话消息 → OpenAI Chat Completions 流式请求;
 * 响应映射:SSE 事件流 → DSH 的 StreamChunk 块协议。
 * 鉴权统一使用 /login 换取的 Bearer 令牌,401 时自动重登重试一次。
 */
export class TotonAiAdapter extends LlmAdapter {
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
    return TOTONAI_MODELS
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
      throw new LlmError(`ToTonAI 请求失败(${res.status}): ${detail}`, 'BAD_GATEWAY', { status: res.status })
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
      throw new LlmError(`ToTonAI 流式响应中断: ${e instanceof Error ? e.message : String(e)}`, 'STREAM_ERROR')
    } finally {
      try {
        reader.releaseLock()
      } catch {
        /* 已释放则忽略 */
      }
    }

    // 收尾:关闭所有未结束的输出块
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
