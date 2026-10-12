import type { AiConfig } from '@/ports/ai'
import { loadSettings } from '@/db/settings'
import type { AiProtocol } from '@/core/types'

/** 从本地设置读出 AI 连接配置（Key 只存在浏览器里，经本机中转发出） */
export async function loadAiConfig(): Promise<AiConfig> {
  const s = await loadSettings()
  return {
    baseUrl: String(s.aiBaseUrl ?? ''),
    apiKey: String(s.aiApiKey ?? ''),
    model: String(s.aiModel ?? ''),
    protocol: (s.aiProtocol as AiProtocol | undefined) ?? 'openai',
  }
}
