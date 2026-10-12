import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { FileUp, Loader2, Upload } from 'lucide-react'
import { Badge, Button, Card, Empty } from '@/components/ui'
import { parseWordList, type ParseResult } from '@/core/importers'
import { db } from '@/db'
import { setActiveBookId } from '@/hooks'
import { useUiStore } from '@/state/ui'
import type { BookRecord, WordRecord } from '@/core/types'

export function ImportPage() {
  const navigate = useNavigate()
  const toast = useUiStore((s) => s.showToast)
  const fileRef = useRef<HTMLInputElement>(null)

  const [parsed, setParsed] = useState<ParseResult | null>(null)
  const [fileName, setFileName] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File) {
    setError(null)
    setParsed(null)
    try {
      const text = await file.text()
      const res = parseWordList(text)
      if (res.rows.length === 0) {
        setError('没有解析出任何英文单词，请检查文件格式。')
        return
      }
      setParsed(res)
      setFileName(file.name)
      setName(file.name.replace(/\.[^.]+$/, '').slice(0, 40))
    } catch (e) {
      setError(`读取文件失败：${(e as Error).message}`)
    }
  }

  async function importBook() {
    if (!parsed || !name.trim()) return
    setBusy(true)
    try {
      const id = `custom-${Date.now()}`
      const bookWords: { id: string; bookId: string; seq: number; word: string }[] = []
      const upserts = new Map<string, WordRecord>()

      // 已存在的单词沿用原释义（词典里的更全），只补齐缺失的
      const existing = await db.words.bulkGet(parsed.rows.map((r) => r.word))
      parsed.rows.forEach((row, i) => {
        const prev = existing[i]
        if (!prev) {
          upserts.set(row.word, {
            word: row.word,
            phonetic: '',
            meanings: row.meaning ? [row.meaning] : [],
            definition: '',
            pos: '',
            bnc: 0,
            frq: 0,
            collins: 0,
            oxford: false,
            exchange: '',
          })
        } else if (prev.meanings.length === 0 && row.meaning) {
          upserts.set(row.word, { ...prev, meanings: [row.meaning] })
        }
        bookWords.push({ id: `${id}::${i}`, bookId: id, seq: i, word: row.word })
      })

      const record: BookRecord = {
        id,
        name: name.trim(),
        desc: `导入自 ${fileName}`,
        source: 'custom',
        count: parsed.rows.length,
        createdAt: Date.now(),
      }

      await db.transaction('rw', db.books, db.bookWords, db.words, async () => {
        if (upserts.size > 0) await db.words.bulkPut([...upserts.values()])
        await db.books.put(record)
        await db.bookWords.bulkPut(bookWords)
      })

      await setActiveBookId(id)
      toast(`已导入「${record.name}」共 ${record.count} 词，并设为当前词书`)
      navigate(`/books/${id}`)
    } catch (e) {
      setError(`导入失败：${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="animate-rise mx-auto max-w-2xl space-y-4">
      <h1 className="text-xl font-semibold">导入词表</h1>

      <Card>
        <p className="mb-3 text-sm text-slate-500">支持三种格式，程序会自动识别：</p>
        <div className="space-y-2 rounded-xl bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-600 dark:bg-slate-950 dark:text-slate-400">
          <div>{'abandon　放弃，抛弃（单词 + Tab + 释义）'}</div>
          <div>ability,能力（单词 + 逗号 + 释义）</div>
          <div>absorb（每行一个单词，释义取自内置词典）</div>
        </div>

        <div className="mt-4">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.csv,.tsv,text/plain,text/csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
          <Button onClick={() => fileRef.current?.click()} disabled={busy}>
            <FileUp size={16} /> 选择文件
          </Button>
        </div>

        {error ? <p className="mt-3 text-sm text-rose-600">{error}</p> : null}
      </Card>

      {parsed ? (
        <Card>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Badge tone="brand">{parsed.rows.length} 词</Badge>
              <Badge>格式：{parsed.format}</Badge>
              {parsed.duplicates.length > 0 ? <Badge tone="amber">去重 {parsed.duplicates.length}</Badge> : null}
              {parsed.skipped > 0 ? <Badge tone="amber">跳过 {parsed.skipped} 行</Badge> : null}
            </div>
          </div>

          <label className="text-sm text-slate-500">词书名称</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900"
            placeholder="例如：GRE 核心词"
          />

          <div className="mt-4 max-h-64 overflow-auto rounded-xl border border-slate-200 dark:border-slate-800">
            {parsed.rows.slice(0, 50).map((r, i) => (
              <div
                key={`${r.word}-${i}`}
                className={`flex gap-3 px-3 py-2 text-sm ${i > 0 ? 'border-t border-slate-100 dark:border-slate-800' : ''}`}
              >
                <span className="w-6 shrink-0 text-xs tabular-nums text-slate-400">{i + 1}</span>
                <span className="font-medium">{r.word}</span>
                <span className="truncate text-slate-500">{r.meaning ?? '（将从内置词典补释义）'}</span>
              </div>
            ))}
          </div>
          {parsed.rows.length > 50 ? (
            <p className="mt-2 text-xs text-slate-400">仅预览前 50 条，导入时会写入全部 {parsed.rows.length} 条</p>
          ) : null}

          <div className="mt-4 flex gap-2">
            <Button onClick={() => void importBook()} disabled={busy || !name.trim()}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />} 导入并设为当前
            </Button>
            <Button variant="ghost" onClick={() => setParsed(null)} disabled={busy}>
              取消
            </Button>
          </div>
        </Card>
      ) : (
        <Empty>选择文件后这里会显示预览</Empty>
      )}
    </div>
  )
}
