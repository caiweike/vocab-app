import { lazy, Suspense, type ReactNode } from 'react'
import { Route, Routes } from 'react-router-dom'
import { AppShell } from '@/components/AppShell'
import { HomePage } from '@/features/home/HomePage'
import { LearnPage } from '@/features/learn/LearnPage'
import { BooksPage } from '@/features/books/BooksPage'
import { BookDetailPage } from '@/features/books/BookDetailPage'
import { WordPage } from '@/features/word/WordPage'
import { ImportPage } from '@/features/import/ImportPage'
import { PassagePage } from '@/features/passage/PassagePage'
import { SettingsPage } from '@/features/settings/SettingsPage'
import NotFound from '@/features/NotFound'

// 统计页独占 Recharts（几百 KB），按需加载，避免进首页就下载图表库
const StatsPage = lazy(async () => ({ default: (await import('@/features/stats/StatsPage')).StatsPage }))

function Loading({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={<div className="py-10 text-center text-sm text-slate-500">载入中…</div>}
    >
      {children}
    </Suspense>
  )
}

export default function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/learn" element={<LearnPage />} />
        <Route path="/books" element={<BooksPage />} />
        <Route path="/books/:id" element={<BookDetailPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/word/:word" element={<WordPage />} />
        <Route path="/passage" element={<PassagePage />} />
        <Route
          path="/stats"
          element={
            <Loading>
              <StatsPage />
            </Loading>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AppShell>
  )
}
