#!/usr/bin/env node
/**
 * 下载服务端 TTS 用的 Kokoro 模型（一次性）。
 *
 *   npm run fetch:tts
 *
 * 输出到 models/：
 *   kokoro-v1.0.onnx   ~310 MB   模型权重（thewh1teagle/kokoro-onnx 官方发布，Apache-2.0）
 *   voices-v1.0.bin    ~27 MB    音色嵌入
 *
 * 已存在则跳过，可反复执行。文件很大，不建议放进版本管理。
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'models')
const BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1'

const FILES = [
  { name: 'kokoro-v1.0.onnx', bytes: 325_505_369 },
  { name: 'voices-v1.0.bin', bytes: 28_214_398 },
]

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`

async function download({ name, bytes }) {
  const dest = path.join(OUT, name)
  if (existsSync(dest) && statSync(dest).size === bytes) {
    console.log(`✓ ${name} 已存在（${mb(bytes)}），跳过`)
    return
  }
  console.log(`↓ 下载 ${name}（${mb(bytes)}）…`)
  const res = await fetch(`${BASE}/${name}`, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length') ?? bytes)
  let got = 0
  let lastPct = -1
  const ws = createWriteStream(dest)

  await new Promise((resolve, reject) => {
    res.body.pipeTo(
      new WritableStream({
        write(chunk) {
          got += chunk.byteLength
          ws.write(chunk)
          const pct = Math.floor((got / total) * 10)
          if (pct !== lastPct) {
            lastPct = pct
            process.stdout.write(`\r   ${mb(got)} / ${mb(total)} (${pct * 10}%)`)
          }
        },
        close() {
          ws.end(resolve)
        },
      }),
    ).catch(reject)
    ws.on('error', reject)
  })
  process.stdout.write('\n')

  if (got !== total) throw new Error(`${name}: 下载不完整 ${got}/${total}`)
  console.log(`✓ ${name} 完成（${mb(got)}）`)
}

mkdirSync(OUT, { recursive: true })
for (const f of FILES) {
  await download(f)
}
console.log('\n模型就绪。启动开发服务时 tts-server.py 会自动加载它。')
