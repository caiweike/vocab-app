import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { requeueAfterFailure, toDateKey, type QueueItem } from '@/core/queue'
import type { Exercise } from '@/core/exercises'
import { Rating, type UserRating } from '@/core/srs'

export interface SessionResult {
  word: string
  rating: UserRating
  /** 作答的真实对错；与 rating（主观自评）是两回事 */
  correct: boolean
  kind: Exercise['kind']
  at: number
}

export interface Feedback {
  correct: boolean
  chosen: string
  /** 答题阶段就点了「忘记了」—— 这种情况只留一个「下一题」，不用再选档 */
  forgot?: boolean
}

/**
 * 一次学习会话的全部状态。
 *
 * 放在 store 而不是组件 state 里，是因为组件卸载（点底部导航去别的页）就等于
 * 丢失进度——SRS 已经落库、配额已经被消耗，进度条却会归零。
 * 再加 localStorage 持久化，刷新页面也能接着做。
 */
export interface LearnSession {
  bookId: string
  /** 开局日期，跨天作废重新排队 */
  dateKey: string
  queue: QueueItem[]
  /** 当前做到第几题 */
  cursor: number
  feedback: Feedback | null
  /** 拼写题的输入内容，切页回来还在 */
  typed: string
  /** 本题已经点过几次「提示」 */
  hints: number
  results: SessionResult[]
  finished: boolean
  startedAt: number
}

/** 会话是否仍然有效：同一天、同一本词书 */
export function isSessionLive(
  session: LearnSession | null,
  bookId: string | null,
): session is LearnSession {
  if (session === null || bookId === null) return false
  return session.bookId === bookId && session.dateKey === toDateKey()
}

/** 隐私模式下 localStorage 读写会抛错，全部吞掉 —— 最坏情况只是不持久化 */
const memorySafeStorage = createJSONStorage(() => ({
  getItem: (key: string) => {
    try {
      return window.localStorage.getItem(key)
    } catch {
      return null
    }
  },
  setItem: (key: string, value: string) => {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* 忽略 */
    }
  },
  removeItem: (key: string) => {
    try {
      window.localStorage.removeItem(key)
    } catch {
      /* 忽略 */
    }
  },
}))

interface LearnStore {
  session: LearnSession | null
  /** 开新一轮。空队列 = 今日配额已用完 */
  begin: (params: { bookId: string; queue: QueueItem[] }) => void
  setTyped: (value: string) => void
  setFeedback: (feedback: Feedback | null) => void
  /** 拼写题点「提示」，逐个揭示字母；换下一题时归零 */
  hint: () => void
  /** 记一次评分并前进；默认答错或自评不认识的词延后重现（`requeue: false` 关掉） */
  advance: (params: {
    rating: UserRating
    correct: boolean
    kind: Exercise['kind']
    requeue?: boolean
  }) => void
  reset: () => void
}

export const useLearnStore = create<LearnStore>()(
  persist(
    (set) => ({
      session: null,

      begin: ({ bookId, queue }) =>
        set({
          session: {
            bookId,
            dateKey: toDateKey(),
            queue,
            cursor: 0,
            feedback: null,
            typed: '',
            hints: 0,
            results: [],
            finished: queue.length === 0,
            startedAt: Date.now(),
          },
        }),

      setTyped: (value) =>
        set((s) => (s.session === null ? s : { session: { ...s.session, typed: value } })),

      setFeedback: (feedback) =>
        set((s) => (s.session === null ? s : { session: { ...s.session, feedback } })),

      hint: () =>
        set((s) =>
          s.session === null ? { session: null } : { session: { ...s.session, hints: s.session.hints + 1 } },
        ),

      advance: ({ rating, correct, kind, requeue = true }) =>
        set((s) => {
          const ses = s.session
          if (ses === null) return { session: null }
          const item = ses.queue[ses.cursor]
          if (item === undefined) return { session: { ...ses, finished: true } }

          // 标了「熟练」就别再往队列里塞了，否则当轮还会再见到这个词
          const shouldRetry = requeue && (!correct || rating <= Rating.Hard)
          const queue = shouldRetry ? requeueAfterFailure(ses.queue, ses.cursor, item) : ses.queue
          const cursor = ses.cursor + 1

          return {
            session: {
              ...ses,
              queue,
              cursor,
              results: [...ses.results, { word: item.word, rating, correct, kind, at: Date.now() }],
              finished: cursor >= queue.length,
              feedback: null,
              typed: '',
              hints: 0,
            },
          }
        }),

      reset: () => set({ session: null }),
    }),
    {
      name: 'vocab.learn.session',
      version: 1,
      storage: memorySafeStorage,
      partialize: (s) => ({ session: s.session }),
    },
  ),
)
