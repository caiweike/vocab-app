/**
 * AI 端口。所有模型请求都走本机 Hono 中转（/api/ai），
 * 因为多数模型服务不允许浏览器跨域直连，同时中转也保证 Key 不出现在前端网络栈之外。
 *
 * 中转会把不同上游协议（OpenAI 兼容 / Anthropic）统一归一化成 OpenAI 形状，
 * 所以下面的解析逻辑只写一份。
 */
import type { AiProtocol } from '@/core/types'

export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 上游协议，默认 openai（OpenAI 兼容） */
  protocol?: AiProtocol
}

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class AiError extends Error {
  kind: 'not-configured' | 'network' | 'server' | 'parse'

  constructor(message: string, kind: 'not-configured' | 'network' | 'server' | 'parse') {
    super(message)
    this.name = 'AiError'
    this.kind = kind
  }
}

/**
 * 配置缺什么，返回具体原因；配置齐全返回 null。
 * 比笼统的"未配置"更有用——尤其是选了 Anthropic 预设后模型名要单独获取这种情况。
 */
export function configIssue(c: AiConfig): string | null {
  if (!c.baseUrl.trim()) return '还没填接口地址 Base URL。'
  if (!c.apiKey.trim()) return '还没填 API Key。'
  if (!c.model.trim()) return '还没选模型名：到设置页点「获取列表」，或手动填写。'
  return null
}

export function isConfigured(c: AiConfig): boolean {
  return configIssue(c) === null
}

/** 非流式调用，要求返回 JSON 对象 */
export async function chatJson<T>(
  cfg: AiConfig,
  messages: AiMessage[],
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<T> {
  const text = await chatRaw(cfg, messages, opts)
  return parseJson<T>(text)
}

/** 流式调用，onDelta 每次收到增量文本 */
export async function chatStream(
  cfg: AiConfig,
  messages: AiMessage[],
  onDelta: (chunk: string) => void,
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!isConfigured(cfg)) {
    throw new AiError(configIssue(cfg) ?? '尚未配置 AI 接口。', 'not-configured')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000)
  let acc = ''
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        protocol: cfg.protocol ?? 'openai',
        temperature: opts.temperature ?? 0.8,
        stream: true,
        messages,
      }),
    })
    if (!res.ok || !res.body) {
      const detail = await safeText(res)
      throw new AiError(`模型服务返回 ${res.status}：${detail}`, 'server')
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const payload = parseSseLine(line)
        if (payload === null) continue
        if (payload === '[DONE]') return acc
        const delta = extractDelta(payload)
        if (delta) {
          acc += delta
          onDelta(delta)
        }
      }
    }
    return acc
  } catch (err) {
    if (err instanceof AiError) throw err
    if ((err as Error).name === 'AbortError') throw new AiError('请求超时，请检查网络或接口配置。', 'network')
    throw new AiError(`无法连接中转服务：${(err as Error).message}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

async function chatRaw(
  cfg: AiConfig,
  messages: AiMessage[],
  opts: { temperature?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!isConfigured(cfg)) {
    throw new AiError(configIssue(cfg) ?? '尚未配置 AI 接口。', 'not-configured')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 60_000)
  try {
    const res = await fetch('/api/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        protocol: cfg.protocol ?? 'openai',
        temperature: opts.temperature ?? 0.7,
        stream: false,
        messages,
      }),
    })
    if (!res.ok) throw new AiError(`模型服务返回 ${res.status}：${await safeText(res)}`, 'server')
    const data = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new AiError('模型返回格式异常（缺少 choices[0].message.content）。', 'parse')
    return content
  } catch (err) {
    if (err instanceof AiError) throw err
    if ((err as Error).name === 'AbortError') throw new AiError('请求超时。', 'network')
    throw new AiError(`无法连接中转服务：${(err as Error).message}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

function parseSseLine(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('data:')) return null
  return trimmed.slice(5).trim()
}

function extractDelta(payload: string): string {
  try {
    const obj = JSON.parse(payload)
    const d = obj?.choices?.[0]?.delta?.content
    return typeof d === 'string' ? d : ''
  } catch {
    return ''
  }
}

/** 模型常在 JSON 外包一层 markdown 代码块，容错解析 */
export function parseJson<T>(text: string): T {
  const stripped = text.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim()
  const start = stripped.search(/[[{]/)
  const candidate = start >= 0 ? stripped.slice(start) : stripped
  try {
    return JSON.parse(candidate) as T
  } catch (e) {
    throw new AiError(`无法解析模型输出为 JSON：${(e as Error).message}`, 'parse')
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text()
    return t.slice(0, 300)
  } catch {
    return '（无响应体）'
  }
}

export interface ModelOption {
  id: string
  label: string
}

/**
 * 拉取上游可用模型列表（经中转，由中转适配不同协议的 /models 接口）。
 * 有些兼容服务没实现该接口，此时会抛错——调用方应提示"可手动填写"。
 */
export async function fetchModels(
  cfg: AiConfig,
  opts: { timeoutMs?: number } = {},
): Promise<ModelOption[]> {
  if (!cfg.baseUrl.trim() || !cfg.apiKey.trim()) {
    throw new AiError('先填好接口地址和 API Key，再获取模型列表。', 'not-configured')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        protocol: cfg.protocol ?? 'openai',
      }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok) {
      throw new AiError(data?.error ?? `模型列表接口返回 ${res.status}`, 'server')
    }
    const list = Array.isArray(data?.models) ? (data.models as ModelOption[]) : []
    if (list.length === 0) throw new AiError('服务返回了空的模型列表。', 'server')
    return list
  } catch (err) {
    if (err instanceof AiError) throw err
    if ((err as Error).name === 'AbortError') throw new AiError('获取模型列表超时。', 'network')
    throw new AiError(`无法获取模型列表：${(err as Error).message}`, 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** 连通性测试：发一个极短请求验证 Base URL / Key / 模型名 */
export async function testConnection(cfg: AiConfig): Promise<{ ok: boolean; message: string }> {
  try {
    const out = await chatRaw(cfg, [{ role: 'user', content: '回复 OK 两个字母即可' }], {
      temperature: 0,
      timeoutMs: 20_000,
    })
    return { ok: true, message: `连接成功，模型响应：${out.slice(0, 60)}` }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}
