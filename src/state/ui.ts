import { create } from 'zustand'

interface UiStore {
  /** 全局提示条 */
  toast: string | null
  showToast: (msg: string, ms?: number) => void
}

let timer: ReturnType<typeof setTimeout> | undefined

export const useUiStore = create<UiStore>((set) => ({
  toast: null,
  showToast: (msg, ms = 2600) => {
    set({ toast: msg })
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => set({ toast: null }), ms)
  },
}))
