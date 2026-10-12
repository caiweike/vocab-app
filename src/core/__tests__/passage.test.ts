import { describe, expect, it } from 'vitest'
import { chunkTargets, MIN_PASSAGE_WORDS, passageId, WORDS_PER_PASSAGE } from '@/core/passage'

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`)

describe('chunkTargets', () => {
  it('词数不超过每篇上限时只有一篇', () => {
    expect(chunkTargets(words(5))).toEqual([words(5)])
    expect(chunkTargets(words(WORDS_PER_PASSAGE))).toEqual([words(WORDS_PER_PASSAGE)])
  })

  it('均分而不是按固定长度切 —— 9 个词给 [5,4] 而不是 [6,3]', () => {
    const out = chunkTargets(words(9))
    expect(out.map((c) => c.length)).toEqual([5, 4])
    for (const c of out) expect(c.length).toBeGreaterThanOrEqual(MIN_PASSAGE_WORDS)
  })

  it('20 个词切成 4 篇均匀的短文', () => {
    expect(chunkTargets(words(20)).map((c) => c.length)).toEqual([5, 5, 5, 5])
  })

  it('末尾太短的一篇并进前一篇', () => {
    // 7 个词按 size=4 会切成 [4,3]，3 个词凑不成一篇
    expect(chunkTargets(words(7)).map((c) => c.length)).toEqual([7])
  })

  it('切完不丢词、不重复', () => {
    const all = words(37)
    expect(chunkTargets(all).flat()).toEqual(all)
  })

  it('空输入返回空数组', () => {
    expect(chunkTargets([])).toEqual([])
  })
})

describe('passageId', () => {
  it('同天同难度同篇号才是同一条', () => {
    expect(passageId('2026-10-06', 'standard', 0)).toBe('2026-10-06::standard::0')
    expect(passageId('2026-10-06', 'standard', 1)).not.toBe(passageId('2026-10-06', 'standard', 0))
    expect(passageId('2026-10-06', 'basic', 0)).not.toBe(passageId('2026-10-06', 'standard', 0))
    expect(passageId('2026-10-07', 'standard', 0)).not.toBe(passageId('2026-10-06', 'standard', 0))
  })
})
