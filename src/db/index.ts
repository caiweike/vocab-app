import Dexie, { type EntityTable } from 'dexie'
import type {
  BookWordRecord,
  BookRecord,
  ExampleRecord,
  PassageRecord,
  ReviewLogRecord,
  SessionRecord,
  SettingKey,
  Settings,
  SrsRecord,
  WordFlagRecord,
  WordRecord,
} from '@/core/types'

export class VocabDB extends Dexie {
  words!: EntityTable<WordRecord, 'word'>
  books!: EntityTable<BookRecord, 'id'>
  bookWords!: EntityTable<BookWordRecord, 'id'>
  srs!: EntityTable<SrsRecord, 'wordId'>
  reviewLog!: EntityTable<ReviewLogRecord, 'id'>
  sessions!: EntityTable<SessionRecord, 'date'>
  passages!: EntityTable<PassageRecord, 'id'>
  examples!: EntityTable<ExampleRecord, 'word'>
  wordFlags!: EntityTable<WordFlagRecord, 'word'>
  settings!: EntityTable<{ key: string; value: unknown }, 'key'>

  constructor() {
    super('vocab')
    this.version(1).stores({
      words: 'word, frq, bnc',
      books: 'id, source, createdAt',
      bookWords: 'id, bookId, [bookId+seq], word',
      srs: 'wordId, due, state',
      reviewLog: '++id, wordId, at',
      sessions: 'date',
      passages: 'id, date, hash',
      settings: 'key',
    })
    // v2：passages 补 createdAt 索引（按时间取最近段落），新增 examples 表缓存 AI 例句
    this.version(2).stores({
      passages: 'id, date, hash, createdAt',
      examples: 'word, createdAt',
    })
    // v3：单词的「收藏 / 熟练」标记。熟练的词不再进学习队列
    this.version(3).stores({
      wordFlags: 'word',
    })
  }
}

export const db = new VocabDB()

/** 设置读写：单行 KV，读不到时回退默认值 */
export async function getSetting<K extends SettingKey>(
  key: K,
  fallback: Settings[K],
): Promise<Settings[K]> {
  const row = await db.settings.get(key)
  return row === undefined ? fallback : (row.value as Settings[K])
}

export async function setSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  await db.settings.put({ key, value })
}

/** 词书选择也存在 settings 里，但它不属于定时/学习类设置项 */
export const ACTIVE_BOOK_KEY = 'activeBookId'
