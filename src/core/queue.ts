import { State } from 'ts-fsrs'
import type { SrsRecord } from '@/core/types'

export interface QueueConfig {
  /** 每日新词上限 */
  dailyNew: number
  /** 每日复习上限（0 = 不限制） */
  dailyReview: number
}

export interface QueueItem {
  word: string
  /** true = 这是本轮第一次见到的词 */
  isNew: boolean
  /**
   * 这是第几次排进队列（首次为 0）。
   * 答错的词会带着更高的 attempts 延后重现，达到上限就留给明天。
   */
  attempts?: number
  srs?: SrsRecord
}

export interface BuildQueueInput {
  /** 当前词书范围内的所有单词 */
  words: string[]
  srsByWord: Map<string, SrsRecord>
  config: QueueConfig
  /** 当天已学的新词数，用于跨会话累加配额 */
  learnedToday: number
  now?: Date
}

export interface BuildQueueResult {
  review: QueueItem[]
  fresh: QueueItem[]
  /** 还剩多少个到期复习没排进队列（用于首页提示"还欠 N 个"） */
  remainingReviews: number
}

/**
 * 今日队列：先排到期复习，再补新词。
 *
 * 复习优先级：Learning/Relearning 到期（分钟级，最紧急）> Review 到期 > 新词。
 * 新词数量受 dailyNew 与今日已学数共同限制，跨会话累加不超额。
 */
export function buildQueue(input: BuildQueueInput): BuildQueueResult {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()

  const due: QueueItem[] = []
  const pendingNew: string[] = []

  for (const word of input.words) {
    const rec = input.srsByWord.get(word)
    if (rec === undefined || rec.state === State.New) {
      pendingNew.push(word)
      continue
    }
    if (rec.due <= nowMs) due.push({ word, isNew: false, srs: rec })
  }

  due.sort((a, b) => {
    const rank = (r: SrsRecord) =>
      r.state === State.Learning || r.state === State.Relearning ? 0 : 1
    const ra = rank(a.srs!)
    const rb = rank(b.srs!)
    if (ra !== rb) return ra - rb
    return a.srs!.due - b.srs!.due
  })

  const limit = input.config.dailyReview
  const review = limit > 0 ? due.slice(0, limit) : due
  const remainingReviews = due.length - review.length

  const newQuota = Math.max(0, input.config.dailyNew - input.learnedToday)
  const fresh = pendingNew.slice(0, newQuota).map((word) => ({ word, isNew: true }))

  return { review, fresh, remainingReviews }
}

export interface RequeueOptions {
  /** 从当前题往后隔几题重现 */
  delay?: number
  /** 同一个词一轮内最多重做几次 */
  maxAttempts?: number
}

/**
 * 答错的词延后重现，让"不认识"当轮就能再练一次，而不是等到明天。
 *
 * 插入位置是 `cursor + 1 + delay`：当前题答完后游标会走到 `cursor + 1`，
 * 于是中间正好隔 `delay` 道别的题。`maxAttempts` 给重试封顶，
 * 否则一个词反复答错会让本轮永远结束不了。
 */
export function requeueAfterFailure(
  queue: QueueItem[],
  cursor: number,
  item: QueueItem,
  opts: RequeueOptions = {},
): QueueItem[] {
  const delay = opts.delay ?? 4
  const maxAttempts = opts.maxAttempts ?? 2
  const attempts = item.attempts ?? 0
  if (attempts >= maxAttempts) return queue

  const retry: QueueItem = { ...item, isNew: false, attempts: attempts + 1 }
  const at = Math.min(cursor + 1 + delay, queue.length)
  return [...queue.slice(0, at), retry, ...queue.slice(at)]
}

/** 今日已学新词数：从复习日志里数当天第一次被评分的词 */
export function countLearnedToday(logs: { at: number; wordId: string }[], now = new Date()): number {
  const dayStart = startOfDay(now).getTime()
  const seen = new Set<string>()
  for (const l of logs) {
    if (l.at >= dayStart && !seen.has(l.wordId)) seen.add(l.wordId)
  }
  return seen.size
}

/**
 * 今天学的**新词**，按首次出现顺序去重。
 *
 * 用 `stateBefore === 0` 判断：只有"评分前还是 New"的那一次算新词 ——
 * 同一个词答错被重排后第二次评分 stateBefore 已经是 Learning，会被排除；
 * 今天复习的到期词 stateBefore 是 Review，同样排除。
 *
 * 段落的目标词必须走这个，否则会掺进一堆已经熟的复习词，
 * 读起来全是熟词，失去"在语境里认识新词"的意义。
 */
export function newWordsLearnedToday(
  logs: { at: number; wordId: string; stateBefore: number }[],
  dayStart: number,
): string[] {
  const seen = new Set<string>()
  for (const l of logs) {
    if (l.at >= dayStart && l.stateBefore === 0) seen.add(l.wordId)
  }
  return [...seen]
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function toDateKey(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  const day = `${d.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${day}`
}
