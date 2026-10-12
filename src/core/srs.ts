import { createEmptyCard, fsrs, Rating, State, type Card, type Grade } from 'ts-fsrs'
import type { ReviewLogRecord, SrsRecord } from '@/core/types'

export { Rating, State }

/** 用户给一次作答的评分：1 不认识 / 2 模糊 / 3 认识 / 4 秒懂 */
export type UserRating = 1 | 2 | 3 | 4

export const RATING_LABELS: Record<number, string> = {
  [Rating.Again]: '不认识',
  [Rating.Hard]: '模糊',
  [Rating.Good]: '认识',
  [Rating.Easy]: '秒懂',
}

/** 反馈区的评分按钮：档位 + 显示名 */
export interface RatingChoice {
  rating: UserRating
  label: string
}

/**
 * 反馈区要展示哪几个评分按钮（固定三档，只是第一个档的叫法会变）。
 *
 * 答对 + 选择题时第一个档叫「忘记了」—— 选择题可能蒙对，得让用户能纠正
 * "以为自己记对了"；这时不再显示「不认识」，因为答错那一侧已经自动记「不认识」了，
 * 两个同时出现就是重复。拼写题手打出来的答案蒙不对，仍然叫「不认识」。
 */
export function ratingChoices(correct: boolean, canForget: boolean): RatingChoice[] {
  const first: RatingChoice = correct && canForget
    ? { rating: Rating.Again, label: '忘记了' }
    : { rating: Rating.Again, label: RATING_LABELS[Rating.Again] }
  return [
    first,
    { rating: Rating.Hard, label: RATING_LABELS[Rating.Hard] },
    { rating: Rating.Good, label: RATING_LABELS[Rating.Good] },
  ]
}

export interface SrsConfig {
  requestRetention: number
  maximumInterval: number
}

const DEFAULT_CONFIG: SrsConfig = { requestRetention: 0.9, maximumInterval: 36500 }

function engine(config: SrsConfig = DEFAULT_CONFIG) {
  return fsrs({
    request_retention: config.requestRetention,
    maximum_interval: config.maximumInterval,
    enable_fuzz: true,
    // 保留短期学习步骤：不认识的词 1-10 分钟后就会再出现，
    // 当天可以反复练；关掉的话答错要等到第二天。
    enable_short_term: true,
  })
}

/**
 * 存库记录 ↔ ts-fsrs Card 互转。
 * ts-fsrs 用 Date，Dexie 里存 epoch 毫秒 —— 这样 JSON 备份才能无损往返。
 */
export function toCard(rec: SrsRecord): Card {
  return {
    due: new Date(rec.due),
    last_review: rec.lastReview === null ? undefined : new Date(rec.lastReview),
    stability: rec.stability,
    difficulty: rec.difficulty,
    elapsed_days: rec.elapsedDays,
    scheduled_days: rec.scheduledDays,
    reps: rec.reps,
    lapses: rec.lapses,
    state: rec.state as State,
    learning_steps: rec.learningSteps,
  }
}

export function toRecord(wordId: string, card: Card): SrsRecord {
  return {
    wordId,
    state: card.state as SrsRecord['state'],
    stability: card.stability,
    difficulty: card.difficulty,
    due: card.due.getTime(),
    lastReview: card.last_review ? card.last_review.getTime() : null,
    reps: card.reps,
    lapses: card.lapses,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps ?? 0,
  }
}

/** 是否是"从没学过"的词 */
export function isNew(rec: SrsRecord | undefined): boolean {
  return rec === undefined || rec.state === State.New
}

/** 按评分推进一步，返回新记录与写日志所需的字段 */
export function advance(
  rec: SrsRecord | undefined,
  rating: UserRating,
  config: SrsConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): { next: SrsRecord; log: Omit<ReviewLogRecord, 'id'> } {
  const card = rec === undefined ? createEmptyCard(now) : toCard(rec)
  const before = {
    state: card.state as SrsRecord['state'],
    stability: card.stability,
    difficulty: card.difficulty,
  }
  const { card: nextCard, log } = engine(config).next(card, now, rating as Grade)

  return {
    next: toRecord(rec?.wordId ?? '', nextCard),
    log: {
      wordId: rec?.wordId ?? '',
      rating,
      at: now.getTime(),
      stateBefore: before.state,
      stabilityBefore: before.stability,
      difficultyBefore: before.difficulty,
      interval: log.scheduled_days,
    },
  }
}

/** 预览四种评分各自的结果，用于在评分按钮上显示"下次 x 天后" */
export function previewIntervals(
  rec: SrsRecord | undefined,
  config: SrsConfig = DEFAULT_CONFIG,
  now: Date = new Date(),
): Record<number, string> {
  const card = rec === undefined ? createEmptyCard(now) : toCard(rec)
  const preview = engine(config).repeat(card, now)
  const out: Record<number, string> = {}
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]) {
    const item = preview[r]
    out[r as number] = formatInterval(item.card.scheduled_days, item.card.state)
  }
  return out
}

function formatInterval(days: number, state: State): string {
  // 学习步骤以分钟计，当天还会再见
  if (state === State.Learning || state === State.Relearning) return '今天'
  if (days < 1) return '今天'
  if (days < 30) return `${Math.round(days)} 天`
  if (days < 365) return `${Math.round(days / 30)} 个月`
  return `${(days / 365).toFixed(1)} 年`
}

/** 记忆掌握程度：稳定天数 → 四档 */
export type Mastery = 'new' | 'learning' | 'reviewing' | 'mastered'

export function masteryOf(rec: SrsRecord | undefined): Mastery {
  if (rec === undefined || rec.state === State.New) return 'new'
  if (rec.state === State.Learning || rec.state === State.Relearning) return 'learning'
  if (rec.stability >= 21) return 'mastered'
  return 'reviewing'
}
