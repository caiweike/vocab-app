/**
 * 本机 AI 中转服务。
 *
 * 存在的理由：模型服务普遍不允许浏览器跨域直连，所以前端统一打到 /api/ai，
 * 由这里转发到用户配置的上游。
 *
 * 同时它负责**协议归一化**：上游可以是 OpenAI 兼容格式，也可以是 Anthropic Messages 格式，
 * 返回给浏览器的一律是 OpenAI 形状（`choices[0].message.content` / `choices[0].delta.content`），
 * 前端只需要写一套解析。
 *
 * 安全边界：
 * - 只监听 127.0.0.1，不对外网开放
 * - CORS 只放行本机前端端口
 * - 目标地址做 SSRF 校验：仅允许公网地址与本机回环（方便接 ollama 等本地模型），
 *   拒绝私网段 / 云元数据地址 / 链路本地地址，避免恶意页面借道扫描内网
 * - 请求体大小上限 + 转发超时，不跟随重定向，不打印任何密钥
 */
import { serve } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import { stream } from 'hono/streaming'

const PORT = Number(process.env.AI_PROXY_PORT ?? 8787)
const MAX_BODY_BYTES = 64 * 1024
const UPSTREAM_TIMEOUT_MS = 90_000
const MAX_TOKENS_DEFAULT = 4096

const ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
]

type Protocol = 'openai' | 'anthropic'

interface ForwardBody {
  baseUrl?: unknown
  apiKey?: unknown
  model?: unknown
  protocol?: unknown
  messages?: unknown
  temperature?: unknown
  maxTokens?: unknown
  stream?: unknown
}

interface ModelsBody {
  baseUrl?: unknown
  apiKey?: unknown
  protocol?: unknown
}

const app = new Hono()

app.use('*', async (c, next) => {
  const origin = c.req.header('origin')
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    c.header('access-control-allow-origin', origin)
    c.header('vary', 'Origin')
    c.header('access-control-allow-methods', 'POST, OPTIONS')
    c.header('access-control-allow-headers', 'content-type')
  }
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

app.get('/api/health', (c) => c.json({ ok: true, service: 'vocab-ai-proxy' }))

app.post('/api/ai', async (c) => {
  const body = await readJson<ForwardBody>(c)
  if (body === null) return c.json({ error: '请求体不是合法 JSON' }, 400)
  if (!isString(body.baseUrl)) return c.json({ error: '缺少 baseUrl' }, 400)
  if (!isString(body.model)) return c.json({ error: '缺少 model' }, 400)

  const protocol = parseProtocol(body.protocol)
  const model = body.model.trim()
  const apiKey = isString(body.apiKey) ? body.apiKey.trim() : ''
  const messages = normalizeMessages(body.messages)
  if (messages === null) return c.json({ error: 'messages 格式不正确' }, 400)

  const target = safeTargetUrl(body.baseUrl.trim())
  if (!target.ok) return c.json({ error: target.error }, 400)

  const endpoint = protocol === 'anthropic' ? 'messages' : 'chat/completions'
  const url = joinApiUrl(target.url, endpoint)
  const temperature = typeof body.temperature === 'number' ? body.temperature : 0.7
  const wantsStream = body.stream === true

  const upstream = await fetchUpstream(url, protocol, apiKey, () =>
    buildChatBody(protocol, model, messages, temperature, wantsStream, body.maxTokens),
  )
  if (upstream instanceof Error) return c.json({ error: `无法连接目标接口：${upstream.message}` }, 502)
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    return c.json({ error: `上游返回 ${upstream.status}`, detail: detail.slice(0, 500) }, 502)
  }
  if (!upstream.body) return c.json({ error: '上游没有响应体' }, 502)

  // OpenAI 兼容流：上游本来就是 OpenAI 的 SSE，直接透传
  if (wantsStream && protocol === 'openai') return passthrough(upstream.body)

  // Anthropic 流：解析它的事件流，转成 OpenAI 的 delta 再发出去
  if (wantsStream && protocol === 'anthropic') return normalizeAnthropicStream(c, upstream.body)

  const text = await upstream.text()
  if (protocol === 'anthropic') {
    const content = extractAnthropicText(text)
    if (content === null) return c.json({ error: 'Anthropic 响应解析失败', detail: text.slice(0, 500) }, 502)
    return c.json({ choices: [{ message: { role: 'assistant', content } }] })
  }
  c.header('content-type', 'application/json; charset=utf-8')
  return c.body(text)
})

app.post('/api/models', async (c) => {
  const body = await readJson<ModelsBody>(c)
  if (body === null) return c.json({ error: '请求体不是合法 JSON' }, 400)
  if (!isString(body.baseUrl)) return c.json({ error: '缺少 baseUrl' }, 400)

  const protocol = parseProtocol(body.protocol)
  const apiKey = isString(body.apiKey) ? body.apiKey.trim() : ''
  const target = safeTargetUrl(body.baseUrl.trim())
  if (!target.ok) return c.json({ error: target.error }, 400)

  const url = joinApiUrl(target.url, 'models')
  const upstream = await fetch(url, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
    headers: authHeaders(protocol, apiKey),
  }).catch((e: Error) => e)

  if (upstream instanceof Error) return c.json({ error: `无法连接目标接口：${upstream.message}` }, 502)
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '')
    const hint =
      upstream.status === 404
        ? '该服务没有实现 /models 接口，请手动填写模型名'
        : `模型列表接口返回 ${upstream.status}`
    return c.json({ error: hint, detail: detail.slice(0, 300) }, 502)
  }

  let parsed: unknown
  try {
    parsed = await upstream.json()
  } catch {
    return c.json({ error: '模型列表返回的不是 JSON' }, 502)
  }

  const raw = (parsed as { data?: unknown })?.data
  if (!Array.isArray(raw)) return c.json({ error: '模型列表结构无法识别' }, 502)

  const models: { id: string; label: string }[] = []
  const seen = new Set<string>()
  for (const item of raw as Record<string, unknown>[]) {
    const id = typeof item?.id === 'string' ? item.id : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    const label = typeof item?.display_name === 'string' ? item.display_name : id
    models.push({ id, label })
    if (models.length >= 500) break
  }
  return c.json({ models })
})

/* ------------------------------ 工具函数 ------------------------------ */

async function readJson<T>(c: { req: { text(): Promise<string> } }): Promise<T | null> {
  const raw = await c.req.text()
  if (raw.length > MAX_BODY_BYTES) throw new BodyTooLarge()
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

class BodyTooLarge extends Error {}

app.onError((err, c) => {
  if (err instanceof BodyTooLarge) return c.json({ error: '请求体过大' }, 413)
  return c.json({ error: (err as Error).message }, 500)
})

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== ''
}

function parseProtocol(v: unknown): Protocol {
  return v === 'anthropic' ? 'anthropic' : 'openai'
}

function normalizeMessages(v: unknown): { role: string; content: string }[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: { role: string; content: string }[] = []
  for (const m of v as Record<string, unknown>[]) {
    const role = typeof m?.role === 'string' ? m.role : ''
    const content = typeof m?.content === 'string' ? m.content : ''
    if (!role || !content) return null
    out.push({ role, content })
  }
  return out
}

/**
 * 拼接 API 地址。
 * base 已带版本路径（`/v1`、`/v4`…）就直接拼，否则补 `/v1`：
 *   https://api.openai.com          + chat/completions → /v1/chat/completions
 *   https://api.deepseek.com/v1     + chat/completions → /v1/chat/completions
 *   https://api.anthropic.com       + messages         → /v1/messages
 *   http://127.0.0.1:11434/v1       + chat/completions → /v1/chat/completions
 */
function joinApiUrl(base: string, endpoint: string): string {
  const b = base.replace(/\/+$/, '')
  const ep = endpoint.replace(/^\//, '')
  return /\/v\d+(?:$|[/?#])/.test(b) ? `${b}/${ep}` : `${b}/v1/${ep}`
}

function authHeaders(protocol: Protocol, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
  return {
    'content-type': 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  }
}

function buildChatBody(
  protocol: Protocol,
  model: string,
  messages: { role: string; content: string }[],
  temperature: number,
  stream: boolean,
  maxTokens: unknown,
): string {
  if (protocol === 'anthropic') {
    // Anthropic 要求 system 单独传，且 messages 里不能出现 system 角色
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')
    const rest = messages.filter((m) => m.role !== 'system')
    const limit = typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : MAX_TOKENS_DEFAULT
    return JSON.stringify({
      model,
      max_tokens: limit,
      ...(system ? { system } : {}),
      messages: rest,
      temperature,
      stream,
    })
  }
  return JSON.stringify({ model, messages, temperature, stream })
}

async function fetchUpstream(
  url: string,
  protocol: Protocol,
  apiKey: string,
  bodyOf: () => string,
): Promise<Response | Error> {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    headers: authHeaders(protocol, apiKey),
    body: bodyOf(),
  }).catch((e: Error) => e)
  return res
}

function passthrough(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  })
}

/** Anthropic 的 SSE → OpenAI 的 `choices[0].delta.content` */
async function normalizeAnthropicStream(c: Context, body: ReadableStream<Uint8Array>): Promise<Response> {
  // hono 的 stream() 第三个参数是 onError 而非 init，响应头得在调用前设
  c.header('content-type', 'text/event-stream; charset=utf-8')
  c.header('cache-control', 'no-cache')
  return stream(c, async (s) => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const payload = t.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          const text = extractAnthropicDelta(payload)
          if (text) {
            await s.write(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
            )
          }
        }
      }
      await s.write('data: [DONE]\n\n')
    } finally {
      reader.releaseLock()
    }
  })
}

interface AnthropicDeltaEvent {
  type?: string
  delta?: { type?: string; text?: unknown }
}

function extractAnthropicDelta(payload: string): string {
  try {
    const obj = JSON.parse(payload) as AnthropicDeltaEvent
    if (obj.type === 'content_block_delta' && obj.delta?.type === 'text_delta') {
      return typeof obj.delta.text === 'string' ? obj.delta.text : ''
    }
    return ''
  } catch {
    return ''
  }
}

function extractAnthropicText(raw: string): string | null {
  try {
    const obj = JSON.parse(raw) as { content?: { type?: string; text?: string }[] }
    if (!Array.isArray(obj.content)) return null
    return obj.content
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
  } catch {
    return null
  }
}

/**
 * SSRF 校验。回环地址放行（本地跑 ollama / llama.cpp 用得到），
 * 其余私网、链路本地、云元数据地址一律拒绝。
 */
function safeTargetUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  if (/[\r\n]/.test(raw)) return { ok: false, error: '接口地址包含非法字符' }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, error: '接口地址不是合法 URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: '接口地址必须是 http 或 https' }
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return { ok: true, url: url.toString() }

  const parts = host.split('.').map(Number)
  const isIpv4 = parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)

  if (isIpv4) {
    const [a, b] = parts
    if (a === 127) return { ok: true, url: url.toString() } // 回环网段
    const blocked: [string, boolean][] = [
      ['私网网段 10.0.0.0/8', a === 10],
      ['私网网段 172.16.0.0/12', a === 172 && b >= 16 && b <= 31],
      ['私网网段 192.168.0.0/16', a === 192 && b === 168],
      ['链路本地 169.254.0.0/16（含云元数据）', a === 169 && b === 254],
      ['运营商级 NAT 100.64.0.0/10', a === 100 && b >= 64 && b <= 127],
      ['0.0.0.0/8', a === 0],
      ['224.0.0.0/4 组播', a >= 224 && a <= 239],
      ['240.0.0.0/4 保留段', a >= 240],
    ]
    for (const [name, hit] of blocked) {
      if (hit) return { ok: false, error: `不允许指向${name}` }
    }
    return { ok: true, url: url.toString() }
  }

  if (host.includes(':')) {
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) {
      return { ok: false, error: '不允许指向 IPv6 私有/链路本地地址' }
    }
    return { ok: true, url: url.toString() }
  }

  if (/\.local$/i.test(host) || /\.internal$/i.test(host) || host === 'metadata.google.internal') {
    return { ok: false, error: '不允许指向内网域名' }
  }
  return { ok: true, url: url.toString() }
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, (info) => {
  console.log(`[ai-proxy] 已启动：http://127.0.0.1:${info.port}/api/ai`)
  console.log(`[ai-proxy] 协议：openai / anthropic（统一归一化为 OpenAI 形状）`)
  console.log(`[ai-proxy] 仅监听本机，CORS 放行：${ALLOWED_ORIGINS.join(', ')}`)
})
