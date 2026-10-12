import { db, getSetting, setSetting } from '@/db'
import type { SettingKey, Settings } from '@/core/types'

/**
 * 每日新词上限的取值范围（设置页滑块与首次启动弹窗共用）。
 * **段落目标词数就等于它** —— 一个数字同时决定"今天背几个词"和"段落串几个词"，
 * 不再单独存一份，否则两个数迟早对不上。
 */
export const DAILY_NEW = { min: 5, max: 100, step: 5, fallback: 20 } as const

/** 夹到合法区间；非法输入退回默认值 */
export function clampDailyNew(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? '').trim(), 10)
  if (!Number.isFinite(n)) return DAILY_NEW.fallback
  return Math.min(DAILY_NEW.max, Math.max(DAILY_NEW.min, n))
}

export const DEFAULTS: Settings = {
  aiBaseUrl: 'https://api.deepseek.com/v1',
  aiApiKey: '',
  aiModel: 'deepseek-chat',
  aiProtocol: 'openai',
  aiEnabled: true,
  voiceName: '',
  voiceLang: 'en-US',
  requestRetention: 0.9,
  dailyNew: 20,
  dailyReview: 200,
  passageLevel: 'standard',
  theme: 'system',
  studyMode: 'cards',
}

/** 首次运行写入默认设置，之后不覆盖用户改动 */
export async function defaultSettings(): Promise<void> {
  const rows = await db.settings.toArray()
  const have = new Set(rows.map((r) => r.key))
  for (const [key, value] of Object.entries(DEFAULTS) as [SettingKey, Settings[SettingKey]][]) {
    if (!have.has(key)) await db.settings.put({ key, value })
  }
}

export async function loadSettings(): Promise<Settings> {
  await defaultSettings()
  const rows = await db.settings.toArray()
  const out: Settings = {}
  for (const r of rows) out[r.key as SettingKey] = r.value as Settings[SettingKey]
  return { ...DEFAULTS, ...out }
}

export async function updateSetting<K extends SettingKey>(key: K, value: Settings[K]): Promise<void> {
  await setSetting(key, value)
}

export { getSetting, setSetting }
