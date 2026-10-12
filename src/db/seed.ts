import type { BookFile, BookRecord, BookWordRecord, WordRecord } from '@/core/types'
import { db, getSetting, setSetting } from '@/db'
import { defaultSettings } from '@/db/settings'

/** 内置词书清单（由 build-books.mjs 生成，体积很小，可静态引入） */
import booksIndex from '@/data/books/index.json'

/**
 * 词书数据分两层：
 * - `data/words.json` 词条详情**跨书去重只存一份**，真正要灌库时才动态引入
 * - `data/books/<id>.json` 每本只存词列表（几十 KB），用 glob 收集 —— **加新书不用改这个文件**
 *
 * 以前每本书都重复存全量词条：两本就 2.6 MB，铺到 8 本会变成 10 MB 且全在启动时加载。
 */
async function loadBuiltinData(): Promise<{ books: BookFile[]; words: WordRecord[] }> {
  const modules = import.meta.glob('../data/books/*.json')
  const files = Object.entries(modules).filter(([key]) => !key.endsWith('/index.json'))
  const books = await Promise.all(
    files.map(([, load]) => (load() as Promise<{ default: BookFile }>).then((m) => m.default)),
  )
  books.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  const words = (await import('@/data/words.json')).default as unknown as WordRecord[]
  return { books, words }
}

/**
 * 内置词书数据版本。改了 `build-books.mjs` 的字段、音标规则或词表本身就 +1，
 * 客户端下次启动会重新灌内置词书 —— 只覆盖 words/books/bookWords，
 * 学习进度（srs / reviewLog / sessions）和自定义词书都不动。
 */
export const BUILTIN_DATA_VERSION = 6

export const builtinBooks = booksIndex as BookRecord[]

/** 首次启动灌数据；之后按数据版本决定是否更新内置词书 */
export async function syncBuiltinBooks(): Promise<void> {
  await defaultSettings()
  const existing = await db.books.count()
  const version = await getSetting('vocabDataVersion', 0)

  if (existing === 0 || version !== BUILTIN_DATA_VERSION) {
    await seedBuiltinBooks()
    await setSetting('vocabDataVersion', BUILTIN_DATA_VERSION)
  }
}

export async function seedBuiltinBooks(): Promise<void> {
  const { books, words } = await loadBuiltinData()
  const now = Date.now()

  const bookRows: BookRecord[] = books.map((b, i) => ({
    id: b.id,
    name: b.name,
    desc: b.desc,
    source: 'built-in',
    count: b.count,
    order: b.order ?? i,
    createdAt: now,
  }))
  const bookWordRows: BookWordRecord[] = books.flatMap((b) =>
    b.words.map((word, seq) => ({ id: `${b.id}::${seq}`, bookId: b.id, seq, word })),
  )

  // 自定义词书里可能有与内置词重复的词，且用户可能补过释义 —— 这里只 upsert 内置数据，
  // 用 bulkPut 不会删掉自定义词条目。
  await db.transaction('rw', db.words, db.books, db.bookWords, async () => {
    await db.words.bulkPut(words)
    await db.books.bulkPut(bookRows)
    await db.bookWords.bulkPut(bookWordRows)
  })

  console.log(
    `[seed] 内置词书已同步：${bookRows.map((b) => `${b.name} ${b.count}`).join('、')}；` +
      `词条 ${words.length} 个去重，词书关系 ${bookWordRows.length} 条`,
  )
}
