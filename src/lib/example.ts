import { AiError, chatJson, configIssue } from '@/ports/ai'
import { loadAiConfig } from '@/ports/aiConfig'
import { db } from '@/db'
import type { WordRecord } from '@/core/types'

export interface WordExample {
  sentence: string
  translation: string
  collocations: { phrase: string; meaning: string }[]
}

/** 读缓存的例句；从没生成过则返回 null */
export async function loadExample(word: string): Promise<WordExample | null> {
  const rec = await db.examples.get(word)
  if (!rec || !rec.sentence) return null
  return { sentence: rec.sentence, translation: rec.translation, collocations: rec.collocations ?? [] }
}

/**
 * 用已配置的模型造句并列出常见搭配。
 * 结果写进 examples 表——同一页里「学习」卡片和单词详情页都会问到同一个词，
 * 不缓存的话每翻一次卡片就烧一次 token。
 */
export async function generateExample(word: WordRecord): Promise<WordExample> {
  const cfg = await loadAiConfig()
  const out = await chatJson<Partial<WordExample>>(
    cfg,
    [
      {
        role: 'system',
        content:
          '你是英语教学助手。只输出 JSON，不要输出任何解释或代码块标记。' +
          '格式：{"sentence":"...","translation":"...","collocations":[{"phrase":"...","meaning":"..."}]}',
      },
      {
        role: 'user',
        content:
          `请为单词 "${word.word}"（释义：${word.meanings.join('；')}）写一个能体现其典型用法的英文例句，` +
          `例句长度 12-22 个词，难度适合英语学习者，例句里必须原样出现 "${word.word}" 这个词，` +
          '不要换成其它词形。' +
          `translation 必须是上面这句例句的中文翻译，整句翻完，不要省略、也不要用例句以外的内容。` +
          `再列出 2-3 个包含 "${word.word}" 的常见固定搭配，每个搭配都要有中文释义。`,
      },
    ],
    { temperature: 0.7 },
  )

  if (!out?.sentence) throw new AiError('模型未返回例句', 'parse')

  const clean: WordExample = {
    sentence: out.sentence,
    translation: out.translation ?? '',
    collocations: (out.collocations ?? []).filter((c) => Boolean(c?.phrase)),
  }

  try {
    await db.examples.put({ word: word.word, ...clean, createdAt: Date.now() })
  } catch {
    // 缓存写不进去不影响这次展示，下次重新生成即可
  }

  return clean
}

/** 正在生成中的例句：同一个词并发只会真的打一次请求 */
const inflight = new Map<string, Promise<WordExample | null>>()

/**
 * 拿到例句：有缓存直接给，没有就自动生成并写进缓存。
 *
 * 这是「不用手点」的那条路径 —— 失败一律返回 null 而不抛错，
 * 界面退回段落语境句或保留手动按钮，不会弹错误打断做题。
 * 没配 AI 时直接短路，也不写失败记录，配好之后再进来就能正常生成。
 */
export function autoExample(word: WordRecord): Promise<WordExample | null> {
  const running = inflight.get(word.word)
  if (running) return running

  const task = (async (): Promise<WordExample | null> => {
    try {
      const hit = await loadExample(word.word)
      if (hit) return hit
      const cfg = await loadAiConfig()
      if (configIssue(cfg)) return null
      return await generateExample(word)
    } catch {
      return null
    } finally {
      inflight.delete(word.word)
    }
  })()

  inflight.set(word.word, task)
  return task
}
