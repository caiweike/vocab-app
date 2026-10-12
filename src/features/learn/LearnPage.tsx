import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, PartyPopper, Volume2, X } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button, Card, Empty, ProgressBar, SectionTitle } from '@/components/ui'
import { ExampleBlock, WordDetail } from '@/components/WordDetail'
import {
  useActiveBookId,
  useBookWords,
  useProficientSet,
  useRecentPassages,
  useSettings,
  useSrsMap,
  useWords,
} from '@/hooks'
import { buildQueue, countLearnedToday, toDateKey, type QueueItem } from '@/core/queue'
import {
  advance,
  isNew,
  previewIntervals,
  Rating,
  ratingChoices,
  type SrsConfig,
  type UserRating,
} from '@/core/srs'
import { isSpellingCorrect, makeExercise, pickKind, spellingHint, type Exercise } from '@/core/exercises'
import { addDuration, recordReview } from '@/db/review'
import { db } from '@/db'
import { speak } from '@/ports/tts'
import { autoExample, loadExample } from '@/lib/example'
import { isSessionLive, useLearnStore } from '@/state/learn'
import { useUiStore } from '@/state/ui'

/** 例句预取窗口：往前生成几题，够覆盖答题速度就行 */
const PREFETCH = 4

/**
 * 只留三档，三个并列。原来四档里「秒懂」和「认识」用户根本区分不开，
 * 真想跳过某个词用卡片上的「熟练」，点一下直接进下一题。
 */
const RATING_TONE: Record<number, string> = {
  [Rating.Again]: 'border-rose-300 text-rose-700 hover:bg-rose-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950',
  [Rating.Hard]: 'border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950',
  [Rating.Good]: 'border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950',
}

export function LearnPage() {
  const toast = useUiStore((s) => s.showToast)

  const bookId = useActiveBookId()
  const words = useBookWords(bookId)
  const wordRecords = useWords(words)
  const srsMap = useSrsMap(words)
  const passages = useRecentPassages(20)
  const proficient = useProficientSet()
  const { settings } = useSettings()

  const session = useLearnStore((s) => s.session)
  const begin = useLearnStore((s) => s.begin)
  const setTyped = useLearnStore((s) => s.setTyped)
  const setFeedback = useLearnStore((s) => s.setFeedback)
  const hint = useLearnStore((s) => s.hint)
  const advanceSession = useLearnStore((s) => s.advance)

  const [submitting, setSubmitting] = useState(false)
  const buildingRef = useRef(false)
  const startedAtRef = useRef(0)

  const live = isSessionLive(session, bookId)

  const config: SrsConfig = useMemo(
    () => ({ requestRetention: Number(settings?.requestRetention ?? 0.9), maximumInterval: 36500 }),
    [settings?.requestRetention],
  )
  const dailyNew = Number(settings?.dailyNew ?? 20)
  const dailyReview = Number(settings?.dailyReview ?? 200)

  const today = toDateKey()
  const todaySession = useLiveQuery(() => db.sessions.get(today), [today])

  /** 已有有效会话就沿用；否则（首次 / 跨天 / 换词书）按配额重建队列 */
  useEffect(() => {
    if (!bookId || !words || !wordRecords || !srsMap || !settings) return
    if (words.length > 0 && wordRecords.length === 0) return
    if (live || buildingRef.current) return

    buildingRef.current = true
    void (async () => {
      try {
        const logs = await db.reviewLog.toArray()
        const built = buildQueue({
          // 标了「熟练」的词以后不再排进来
          words: words.filter((w) => !proficient.has(w)),
          srsByWord: srsMap,
          config: {
            dailyNew: Number(settings.dailyNew ?? 20),
            dailyReview: Number(settings.dailyReview ?? 200),
          },
          learnedToday: countLearnedToday(logs),
        })
        // await 期间可能已经建好了（快速切页再切回来、StrictMode 双跑），别把进度冲掉
        const existing = useLearnStore.getState().session
        if (existing && isSessionLive(existing, bookId)) return
        begin({ bookId, queue: [...built.review, ...built.fresh] })
        if (built.remainingReviews > 0) {
          toast(`今日复习量已达上限，还有 ${built.remainingReviews} 个到期词留到明天`)
        }
      } catch (e) {
        toast(`建队失败：${(e as Error).message}`)
      } finally {
        buildingRef.current = false
      }
    })()
  }, [bookId, words, wordRecords, srsMap, settings, proficient, live, begin, toast])

  const queue = session?.queue
  const cursor = session?.cursor ?? -1
  const current: QueueItem | undefined = live ? queue?.[cursor] : undefined
  const target = useMemo(
    () => (current && wordRecords ? wordRecords.find((w) => w.word === current.word) : undefined),
    [current, wordRecords],
  )
  const exercise = useMemo<Exercise | null>(() => {
    if (!current || !target || !wordRecords) return null
    return makeExercise({ word: target, pool: wordRecords, kind: pickKind(current.word) })
  }, [current, target, wordRecords])

  const feedback = session?.feedback ?? null
  const finished = Boolean(live && session?.finished)

  /** 提前把接下来几题的例句生成好，翻到那张卡时就是现成的，不用站着等网络 */
  useEffect(() => {
    if (!live || !queue || !wordRecords) return
    const upcoming = queue.slice(cursor + 1, cursor + 1 + PREFETCH).map((q) => q.word)
    if (upcoming.length === 0) return
    let cancelled = false
    void (async () => {
      for (const w of upcoming) {
        if (cancelled) return
        const rec = wordRecords.find((r) => r.word === w)
        if (!rec) continue
        if (await loadExample(w)) continue // 已经缓存过的直接跳过
        await autoExample(rec) // 串行：一次只打一个请求，不把上游打爆
      }
    })()
    return () => {
      cancelled = true
    }
  }, [live, queue, cursor, wordRecords])

  /**
   * 每道题进题就读一遍发音，用户不用自己点喇叭。
   * 只在换题时触发一次 —— 翻面、评分都不重播，否则一张卡会连读好几遍。
   */
  useEffect(() => {
    if (!exercise || !target) return
    speak(target.word)
  }, [exercise, target])

  /** 学习时长：结束时结一次账，中途切页/刷新由卸载兜底 */
  useEffect(() => {
    startedAtRef.current = Date.now()
  }, [session?.startedAt])

  useEffect(() => {
    if (!finished || startedAtRef.current <= 0) return
    const secs = Math.round((Date.now() - startedAtRef.current) / 1000)
    if (secs > 0) void addDuration(secs)
    startedAtRef.current = 0
  }, [finished])

  useEffect(
    () => () => {
      if (startedAtRef.current <= 0) return
      const secs = Math.round((Date.now() - startedAtRef.current) / 1000)
      if (secs > 0) void addDuration(secs)
    },
    [],
  )

  function submit(chosen: string) {
    if (!exercise || !target || !session || session.feedback) return
    const correct =
      exercise.kind === 'zh2en'
        ? isSpellingCorrect(chosen, exercise.answer, target.exchange)
        : chosen === exercise.answer
    setFeedback({ correct, chosen })
    // 进题读一遍、答完再读一遍，把读音和词形绑在一起
    speak(target.word)
  }

  /** 直接承认想不起来：走答错的记账，但跳过自评，只留一个「下一题」 */
  function forgot() {
    if (!exercise || !target || !session || session.feedback) return
    setFeedback({ correct: false, chosen: '', forgot: true })
    speak(target.word)
  }

  async function rate(rating: UserRating, opts?: { requeue?: boolean }) {
    if (!session || !current || !exercise || !target || !srsMap) return
    if (session.feedback === null || submitting) return
    setSubmitting(true)
    try {
      const prev = srsMap.get(current.word)
      const { next: nextCard, log } = advance(prev, rating, config)
      const correct = session.feedback.correct
      await recordReview({
        next: { ...nextCard, wordId: current.word },
        log: { ...log, wordId: current.word },
        isNewWord: isNew(prev),
        correct,
        // 当轮重做不重复计入当日统计：统计口径是"今天学过哪些词"
        countInSession: (current.attempts ?? 0) === 0,
      })
      advanceSession({ rating, correct, kind: exercise.kind, requeue: opts?.requeue })
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`)
    } finally {
      setSubmitting(false)
    }
  }

  /** 快捷键：作答态 1-4 选选项、翻面后 1-4 评分、空格发音 */
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!session || !exercise || !target) return
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.code === 'Space') {
        e.preventDefault()
        speak(target.word)
        return
      }

      const n = Number(e.key)
      const pressed = Number.isInteger(n) && n >= 1 && n <= 4

      if (session.feedback) {
        // 答错（含点了「忘记了」）自动记「不认识」，只剩一个「下一题」
        if (!session.feedback.correct) {
          if (e.key === 'Enter') {
            e.preventDefault()
            void rate(Rating.Again)
          }
          return
        }
        const choices = ratingChoices(true, exercise.options.length > 0)
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
          e.preventDefault()
          void rate(choices[n - 1].rating)
        } else if (e.key === 'Enter') {
          e.preventDefault()
          void rate(Rating.Good)
        }
        return
      }

      if (e.key === 'Enter' && session.typed.trim() !== '') {
        e.preventDefault()
        submit(session.typed)
        return
      }
      if (pressed && exercise.options.length > 0 && n <= exercise.options.length) {
        e.preventDefault()
        submit(exercise.options[n - 1].text)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, exercise, target, submitting])

  if (!bookId) {
    return (
      <div className="py-10">
        <Empty>
          还没有选择词书。
          <Link className="ml-1 font-medium text-brand-600 underline" to="/books">
            去选一本
          </Link>
        </Empty>
      </div>
    )
  }

  if (!live || session === null || wordRecords === null || srsMap === null) {
    return <div className="py-10 text-center text-sm text-slate-500">正在准备今日任务…</div>
  }

  if (session.queue.length === 0 || session.finished) {
    return (
      <DoneView
        results={session.results}
        dailyNew={dailyNew}
        dailyReview={dailyReview}
        todayNew={todaySession?.newCount ?? 0}
        todayReview={todaySession?.reviewCount ?? 0}
        onRedoWrong={(queue) => begin({ bookId, queue })}
      />
    )
  }

  if (!exercise || !target || !current) {
    return <div className="py-10 text-center text-sm text-slate-500">正在出题…</div>
  }

  const intervals = previewIntervals(srsMap.get(current.word), config)
  const isTyping = exercise.kind === 'zh2en'
  /** 四选一答对时会多一个「忘记了」，用来纠正蒙对的错觉 */
  const choices = feedback ? ratingChoices(feedback.correct, exercise.options.length > 0) : []

  return (
    <div className="animate-rise mx-auto max-w-2xl">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400">
        <span>
          今日新词 {todaySession?.newCount ?? 0}/{dailyNew}
        </span>
        <span>
          今日复习 {todaySession?.reviewCount ?? 0}
          {dailyReview > 0 ? `/${dailyReview}` : ''}
        </span>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <span className="text-sm tabular-nums text-slate-500">
          {session.cursor + 1} / {session.queue.length}
        </span>
        <ProgressBar value={session.cursor + 1} max={session.queue.length} className="flex-1" />
        <span className="rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          {current.attempts ? `重做 ${current.attempts}` : current.isNew ? '新词' : '复习'}
        </span>
      </div>

      <Card className="p-6">
        <ExerciseView
          exercise={exercise}
          target={target}
          feedback={feedback}
          typed={session.typed}
          setTyped={setTyped}
          hints={session.hints}
          onHint={hint}
          onSubmit={submit}
          onSpeak={() => speak(target.word)}
          onForgot={forgot}
        />

        {feedback ? (
          <div className="mt-6 border-t border-slate-200 pt-4 dark:border-slate-800">
            <div
              className={`mb-4 flex flex-wrap items-center gap-2 rounded-xl border p-3 text-sm ${
                feedback.correct ? 'opt-correct' : 'opt-wrong'
              }`}
            >
              {feedback.correct ? (
                <Check size={16} className="shrink-0" />
              ) : (
                <X size={16} className="shrink-0" />
              )}
              <span className="font-medium">
                {feedback.correct ? '答对了' : feedback.forgot ? '忘记了' : '答错了'}
              </span>
              {!feedback.correct && exercise.answer !== target.word ? (
                <span className="ml-auto text-xs opacity-80">正确答案：{exercise.answer}</span>
              ) : null}
            </div>

            <WordDetail
              word={target}
              size="sm"
              // 标熟练 = 这个词不学了，既不重排也直接往下走
              onProficient={() => void rate(Rating.Easy, { requeue: false })}
            />
            <div className="mt-4 border-t border-slate-100 pt-4 dark:border-slate-800">
              <ExampleBlock word={target} passages={passages} showTitle={false} single />
            </div>

            <div className="mt-5 border-t border-slate-100 pt-4 dark:border-slate-800">
              {!feedback.correct ? (
                /* 答错（含点「忘记了」）一律自动记「不认识」，别再让用户多做一次选择 */
                <>
                  <Button
                    className="w-full"
                    size="lg"
                    disabled={submitting}
                    onClick={() => void rate(Rating.Again)}
                  >
                    下一题
                  </Button>
                  <p className="mt-2 text-center text-xs text-slate-400">
                    已自动记为「不认识」，按 Enter 继续
                  </p>
                </>
              ) : (
                <>
                  <SectionTitle>你掌握得怎么样？</SectionTitle>
                  <div className={`grid gap-2 ${choices.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
                    {choices.map((c, i) => (
                      <button
                        key={`${c.label}-${i}`}
                        onClick={() => void rate(c.rating)}
                        disabled={submitting}
                        className={`rounded-xl border bg-white px-2 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 dark:bg-slate-900 ${RATING_TONE[c.rating]}`}
                      >
                        <div>{c.label}</div>
                        <div className="mt-0.5 text-[11px] font-normal opacity-70">{intervals[c.rating]}</div>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-center text-xs text-slate-400">
                    按 1-{choices.length} 评分 · Enter 快进 · 空格发音
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-400">
            {isTyping ? '输入后按 Enter 提交' : '按 1-4 选择，空格发音'}
          </p>
        )}
      </Card>
    </div>
  )
}

function DoneView({
  results,
  dailyNew,
  dailyReview,
  todayNew,
  todayReview,
  onRedoWrong,
}: {
  results: { word: string; correct: boolean; rating: number }[]
  dailyNew: number
  dailyReview: number
  todayNew: number
  todayReview: number
  onRedoWrong: (queue: QueueItem[]) => void
}) {
  const total = results.length
  const correct = results.filter((r) => r.correct).length
  const pct = total > 0 ? Math.round((correct / total) * 100) : 0
  const wrongWords = [...new Set(results.filter((r) => !r.correct).map((r) => r.word))]

  function redo() {
    onRedoWrong(wrongWords.map((word) => ({ word, isNew: false })))
  }

  return (
    <div className="animate-rise mx-auto max-w-xl py-8">
      <Card className="text-center">
        <PartyPopper className="mx-auto text-amber-500" size={40} />
        <h1 className="mt-3 text-xl font-semibold">
          {total > 0 ? '本轮学习完成' : '今日任务已完成'}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {total > 0
            ? `完成 ${total} 题，答对 ${correct}（${pct}%）`
            : `新词 ${todayNew}/${dailyNew} 已学完，今日复习 ${todayReview} 词，明天再来吧`}
        </p>

        {wrongWords.length > 0 ? (
          <div className="mt-4">
            <p className="text-xs text-slate-400">本轮错词 {wrongWords.length} 个</p>
            <div className="mt-2 flex flex-wrap justify-center gap-1.5">
              {wrongWords.map((w) => (
                <Link key={w} to={`/word/${encodeURIComponent(w)}`}>
                  <span className="inline-block rounded-md border border-rose-200 px-2 py-0.5 text-xs text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950">
                    {w}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {wrongWords.length > 0 ? <Button onClick={redo}>重做错词</Button> : null}
          <Link to="/passage">
            <Button variant="outline">看今日 AI 段落</Button>
          </Link>
          <Link to="/stats">
            <Button variant="ghost">查看统计</Button>
          </Link>
        </div>

        <p className="mt-4 text-xs text-slate-400">
          今日进度：新词 {todayNew}/{dailyNew} · 复习 {todayReview}
          {dailyReview > 0 ? `/${dailyReview}` : ''}
        </p>
      </Card>
    </div>
  )
}

function ExerciseView({
  exercise,
  target,
  feedback,
  typed,
  setTyped,
  hints,
  onHint,
  onSubmit,
  onSpeak,
  onForgot,
}: {
  exercise: Exercise
  target: { word: string; phonetic: string; exchange: string }
  feedback: { correct: boolean; chosen: string; forgot?: boolean } | null
  typed: string
  setTyped: (v: string) => void
  hints: number
  onHint: () => void
  onSubmit: (chosen: string) => void
  onSpeak: () => void
  onForgot: () => void
}) {
  const isTyping = exercise.kind === 'zh2en'
  const maxHints = Math.max([...target.word].length - 1, 0)

  if (exercise.kind === 'en2zh') {
    return (
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-3xl font-semibold">{exercise.prompt}</h2>
          <button
            onClick={onSpeak}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
            title="发音（空格）"
          >
            <Volume2 size={20} />
          </button>
        </div>
        {target.phonetic ? <div className="mt-1 text-sm text-slate-400">/{target.phonetic}/</div> : null}
        <Options exercise={exercise} feedback={feedback} onPick={onSubmit} />
        {feedback ? null : <ForgotButton onClick={onForgot} />}
      </div>
    )
  }

  if (exercise.kind === 'listen2word' || exercise.kind === 'listen2zh') {
    return (
      <div>
        <button
          onClick={onSpeak}
          className="mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-brand-50 text-brand-600 transition-transform hover:scale-105 dark:bg-brand-950"
          title="点击播放（空格）"
        >
          <Volume2 size={38} />
        </button>
        <p className="mt-3 text-center text-sm text-slate-500">
          听发音，选{exercise.kind === 'listen2word' ? '正确的拼写' : '正确的释义'}
        </p>
        <Options exercise={exercise} feedback={feedback} onPick={onSubmit} />
        {feedback ? null : <ForgotButton onClick={onForgot} />}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-xl font-semibold leading-snug">{exercise.prompt}</h2>
      </div>
      {isTyping ? (
        <>
          {hints > 0 ? (
            <div className="mb-2 flex items-baseline gap-3">
              <span className="font-mono text-lg tracking-[0.25em] text-slate-600 dark:text-slate-300">
                {spellingHint(target.word, hints)}
              </span>
              {target.phonetic ? <span className="text-sm text-slate-400">/{target.phonetic}/</span> : null}
            </div>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault()
              onSubmit(typed)
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              // 显式处理 Enter：不依赖表单隐式提交（不同浏览器/自动化下行为不一致）
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                if (typed.trim() !== '' && !feedback) onSubmit(typed)
              }}
              disabled={Boolean(feedback)}
              placeholder="输入英文单词"
              className="flex-1 rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg outline-none focus:border-brand-500 disabled:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:disabled:bg-slate-800"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <Button type="submit" disabled={Boolean(feedback) || typed.trim() === ''}>
              确定
            </Button>
          </form>

          {feedback ? null : (
            <div className="mt-2 flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onHint}
                disabled={hints >= maxHints}
              >
                提示
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => onSubmit('')}>
                不会
              </Button>
            </div>
          )}
        </>
      ) : null}
    </div>
  )
}

function Options({
  exercise,
  feedback,
  onPick,
}: {
  exercise: Exercise
  feedback: { correct: boolean; chosen: string } | null
  onPick: (v: string) => void
}) {
  return (
    <div className="mt-5 grid gap-2.5">
      {exercise.options.map((opt, i) => {
        let cls = 'opt-idle'
        if (feedback) {
          if (opt.correct) cls = 'opt-correct'
          else if (opt.text === feedback.chosen) cls = 'opt-wrong'
          else cls = 'border-slate-200 bg-white opacity-60 dark:border-slate-800 dark:bg-slate-900'
        }
        return (
          <button
            key={`${opt.text}-${i}`}
            onClick={() => onPick(opt.text)}
            disabled={Boolean(feedback)}
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-left text-[15px] transition-colors ${cls}`}
          >
            <span className="w-4 shrink-0 text-xs text-slate-400">{i + 1}</span>
            <span className="flex-1">{opt.text}</span>
          </button>
        )
      })}
    </div>
  )
}

/**
 * 四选一题型下方的「忘记了」。老实承认想不起来比硬蒙一个强，
 * 点它跳过自评、直接按「不认识」记账进下一题。
 */
function ForgotButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 w-full rounded-xl border border-dashed border-slate-300 py-2.5 text-sm font-medium text-slate-500 transition-colors hover:border-slate-400 hover:text-slate-700 dark:border-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
    >
      忘记了
    </button>
  )
}
