/**
 * ECDICT `exchange` 字段的解析。
 *
 * 真实格式是 `码:词` 用 `/` 串联，例如 state → `s:states/p:stated/d:stated/3:states/i:stating`。
 * 早期实现直接按 `/` 切开拿去和用户输入比对，`"p:stated" !== "stated"`，
 * 导致词形变化判定对真实数据从不生效。
 */

/** 展示用的类型码顺序：复数 → 三单 → 现在分词 → 过去式 → 过去分词 → 比较级 → 最高级 */
const EXCHANGE_ORDER = ['s', '3', 'i', 'p', 'd', 'r', 't'] as const

const EXCHANGE_LABELS: Record<string, string> = {
  s: '复数',
  3: '第三人称单数',
  i: '现在分词',
  p: '过去式',
  d: '过去分词',
  r: '比较级',
  t: '最高级',
}

/**
 * 指针类码，指向的是"原形"或"词形类型"，本身不是可输入的单词：
 * `0:` = 该词形的原形（`0:run`），`1:` = 该词形属于哪种变化（`1:d`）。
 * 把它们当成候选答案会让用户输入 `d` 就算答对 run。
 */
const POINTER_CODES = new Set(['0', '1'])

export interface WordForm {
  code: string
  label: string
  form: string
}

/**
 * 解析成可展示的词形列表。
 * 未知码与指针码一律忽略；没有数据（空串或 `0`）返回空数组。
 */
export function parseExchange(exchange: string): WordForm[] {
  const picked: WordForm[] = []
  const seen = new Set<string>()

  for (const pair of (exchange ?? '').split('/')) {
    const trimmed = pair.trim()
    if (!trimmed || trimmed === '0') continue
    const sep = trimmed.indexOf(':')
    if (sep <= 0) continue
    const code = trimmed.slice(0, sep)
    const form = trimmed.slice(sep + 1).trim()
    const label = EXCHANGE_LABELS[code]
    if (!label || !form) continue
    const key = `${label}::${form}`
    if (seen.has(key)) continue
    seen.add(key)
    picked.push({ code, label, form })
  }

  return EXCHANGE_ORDER.map((code) => picked.filter((f) => f.code === code)).flat()
}

/**
 * 拼写题可接受的全部写法：原形之外的各种词形。
 * 无 `码:` 前缀的裸格式（历史数据 / 导入的词表）同样接受。
 */
export function acceptedForms(exchange: string): string[] {
  const out = new Set<string>()

  for (const pair of (exchange ?? '').split('/')) {
    const trimmed = pair.trim()
    if (!trimmed || trimmed === '0') continue
    const sep = trimmed.indexOf(':')
    const code = sep > 0 ? trimmed.slice(0, sep) : null
    if (code !== null && POINTER_CODES.has(code)) continue
    const value = (sep > 0 ? trimmed.slice(sep + 1) : trimmed).trim()
    if (value) out.add(value.toLowerCase())
  }

  return [...out]
}
