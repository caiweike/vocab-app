import { beforeEach, describe, expect, it } from 'vitest'
import { isSessionLive, useLearnStore } from '@/state/learn'
import { toDateKey, type QueueItem } from '@/core/queue'
import { Rating } from '@/core/srs'

function queueOf(n: number): QueueItem[] {
  return Array.from({ length: n }, (_, i) => ({ word: `w${i}`, isNew: true }))
}

const store = () => useLearnStore.getState()

beforeEach(() => {
  store().reset()
})

describe('begin', () => {
  it('建会话并记录词书与日期', () => {
    store().begin({ bookId: 'cet4', queue: queueOf(3) })
    const s = store().session
    expect(s?.bookId).toBe('cet4')
    expect(s?.dateKey).toBe(toDateKey())
    expect(s?.queue).toHaveLength(3)
    expect(s?.cursor).toBe(0)
    expect(s?.finished).toBe(false)
  })

  it('空队列直接进入完成态（今日配额已学完）', () => {
    store().begin({ bookId: 'cet4', queue: [] })
    expect(store().session?.finished).toBe(true)
  })
})

describe('advance', () => {
  beforeEach(() => {
    store().begin({ bookId: 'cet4', queue: queueOf(3) })
    store().setTyped('hello')
    store().setFeedback({ correct: true, chosen: 'hello' })
  })

  it('答对时队列不变，只推进游标并清空作答状态', () => {
    store().advance({ rating: Rating.Good, correct: true, kind: 'zh2en' })
    const s = store().session
    expect(s?.queue).toHaveLength(3)
    expect(s?.cursor).toBe(1)
    expect(s?.feedback).toBeNull()
    expect(s?.typed).toBe('')
    expect(s?.results).toHaveLength(1)
    expect(s?.results[0]).toMatchObject({ word: 'w0', correct: true, kind: 'zh2en' })
  })

  it('答错时错词延后 4 题重现，队列变长', () => {
    store().begin({ bookId: 'cet4', queue: queueOf(8) })
    store().setFeedback({ correct: false, chosen: 'x' })
    store().advance({ rating: Rating.Again, correct: false, kind: 'en2zh' })

    const s = store().session
    expect(s?.cursor).toBe(1)
    expect(s?.queue).toHaveLength(9)
    expect(s?.queue[5]?.word).toBe('w0')
    expect(s?.queue[5]?.attempts).toBe(1)
    expect(s?.queue[5]?.isNew).toBe(false)
    expect(s?.results[0]?.correct).toBe(false)
  })

  it('自评「不认识」也算需要重来，即使题目答对了', () => {
    store().begin({ bookId: 'cet4', queue: queueOf(8) })
    store().advance({ rating: Rating.Again, correct: true, kind: 'en2zh' })
    expect(store().session?.queue).toHaveLength(9)
  })

  it('requeue:false 时不塞回队列——标了「熟练」的词当轮也不再出现', () => {
    store().begin({ bookId: 'cet4', queue: queueOf(8) })
    store().setFeedback({ correct: false, chosen: 'x' })
    store().advance({ rating: Rating.Again, correct: false, kind: 'en2zh', requeue: false })

    const s = store().session
    expect(s?.queue).toHaveLength(8)
    expect(s?.cursor).toBe(1)
    expect(s?.finished).toBe(false)
  })

  it('做到队尾进入完成态', () => {
    store().advance({ rating: Rating.Good, correct: true, kind: 'zh2en' })
    store().advance({ rating: Rating.Good, correct: true, kind: 'zh2en' })
    store().advance({ rating: Rating.Good, correct: true, kind: 'zh2en' })
    const s = store().session
    expect(s?.cursor).toBe(3)
    expect(s?.finished).toBe(true)
    expect(s?.results).toHaveLength(3)
  })

  it('没有会话时调用是安全的', () => {
    store().reset()
    expect(() => store().advance({ rating: Rating.Good, correct: true, kind: 'zh2en' })).not.toThrow()
    expect(store().session).toBeNull()
  })
})

describe('hint', () => {
  it('点提示逐次累加，进入下一题时归零', () => {
    store().begin({ bookId: 'cet4', queue: queueOf(2) })
    expect(store().session?.hints).toBe(0)

    store().hint()
    store().hint()
    expect(store().session?.hints).toBe(2)

    store().setFeedback({ correct: false, chosen: '' })
    store().advance({ rating: Rating.Again, correct: false, kind: 'zh2en' })
    expect(store().session?.hints).toBe(0)
  })

  it('没有会话时点提示是安全的', () => {
    store().reset()
    expect(() => store().hint()).not.toThrow()
    expect(store().session).toBeNull()
  })
})

describe('isSessionLive', () => {
  const base = {
    bookId: 'cet4',
    dateKey: toDateKey(),
    queue: queueOf(1),
    cursor: 0,
    feedback: null,
    typed: '',
    hints: 0,
    results: [],
    finished: false,
    startedAt: 0,
  }

  it('同一天同一本词书才算有效', () => {
    expect(isSessionLive(base, 'cet4')).toBe(true)
  })

  it('换词书后旧会话作废', () => {
    expect(isSessionLive(base, 'ky')).toBe(false)
  })

  it('跨天后旧会话作废', () => {
    expect(isSessionLive({ ...base, dateKey: '2020-01-01' }, 'cet4')).toBe(false)
  })

  it('没有会话或没选词书时无效', () => {
    expect(isSessionLive(null, 'cet4')).toBe(false)
    expect(isSessionLive(base, null)).toBe(false)
  })
})
