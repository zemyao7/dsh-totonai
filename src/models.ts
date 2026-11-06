import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'

/**
 * ToTonAI 中转站模型目录。
 *
 * 与后端 proxy.py 的 ALL_MODEL_LIST 保持一致的模型 id,请求时原样透传给中转站。
 * 过滤掉了生图模型(gpt-image-* / *-image 等):DSH 的对话流不承载生图,
 * 生图请继续在 ToTonAI 网页使用。
 *
 * 如站点模型有增减,同步改这里即可。
 */
const TEXT_MODEL_IDS = [
  // OpenAI
  'openai/gpt-6.1-sol',
  'openai/gpt-6-sol',
  'openai/gpt-6-luna',
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'openai/gpt-5.4-pro',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.3-codex',
  'openai/gpt-5.2-codex',
  'openai/gpt-5.2-chat',
  'openai/gpt-5.2',
  'openai/gpt-5-pro',
  'openai/gpt-5-nano',
  'openai/gpt-5-mini',
  'openai/gpt-5',
  'gpt-oss-120b',
  // Anthropic
  'anthropic/claude-opus-5.5',
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-opus-5',
  'anthropic/claude-sonnet-5',
  'anthropic/claude-fable-5',
  'anthropic/claude-4.8-opus',
  'anthropic/claude-4.7-opus',
  'claude-4.6-opus',
  'claude-4.6-sonnet',
  'claude-4.5-opus',
  'claude-4.5-sonnet',
  'claude-4.5-haiku',
  // Google Gemini
  'google/gemini-4-argon',
  'google/gemini-3.7-flash',
  'google/gemini-3.6-flash',
  'google/gemini-3.5-flash',
  'google/gemini-3.5-flash-lite',
  'google/gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3.0-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  // DeepSeek
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash-20260731',
  'deepseek/deepseek-v4-pro-0813',
  'deepseek/deepseek-v3.2-251201',
  // Bytedance
  'bytedance/doubao-seed-2-1-pro',
  'bytedance/doubao-seed-2-1-turbo',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-mini',
  'doubao-seed-2.0-lite',
  'doubao-seed-2.0-code',
  'doubao-1.5-pro-32k',
  // X-AI Grok
  'x-ai/grok-4.7',
  'x-ai/grok-4.6',
  'x-ai/grok-4.5',
  'x-ai/grok-4.3',
  'x-ai/grok-4.2-reasoning',
  'x-ai/grok-4.2-non-reasoning',
  'x-ai/grok-4.2-fast-reasoning',
  'x-ai/grok-4.2-fast-non-reasoning',
  'x-ai/grok-4.1-fast',
  'x-ai/grok-4.1-fast-reasoning',
  'x-ai/grok-4.1-fast-non-reasoning',
  'x-ai/grok-code-fast-1',
  // Z-AI GLM
  'z-ai/glm-5.3',
  'z-ai/glm-5.2',
  'z-ai/glm-5.1',
  'z-ai/glm-5',
]

/** 提供给 DSH 的模型目录(provider 路由固定为 totonai) */
export const TOTONAI_MODELS: LlmModelInfo[] = TEXT_MODEL_IDS.map((id) => ({
  provider: 'totonai',
  id,
  name: id,
}))

/** 默认上下文窗口与默认输出上限(DSH 上下文预算用;以站点实际为准) */
export const DEFAULT_CONTEXT_WINDOW = 200_000
export const DEFAULT_MAX_TOKENS = 8_192
