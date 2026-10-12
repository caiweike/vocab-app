import { useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Badge, Card, Empty } from '@/components/ui'
import { ExampleBlock, WordDetail } from '@/components/WordDetail'
import { db } from '@/db'
import { masteryOf } from '@/core/srs'

const STATE_LABEL: Record<string, string> = {
  new: '未学',
  learning: '学习中',
  reviewing: '复习中',
  mastered: '已掌握',
}

export function WordPage() {
  const { word = '' } = useParams()
  const decoded = decodeURIComponent(word)

  const rec = useLiveQuery(() => db.words.get(decoded), [decoded])
  const srs = useLiveQuery(() => db.srs.get(decoded), [decoded])
  const books = useLiveQuery(async () => {
    const rows = await db.bookWords.where('word').equals(decoded).toArray()
    const ids = [...new Set(rows.map((r) => r.bookId))]
    const found = await db.books.bulkGet(ids)
    return found.filter((b) => b !== undefined)
  }, [decoded])

  if (rec === undefined) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>
  if (rec === null) {
    return (
      <div className="py-10">
        <Empty>词库里没有「{decoded}」这个词</Empty>
      </div>
    )
  }

  const mastery = masteryOf(srs)
  const dueText =
    srs && srs.lastReview
      ? new Date(srs.due).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
      : '—'

  return (
    <div className="animate-rise mx-auto max-w-2xl space-y-4">
      <button
        onClick={() => window.history.back()}
        className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <ArrowLeft size={15} /> 返回
      </button>

      <Card>
        <WordDetail
          word={rec}
          books={books}
          badge={
            <Badge tone={mastery === 'mastered' ? 'green' : mastery === 'new' ? 'slate' : 'brand'}>
              {STATE_LABEL[mastery]}
            </Badge>
          }
        />
      </Card>

      {srs ? (
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-slate-500">记忆状态</h2>
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <div className="text-xs text-slate-400">下次复习</div>
              <div className="mt-0.5 font-medium tabular-nums">{dueText}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">稳定天数</div>
              <div className="mt-0.5 font-medium tabular-nums">{srs.stability.toFixed(1)} 天</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">难度</div>
              <div className="mt-0.5 font-medium tabular-nums">{srs.difficulty.toFixed(1)}</div>
            </div>
            <div>
              <div className="text-xs text-slate-400">复习 / 遗忘</div>
              <div className="mt-0.5 font-medium tabular-nums">
                {srs.reps} / {srs.lapses}
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      <Card>
        <ExampleBlock word={rec} />
      </Card>
    </div>
  )
}
