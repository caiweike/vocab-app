import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { BookOpen, Flame, Play, Target } from 'lucide-react'
import { Button, Card, ProgressBar, SectionTitle, Stat } from '@/components/ui'
import { useActiveBookId, useBookWords, useSettings, useSrsMap, useBooks, useProficientSet } from '@/hooks'
import { buildQueue, countLearnedToday, toDateKey } from '@/core/queue'
import { calcStreak, checkedInToday, forecast, masteryBreakdown } from '@/core/stats'
import { masteryOf } from '@/core/srs'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'

/** 学习方式：背单词和 AI 段落是并列的两种，开跑前先选一种 */
type StudyMode = 'cards' | 'passage'

const STUDY_MODES: { key: StudyMode; label: string; to: string }[] = [
  { key: 'cards', label: '背单词', to: '/learn' },
  { key: 'passage', label: 'AI 段落', to: '/passage' },
]

export function HomePage() {
  const books = useBooks()
  const bookId = useActiveBookId()
  const words = useBookWords(bookId)
  const srsMap = useSrsMap(words)
  const proficient = useProficientSet()
  const { settings, update } = useSettings()

  const sessions = useLiveQuery(() => db.sessions.toArray(), [])
  const logs = useLiveQuery(() => db.reviewLog.toArray(), [])

  const activeBook = books?.find((b) => b.id === bookId) ?? null

  const summary = useMemo(() => {
    if (!words || !srsMap || !settings) return null
    const learnedToday = countLearnedToday(logs ?? [])
    const q = buildQueue({
      // 标了「熟练」的词以后不再排进学习
      words: words.filter((w) => !proficient.has(w)),
      srsByWord: srsMap,
      config: {
        dailyNew: Number(settings.dailyNew ?? 20),
        dailyReview: Number(settings.dailyReview ?? 200),
      },
      learnedToday,
    })
    const all = [...q.review, ...q.fresh]
    // 熟练的词算进「已掌握」：它们不再学，挂在"未学"里会让人以为还有那么多要背
    const breakDown = masteryBreakdown(
      words.map((w) => (proficient.has(w) ? 'mastered' : masteryOf(srsMap.get(w)))),
    )
    return {
      due: q.review.length,
      fresh: q.fresh.length,
      queueLength: all.length,
      remaining: q.remainingReviews,
      breakDown,
      learnedToday,
      forecast: forecast(
        [...srsMap].filter(([w]) => !proficient.has(w)).map(([, r]) => r),
        7,
      ),
      streak: calcStreak(sessions ?? []),
      checkedIn: checkedInToday(sessions ?? []),
    }
  }, [words, srsMap, settings, logs, sessions, proficient])

  if (!bookId) {
    return (
      <div className="py-12">
        <Card className="text-center">
          <BookOpen className="mx-auto text-brand-500" size={36} />
          <h1 className="mt-3 text-lg font-semibold">先选一本词书</h1>
          <p className="mt-1 text-sm text-slate-500">内置了四级与考研词汇，也可以导入你自己的词表。</p>
          <Link to="/books" className="mt-4 inline-block">
            <Button>选择词书</Button>
          </Link>
        </Card>
      </div>
    )
  }

  if (!summary || !activeBook) {
    return <div className="py-10 text-center text-sm text-slate-500">正在统计…</div>
  }

  const { breakDown } = summary
  const started = breakDown.total - breakDown.new

  // 开跑前先选学习方式；选择会记住，下次进来默认是上次那个
  const mode: StudyMode = settings?.studyMode === 'passage' ? 'passage' : 'cards'
  const activeMode = STUDY_MODES.find((m) => m.key === mode) ?? STUDY_MODES[0]
  const modeHint =
    mode === 'cards'
      ? `FSRS 队列：${summary.due} 个到期复习 + ${summary.fresh} 个新词，答错的词会在本轮重现`
      : '把今天学的词串成一篇短文，带逐句翻译、固定搭配和 2 道阅读题'
  const cta = mode === 'cards' ? (summary.queueLength > 0 ? '开始学习' : '再学一点') : '读今日段落'  // 学了几百个词之前百分比一直是 0，直接给一个更有意义的读数
  const learnedLabel =
    breakDown.total === 0 ? '0%' : started / breakDown.total < 0.01 ? `<1%` : `${Math.round((started / breakDown.total) * 100)}%`

  return (
    <div className="animate-rise space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{summary.checkedIn ? '今天已打卡' : '今天还没开始'}</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {activeBook.name} · 已学 {breakDown.total - breakDown.new} / {breakDown.total} 词
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2.5 py-1 font-medium text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <Flame size={15} /> {summary.streak} 天
          </span>
        </div>
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm text-slate-500">今日任务</div>
            <div className="mt-1 flex items-baseline gap-4">
              <span>
                <span className="text-3xl font-semibold tabular-nums">{summary.queueLength}</span>
                <span className="ml-1.5 text-sm text-slate-500">个待完成</span>
              </span>
              <span className="text-sm text-slate-500">
                复习 <b className="tabular-nums text-slate-800 dark:text-slate-100">{summary.due}</b> · 新词{' '}
                <b className="tabular-nums text-slate-800 dark:text-slate-100">{summary.fresh}</b>
              </span>
            </div>
            {summary.remaining > 0 ? (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                另有 {summary.remaining} 个到期词超出每日上限，已顺延
              </p>
            ) : null}
            <p className="mt-1 text-xs text-slate-500">{modeHint}</p>
          </div>
          <div className="flex flex-col items-end gap-2">
            {/* 段落和背单词是并列的两种学习方式，先选再开跑 */}
            <div className="flex rounded-xl bg-slate-100 p-1 dark:bg-slate-800">
              {STUDY_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={mode === m.key}
                  onClick={() => void update('studyMode', m.key)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === m.key
                      ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-900 dark:text-slate-100'
                      : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Link to={activeMode.to}>
              <Button size="lg">
                <Play size={17} /> {cta}
              </Button>
            </Link>
          </div>
        </div>
        <ProgressBar value={summary.learnedToday} max={Number(settings?.dailyNew ?? 20) + summary.due} className="mt-4" />
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="连续打卡" value={`${summary.streak}`} hint="天" />
        <Stat label="已开始学习" value={learnedLabel} hint={`${started} 词`} />
        <Stat label="已掌握" value={breakDown.mastered} hint="稳定 ≥ 21 天" />
        <Stat label="学习中" value={breakDown.learning} hint="间隔 < 21 天" />
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <SectionTitle action={<Link to="/stats" className="text-xs text-brand-600">全部统计</Link>}>
            未来 7 天到期
          </SectionTitle>
          <div className="flex h-28 items-end gap-1.5">
            {summary.forecast.map((d) => {
              const max = Math.max(1, ...summary.forecast.map((x) => x.count))
              // 列是 flex 自适应高度，百分比高度取不到基准，必须用像素
              const BAR_MAX_PX = 76
              const h = Math.max(3, Math.round((d.count / max) * BAR_MAX_PX))
              const isToday = d.date === toDateKey()
              return (
                <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                  <span className="text-[10px] tabular-nums text-slate-400">{d.count > 0 ? d.count : ''}</span>
                  <div
                    className={`w-full rounded-t ${isToday ? 'bg-brand-500' : 'bg-brand-200 dark:bg-brand-900'}`}
                    style={{ height: `${h}px` }}
                    title={`${d.date}：${d.count} 词`}
                  />
                  <span className="text-[10px] text-slate-400">{Number(d.date.slice(-2))}</span>
                </div>
              )
            })}
          </div>
        </Card>

        <Card>
          <SectionTitle action={<Link to="/books" className="text-xs text-brand-600">管理词书</Link>}>
            掌握分布
          </SectionTitle>
          <div className="space-y-2.5 text-sm">
            {[
              { label: '未学', n: breakDown.new, cls: 'bg-slate-300 dark:bg-slate-700' },
              { label: '学习中', n: breakDown.learning, cls: 'bg-amber-400' },
              { label: '复习中', n: breakDown.reviewing, cls: 'bg-brand-400' },
              { label: '已掌握', n: breakDown.mastered, cls: 'bg-emerald-500' },
            ].map((r) => (
              <div key={r.label} className="flex items-center gap-3">
                <span className="w-16 shrink-0 text-slate-500">{r.label}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div
                    className={`h-full ${r.cls}`}
                    style={{ width: `${breakDown.total > 0 ? (r.n / breakDown.total) * 100 : 0}%` }}
                  />
                </div>
                <span className="w-12 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-300">{r.n}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-1.5 text-xs text-slate-400">
            <Target size={13} /> 目标记忆保持率 {Math.round(Number(settings?.requestRetention ?? 0.9) * 100)}%
          </div>
        </Card>
      </div>
    </div>
  )
}
