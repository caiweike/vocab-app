import { describe, expect, it } from 'vitest'
import { advance, isNew, masteryOf, previewIntervals, Rating, ratingChoices, State, toCard, toRecord } from '@/core/srs'
import type { SrsRecord } from '@/core/types'

const CONFIG = { requestRetention: 0.9, maximumInterval: 36500 }

function reviewRec(due: number): SrsRecord {
  return {
    wordId: 'w',
    state: State.Review,
    stability: 5,
    difficulty: 5,
    due,
    lastReview: due - 5 * 86400000,
    reps: 3,
    lapses: 0,
    elapsedDays: 5,
    scheduledDays: 5,
    learningSteps: 0,
  }
}

describe('ratingChoices', () => {
  const labels = (correct: boolean, canForget: boolean) =>
    ratingChoices(correct, canForget).map((c) => c.label)

  it('四选一答对时第一个档叫「忘记了」，不再重复出现「不认识」', () => {
    const choices = ratingChoices(true, true)
    expect(labels(true, true)).toEqual(['忘记了', '模糊', '认识'])
    expect(choices).toHaveLength(3)
    expect(choices[0]?.rating).toBe(Rating.Again)
    expect(labels(true, true)).not.toContain('不认识')
  })

  it('答错时第一个档仍叫「不认识」', () => {
    expect(labels(false, true)).toEqual(['不认识', '模糊', '认识'])
  })

  it('拼写题手打蒙不对，答对也叫「不认识」', () => {
    expect(labels(true, false)).toEqual(['不认识', '模糊', '认识'])
  })
})

describe('toCard / toRecord 往返', () => {
  it('Date 与 epoch 毫秒互相转换后字段一致', () => {
    const rec = reviewRec(Date.parse('2026-10-10T00:00:00Z'))
    const card = toCard(rec)
    expect(card.due).toBeInstanceOf(Date)
    expect(card.last_review).toBeInstanceOf(Date)
    const back = toRecord(rec.wordId, card)
    expect(back).toEqual(rec)
  })

  it('lastReview 为 null 时往返保持 null（而不是 0）', () => {
    const rec: SrsRecord = { ...reviewRec(0), state: State.New, lastReview: null, stability: 0, reps: 0 }
    const back = toRecord('w', toCard(rec))
    expect(back.lastReview).toBeNull()
  })
})

describe('advance', () => {
  const now = new Date('2026-10-04T10:00:00')

  it('认识/秒懂会把复习时间推到未来', () => {
    const rec = reviewRec(now.getTime())
    for (const r of [Rating.Good, Rating.Easy] as const) {
      const { next } = advance(rec, r, CONFIG, now)
      expect(next.due).toBeGreaterThan(now.getTime())
      expect(next.lastReview).toBe(now.getTime())
      expect(next.reps).toBe(rec.reps + 1)
    }
  })

  it('不认识会把状态打回学习中并增加遗忘次数', () => {
    const rec = reviewRec(now.getTime())
    const { next } = advance(rec, Rating.Again, CONFIG, now)
    expect([State.Learning, State.Relearning]).toContain(next.state)
    expect(next.lapses).toBe(rec.lapses + 1)
  })

  it('未学过的词用空卡起步，state 变为学习中', () => {
    const { next } = advance(undefined, Rating.Good, CONFIG, now)
    expect(next.state).not.toBe(State.New)
    expect(next.wordId).toBe('')
  })

  it('返回的日志记录了评分前的状态与本次间隔', () => {
    const rec = reviewRec(now.getTime())
    const { log } = advance(rec, Rating.Good, CONFIG, now)
    expect(log.rating).toBe(Rating.Good)
    expect(log.stateBefore).toBe(State.Review)
    expect(log.stabilityBefore).toBe(5)
    expect(log.interval).toBeGreaterThan(0)
    expect(log.at).toBe(now.getTime())
  })

  it('多次评分后稳定天数会增长（确实学进去了）', () => {
    let rec: SrsRecord | undefined = undefined
    const base = now.getTime()
    for (let i = 0; i < 6; i++) {
      const at = new Date(base + i * 86400000)
      rec = advance(rec, Rating.Good, CONFIG, at).next
      rec.wordId = 'w'
    }
    expect(rec!.stability).toBeGreaterThan(5)
    expect(rec!.state).toBe(State.Review)
  })
})

describe('previewIntervals', () => {
  const now = new Date('2026-10-04T10:00:00')

  it('四种评分都有可读的间隔文案', () => {
    const out = previewIntervals(reviewRec(now.getTime()), CONFIG, now)
    expect(Object.keys(out)).toHaveLength(4)
    for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
      expect(typeof out[r]).toBe('string')
      expect(out[r].length).toBeGreaterThan(0)
    }
  })

  it('秒懂的间隔不短于认识', () => {
    const out = previewIntervals(reviewRec(now.getTime()), CONFIG, now)
    const parse = (s: string) => {
      const n = Number.parseFloat(s)
      if (s.includes('年')) return n * 365
      if (s.includes('个月')) return n * 30
      if (s.includes('天')) return n
      return 0
    }
    expect(parse(out[Rating.Easy])).toBeGreaterThanOrEqual(parse(out[Rating.Good]))
  })
})

describe('isNew / masteryOf', () => {
  it('未定义与 New 状态都算新词', () => {
    expect(isNew(undefined)).toBe(true)
    expect(isNew({ ...reviewRec(0), state: State.New })).toBe(true)
    expect(isNew(reviewRec(0))).toBe(false)
  })

  it('按状态与稳定天数分档', () => {
    expect(masteryOf(undefined)).toBe('new')
    expect(masteryOf({ ...reviewRec(0), state: State.Learning })).toBe('learning')
    expect(masteryOf({ ...reviewRec(0), state: State.Relearning })).toBe('learning')
    expect(masteryOf({ ...reviewRec(0), stability: 10 })).toBe('reviewing')
    expect(masteryOf({ ...reviewRec(0), stability: 30 })).toBe('mastered')
  })
})
