import { useEffect, useMemo, useState } from 'react'
import 'dexie-export-import'
import { Download, Loader2, List, Trash2, Upload, Volume2, CheckCircle2, AlertCircle } from 'lucide-react'
import { Button, Card, SectionTitle } from '@/components/ui'
import { applyTheme } from '@/lib/theme'
import { useSettings } from '@/hooks'
import { db } from '@/db'
import { DAILY_NEW } from '@/db/settings'
import { fetchModels, testConnection, type AiConfig, type ModelOption } from '@/ports/ai'
import { AI_PROTOCOLS, PASSAGE_LEVELS, type AiProtocol, type PassageLevel } from '@/core/types'
import { isTtsAvailable, setVoicePreference, speak } from '@/ports/tts'
import { useUiStore } from '@/state/ui'

export function SettingsPage() {
  const { settings, update, updateAll, ready } = useSettings()
  const toast = useUiStore((s) => s.showToast)
  const [exporting, setExporting] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => readVoices())

  // 语音列表异步加载：effect 只注册监听，setState 发生在之后触发的回调里
  useEffect(() => {
    if (!isTtsAvailable()) return
    const handler = () => setVoices(readVoices())
    window.speechSynthesis.addEventListener('voiceschanged', handler)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', handler)
  }, [])

  const englishVoices = useMemo(() => voices.filter((v) => v.lang.toLowerCase().startsWith('en')), [voices])

  if (!ready || !settings) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>

  async function exportBackup() {
    setExporting(true)
    try {
      const blob = await db.export()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `vocab-backup-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast('备份已导出')
    } catch (e) {
      toast(`导出失败：${(e as Error).message}`)
    } finally {
      setExporting(false)
    }
  }

  async function importBackup(file: File) {
    if (!window.confirm('导入备份会覆盖当前所有数据，确定继续？')) return
    try {
      await db.import(file)
      toast('备份已导入，正在刷新…')
      setTimeout(() => window.location.reload(), 800)
    } catch (e) {
      toast(`导入失败：${(e as Error).message}`, 5000)
    }
  }

  async function clearProgress() {
    if (!window.confirm('清除所有学习进度、复习记录和打卡数据？词书和导入的词表会保留。此操作不可撤销。')) return
    await db.transaction('rw', db.srs, db.reviewLog, db.sessions, db.passages, async () => {
      await db.srs.clear()
      await db.reviewLog.clear()
      await db.sessions.clear()
      await db.passages.clear()
    })
    toast('学习进度已清除')
  }

  // key 绑定已保存的值：保存后重建子组件，草稿自然回到已存状态
  const configKey = `${settings.aiBaseUrl}|${settings.aiApiKey}|${settings.aiModel}|${settings.aiProtocol}`

  return (
    <div className="animate-rise mx-auto max-w-2xl space-y-5">
      <h1 className="text-xl font-semibold">设置</h1>

      <AiConfigCard
        key={configKey}
        initial={{
          baseUrl: String(settings.aiBaseUrl ?? ''),
          apiKey: String(settings.aiApiKey ?? ''),
          model: String(settings.aiModel ?? ''),
          protocol: (settings.aiProtocol as AiProtocol | undefined) ?? 'openai',
        }}
        onSave={async (cfg) => {
          await updateAll({
            aiBaseUrl: cfg.baseUrl,
            aiApiKey: cfg.apiKey,
            aiModel: cfg.model,
            aiProtocol: cfg.protocol ?? 'openai',
          })
          toast('AI 配置已保存')
        }}
      />

      <Card>
        <SectionTitle>学习计划</SectionTitle>
        <div className="space-y-4">
          <Slider
            label="每日新词上限"
            hint="同时决定 AI 段落拿几个词串短文"
            value={Number(settings.dailyNew ?? DAILY_NEW.fallback)}
            min={DAILY_NEW.min}
            max={DAILY_NEW.max}
            step={DAILY_NEW.step}
            suffix="词"
            onChange={(v) => void update('dailyNew', v)}
          />
          <Slider
            label="每日复习上限"
            value={Number(settings.dailyReview ?? 200)}
            min={20}
            max={600}
            step={20}
            suffix="词"
            onChange={(v) => void update('dailyReview', v)}
          />
          <Slider
            label="目标记忆保持率"
            value={Math.round(Number(settings.requestRetention ?? 0.9) * 100)}
            min={70}
            max={97}
            step={1}
            suffix="%"
            hint="越高复习越频繁、记得越牢"
            onChange={(v) => void update('requestRetention', v / 100)}
          />
        </div>
      </Card>

      <Card>
        <SectionTitle>阅读段落</SectionTitle>
        <Field
          label="段落难度"
          htmlFor="passage-level"
          hint="控制 AI 生成段落的句子长度与词汇范围；改了之后当天会重新生成一篇，不会复用旧的"
        >
          <select
            id="passage-level"
            value={String(settings.passageLevel ?? 'standard')}
            onChange={(e) => void update('passageLevel', e.target.value as PassageLevel)}
            className={inputCls}
          >
            {PASSAGE_LEVELS.map((lv) => (
              <option key={lv.value} value={lv.value}>
                {lv.label}
              </option>
            ))}
          </select>
        </Field>
        <p className="mt-2 text-xs text-slate-400">
          {
            PASSAGE_LEVELS.find((lv) => lv.value === (settings.passageLevel ?? 'standard'))?.prompt
          }
        </p>
      </Card>

      <Card>
        <SectionTitle>发音</SectionTitle>
        {!isTtsAvailable() ? (
          <p className="text-sm text-slate-500">当前浏览器不支持语音合成。</p>
        ) : (
          <>
            <div className="space-y-2">
              <label htmlFor="ai-voice" className="text-sm text-slate-500">
                朗读语音
              </label>
              <select
                id="ai-voice"
                value={String(settings.voiceName ?? '')}
                onChange={(e) => {
                  void update('voiceName', e.target.value)
                  const v = voices.find((x) => x.name === e.target.value)
                  setVoicePreference(e.target.value || null, v?.lang ?? 'en-US')
                  if (v) speak('vocabulary', voices)
                }}
                className={inputCls}
              >
                <option value="">自动选择（推荐）</option>
                {englishVoices.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.name} — {v.lang}
                  </option>
                ))}
              </select>
              {englishVoices.length === 0 ? (
                <p className="text-xs text-amber-600">
                  还没检测到英语语音。Windows 上用 Edge 浏览器的英文音质明显好于 Chrome。
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => speak('Hello, let us start learning.', voices)}
            >
              <Volume2 size={14} /> 试听
            </Button>
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>外观</SectionTitle>
        <div className="flex gap-2">
          {(['system', 'light', 'dark'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                void update('theme', t)
                applyTheme(t)
              }}
              className={`rounded-xl px-4 py-2 text-sm ${
                settings.theme === t
                  ? 'bg-brand-600 text-white'
                  : 'border border-slate-300 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              {{ system: '跟随系统', light: '浅色', dark: '深色' }[t]}
            </button>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>数据</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void exportBackup()} disabled={exporting}>
            {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} 导出备份
          </Button>
          <label className="inline-flex">
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importBackup(f)
                e.target.value = ''
              }}
            />
            <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-slate-300 px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800">
              <Upload size={14} /> 导入备份
            </span>
          </label>
          <Button variant="danger" onClick={() => void clearProgress()}>
            <Trash2 size={14} /> 清除学习进度
          </Button>
        </div>
        <p className="mt-3 text-xs text-slate-400">
          数据全部保存在浏览器本地（IndexedDB）。换电脑或清理浏览器数据前请先导出备份。
        </p>
      </Card>
    </div>
  )
}

function readVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return []
  return window.speechSynthesis.getVoices()
}

/** 服务商预设：选一个自动填好协议、地址和默认模型 */
const PRESETS: { label: string; protocol: AiProtocol; baseUrl: string; model?: string }[] = [
  { label: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com', model: 'gpt-4o-mini' },
  { label: 'Anthropic Claude', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { label: '月之暗面 Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '阿里通义千问', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: 'Ollama（本机）', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1' },
]

/**
 * AI 连接配置。初始状态直接来自 props（父组件用 key 绑定已保存值重建），
 * 这样保存后表单会回到已存状态，而不必在 effect 里同步表单。
 */
function AiConfigCard({ initial, onSave }: { initial: AiConfig; onSave: (cfg: AiConfig) => void | Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl)
  const [apiKey, setApiKey] = useState(initial.apiKey)
  const [model, setModel] = useState(initial.model)
  const [protocol, setProtocol] = useState<AiProtocol>(initial.protocol ?? 'openai')
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const [models, setModels] = useState<ModelOption[] | null>(null)
  const [modelsBusy, setModelsBusy] = useState(false)
  const [modelsError, setModelsError] = useState<string | null>(null)

  const draft: AiConfig = {
    baseUrl: baseUrl.trim(),
    apiKey: apiKey.trim(),
    model: model.trim(),
    protocol,
  }

  async function runTest() {
    setTesting(true)
    setResult(null)
    setResult(await testConnection(draft))
    setTesting(false)
  }

  async function loadModels() {
    setModelsBusy(true)
    setModelsError(null)
    try {
      const list = await fetchModels(draft)
      setModels(list)
      // 模型名为空时要真的选中第一项：否则 <select> 视觉上选了第一项、
      // React state 却仍是空串，保存下去就是个空模型名
      if (!model.trim() || list.length === 1) setModel(list[0].id)
    } catch (e) {
      setModels(null)
      setModelsError((e as Error).message)
    } finally {
      setModelsBusy(false)
    }
  }

  function applyPreset(name: string) {
    const p = PRESETS.find((x) => x.label === name)
    if (!p) return
    setBaseUrl(p.baseUrl)
    setProtocol(p.protocol)
    setModel(p.model ?? '')
    setModels(null)
    setModelsError(null)
    setResult(null)
  }

  const protocolHint = AI_PROTOCOLS.find((p) => p.value === protocol)?.hint ?? ''

  return (
    <Card>
      <SectionTitle>AI 接口（用于段落与例句生成）</SectionTitle>
      <div className="space-y-3">
        <Field
          label="服务商预设"
          hint="选一个会填好协议与地址；模型名可用下面的按钮自动获取"
          htmlFor="ai-preset"
        >
          <select
            id="ai-preset"
            defaultValue=""
            onChange={(e) => applyPreset(e.target.value)}
            className={inputCls}
          >
            <option value="" disabled>
              选择服务商…
            </option>
            {PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="接口协议" hint={protocolHint} htmlFor="ai-protocol">
          <select
            id="ai-protocol"
            value={protocol}
            onChange={(e) => {
              setProtocol(e.target.value as AiProtocol)
              setModels(null)
              setModelsError(null)
            }}
            className={inputCls}
          >
            {AI_PROTOCOLS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="接口地址 Base URL" hint="可带可不带 /v1，中转会自动补全" htmlFor="ai-baseurl">
          <input
            id="ai-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.deepseek.com/v1"
            className={inputCls}
          />
        </Field>

        <Field
          label="API Key"
          hint="只保存在你本机浏览器里，请求经本机中转服务发出"
          htmlFor="ai-key"
        >
          <input
            id="ai-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-..."
            className={inputCls}
          />
        </Field>

        <Field label="模型名" htmlFor="ai-model">
          <div className="flex gap-2">
            <input
              id="ai-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              className={inputCls}
            />
            <Button variant="outline" onClick={() => void loadModels()} disabled={modelsBusy} className="shrink-0">
              {modelsBusy ? <Loader2 size={14} className="animate-spin" /> : <List size={14} />} 获取列表
            </Button>
          </div>
          {models ? (
            <div className="mt-2">
              <select
                id="ai-model-list"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className={inputCls}
              >
                {!models.some((m) => m.id === model) && model ? <option value={model}>{model}（当前）</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label === m.id ? m.id : `${m.label}（${m.id}）`}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-slate-400">共 {models.length} 个可用模型，选一个填回上面的输入框。</p>
            </div>
          ) : null}
          {modelsError ? <p className="mt-2 text-xs text-rose-600">{modelsError}</p> : null}
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => void onSave(draft)}>保存</Button>
          <Button variant="outline" onClick={() => void runTest()} disabled={testing}>
            {testing ? <Loader2 size={14} className="animate-spin" /> : null} 测试连接
          </Button>
        </div>

        {result ? (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-sm ${
              result.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'
                : 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300'
            }`}
          >
            {result.ok ? (
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" />
            ) : (
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
            )}
            <span className="break-all">{result.message}</span>
          </div>
        ) : null}
        <p className="text-xs text-slate-400">
          需要先启动中转服务：项目目录运行{' '}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">npm run server</code>，或直接{' '}
          <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">npm run dev:all</code> 同时启动前后端。
        </p>
      </div>
    </Card>
  )
}

const inputCls =
  'w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-900'

function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="text-sm text-slate-500">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-xs text-slate-400">{hint}</p> : null}
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  suffix,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-slate-500">{label}</span>
        <span className="font-medium tabular-nums">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-brand-600"
      />
      {hint ? <p className="mt-0.5 text-xs text-slate-400">{hint}</p> : null}
    </div>
  )
}
