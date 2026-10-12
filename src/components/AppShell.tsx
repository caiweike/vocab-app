import { useEffect, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { BookOpen, CalendarCheck, LineChart, NotebookPen, Settings, Sparkles } from 'lucide-react'
import { syncBuiltinBooks } from '@/db/seed'
import { clampDailyNew, DAILY_NEW, loadSettings, updateSetting } from '@/db/settings'
import { getVoices, setVoicePreference } from '@/ports/tts'
import { Button } from '@/components/ui'
import { useUiStore } from '@/state/ui'
import { applyTheme } from '@/lib/theme'

const NAV = [
  { to: '/', label: '首页', icon: CalendarCheck, end: true },
  { to: '/learn', label: '学习', icon: NotebookPen, end: false },
  { to: '/passage', label: '段落', icon: Sparkles, end: false },
  { to: '/books', label: '词书', icon: BookOpen, end: false },
  { to: '/stats', label: '统计', icon: LineChart, end: false },
  { to: '/settings', label: '设置', icon: Settings, end: false },
]

export function AppShell({ children }: { children: ReactNode }) {
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  /** 首次启动问一次每日新词上限；null = 不弹 */
  const [askDailyNew, setAskDailyNew] = useState<string | null>(null)
  const toast = useUiStore((s) => s.toast)
  const location = useLocation()

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        await syncBuiltinBooks()
        const s = await loadSettings()
        applyTheme((s.theme as string) ?? 'system')
        // 选过的朗读语音必须在启动时恢复，否则每次刷新都退回自动挑选 ——
        // 挑错了声音（甚至挑到中文声）听起来会非常机械
        const voices = getVoices()
        const savedVoice = String(s.voiceName ?? '')
        setVoicePreference(
          savedVoice || null,
          voices.find((v) => v.name === savedVoice)?.lang ?? 'en-US',
        )
        // 首次启动问一次「每天学几个新词」。这个数同时决定段落用几个词，
        // 所以一个数管两处；故意不写进 DEFAULTS，否则"没设过"判断不出来、弹窗永远不出现
        if (s.setupDone !== true) setAskDailyNew(String(DAILY_NEW.fallback))
      } catch (e) {
        if (alive) setBootError((e as Error).message)
      } finally {
        if (alive) setBooting(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 切换路由时滚回顶部
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [location.pathname])

  /** 首次启动弹窗：写进每日新词上限。存不进去也必须能关掉，否则会把整个应用堵死 */
  async function saveDailyNew(raw: string) {
    const value = clampDailyNew(raw)
    try {
      await updateSetting('dailyNew', value)
      await updateSetting('setupDone', true)
    } catch (e) {
      console.error('[setup] 每日新词上限保存失败', e)
    }
    setAskDailyNew(null)
  }

  if (booting) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        正在载入词库…
      </div>
    )
  }

  if (bootError) {
    return (
      <div className="mx-auto max-w-lg p-6 text-sm">
        <div className="rounded-xl border border-rose-300 bg-rose-50 p-4 text-rose-800 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200">
          初始化失败：{bootError}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 pb-24 pt-4 sm:px-6">
      <main className="flex-1">{children}</main>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
        <div className="mx-auto flex max-w-5xl justify-between px-2 sm:px-6">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex min-w-14 flex-col items-center gap-0.5 px-2 py-2.5 text-[11px] transition-colors ${
                  isActive
                    ? 'font-semibold text-brand-600 dark:text-brand-400'
                    : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
                }`
              }
            >
              <Icon size={19} strokeWidth={2} />
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      {toast ? (
        <div className="fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          {toast}
        </div>
      ) : null}

      {/* 首次启动：先定每天学几个新词，再放行 */}
      {askDailyNew !== null ? (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void saveDailyNew(askDailyNew)
            }}
            className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl dark:border-slate-700 dark:bg-slate-900"
          >
            <h2 className="text-lg font-semibold">先定每天学几个新词</h2>
            <p className="mt-1.5 text-sm text-slate-500">
              这个数同时管两件事：今天背几个新词，以及 AI 段落拿几个词串短文。
              填 {DAILY_NEW.min}–{DAILY_NEW.max} 之间的数，之后在设置页「学习计划」里随时改。
            </p>
            <label htmlFor="daily-new" className="mt-4 block text-sm text-slate-500">
              每日新词上限
            </label>
            <input
              id="daily-new"
              type="number"
              inputMode="numeric"
              min={DAILY_NEW.min}
              max={DAILY_NEW.max}
              step={DAILY_NEW.step}
              autoFocus
              value={askDailyNew}
              onChange={(e) => setAskDailyNew(e.target.value)}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-lg outline-none focus:border-brand-500 dark:border-slate-700 dark:bg-slate-800"
            />
            <Button type="submit" className="mt-4 w-full" size="lg">
              开始使用
            </Button>
          </form>
        </div>
      ) : null}
    </div>
  )
}
