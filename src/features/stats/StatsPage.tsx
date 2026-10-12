import { useMemo } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useLiveQuery } from 'dexie-react-hooks'
import { Card, Empty, SectionTitle, Stat } from '@/components/ui'
import { db } from '@/db'
import { dailyStats, heatmap, masteryBreakdown, retentionRate } from '@/core/stats'
import { masteryOf } from '@/core/srs'
import { useActiveBookId, useBookWords, useSrsMap } from '@/hooks'

const LEVEL_BG = [
  'bg-slate-100 dark:bg-slate-800',
  'bg-brand-200 dark:bg-brand-900',
  'bg-brand-300 dark:bg-brand-800',
  'bg-brand-400 dark:bg-brand-700',
  'bg-brand-600',
]

export function StatsPage() {
  const sessions = useLiveQuery(() => db.sessions.toArray(), [])
  const logs = useLiveQuery(() => db.reviewLog.toArray(), [])
  const bookId = useActiveBookId()
  const words = useBookWords(bookId)
  const srsMap = useSrsMap(words)

  const days = useMemo(() => dailyStats(sessions ?? [], 30), [sessions])
  const heat = useMemo(() => heatmap(sessions ?? [], 182), [sessions])

  const totals = useMemo(() => {
    const s = sessions ?? []
    return {
      totalReviews: s.reduce((a, x) => a + x.correct + x.wrong, 0),
      totalLearned: s.reduce((a, x) => a + x.newCount, 0),
      totalMinutes: Math.round(s.reduce((a, x) => a + x.durationSec, 0) / 60),
      activeDays: s.filter((x) => x.newCount + x.reviewCount > 0).length,
    }
  }, [sessions])

  const retention = useMemo(() => retentionRate(logs ?? [], 30), [logs])
  const mastery = useMemo(() => {
    if (!words || !srsMap) return null
    return masteryBreakdown(words.map((w) => masteryOf(srsMap.get(w))))
  }, [words, srsMap])

  // 保留率曲线：按 5 天分桶。锚点取最近一次复习时间（只依赖已有数据，渲染保持纯），
  // 这样不会因为重新渲染时墙钟跳动而改变结果。
  const retentionSeries = useMemo(() => {
    const all = logs ?? []
    if (all.length === 0) return []
    const anchor = Math.max(...all.map((l) => l.at))
    const out: { label: string; value: number | null }[] = []
    for (let bucket = 4; bucket >= 0; bucket--) {
      const to = anchor - bucket * 5 * 86400000
      const from = to - 5 * 86400000
      const slice = all.filter((l) => l.at > from && l.at <= to && l.stateBefore !== 0)
      out.push({
        label: new Date(to).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }),
        value: slice.length >= 5 ? Math.round((slice.filter((l) => l.rating >= 3).length / slice.length) * 100) : null,
      })
    }
    return out
  }, [logs])

  const chartData = days.map((d) => ({ ...d, day: Number(d.date.slice(-2)) }))

  if (!sessions) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>

  return (
    <div className="animate-rise space-y-5">
      <h1 className="text-xl font-semibold">学习统计</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="累计答题" value={totals.totalReviews} hint="次" />
        <Stat label="累计学习" value={totals.totalLearned} hint="新词" />
        <Stat label="学习天数" value={totals.activeDays} hint="天" />
        <Stat label="学习时长" value={totals.totalMinutes} hint="分钟" />
      </div>

      <Card>
        <SectionTitle>近 30 天每日学习量</SectionTitle>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} interval={3} stroke="currentColor" className="text-slate-400" />
              <YAxis tick={{ fontSize: 11 }} stroke="currentColor" className="text-slate-400" allowDecimals={false} />
              <Tooltip
                contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12 }}
                labelFormatter={(_, p) => `第 ${p?.[0]?.payload.day} 日`}
                formatter={(v, n) => [v ?? 0, n === 'reviews' ? '学习量' : '其中新词']}
              />
              <Bar dataKey="reviews" fill="#3385fb" radius={[4, 4, 0, 0]} />
              <Bar dataKey="news" fill="#fbbf24" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="mt-2 flex gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#3385fb]" /> 总学习量</span>
          <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-[#fbbf24]" /> 其中新词</span>
        </div>
      </Card>

      <div className="grid gap-5 sm:grid-cols-2">
        <Card>
          <SectionTitle>记忆保持率</SectionTitle>
          {retention === null ? (
            <Empty>还没有到期复习记录，学几天后再来看</Empty>
          ) : (
            <>
              <div className="mb-2 flex items-baseline gap-2">
                <span className="text-3xl font-semibold tabular-nums">{retention}%</span>
                <span className="text-sm text-slate-500">近 30 天复习答对率</span>
              </div>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={retentionSeries} margin={{ top: 4, right: 8, bottom: 0, left: -28 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="currentColor" className="text-slate-400" />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="currentColor" className="text-slate-400" />
                    <Tooltip contentStyle={{ borderRadius: 12, fontSize: 12 }} formatter={(v) => [`${v ?? 0}%`, '答对率']} />
                    <Line type="monotone" dataKey="value" stroke="#10b981" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </Card>

        <Card>
          <SectionTitle>掌握分布</SectionTitle>
          {mastery ? (
            <div className="space-y-3">
              {[
                { label: '未学', n: mastery.new, cls: 'bg-slate-300 dark:bg-slate-700' },
                { label: '学习中', n: mastery.learning, cls: 'bg-amber-400' },
                { label: '复习中', n: mastery.reviewing, cls: 'bg-brand-400' },
                { label: '已掌握', n: mastery.mastered, cls: 'bg-emerald-500' },
              ].map((r) => (
                <div key={r.label} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-slate-500">{r.label}</span>
                  <div className="h-3 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                    <div
                      className={`h-full ${r.cls}`}
                      style={{ width: `${mastery.total > 0 ? (r.n / mastery.total) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="w-14 shrink-0 text-right tabular-nums text-slate-600 dark:text-slate-300">
                    {r.n} · {mastery.total > 0 ? Math.round((r.n / mastery.total) * 100) : 0}%
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Empty>选择词书后显示</Empty>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>打卡日历（近 182 天）</SectionTitle>
        <div className="grid grid-flow-col grid-rows-7 gap-1 overflow-x-auto pb-1" style={{ gridAutoColumns: 'minmax(13px, 1fr)' }}>
          {heat.map((d) => (
            <div
              key={d.date}
              className={`aspect-square rounded-[3px] ${LEVEL_BG[d.level]}`}
              title={`${d.date}：${d.count} 词`}
            />
          ))}
        </div>
        <div className="mt-3 flex items-center justify-end gap-1.5 text-xs text-slate-400">
          少
          {LEVEL_BG.map((c, i) => (
            <i key={i} className={`h-3 w-3 rounded-[3px] ${c}`} />
          ))}
          多
        </div>
      </Card>
    </div>
  )
}
