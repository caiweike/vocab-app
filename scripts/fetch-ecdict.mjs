#!/usr/bin/env node
/**
 * 下载 ECDICT 词典数据（MIT 协议）到 dict/ecdict.csv。
 *
 * raw.githubusercontent.com 在部分网络环境不可达，因此内置多镜像回退，
 * 最后兜底用 git clone（git 在多数环境都可用）。
 *
 * 用法：node scripts/fetch-ecdict.mjs [--force]
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DICT_DIR = path.join(ROOT, 'dict')
const TARGET = path.join(DICT_DIR, 'ecdict.csv')
const TMP = path.join(DICT_DIR, 'ecdict.csv.part')

/** 固定到具体 commit，保证构建可复现 */
const REF = 'master'
const RAW = `https://raw.githubusercontent.com/skywind3000/ECDICT/${REF}/ecdict.csv`

const MIRRORS = [
  RAW,
  `https://ghproxy.net/${RAW}`,
  `https://gh-proxy.com/${RAW}`,
  `https://ghfast.top/${RAW}`,
]

const MIN_BYTES = 50 * 1024 * 1024 // 正常应在 62.9MB 左右，低于 50MB 视为下砸了错误页

async function download(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'vocab-app-build/1.0' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!res.body) throw new Error('empty body')
  await pipeline(res.body, createWriteStream(TMP))
  const size = statSync(TMP).size
  if (size < MIN_BYTES) throw new Error(`文件过小（${size} bytes），可能不是完整数据`)
  return size
}

async function viaGit() {
  console.log('  镜像全部失败，改用 git clone ...')
  const tmpRepo = path.join(DICT_DIR, '.clone')
  try {
    if (existsSync(tmpRepo)) execFileSync('rm', ['-rf', tmpRepo])
    execFileSync('git', ['clone', '--depth', '1', 'https://github.com/skywind3000/ECDICT.git', tmpRepo], {
      stdio: 'inherit',
    })
    const src = path.join(tmpRepo, 'ecdict.csv')
    if (!existsSync(src)) throw new Error('clone 后未找到 ecdict.csv')
    renameSync(src, TARGET)
  } finally {
    try {
      execFileSync('rm', ['-rf', tmpRepo])
    } catch {
      /* 清理失败不影响结果 */
    }
  }
}

async function main() {
  const force = process.argv.includes('--force')
  mkdirSync(DICT_DIR, { recursive: true })

  if (existsSync(TARGET) && !force) {
    const size = statSync(TARGET).size
    if (size >= MIN_BYTES) {
      console.log(`✓ 已存在 dict/ecdict.csv（${(size / 1024 / 1024).toFixed(1)} MB），跳过下载。加 --force 重新下载。`)
      return
    }
    console.log('已存在的文件不完整，重新下载...')
    unlinkSync(TARGET)
  }

  for (const url of MIRRORS) {
    console.log(`→ 尝试 ${url}`)
    try {
      const size = await download(url)
      renameSync(TMP, TARGET)
      console.log(`✓ 下载完成：${(size / 1024 / 1024).toFixed(1)} MB`)
      return
    } catch (e) {
      console.log(`  ✗ 失败：${e.message}`)
      if (existsSync(TMP)) unlinkSync(TMP)
    }
  }

  await viaGit()
  const size = statSync(TARGET).size
  console.log(`✓ 通过 git 获取：${(size / 1024 / 1024).toFixed(1)} MB`)
}

main().catch((e) => {
  console.error(`\n✗ 获取词典失败：${e.message}`)
  console.error('  可以手动下载 https://github.com/skywind3000/ECDICT 仓库里的 ecdict.csv')
  console.error(`  放到 ${TARGET} 后重新运行 pnpm build:books`)
  process.exit(1)
})
