import { db } from '@/db'
import type { ReviewLogRecord, SessionRecord, SrsRecord } from '@/core/types'
import { toDateKey } from '@/core/queue'

/**
 * 落一次评分：更新卡片状态 + 写复习日志 + 累加当日会话统计。
 * 放在同一事务里，保证"卡片推进"和"统计"不会对不上。
 *
 * `countInSession` 用于错词的当轮重做：重试同样要推进 FSRS、留复习日志，
 * 但不能让 sessions 的计数翻倍——统计口径是"今天学过哪些词"，一个词只算一次。
 */
export async function recordReview(params: {
  next: SrsRecord
  log: Omit<ReviewLogRecord, 'id'>
  isNewWord: boolean
  correct: boolean
  countInSession?: boolean
}): Promise<void> {
  const { next, log, isNewWord, correct } = params
  const count = params.countInSession ?? true
  const date = toDateKey()

  await db.transaction('rw', db.srs, db.reviewLog, db.sessions, async () => {
    await db.srs.put({ ...next, wordId: log.wordId })
    await db.reviewLog.add({ ...log, wordId: log.wordId })

    if (!count) return

    const existing = await db.sessions.get(date)
    const base: SessionRecord = existing ?? {
      date,
      newCount: 0,
      reviewCount: 0,
      correct: 0,
      wrong: 0,
      durationSec: 0,
    }
    await db.sessions.put({
      ...base,
      newCount: base.newCount + (isNewWord ? 1 : 0),
      reviewCount: base.reviewCount + (isNewWord ? 0 : 1),
      correct: base.correct + (correct ? 1 : 0),
      wrong: base.wrong + (correct ? 0 : 1),
    })
  })
}

/** 累加学习时长（学习结束时调一次） */
export async function addDuration(seconds: number): Promise<void> {
  if (seconds <= 0) return
  const date = toDateKey()
  const existing = await db.sessions.get(date)
  const base: SessionRecord = existing ?? {
    date,
    newCount: 0,
    reviewCount: 0,
    correct: 0,
    wrong: 0,
    durationSec: 0,
  }
  await db.sessions.put({ ...base, durationSec: base.durationSec + Math.round(seconds) })
}
