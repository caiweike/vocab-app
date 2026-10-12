import type { PassageRecord, WordRecord } from '@/core/types'
import { acceptedForms } from '@/core/wordforms'

export type ExerciseKind =
  /** 英文 → 选中文释义 */
  | 'en2zh'
  /** 中文 → 拼写英文 */
  | 'zh2en'
  /** 听发音 → 选拼写 */
  | 'listen2word'
  /** 听发音 → 选中文释义 */
  | 'listen2zh'

export interface Option {
  text: string
  /** 是否是正确项 */
  correct: boolean
}

export interface Exercise {
  kind: ExerciseKind
  word: WordRecord
  /** 题干：单词或中文释义 */
  prompt: string
  options: Option[]
  /** 输入型题目的参考答案 */
  answer: string
}

export interface ExerciseInput {
  word: WordRecord
  /** 同词书内的其它词，用于挑选干扰项 */
  pool: WordRecord[]
  kind: ExerciseKind
}

/**
 * 参与轮换的题型。当前只启用英译中四选一，停用了三个：
 * - 中译英拼写（zh2en）
 * - 听音选词（listen2word，听发音挑英文拼写那个）
 * - 听音辨义（listen2zh，听发音挑中文释义那个）
 *
 * 想恢复就把它们加回这个数组，出题分支、选项、喇叭按钮都还在原处没删。
 */
const KINDS: ExerciseKind[] = ['en2zh']

/**
 * 题型轮换：按单词哈希取模，保证同一个词每次题型稳定（利于形成固定记忆路径），
 * 同时整体上几类题型均匀分布。
 */
export function pickKind(word: string): ExerciseKind {
  return KINDS[hash(word) % KINDS.length]
}

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/**
 * 选干扰项：优先同词性、频率相近的词（最易混淆），退化到随机。
 * 去重且永不混入正确答案本身。
 */
export function pickDistractors(target: WordRecord, pool: WordRecord[], count: number): WordRecord[] {
  const others = pool.filter((w) => w.word !== target.word && w.meanings.length > 0)
  const samePos = others.filter((w) => w.pos && w.pos === target.pos)
  const nearFreq = (list: WordRecord[]) =>
    [...list]
      .map((w) => ({ w, d: Math.abs((w.frq || 99999) - (target.frq || 99999)) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count * 3)

  const picked: WordRecord[] = []
  const seen = new Set<string>([target.word])

  for (const cand of nearFreq(samePos)) {
    if (picked.length >= count) break
    if (seen.has(cand.w.word)) continue
    seen.add(cand.w.word)
    picked.push(cand.w)
  }
  for (const cand of nearFreq(others)) {
    if (picked.length >= count) break
    if (seen.has(cand.w.word)) continue
    seen.add(cand.w.word)
    picked.push(cand.w)
  }
  return picked
}

/**
 * 干扰项取什么。
 * `word` = 听音拼写题，四个选项都是英文单词；`meaning` = 释义题，四个选项都是中文。
 * 两者混用会出现"三个中文一个英文"，一眼就能看出哪个是答案。
 */
export type DistractorSource = 'word' | 'meaning'

/** 4 选 1 选项（含正确项），按固定种子洗牌，避免同一词每次答案位置不同 */
export function buildOptions(
  target: WordRecord,
  pool: WordRecord[],
  correct: string,
  seed: string,
  distractor: DistractorSource = 'meaning',
): Option[] {
  const used = new Set([normalize(correct)])
  const wrong: string[] = []

  const tryAdd = (raw: string) => {
    // 单词选项不能过 shortGloss：它按逗号切、超长还会截断加省略号，会把整词毁掉
    const text = distractor === 'word' ? raw.trim() : shortGloss(raw)
    const key = normalize(text)
    if (!text || used.has(key)) return
    used.add(key)
    wrong.push(text)
  }

  const textOf = (cand: WordRecord) =>
    distractor === 'word' ? cand.word : extractMeaning(cand, correct)

  // 同词性、频率相近的词最易混淆，先从这个子集里挑
  for (const cand of pickDistractors(target, pool, 20)) tryAdd(textOf(cand))
  // 同词性候选撞车时（两个词主释义一样），退到全池按频率接近程度补齐
  if (wrong.length < 3) {
    for (const cand of pickDistractors(target, pool, 80)) tryAdd(textOf(cand))
  }

  const options: Option[] = [
    { text: correct, correct: true },
    ...wrong.slice(0, 3).map((text) => ({ text, correct: false })),
  ]
  return shuffle(options, seed)
}

/** 比较用的归一化：忽略空白与中英文标点，`州；状态` 与 `州,状态` 视作同一项 */
function normalize(s: string): string {
  return s.replace(/[\s,，;；、。.·]+/g, '')
}

function extractMeaning(w: WordRecord, correct: string): string {
  const m = w.meanings.find((x) => x !== correct) ?? w.meanings[0] ?? w.word
  return m
}

/** 主释义：取第一条（卡片背面展示完整义项用） */
export function primaryMeaning(w: WordRecord): string {
  return w.meanings[0] ?? '（暂无释义）'
}

const POS_PREFIX = /^\s*([a-z]{1,4}\.?)\s+/i
const GLOSS_MAX = 18

/**
 * 题干与选项用的短释义。
 *
 * ECDICT 的一条义项常是 `州, 状态, 情形, 国家, 政府, 领土, 国务, 社会地位` 这样一长串，
 * 直接当四选一的选项，做题就变成了阅读理解——所以去掉词性前缀、只留前两个义项、过长截断。
 * 完整释义留给卡片翻面展示。
 */
export function shortGloss(meaning: string): string {
  const body = (meaning ?? '').replace(POS_PREFIX, '').trim()
  if (!body) return ''
  const senses = body.split(/\s*[,，;；、]\s*/).filter(Boolean)
  const text = senses.slice(0, 2).join('；') || body
  if (text.length <= GLOSS_MAX) return text
  const cut = text.lastIndexOf(' ', GLOSS_MAX)
  return `${text.slice(0, cut > 6 ? cut : GLOSS_MAX)}…`
}

/** 确定性洗牌：同 seed 结果一致，刷新页面选项不跳动 */
export function shuffle<T>(arr: T[], seed: string): T[] {
  const out = [...arr]
  let s = hash(seed) || 1
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * 构造一道题。
 * @param kind 题型，由 `pickKind` 按词轮换给出
 */
export function makeExercise(input: ExerciseInput): Exercise {
  const { word, pool, kind } = input

  const gloss = shortGloss(primaryMeaning(word))

  switch (kind) {
    case 'en2zh':
      return {
        kind,
        word,
        prompt: word.word,
        options: buildOptions(word, pool, gloss, word.word + 'en2zh'),
        answer: gloss,
      }
    case 'zh2en':
      return {
        kind,
        word,
        prompt: gloss,
        options: [],
        answer: word.word,
      }
    case 'listen2word':
      return {
        kind,
        word,
        prompt: '',
        // 选拼写的题四个选项都得是单词，不能混进中文释义
        options: buildOptions(word, pool, word.word, word.word + 'l2w', 'word'),
        answer: word.word,
      }
    case 'listen2zh':
      return {
        kind,
        word,
        prompt: '',
        options: buildOptions(word, pool, gloss, word.word + 'l2zh'),
        answer: gloss,
      }
  }
}

/** 从历史段落里找一句含目标词的句子，作为卡片背面的语境例句 */
export function findSentenceFor(target: string, passages: PassageRecord[]): string | null {
  if (!target || passages.length === 0) return null
  const re = new RegExp(`\\b${escapeRegExp(target)}\\b`, 'i')
  for (const p of passages) {
    for (const sentence of splitSentences(p.passage)) {
      if (re.test(sentence)) return sentence
    }
  }
  return null
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface TextSeg {
  text: string
  hit: boolean
}

/**
 * 按词边界把句子里的目标词切出来，给例句划重点用。
 * 大小写不敏感，`Might it work?` 里的 `Might` 同样命中。
 */
export function splitAroundWord(sentence: string, word: string): TextSeg[] {
  const text = sentence ?? ''
  const target = (word ?? '').trim()
  if (!text) return []
  if (!target) return [{ text, hit: false }]

  const re = new RegExp(`\\b${escapeRegExp(target)}\\b`, 'gi')
  const out: TextSeg[] = []
  let last = 0
  let m: RegExpExecArray | null

  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++
      continue
    }
    if (m.index > last) out.push({ text: text.slice(last, m.index), hit: false })
    out.push({ text: m[0], hit: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false })

  return out
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 拼写题判定：完全匹配，或命中词形变化（复数/过去式等，真实格式是 `p:went` 这种带码的） */
export function isSpellingCorrect(input: string, answer: string, exchange: string): boolean {
  const a = input.trim().toLowerCase()
  if (a === '') return false
  if (a === answer.toLowerCase()) return true
  return acceptedForms(exchange).includes(a)
}

/**
 * 拼写题的「提示」：逐个揭示字母，`level` 为 1 时给首字母，之后每档多一个。
 * 永远留最后一个字母不揭晓——全给了就不叫测试了。
 */
export function spellingHint(word: string, level: number): string {
  if (level <= 0) return ''
  const chars = [...word]
  const max = chars.length - 1
  if (max <= 0) return ''
  const revealed = Math.min(level, max)
  return chars.map((c, i) => (i < revealed ? c : '_')).join(' ')
}
