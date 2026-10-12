import type { ReviewLogRecord, SessionRecord, SrsRecord } from '@/core/types'
import type { Mastery } from '@/core/srs'
import { startOfDay, toDateKey } from '@/core/queue'

/** 连续打卡天数：从今天（或昨天，若今天还没学）往前数连续有学习记录的日子 */
export function calcStreak(sessions: SessionRecord[], now = new Date()): number {
  const learned = new Set(sessions.filter((s) => s.newCount + s.reviewCount > 0).map((s) => s.date))
  if (learned.size === 0) return 0

  const cursor = startOfDay(now)
  // 今天还没学，从昨天开始数，不打断连续性
  if (!learned.has(toDateKey(cursor))) cursor.setDate(cursor.getDate() - 1)

  let streak = 0
  while (learned.has(toDateKey(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** 是否已打卡（今天学过） */
export function checkedInToday(sessions: SessionRecord[], now = new Date()): boolean {
  const key = toDateKey(now)
  const s = sessions.find((x) => x.date === key)
  return s !== undefined && s.newCount + s.reviewCount > 0
}

export interface DayStat {
  date: string
  reviews: number
  news: number
  accuracy: number
}

export function dailyStats(sessions: SessionRecord[], days: number, now = new Date()): DayStat[] {
  const map = new Map(sessions.map((s) => [s.date, s]))
  const out: DayStat[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = startOfDay(now)
    d.setDate(d.getDate() - i)
    const key = toDateKey(d)
    const s = map.get(key)
    const total = (s?.correct ?? 0) + (s?.wrong ?? 0)
    out.push({
      date: key,
      reviews: (s?.reviewCount ?? 0) + (s?.newCount ?? 0),
      news: s?.newCount ?? 0,
      accuracy: total > 0 ? Math.round(((s?.correct ?? 0) / total) * 100) : 0,
    })
  }
  return out
}

/** 打卡热力图数据：近半年每天的学习量 */
export interface HeatmapDay {
  date: string
  count: number
  level: 0 | 1 | 2 | 3 | 4
}

export function heatmap(sessions: SessionRecord[], days = 182, now = new Date()): HeatmapDay[] {
  const map = new Map(sessions.map((s) => [s.date, s.newCount + s.reviewCount]))
  const out: HeatmapDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = startOfDay(now)
    d.setDate(d.getDate() - i)
    const key = toDateKey(d)
    const count = map.get(key) ?? 0
    out.push({ date: key, count, level: levelOf(count) })
  }
  return out
}

function levelOf(n: number): 0 | 1 | 2 | 3 | 4 {
  if (n === 0) return 0
  if (n < 20) return 1
  if (n < 50) return 2
  if (n < 100) return 3
  return 4
}

export interface MasteryBreakdown {
  new: number
  learning: number
  reviewing: number
  mastered: number
  total: number
}

export function masteryBreakdown(all: Mastery[]): MasteryBreakdown {
  const acc: Record<Mastery, number> = { new: 0, learning: 0, reviewing: 0, mastered: 0 }
  for (const m of all) acc[m]++
  return { ...acc, total: all.length }
}

/**
 * 实际记忆保持率：过去 N 天内到期复习里，被评分为"认识/秒懂"的比例。
 * 这是比"主观感觉记住多少"更可信的指标。
 */
export function retentionRate(logs: ReviewLogRecord[], days = 30, now = new Date()): number | null {
  const cutoff = startOfDay(now).getTime() - (days - 1) * 86400000
  const recent = logs.filter((l) => l.at >= cutoff && l.stateBefore !== 0)
  if (recent.length === 0) return null
  const ok = recent.filter((l) => l.rating >= 3).length
  return Math.round((ok / recent.length) * 100)
}

/** 预测未来 30 天每天的到期复习量，用于首页"即将到来"提示 */
export function forecast(srs: SrsRecord[], days = 7, now = new Date()): { date: string; count: number }[] {
  const base = startOfDay(now).getTime()
  const out: { date: string; count: number }[] = []
  for (let i = 0; i < days; i++) {
    const from = base + i * 86400000
    const to = from + 86400000
    const count = srs.filter((r) => r.due >= from && r.due < to).length
    const d = new Date(from)
    out.push({ date: toDateKey(d), count })
  }
  return out
}
