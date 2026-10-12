#!/usr/bin/env node
/**
 * 本地 mock 上游，用于在没有真实 API key 时验证中转服务的两条协议路径：
 *   - OpenAI 兼容：GET /v1/models、POST /v1/chat/completions
 *   - Anthropic：  GET /v1/models、POST /v1/messages（含 SSE content_block_delta）
 *
 * 用法：
 *   npm run mock:ai                       # 监听 127.0.0.1:9999
 *   然后在设置页：
 *     协议 = OpenAI 兼容，Base URL = http://127.0.0.1:9999/v1，模型 = mock-openai
 *     或 协议 = Anthropic Claude，Base URL = http://127.0.0.1:9999/v1，模型 = mock-claude
 *
 * 只用于本地开发，不要部署。
 */
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_AI_PORT ?? 9999)

/** 从提示词里取出"目标单词："列表 */
function extractTargets(content) {
  const idx = content.indexOf('目标单词')
  if (idx < 0) return ['example']
  return content
    .slice(idx)
    .split('\n')
    .slice(1)
    .map((line) => line.replace(/^\s*\d+\.\s*/, '').trim())
    .filter((w) => /^[A-Za-z][A-Za-z'\-]*$/.test(w))
}

function buildPassage(targets) {
  const used = targets.slice(0, 6)
  const list = used.map((w, i) => `${i + 1}. ${w}`).join(', ')
  const passage = used
    .map((w) => `Our team will ${w} the plan carefully before we make the final decision.`)
    .join(' ')
  return {
    passage,
    translation: used.map((w) => `我们会仔细${w}这个计划，然后再做最终决定。`).join('\n'),
    collocations: used.slice(0, 3).map((w) => ({
      phrase: `${w} the plan`,
      meaning: `（示例）与「${w}」相关的固定搭配`,
      sentence: `Our team will ${w} the plan carefully before we make the final decision.`,
    })),
    questions: [
      {
        question: `What will the team do before the final decision? (目标词：${list})`,
        options: ['Consider the plan carefully', 'Ignore the plan', 'Delete the plan', 'Postpone forever'],
        answerIndex: 0,
        explanation: '示例解析：段落说的是在最终决定前会仔细处理这个计划。',
      },
      {
        question: '这段文字主要在讲什么？',
        options: ['A decision process', 'A weather report', 'A recipe', 'A sports match'],
        answerIndex: 0,
        explanation: '示例解析：整段围绕"做决定前的准备"展开。',
      },
    ],
  }
}

function resolveContent(body) {
  const userMsg = (body.messages ?? []).find((m) => m.role === 'user')
  const text = userMsg?.content ?? ''
  if (text.includes('回复 OK')) return 'OK'
  return JSON.stringify(buildPassage(extractTargets(text)))
}

function sse(res, chunks, done = '[DONE]') {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const piece of chunks) res.write(`data: ${piece}\n\n`)
  if (done) res.write(`data: ${done}\n\n`)
  res.end()
}

const server = createServer((req, res) => {
  const url = (req.url ?? '/').split('?')[0]

  if (url.endsWith('/health')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'mock-ai' }))
    return
  }

  if (req.method === 'GET' && url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        data: [
          { id: 'mock-openai', display_name: 'Mock OpenAI' },
          { id: 'mock-large', display_name: 'Mock Large' },
          { id: 'mock-claude', display_name: 'Mock Claude' },
        ],
      }),
    )
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }

  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(raw || '{}')
    } catch {
      res.writeHead(400).end('bad json')
      return
    }

    const content = resolveContent(body)

    /* ---------- Anthropic：POST /v1/messages ---------- */
    if (url.endsWith('/messages')) {
      // 校验一下鉴权头，确保中转确实按协议发了 x-api-key
      if (req.headers['x-api-key'] !== 'test-key' && req.headers['x-api-key'] !== 'local-test-key') {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }))
        return
      }
      if (typeof body.max_tokens !== 'number') {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required' } }))
        return
      }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'msg_mock',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: content }],
            model: body.model,
            stop_reason: 'end_turn',
          }),
        )
        return
      }
      // Anthropic 的 SSE：事件名 + data，content_block_delta 才带正文
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock"}}\n\n')
      const piece = 24
      for (let i = 0; i < content.length; i += piece) {
        const delta = JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: content.slice(i, i + piece) } })
        res.write('event: content_block_delta\n')
        res.write(`data: ${delta}\n\n`)
      }
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
      res.end()
      return
    }

    /* ---------- OpenAI 兼容：POST /v1/chat/completions ---------- */
    if (req.headers.authorization !== 'Bearer test-key' && req.headers.authorization !== 'Bearer local-test-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }))
      return
    }
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content } }] }))
      return
    }
    sse(
      res,
      Array.from({ length: Math.ceil(content.length / 24) }, (_, i) =>
        JSON.stringify({ choices: [{ index: 0, delta: { content: content.slice(i * 24, (i + 1) * 24) } }] }),
      ),
    )
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-ai] http://127.0.0.1:${PORT}/v1  （同时模拟 OpenAI 兼容 与 Anthropic 两种协议）`)
})
