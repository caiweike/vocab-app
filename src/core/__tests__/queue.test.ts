import { describe, expect, it } from 'vitest'
import {
  buildQueue,
  countLearnedToday,
  newWordsLearnedToday,
  requeueAfterFailure,
  toDateKey,
  type QueueItem,
} from '@/core/queue'
import { State } from 'ts-fsrs'
import type { SrsRecord } from '@/core/types'

function rec(wordId: string, state: 0 | 1 | 2 | 3, due: number): SrsRecord {
  return {
    wordId,
    state,
    stability: 3,
    difficulty: 5,
    due,
    lastReview: due - 1000,
    reps: 1,
    lapses: 0,
    elapsedDays: 1,
    scheduledDays: 3,
    learningSteps: 0,
  }
}

describe('buildQueue', () => {
  const now = new Date('2026-10-04T09:00:00')
  const nowMs = now.getTime()

  it('先排到期复习，再补新词', () => {
    const words = ['new1', 'new2', 'dueOld', 'dueLearn', 'future']
    const srs = new Map<string, SrsRecord>([
      ['dueOld', rec('dueOld', State.Review, nowMs - 1000)],
      ['dueLearn', rec('dueLearn', State.Learning, nowMs - 1000)],
      ['future', rec('future', State.Review, nowMs + 86400000)],
    ])

    const out = buildQueue({
      words,
      srsByWord: srs,
      config: { dailyNew: 20, dailyReview: 200 },
      learnedToday: 0,
      now,
    })

    expect(out.review.map((r) => r.word).sort()).toEqual(['dueLearn', 'dueOld'])
    expect(out.fresh.map((r) => r.word)).toEqual(['new1', 'new2'])
    expect(out.remainingReviews).toBe(0)
  })

  it('学习中（分钟级）到期的排在复习词之前', () => {
    const words = ['old', 'learning']
    const srs = new Map<string, SrsRecord>([
      ['old', rec('old', State.Review, nowMs - 50000)],
      ['learning', rec('learning', State.Learning, nowMs - 1000)],
    ])

    const out = buildQueue({
      words,
      srsByWord: srs,
      config: { dailyNew: 0, dailyReview: 0 },
      learnedToday: 0,
      now,
    })

    expect(out.review[0]?.word).toBe('learning')
  })

  it('新词受 dailyNew 与今日已学数共同限制', () => {
    const words = ['a', 'b', 'c', 'd', 'e']
    const out = buildQueue({
      words,
      srsByWord: new Map(),
      config: { dailyNew: 3, dailyReview: 100 },
      learnedToday: 2,
      now,
    })
    expect(out.fresh).toHaveLength(1)
  })

  it('复习超上限时只入队上限数量并报告剩余', () => {
    const words = ['w1', 'w2', 'w3', 'w4']
    const srs = new Map(words.map((w) => [w, rec(w, State.Review, nowMs - 1)] as const))
    const out = buildQueue({
      words,
      srsByWord: srs,
      config: { dailyNew: 0, dailyReview: 2 },
      learnedToday: 0,
      now,
    })
    expect(out.review).toHaveLength(2)
    expect(out.remainingReviews).toBe(2)
  })

  it('未到时间的词不会进队列', () => {
    const out = buildQueue({
      words: ['future'],
      srsByWord: new Map([['future', rec('future', State.Review, nowMs + 1)]]),
      config: { dailyNew: 5, dailyReview: 100 },
      learnedToday: 0,
      now,
    })
    expect(out.review).toHaveLength(0)
    expect(out.fresh).toHaveLength(0)
  })

  it('返回项标记了 isNew', () => {
    const out = buildQueue({
      words: ['x'],
      srsByWord: new Map(),
      config: { dailyNew: 5, dailyReview: 100 },
      learnedToday: 0,
      now,
    })
    const item: QueueItem | undefined = out.fresh[0]
    expect(item?.isNew).toBe(true)
  })
})

describe('requeueAfterFailure', () => {
  const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const queue: QueueItem[] = words.map((word) => ({ word, isNew: true }))

  it('错词延后 delay 题重现，且不是新词', () => {
    const out = requeueAfterFailure(queue, 0, queue[0], { delay: 4 })
    expect(out).toHaveLength(words.length + 1)
    // 当前题答完游标走到 1，中间正好隔 4 道别的题
    expect(out[5]?.word).toBe('a')
    expect(out[5]?.isNew).toBe(false)
    expect(out[5]?.attempts).toBe(1)
    expect(out.slice(1, 5).map((q) => q.word)).toEqual(['b', 'c', 'd', 'e'])
  })

  it('重做次数有上限，不会让一轮永远结束不了', () => {
    const once = requeueAfterFailure(queue, 0, queue[0], { delay: 4 })
    const twice = requeueAfterFailure(once, 5, once[5]!, { delay: 4 })
    expect(twice).toHaveLength(words.length + 2)

    const third = twice.find((q) => q.word === 'a' && q.attempts === 2)
    expect(third).toBeDefined()
    const capped = requeueAfterFailure(twice, 6, third!, { delay: 4 })
    expect(capped).toHaveLength(words.length + 2)
  })

  it('在队尾时插到末尾，不越界', () => {
    const tail = queue.slice(0, 3)
    const out = requeueAfterFailure(tail, 2, tail[2], { delay: 4 })
    expect(out).toHaveLength(4)
    expect(out[3]?.word).toBe('c')
  })

  it('改 delay 可以控制隔几题', () => {
    const out = requeueAfterFailure(queue, 0, queue[0], { delay: 1 })
    expect(out[2]?.word).toBe('a')
  })
})

describe('newWordsLearnedToday', () => {
  const dayStart = new Date('2026-10-06T00:00:00').getTime()
  const t = dayStart + 3600_000

  it('只留"评分前还是 New"的那一次，复习词不掺进来', () => {
    const logs = [
      { at: t, wordId: 'newWord', stateBefore: 0 },   // 今天第一次学的新词
      { at: t + 1, wordId: 'dueWord', stateBefore: 2 }, // 今天复习的到期词
      { at: t + 2, wordId: 'newWord', stateBefore: 1 }, // 新词答错重排后的第二次
    ]
    expect(newWordsLearnedToday(logs, dayStart)).toEqual(['newWord'])
  })

  it('按首次出现顺序去重，且忽略昨天的记录', () => {
    const logs = [
      { at: dayStart - 1, wordId: 'yesterday', stateBefore: 0 },
      { at: t, wordId: 'a', stateBefore: 0 },
      { at: t + 1, wordId: 'b', stateBefore: 0 },
      { at: t + 2, wordId: 'a', stateBefore: 1 },
    ]
    expect(newWordsLearnedToday(logs, dayStart)).toEqual(['a', 'b'])
  })
})

describe('countLearnedToday', () => {
  const day = new Date('2026-10-04T23:00:00')

  it('只统计今天且按词去重', () => {
    const start = new Date('2026-10-04T00:00:00').getTime()
    const logs = [
      { at: start + 1000, wordId: 'a' },
      { at: start + 2000, wordId: 'a' },
      { at: start + 3000, wordId: 'b' },
      { at: start - 86400000, wordId: 'c' },
    ]
    expect(countLearnedToday(logs, day)).toBe(2)
  })
})

describe('toDateKey', () => {
  it('输出 YYYY-MM-DD', () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05')
    expect(toDateKey(new Date(2026, 11, 31))).toBe('2026-12-31')
  })
})
