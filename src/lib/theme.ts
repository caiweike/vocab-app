/** 主题切换：与组件解耦，方便在初始化和设置页两处调用 */
export function applyTheme(theme: string): void {
  const root = document.documentElement
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  const dark = theme === 'dark' || (theme === 'system' && prefersDark)
  root.classList.toggle('dark', dark)
}
