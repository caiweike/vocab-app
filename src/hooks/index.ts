import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ACTIVE_BOOK_KEY, db } from '@/db'
import { loadSettings, updateSetting } from '@/db/settings'
import type {
  BookRecord,
  PassageRecord,
  SettingKey,
  Settings,
  SrsRecord,
  WordRecord,
} from '@/core/types'

/** 读取全部设置；改动会写回 IndexedDB 并立即更新内存 */
export function useSettings() {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    let alive = true
    loadSettings().then((s) => {
      if (alive) setSettings(s)
    })
    return () => {
      alive = false
    }
  }, [])

  const update = useCallback(async <K extends SettingKey>(key: K, value: Settings[K]) => {
    await updateSetting(key, value)
    setSettings((prev) => ({ ...(prev ?? {}), [key]: value }))
  }, [])

  /**
   * 一次写多项设置。
   * 逐个 update 会导致中间态：比如保存 AI 配置时先写完 baseUrl，
   * 依赖 baseUrl 的 key 就变了，子组件会拿**还没写入的协议值**提前重挂载。
   */
  const updateAll = useCallback(async (patch: Settings) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      await updateSetting(key as SettingKey, value)
    }
    setSettings((prev) => ({ ...(prev ?? {}), ...patch }))
  }, [])

  return { settings, update, updateAll, ready: settings !== null }
}

/** 当前词书 id，存在 settings.activeBookId；没有选过则为 null */
export function useActiveBookId(): string | null {
  const row = useLiveQuery(() => db.settings.get(ACTIVE_BOOK_KEY), [])
  if (row === undefined) return null
  return typeof row.value === 'string' && row.value ? row.value : null
}

export async function setActiveBookId(id: string): Promise<void> {
  await db.settings.put({ key: ACTIVE_BOOK_KEY, value: id })
}

/**
 * 所有词书。内置词书按 `build-books` 声明的顺序（中考→高考→四六级→考研→雅思→托福→GRE），
 * 用户导入的排在后面。
 * 以前按 createdAt 排，但同一次灌库的 createdAt 完全相同，IndexedDB 只能按主键兜底，
 * 结果实际是字典序（cet4, cet6, gk, gre, …），和考试阶段无关。
 */
export function useBooks(): BookRecord[] | null {
  const rows = useLiveQuery(() => db.books.toArray(), [])
  return useMemo(() => {
    if (!rows) return null
    const rank = (b: BookRecord) => b.order ?? 1000
    return [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
  }, [rows])
}

export function useBookWords(bookId: string | null): string[] | null {
  const rows = useLiveQuery(async () => {
    if (!bookId) return []
    const r = await db.bookWords.where('bookId').equals(bookId).sortBy('seq')
    return r.map((x) => x.word)
  }, [bookId])
  return rows ?? null
}

/**
 * 取单词记录。
 * 注意：`words` 还没加载时必须返回 null 而不是空数组 ——
 * 否则调用方会以为"查完了但一个都没有"，用空词池去出题却拿真实词表建队列。
 */
export function useWords(words: string[] | null): WordRecord[] | null {
  const rows = useLiveQuery(async () => {
    if (!words) return null
    if (words.length === 0) return []
    const got = await db.words.bulkGet(words)
    return got.filter((w): w is WordRecord => w !== undefined)
  }, [words?.join(',') ?? ''])
  return rows ?? null
}

/** 单词的 FSRS 状态；全部词书共享同一份（词书只是范围，不是记忆状态的容器） */
export function useSrsMap(words: string[] | null): Map<string, SrsRecord> | null {
  const rows = useLiveQuery(async () => {
    if (!words) return null
    if (words.length === 0) return []
    const got = await db.srs.bulkGet(words)
    return got.filter((r): r is SrsRecord => r !== undefined)
  }, [words?.join(',') ?? ''])

  // 每次渲染 new 一个 Map 会让依赖它的 effect 认为值变了，反复重跑
  return useMemo(() => (rows ? new Map(rows.map((r) => [r.wordId, r])) : null), [rows])
}

/**
 * 最近生成的 AI 段落，作为卡片背面的语境例句语料。
 * 学习页和单词详情页共用同一个 hook，避免各查各的拿到不一样的结果。
 */
export function useRecentPassages(limit = 20): PassageRecord[] | null {
  const rows = useLiveQuery(() => db.passages.orderBy('createdAt').reverse().limit(limit).toArray(), [limit])
  return rows ?? null
}

/** 单词的「收藏 / 熟练」标记，翻转其中一个不会动另一个 */
export function useWordFlag(word: string | null) {
  const row = useLiveQuery(() => (word ? db.wordFlags.get(word) : undefined), [word])
  const starred = row?.starred ?? false
  const proficient = row?.proficient ?? false

  const toggle = useCallback(
    async (key: 'starred' | 'proficient') => {
      if (!word) return
      await db.wordFlags.put({
        word,
        starred: key === 'starred' ? !starred : starred,
        proficient: key === 'proficient' ? !proficient : proficient,
        updatedAt: Date.now(),
      })
    },
    [word, starred, proficient],
  )

  return { starred, proficient, toggle }
}

/**
 * 被标为「熟练」的词。学习队列按它排除，
 * 首页任务数和学习页队列必须用同一份集合，否则两处数字对不上。
 */
export function useProficientSet(): Set<string> {
  const rows = useLiveQuery(() => db.wordFlags.filter((f) => Boolean(f.proficient)).toArray(), [])
  return useMemo(() => new Set((rows ?? []).map((r) => r.word)), [rows])
}
