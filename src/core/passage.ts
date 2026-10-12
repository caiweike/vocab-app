import type { PassageLevel } from '@/core/types'

/** 每篇短文约用几个词 */
export const WORDS_PER_PASSAGE = 6

/** 每篇至少几个词，否则串不出一篇像样的短文 */
export const MIN_PASSAGE_WORDS = 4

/**
 * 把目标词切成若干篇短文，**尽量均分**且每篇不低于 `min`。
 *
 * 为什么不直接按 `WORDS_PER_PASSAGE` 切：9 个词会切成 `[6, 3]`，
 * 3 个词凑不成一篇、读起来像句子罗列。所以先算篇数再均分 → `[5, 4]`。
 * 末尾仍然过短的（比如 7 个词切成 `[4, 3]`）并进前一篇。
 *
 * 每篇词越少，句子越不容易为了塞词而变生硬 —— 这是"保证文章质量"的关键。
 */
export function chunkTargets(
  targets: string[],
  per = WORDS_PER_PASSAGE,
  min = MIN_PASSAGE_WORDS,
): string[][] {
  const n = targets.length
  if (n === 0) return []

  const count = Math.ceil(n / per)
  const size = Math.ceil(n / count)
  const out: string[][] = []
  for (let i = 0; i < n; i += size) out.push(targets.slice(i, i + size))

  while (out.length > 1 && out[out.length - 1].length < min) {
    const last = out.pop() as string[]
    out[out.length - 1].push(...last)
  }
  return out
}

/** 一条段落记录对应「某天 + 某难度 + 第几篇」，重复生成会覆盖同一条 */
export function passageId(dateKey: string, level: PassageLevel | string, chunk: number): string {
  return `${dateKey}::${level}::${chunk}`
}
