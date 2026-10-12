import { Link, useNavigate } from 'react-router-dom'
import { BookOpen, Check, Import, Plus } from 'lucide-react'
import { Badge, Button, Card, SectionTitle } from '@/components/ui'
import { useActiveBookId, useBooks, setActiveBookId } from '@/hooks'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { useUiStore } from '@/state/ui'

export function BooksPage() {
  const books = useBooks()
  const activeId = useActiveBookId()
  const navigate = useNavigate()
  const toast = useUiStore((s) => s.showToast)

  // 每本书的已学进度：join bookWords + srs 状态太重，这里按词数与 srs 表统计
  const progress = useLiveQuery(async () => {
    if (!books) return {}
    const out: Record<string, { learned: number; mastered: number }> = {}
    for (const b of books) {
      const rows = await db.bookWords.where('bookId').equals(b.id).toArray()
      const recs = await db.srs.bulkGet(rows.map((r) => r.word))
      const learned = recs.filter((r) => r !== undefined && r.state !== 0).length
      const mastered = recs.filter((r) => r !== undefined && r.state === 2 && r.stability >= 21).length
      out[b.id] = { learned, mastered }
    }
    return out
  }, [books])

  if (!books) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>

  const builtin = books.filter((b) => b.source === 'built-in')
  const custom = books.filter((b) => b.source === 'custom')

  return (
    <div className="animate-rise space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">词书</h1>
        <div className="flex gap-2">
          <Link to="/import">
            <Button variant="outline" size="sm">
              <Import size={15} /> 导入词表
            </Button>
          </Link>
        </div>
      </div>

      <section>
        <SectionTitle>内置词书</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          {builtin.map((b) => (
            <BookCard
              key={b.id}
              name={b.name}
              desc={b.desc}
              count={b.count}
              active={b.id === activeId}
              learned={progress?.[b.id]?.learned ?? 0}
              mastered={progress?.[b.id]?.mastered ?? 0}
              onSelect={async () => {
                await setActiveBookId(b.id)
                toast(`已切换到「${b.name}」`)
              }}
              onOpen={() => navigate(`/books/${b.id}`)}
            />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle
          action={
            <Link to="/import" className="text-xs text-brand-600">
              导入新的
            </Link>
          }
        >
          自定义词书（{custom.length}）
        </SectionTitle>
        {custom.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">
            <Plus className="mx-auto mb-2 text-slate-400" size={20} />
            还没有自定义词库。
            <Link className="ml-1 font-medium text-brand-600 underline" to="/import">
              导入 txt / csv
            </Link>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {custom.map((b) => (
              <BookCard
                key={b.id}
                  name={b.name}
                desc={b.desc}
                count={b.count}
                active={b.id === activeId}
                learned={progress?.[b.id]?.learned ?? 0}
                mastered={progress?.[b.id]?.mastered ?? 0}
                onSelect={async () => {
                  await setActiveBookId(b.id)
                  toast(`已切换到「${b.name}」`)
                }}
                onOpen={() => navigate(`/books/${b.id}`)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function BookCard({
  name,
  desc,
  count,
  active,
  learned,
  mastered,
  onSelect,
  onOpen,
}: {
  name: string
  desc: string
  count: number
  active: boolean
  learned: number
  mastered: number
  onSelect: () => void | Promise<void>
  onOpen: () => void
}) {
  const pct = count > 0 ? Math.round((learned / count) * 100) : 0
  return (
    <Card className={active ? 'ring-2 ring-brand-500' : ''}>
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600 dark:bg-brand-950">
          <BookOpen size={19} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-medium">{name}</h3>
            {active ? <Badge tone="brand">当前</Badge> : null}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{desc}</p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>
          {count} 词 · 已学 {learned} · 已掌握 {mastered}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className="h-full bg-brand-500" style={{ width: `${pct}%` }} />
      </div>

      <div className="mt-3 flex gap-2">
        <Button size="sm" variant={active ? 'outline' : 'primary'} onClick={() => void onSelect()}>
          {active ? (
            <>
              <Check size={14} /> 使用中
            </>
          ) : (
            '设为当前'
          )}
        </Button>
        <Button size="sm" variant="ghost" onClick={onOpen}>
          查看单词
        </Button>
      </div>
    </Card>
  )
}
