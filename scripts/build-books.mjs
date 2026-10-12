#!/usr/bin/env node
/**
 * 由 ECDICT 构建内置词书。
 *
 * 输入：dict/ecdict.csv（MIT 协议，先运行 `pnpm fetch:dict`）
 * 输出：src/data/books/{cet4,ky}.json + src/data/books/index.json
 *
 * 关键点：
 * - 词书成员由 tag 字段判定（cet4 / ky），一个数据源即可，无需拼第二个词表
 * - `pos` 字段是词频分布（如 n:46/v:54），不能当词性用；词性从释义首行前缀解析
 * - 音标是 legacy 记法，需要规范化后再存
 * - 按 frq（COCA 频率）升序作为书内学习顺序
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(ROOT, 'dict', 'ecdict.csv')
const DATA_DIR = path.join(ROOT, 'src', 'data')
const OUT_DIR = path.join(DATA_DIR, 'books')

/**
 * 内置词书，按考试阶段排序 —— 数组顺序就是 `order`，词书页按它展示。
 * `syllabus` 标注用哪份考纲释义表（可选）。
 */
const BOOKS = [
  { id: 'zk', name: '中考词汇', desc: '中考英语大纲词汇，按词频从高到低排列', tag: 'zk' },
  { id: 'gk', name: '高考词汇', desc: '高考英语大纲词汇，按词频从高到低排列', tag: 'gk' },
  {
    id: 'cet4',
    name: '英语四级 CET-4',
    desc: '大学英语四级考试大纲词汇，按词频从高到低排列',
    tag: 'cet4',
    syllabus: 'cet_syllabus.json',
  },
  {
    id: 'cet6',
    name: '英语六级 CET-6',
    desc: '大学英语六级考试大纲词汇，按词频从高到低排列',
    tag: 'cet6',
    syllabus: 'cet_syllabus.json',
  },
  {
    id: 'ky',
    name: '考研词汇',
    desc: '全国硕士研究生统一招生考试英语大纲词汇，按词频从高到低排列',
    tag: 'ky',
    syllabus: 'ky_syllabus.json',
  },
  { id: 'ielts', name: '雅思词汇 IELTS', desc: '雅思考试高频词汇，按词频从高到低排列', tag: 'ielts' },
  { id: 'toefl', name: '托福词汇 TOEFL', desc: '托福考试高频词汇，按词频从高到低排列', tag: 'toefl' },
  { id: 'gre', name: 'GRE 词汇', desc: 'GRE 考试高频词汇，按词频从高到低排列', tag: 'gre' },
]

/**
 * 读考纲释义表 `[{ w, m }]`（由 npm run fetch:syllabus 下载）。
 * ECDICT 判断不了哪个义项是词纲义（它的 pos 列全空），只能靠这份数据。
 */
function loadSyllabus(file) {
  if (!file) return new Map()
  const p = path.join(ROOT, 'dict', file)
  if (!existsSync(p)) {
    console.warn(`  ⚠ 缺少 dict/${file}，相关词书退回纯 ECDICT 释义（运行 npm run fetch:syllabus）`)
    return new Map()
  }
  const rows = JSON.parse(readFileSync(p, 'utf8'))
  return new Map(rows.map((r) => [r.w, r]))
}

/**
 * 合并所有考纲表，**按 BOOKS 声明顺序取先出现的那份**（四六级表优先于考研表）。
 * 词表是全局去重的，一个词只能存一份释义，所以必须在这里定优先级。
 */
function allSyllabus() {
  const map = new Map()
  const seen = []
  for (const book of BOOKS) {
    if (!book.syllabus || seen.includes(book.syllabus)) continue
    seen.push(book.syllabus)
    const one = loadSyllabus(book.syllabus)
    for (const [w, r] of one) if (!map.has(w)) map.set(w, r)
    console.log(`  考纲释义 ${book.syllabus}：${one.size} 条`)
  }
  return map
}

/**
 * 考纲释义永远排第一，词典义项跟在后面。
 * 详情页会把第一条加粗顶到最前 —— 那么第一条就必须真的是词纲义，而不是词典的首义。
 */
function mergeSyllabus(gloss, ecdictMeanings) {
  if (!gloss) return ecdictMeanings
  return [gloss, ...ecdictMeanings.filter((m) => m !== gloss)]
}

/** 释义分隔符：ECDICT 里是字面的 `\n` 两个字符，不是真换行 */
const LINE_SPLIT = /\\n|\r?\n/

/**
 * 词性白名单。宽松的 `/^[a-z]{1,3}\s+/` 会把 `the trait of ...` 这类英文释义的
 * 前三个字母误判成词性，所以只认词典里真实存在的缩写。
 */
const POS_TOKENS = [
  'n', 'v', 'vt', 'vi', 'a', 'adj', 'ad', 'adv', 'un', 'na', 'pl', 'pla',
  'int', 'interj', 'pref', 'suf', 'suff', 'prep', 'pron', 'num', 'conj',
  'vbl', 'aux', 'art', 'phr', 'comb', 'pp', 'abbr', 'modal', 'det', 'prop',
]
const POS_LINE_RE = new RegExp(`^(${POS_TOKENS.join('|')})\\.?\\s+`, 'i')

/**
 * ECDICT 偶尔把语法说明混进释义（如 `run的过去式和过去分词`），
 * 这种行开头是英文单词直接接中文，不是义项。
 */
const NOT_A_SENSE = /^[A-Za-z][\w-]*[一-鿿]/

/**
 * legacy 音标 → 标准 IPA。
 * 原则是「只删确定不是音标的字符」——用白名单会误删 ɔ、ɒ、: 等合法符号。
 * 转换顺序敏感：先做双元音再做单元音，否则 `steit` 会变成 `stɪt`。
 */
function normalizePhonetic(raw) {
  if (!raw) return ''
  let s = String(raw).trim().replace(/^\/+|\/+$/g, '')
  if (!s) return ''
  // 中文与全角字符
  s = s.replace(/[一-鿿㐀-䶿　-〿＀-￯“”‘’]/g, '')
  // 字面转义
  s = s.replace(/\\[nrt]/g, '')
  // 记号：' 主重音，" 与 , 次重音，: 长音
  s = s.replace(/'/g, 'ˈ').replace(/"/g, 'ˌ').replace(/,/g, 'ˌ').replace(/:/g, 'ː')
  // 西里尔字母：Ә→/ɜ/、ә→/ə/、є→/ɛ/（ECDICT 沿用旧式注音字母）
  s = s.replace(/Ә/g, 'ɜ').replace(/ә/g, 'ə').replace(/є/g, 'ɛ').replace(/Є/g, 'ɛ')
  // 塞擦音：旧式用 d+j、t+j 表示，IPA 应为 dʒ、tʃ
  s = s.replace(/dj/g, 'dʒ').replace(/tj/g, 'tʃ')
  // 句首的 . 是无重音音节标记，单独出现在开头没有意义
  s = s.replace(/^\./, '')
  // ə 永不长音，`əː` 实为 /ɜː/
  s = s.replace(/ə(?=ː)/g, 'ɜ')
  // 双元音：legacy 用字母组合表示
  s = s
    .replace(/ai/g, 'aɪ')
    .replace(/ei/g, 'eɪ')
    .replace(/ɔi/g, 'ɔɪ')
    .replace(/oi/g, 'ɔɪ')
    .replace(/au/g, 'aʊ')
    .replace(/ou/g, 'əʊ')
    .replace(/iə/g, 'ɪə')
    .replace(/uə/g, 'ʊə')
  // 长元音 iː / uː 保护：先于短元音替换
  s = s.replace(/i(?![ː])/g, 'ɪ').replace(/u(?![ː])/g, 'ʊ')
  // 明确非音标的 ASCII 符号
  s = s.replace(/[!"#$%&*;<=>?@[\]^`{}~]/g, '')
  // 合并重复记号
  s = s.replace(/(ˈ|ˌ)\1+/g, '$1').replace(/ːː+/g, 'ː')
  s = s.replace(/\s+/g, '')
  if (!/[a-zA-Zəɪʊæɑɒɔɜʌθðʃʒŋˈˌː]/.test(s)) return ''
  return s
}

/** 拆出释义行，去掉 `[计]` `[医]` 这类领域标记行 */
function senseLines(translation) {
  const lines = translation
    .split(LINE_SPLIT)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const plain = lines.filter((l) => !l.startsWith('[') && !NOT_A_SENSE.test(l))
  return plain.length > 0 ? plain : lines
}

/** 词性：收集前几行出现的全部词性（一个词常有多个），拼成 `n./v.`（`pos` 字段是词频分布，不能用） */
function extractPos(lines) {
  const found = []
  for (const line of lines.slice(0, 6)) {
    const m = line.match(POS_LINE_RE)
    if (!m) continue
    let p = m[1].toLowerCase()
    if (!p.endsWith('.')) p += '.'
    if (!found.includes(p)) found.push(p)
    if (found.length >= 3) break
  }
  return found.join('/')
}

function extractMeanings(lines, limit = 4) {
  const out = []
  for (const line of lines) {
    const sense = line.replace(POS_LINE_RE, '').trim()
    if (sense && !out.includes(sense)) out.push(sense)
    if (out.length >= limit) break
  }
  return out
}

/**
 * 英文释义（ECDICT 的 `definition` 字段）。取前两行、控制在 140 字符内——
 * 它是给卡片背面当辅助说明用的，不是全文词条，超长会把卡片撑爆。
 */
function extractDefinition(raw) {
  if (!raw) return ''
  const lines = raw
    .split(LINE_SPLIT)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  const text = lines.slice(0, 2).join('; ')
  if (text.length <= 140) return text
  const cut = text.lastIndexOf(' ', 140)
  return `${text.slice(0, cut > 100 ? cut : 140)}…`
}

function toNumber(v) {
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) ? n : 0
}

function main() {
  if (!existsSync(SRC)) {
    console.error('✗ 缺少 dict/ecdict.csv，请先运行：pnpm fetch:dict')
    process.exit(1)
  }

  console.log('读取 ECDICT ...')
  const text = readFileSync(SRC, 'utf8')
  const { data, errors } = Papa.parse(text, {
    header: true,
    skipEmptyLines: 'greedy',
    delimiter: ',',
  })
  if (errors.length > 0) {
    console.log(`  解析提示 ${errors.length} 条（首条：${errors[0].message}），继续处理`)
  }
  console.log(`  共 ${data.length} 行`)

  /** word -> 已合并的词条 */
  const merged = new Map()

  for (const row of data) {
    const word = (row.word ?? '').trim()
    if (!word) continue
    const translation = (row.translation ?? '').trim()
    if (!translation) continue
    // 只保留字母/连字符/撇号构成的单词，排除词组与纯符号条目
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) continue

    const tags = (row.tag ?? '').split(/\s+/).filter(Boolean)
    if (tags.length === 0) continue

    const lines = senseLines(translation)
    const existing = merged.get(word)
    const entry = {
      word,
      phonetic: normalizePhonetic(row.phonetic),
      meanings: extractMeanings(lines),
      definition: extractDefinition(row.definition),
      pos: extractPos(lines),
      bnc: toNumber(row.bnc),
      frq: toNumber(row.frq),
      collins: toNumber(row.collins),
      oxford: (row.oxford ?? '').trim() === '1',
      exchange: (row.exchange ?? '').trim(),
      tags,
    }
    if (!existing) {
      merged.set(word, entry)
    } else {
      // 同词多行（异体拼写）合并：保留释义更全的，tag/英文释义取并集
      const base = entry.meanings.length > existing.meanings.length ? entry : existing
      const other = base === entry ? existing : entry
      merged.set(word, {
        ...base,
        definition: base.definition || other.definition,
        tags: [...new Set([...existing.tags, ...entry.tags])],
      })
    }
  }
  console.log(`  有效词条 ${merged.size} 个`)

  const syllabus = allSyllabus()
  mkdirSync(OUT_DIR, { recursive: true })

  // 1) 全局词表：只收被至少一本内置词书用到的词，**去重存一份**。
  //    词条详情放这里，各本书只存词列表 —— 否则加一本书就要把全量词条再复制一遍。
  const usedTags = new Set(BOOKS.map((b) => b.tag))
  const used = [...merged.values()].filter((e) => e.tags.some((t) => usedTags.has(t)))
  const wordRows = used.map((e) => ({
    word: e.word,
    phonetic: e.phonetic,
    // 考纲释义置顶，词典义项跟在后面
    meanings: mergeSyllabus(syllabus.get(e.word)?.m, e.meanings),
    definition: e.definition,
    pos: e.pos,
    bnc: e.bnc,
    frq: e.frq,
    collins: e.collins,
    oxford: e.oxford,
    exchange: e.exchange,
  }))
  writeFileSync(path.join(DATA_DIR, 'words.json'), JSON.stringify(wordRows))
  const wordKb = (JSON.stringify(wordRows).length / 1024).toFixed(0)
  const covered = wordRows.filter((r) => syllabus.has(r.word)).length
  console.log(
    `\n✓ src/data/words.json：${wordRows.length} 词去重（${covered} 条带考纲释义）→ ${wordKb} KB`,
  )

  // 2) 每本书只存词列表，`order` 决定词书页的展示顺序
  const index = []
  BOOKS.forEach((book, order) => {
    const entries = [...merged.values()]
      .filter((e) => e.tags.includes(book.tag))
      // 无频率数据的排到最后；同频按字母序保证稳定
      .sort((a, b) => (a.frq || 999999) - (b.frq || 999999) || a.word.localeCompare(b.word))
    const words = entries.map((e) => e.word)

    const file = {
      id: book.id,
      name: book.name,
      desc: book.desc,
      source: 'built-in',
      order,
      count: words.length,
      words,
    }
    writeFileSync(path.join(OUT_DIR, `${book.id}.json`), JSON.stringify(file))
    const kb = (JSON.stringify(file).length / 1024).toFixed(0)
    const hit = words.filter((w) => syllabus.has(w)).length
    console.log(
      `✓ ${book.name.padEnd(14)} ${String(words.length).padStart(5)} 词（${hit} 带考纲释义）→ books/${book.id}.json（${kb} KB）`,
    )
    index.push({ id: book.id, name: book.name, desc: book.desc, source: 'built-in', count: words.length, order })
  })

  writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2))
  console.log('✓ src/data/books/index.json 已生成')

  // 验收抽查：拿词列表回查全局词表
  const byWord = new Map(wordRows.map((r) => [r.word, r]))
  for (const book of BOOKS.slice(0, 3)) {
    const f = JSON.parse(readFileSync(path.join(OUT_DIR, `${book.id}.json`), 'utf8'))
    const mid = Math.floor(f.words.length / 2)
    const sample = [...f.words.slice(0, 2), ...f.words.slice(mid, mid + 2)]
    console.log(`\n抽查「${book.name}」（${f.count} 词）：`)
    for (const w of sample) {
      const r = byWord.get(w)
      const ph = r?.phonetic ? `/${r.phonetic}/` : '(无音标)'
      console.log(`  ${w} ${ph} — ${r?.meanings.join('；') ?? '(缺词条)'}`)
    }
  }
}

main()
