import { describe, expect, it } from 'vitest'
import {
  calcStreak,
  checkedInToday,
  dailyStats,
  heatmap,
  masteryBreakdown,
  retentionRate,
} from '@/core/stats'
import { parseWordList } from '@/core/importers'
import type { Mastery } from '@/core/srs'
import type { ReviewLogRecord, SessionRecord } from '@/core/types'

function session(date: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return { date, newCount: 0, reviewCount: 0, correct: 0, wrong: 0, durationSec: 0, ...over }
}

function daysAgo(n: number, now: Date): Date {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  return d
}

describe('calcStreak', () => {
  const now = new Date('2026-10-04T12:00:00')
  const key = (d: Date) =>
    `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`

  it('今天没学不算断签，从昨天起算', () => {
    const s = [session(key(daysAgo(1, now)), { newCount: 10 }), session(key(daysAgo(2, now)), { newCount: 10 })]
    expect(calcStreak(s, now)).toBe(2)
  })

  it('今天也学了则算到今天', () => {
    const s = [
      session(key(now), { reviewCount: 5 }),
      session(key(daysAgo(1, now)), { newCount: 10 }),
      session(key(daysAgo(2, now)), { newCount: 10 }),
    ]
    expect(calcStreak(s, now)).toBe(3)
  })

  it('中间断了就重新数', () => {
    const s = [
      session(key(daysAgo(1, now)), { newCount: 5 }),
      session(key(daysAgo(3, now)), { newCount: 5 }),
    ]
    expect(calcStreak(s, now)).toBe(1)
  })

  it('完全没有记录为 0', () => {
    expect(calcStreak([], now)).toBe(0)
    // 有记录但当天学习量都是 0 也不算打卡
    expect(calcStreak([session(key(daysAgo(1, now)))], now)).toBe(0)
  })
})

describe('checkedInToday', () => {
  const now = new Date('2026-10-04T12:00:00')
  it('今天有学习量才算打卡', () => {
    expect(checkedInToday([session('2026-10-04', { newCount: 3 })], now)).toBe(true)
    expect(checkedInToday([session('2026-10-04')], now)).toBe(false)
    expect(checkedInToday([session('2026-10-03', { newCount: 3 })], now)).toBe(false)
  })
})

describe('dailyStats / heatmap', () => {
  const now = new Date('2026-10-04T12:00:00')

  it('补齐没有记录的日期', () => {
    const out = dailyStats([session('2026-10-04', { newCount: 5, correct: 8, wrong: 2 })], 7, now)
    expect(out).toHaveLength(7)
    expect(out.at(-1)).toMatchObject({ date: '2026-10-04', news: 5, reviews: 5, accuracy: 80 })
    expect(out[0].reviews).toBe(0)
  })

  it('没有作答时正确率为 0 而不是 NaN', () => {
    const out = dailyStats([], 1, now)
    expect(out[0].accuracy).toBe(0)
  })

  it('热力图按学习量分 5 档，输出从旧到新', () => {
    const out = heatmap(
      [session('2026-10-04', { newCount: 0 }), session('2026-10-03', { newCount: 10 }), session('2026-10-02', { newCount: 60 })],
      3,
      now,
    )
    expect(out.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04'])
    expect(out.map((d) => d.level)).toEqual([3, 1, 0])
  })
})

describe('masteryBreakdown', () => {
  it('分类计数且总数正确', () => {
    const list: Mastery[] = ['new', 'new', 'learning', 'reviewing', 'mastered', 'mastered']
    const out = masteryBreakdown(list)
    expect(out).toEqual({ new: 2, learning: 1, reviewing: 1, mastered: 2, total: 6 })
  })
})

describe('retentionRate', () => {
  const now = new Date('2026-10-04T12:00:00')
  const base = now.getTime()

  function log(rating: 1 | 2 | 3 | 4, at: number, stateBefore: 0 | 1 | 2 | 3 = 2): ReviewLogRecord {
    return {
      wordId: 'w',
      rating,
      at,
      stateBefore,
      stabilityBefore: 1,
      difficultyBefore: 5,
      interval: 1,
    }
  }

  it('没有到期复习记录时返回 null 而非 0', () => {
    expect(retentionRate([], 30, now)).toBeNull()
    expect(retentionRate([log(3, base, 0)], 30, now)).toBeNull()
  })

  it('只统计状态不为 New 的复习，答对率四舍五入', () => {
    const logs = [log(3, base - 86400000), log(4, base - 86400000), log(1, base - 86400000), log(3, base - 86400000)]
    expect(retentionRate(logs, 30, now)).toBe(75)
  })
})

describe('parseWordList', () => {
  it('识别 Tab 分隔', () => {
    const r = parseWordList('abandon\t放弃\nability\t能力\n')
    expect(r.format).toBe('tab')
    expect(r.rows).toEqual([
      { word: 'abandon', meaning: '放弃' },
      { word: 'ability', meaning: '能力' },
    ])
  })

  it('识别 CSV（释义里的逗号不拆错）', () => {
    const r = parseWordList('abandon,"放弃, 抛弃"\nability,能力\n')
    expect(r.format).toBe('csv')
    expect(r.rows[0].meaning).toContain('放弃')
    expect(r.rows[0].meaning).toContain('抛弃')
    expect(r.rows[1].word).toBe('ability')
  })

  it('每行一个单词', () => {
    const r = parseWordList('alpha\nbeta\ngamma')
    expect(r.format).toBe('plain')
    expect(r.rows.map((x) => x.word)).toEqual(['alpha', 'beta', 'gamma'])
    expect(r.rows[0].meaning).toBeUndefined()
  })

  it('去重、跳过表头与非英文行', () => {
    const r = parseWordList('abandon,"放弃, 抛弃"\nABANDON,重复\n1234,数字\n,空行\n')
    expect(r.rows).toEqual([{ word: 'abandon', meaning: '放弃, 抛弃' }])
    expect(r.duplicates).toEqual(['ABANDON'])
    expect(r.skipped).toBe(2)
  })

  it('容忍 CRLF 与 BOM', () => {
    const r = parseWordList('\uFEFFabandon\t放弃\r\nability\t能力\r\n')
    expect(r.rows.map((x) => x.word)).toEqual(['abandon', 'ability'])
  })

  it('空输入返回空结果', () => {
    const r = parseWordList('')
    expect(r.rows).toHaveLength(0)
    expect(r.duplicates).toHaveLength(0)
  })

  it('带连字符与撇号的单词被保留', () => {
    const r = parseWordList("mother-in-law\nit's\nco-operate")
    expect(r.rows.map((x) => x.word)).toEqual(["mother-in-law", "it's", 'co-operate'])
  })
})
