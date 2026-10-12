#!/usr/bin/env node
/** 同时启动 TTS、AI 中转与 Vite 开发服务器，关键进程退出则一起退出 */
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'

const TASKS = [
  // TTS 不是必需的：没装 Python 或没拉模型时前端会回退到浏览器自带语音，
  // 所以它退出不能把整个开发环境一起干掉
  { name: 'tts', cmd: 'python', args: ['scripts/tts-server.py'], fatal: false },
  { name: 'server', cmd: 'node', args: ['--experimental-strip-types', '--no-warnings', 'server/index.ts'] },
  { name: 'web', cmd: 'npm', args: ['run', 'dev'] },
]

const procs = TASKS.map(({ name, cmd, args, fatal = true }) => {
  const p = spawn(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, FORCE_COLOR: '1' },
  })
  p.on('exit', (code) => {
    if (!fatal) {
      console.log(`[${name}] 退出（code=${code}），发音回退到浏览器自带语音`)
      return
    }
    console.log(`[${name}] 退出（code=${code}），停止其余进程`)
    shutdown(code ?? 0)
  })
  return p
})

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const p of procs) killTree(p)
  process.exit(code)
}

/**
 * Windows 上 spawn 是经 cmd.exe 包了一层，直接 p.kill() 只杀 shell，
 * node 子进程会变成孤儿继续占端口（下次启动就 EADDRINUSE），所以按进程树整棵杀。
 */
function killTree(p) {
  if (p.exitCode !== null || p.signalCode !== null) return
  try {
    if (isWin) execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' })
    else p.kill('SIGTERM')
  } catch {
    /* 进程已退出 */
  }
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('exit', () => {
  for (const p of procs) killTree(p)
})
