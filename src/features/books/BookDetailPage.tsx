import { useLiveQuery } from 'dexie-react-hooks'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Award, Search, Star, Trash2 } from 'lucide-react'
import { Badge, Button, Card, Empty, ProgressBar } from '@/components/ui'
import { db } from '@/db'
import { masteryOf } from '@/core/srs'
import type { SrsRecord, WordRecord } from '@/core/types'
import { setActiveBookId, useActiveBookId } from '@/hooks'
import { useUiStore } from '@/state/ui'

/** 页面加载时刻。渲染路径调 Date.now 是不纯的，这里固定取一次。 */
const PAGE_LOADED_AT = Date.now()

type Filter = 'all' | 'new' | 'learning' | 'mastered' | 'starred' | 'proficient'
const PAGE = 60

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'new', label: '未学' },
  { key: 'learning', label: '学习中' },
  { key: 'mastered', label: '已掌握' },
  { key: 'starred', label: '收藏' },
  { key: 'proficient', label: '熟练' },
]

export function BookDetailPage() {
  const { id = '' } = useParams()
  const toast = useUiStore((s) => s.showToast)
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)

  const book = useLiveQuery(() => db.books.get(id), [id])
  const activeId = useActiveBookId()
  const entries = useLiveQuery(async () => {
    const rows = await db.bookWords.where('bookId').equals(id).sortBy('seq')
    return rows
  }, [id])

  const joined = useLiveQuery(async () => {
    if (!entries || entries.length === 0) return null
    const keys = entries.map((e) => e.word)
    const words = await db.words.bulkGet(keys)
    const recs = await db.srs.bulkGet(keys)
    const flags = await db.wordFlags.bulkGet(keys)
    return entries.map((e, i) => ({
      seq: e.seq,
      word: words[i] as WordRecord | undefined,
      srs: recs[i] as SrsRecord | undefined,
      flag: flags[i],
    }))
  }, [entries])

  const filtered = useMemo(() => {
    if (!joined) return []
    const q = query.trim().toLowerCase()
    return joined.filter((row) => {
      if (q) {
        const inWord = row.word?.word.toLowerCase().includes(q) ?? false
        const inMeaning = row.word?.meanings.some((m) => m.includes(query.trim())) ?? false
        if (!inWord && !inMeaning) return false
      }
      if (filter === 'all') return true
      if (filter === 'starred') return row.flag?.starred === true
      if (filter === 'proficient') return row.flag?.proficient === true
      // 熟练的词不再学习，统计上按已掌握算，和首页口径一致
      const m = row.flag?.proficient ? 'mastered' : masteryOf(row.srs)
      if (filter === 'new') return m === 'new'
      if (filter === 'learning') return m === 'learning' || m === 'reviewing'
      return m === 'mastered'
    })
  }, [joined, filter, query])

  const counts = useMemo(() => {
    const acc = { all: 0, new: 0, learning: 0, mastered: 0, starred: 0, proficient: 0 }
    if (!joined) return acc
    acc.all = joined.length
    for (const row of joined) {
      if (row.flag?.starred) acc.starred++
      if (row.flag?.proficient) acc.proficient++
      const m = row.flag?.proficient ? 'mastered' : masteryOf(row.srs)
      if (m === 'new') acc.new++
      else if (m === 'mastered') acc.mastered++
      else acc.learning++
    }
    return acc
  }, [joined])

  if (!book) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>

  const visible = filtered.slice(0, limit)
  const learned = counts.all - counts.new

  async function removeCustomBook() {
    if (!book || book.source !== 'custom') return
    if (!window.confirm(`删除词书「${book.name}」？单词的记忆进度会保留。`)) return
    await db.transaction('rw', db.books, db.bookWords, async () => {
      await db.books.delete(book.id)
      await db.bookWords.where('bookId').equals(book.id).delete()
    })
    toast('词书已删除')
    window.history.back()
  }

  return (
    <div className="animate-rise space-y-4">
      <Link to="/books" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 dark:hover:text-slate-200">
        <ArrowLeft size={15} /> 返回词书
      </Link>

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{book.name}</h1>
            <p className="mt-1 text-sm text-slate-500">{book.desc}</p>
            <div className="mt-2 flex gap-2">
              <Badge>{book.count} 词</Badge>
              <Badge tone="brand">已学 {learned}</Badge>
              <Badge tone="green">已掌握 {counts.mastered}</Badge>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={book.id === activeId ? 'outline' : 'primary'}
              disabled={book.id === activeId}
              onClick={async () => {
                await setActiveBookId(book.id)
                toast(`已切换到「${book.name}」`)
              }}
            >
              {book.id === activeId ? '✓ 当前词书' : '设为当前词书'}
            </Button>
            {book.source === 'custom' ? (
              <Button size="sm" variant="ghost" onClick={() => void removeCustomBook()}>
                <Trash2 size={15} /> 删除
              </Button>
            ) : null}
          </div>
        </div>
        <ProgressBar value={learned} max={counts.all || 1} className="mt-4" />
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => {
                setFilter(f.key)
                setLimit(PAGE)
              }}
              className={`rounded-lg px-3 py-1.5 text-sm transition-colors ${
                filter === f.key
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {f.label} <span className="tabular-nums opacity-75">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-full sm:w-64">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setLimit(PAGE)
            }}
            placeholder="搜索单词或释义"
            className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty>{query ? '没有匹配的单词' : '这个分类下还没有单词'}</Empty>
      ) : (
        <>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {visible.map((row, i) => {
              if (!row.word) return null
              const m = row.flag?.proficient ? 'mastered' : masteryOf(row.srs)
              const due = !row.flag?.proficient && row.srs && row.srs.due <= PAGE_LOADED_AT && m !== 'new'
              return (
                <Link
                  key={row.word.word}
                  to={`/word/${encodeURIComponent(row.word.word)}`}
                  className={`flex items-center gap-3 px-4 py-3 transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/60 ${
                    i > 0 ? 'border-t border-slate-100 dark:border-slate-800' : ''
                  }`}
                >
                  <span className="w-8 shrink-0 text-xs tabular-nums text-slate-400">{row.seq + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="font-medium">{row.word.word}</span>
                      {row.word.phonetic ? <span className="text-xs text-slate-400">/{row.word.phonetic}/</span> : null}
                      {row.flag?.starred ? (
                        <Star size={12} className="shrink-0 text-amber-500" fill="currentColor" />
                      ) : null}
                      {row.flag?.proficient ? <Award size={12} className="shrink-0 text-emerald-500" /> : null}
                    </div>
                    <div className="truncate text-sm">
                      {/* 词书的主释义加粗顶在最前，其余义项弱化跟在后面 */}
                      {row.word.meanings[0] ? (
                        <span className="font-semibold text-slate-700 dark:text-slate-200">
                          {row.word.meanings[0]}
                        </span>
                      ) : null}
                      {row.word.meanings.length > 1 ? (
                        <span className="text-slate-400 dark:text-slate-500">
                          ；{row.word.meanings.slice(1).join('；')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      m === 'new'
                        ? 'bg-slate-300 dark:bg-slate-700'
                        : m === 'mastered'
                          ? 'bg-emerald-500'
                          : due
                            ? 'bg-amber-500'
                            : 'bg-brand-400'
                    }`}
                    title={due ? '到期待复习' : m}
                  />
                </Link>
              )
            })}
          </div>

          {limit < filtered.length ? (
            <div className="text-center">
              <Button variant="outline" onClick={() => setLimit((n) => n + PAGE)}>
                加载更多（还有 {filtered.length - limit} 个）
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}
