import Papa from 'papaparse'

export interface ParsedRow {
  word: string
  meaning?: string
}

export interface ParseResult {
  rows: ParsedRow[]
  /** 重复的词（同文件内） */
  duplicates: string[]
  format: 'tab' | 'csv' | 'plain'
  /** 解析后被丢弃的空行数 */
  skipped: number
}

/**
 * 解析用户导入的词表。支持三种常见形态，按探测顺序：
 * 1. `单词<TAB>释义` —— 墨墨/Anki 导出常见
 * 2. `word,释义` CSV —— 带引号的释义里可能含逗号，交给 papaparse
 * 3. 每行一个单词 —— 最简单
 */
export function parseWordList(text: string): ParseResult {
  const raw = text.replace(/^\uFEFF/, '')
  const lines = raw.split(/\r?\n/)
  const nonEmpty = lines.filter((l) => l.trim() !== '')

  if (nonEmpty.length === 0) {
    return { rows: [], duplicates: [], format: 'plain', skipped: 0 }
  }

  const tabCount = nonEmpty.filter((l) => l.includes('\t')).length
  const commaCount = nonEmpty.filter((l) => l.includes(',')).length

  let rows: ParsedRow[]
  let format: ParseResult['format']

  if (tabCount >= Math.max(1, nonEmpty.length * 0.5)) {
    format = 'tab'
    rows = nonEmpty.map((line) => {
      const [w, ...rest] = line.split('\t')
      const meaning = rest.join('\t').trim()
      return { word: w.trim(), meaning: meaning || undefined }
    })
  } else if (commaCount >= Math.max(1, nonEmpty.length * 0.5)) {
    format = 'csv'
    const parsed = Papa.parse<string[]>(raw, {
      skipEmptyLines: 'greedy',
      delimiter: ',',
    })
    rows = (parsed.data ?? []).map((cells) => {
      const w = (cells[0] ?? '').trim()
      const meaning = cells.slice(1).filter((c) => c && c.trim()).join('；').trim()
      return { word: w, meaning: meaning || undefined }
    })
  } else {
    format = 'plain'
    rows = nonEmpty.map((line) => ({ word: line.trim() }))
  }

  const seen = new Set<string>()
  const duplicates: string[] = []
  const cleaned: ParsedRow[] = []
  let skipped = 0

  for (const r of rows) {
    const w = r.word.trim().replace(/^["']|["']$/g, '')
    // 只接受单个英文词，跳过表头、序号行、中英混排行
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(w)) {
      skipped++
      continue
    }
    const key = w.toLowerCase()
    if (seen.has(key)) {
      duplicates.push(w)
      continue
    }
    seen.add(key)
    cleaned.push({ word: w, meaning: r.meaning?.trim() || undefined })
  }

  return { rows: cleaned, duplicates, format, skipped }
}
