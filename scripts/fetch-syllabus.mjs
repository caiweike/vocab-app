#!/usr/bin/env node
/**
 * 下载「考试大纲释义」词表（一次性）。
 *
 *   npm run fetch:syllabus
 *
 * 来源（GitHub，exam-data 组织）：
 *   CETVocabulary    四六级考试大纲 2016 修订版，5278 词
 *   NETEMVocabulary  2024 考研大纲，5530 词
 *
 * 输出 dict/{cet,ky}_syllabus.json：`[{ w, m, c6 }]`
 *   w  单词        m  考纲中文释义（权威，会排在词典义项之前并加粗）
 *   c6 是否六级词（仅四六级表有，★ 标记）
 *
 * ECDICT 没有任何"这个词在不在词纲里"的标记（pos 列 77 万行全空），
 * 所以词纲义只能从这份数据来。拿不到时 build-books 会自动退回纯 ECDICT 构建。
 *
 * 许可：数据 CC BY-NC-SA 4.0（禁商用），代码 MIT。个人学习用没问题，
 *      将来要商业化需要换源或取得授权。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'dict')

const SOURCES = [
  {
    repo: 'exam-data/CETVocabulary',
    branch: 'main',
    file: 'cet_full_list.json',
    sheet: '四六级词汇词频排序表',
    out: 'cet_syllabus.json',
    sixLevel: true,
  },
  {
    repo: 'exam-data/NETEMVocabulary',
    branch: 'master',
    file: 'netem_full_list.json',
    sheet: '5530考研词汇词频排序表',
    out: 'ky_syllabus.json',
    sixLevel: false,
  },
]

/** 国内直连 raw.githubusercontent 偶尔不通，走镜像兜底 */
function urls({ repo, branch, file }) {
  const raw = `https://raw.githubusercontent.com/${repo}/${branch}/${file}`
  return [raw, `https://ghfast.top/${raw}`]
}

async function fetchJson(src) {
  let lastError
  for (const url of urls(src)) {
    try {
      const res = await fetch(url, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const rows = data[src.sheet]
      if (!Array.isArray(rows)) throw new Error(`找不到工作表「${src.sheet}」，实际是 ${Object.keys(data).join(',')}`)
      return rows
    } catch (e) {
      lastError = `${url} -> ${e.message}`
    }
  }
  throw new Error(lastError ?? 'unknown')
}

for (const src of SOURCES) {
  const rows = await fetchJson(src)
  const out = rows
    .map((r) => ({
      w: String(r['单词'] ?? '').trim(),
      m: String(r['释义'] ?? '').trim(),
      c6: src.sixLevel ? r['六级'] === '★' : undefined,
    }))
    .filter((r) => r.w && r.m)

  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, src.out), JSON.stringify(out))
  const missing = rows.length - out.length
  console.log(`✓ ${src.repo}：${out.length} 条考纲释义${missing ? `（丢弃 ${missing} 条空释义）` : ''} -> dict/${src.out}`)
}

console.log('\n提示：数据许可为 CC BY-NC-SA 4.0（禁商用）。')
