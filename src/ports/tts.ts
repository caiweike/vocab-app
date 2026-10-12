/**
 * 发音端口。平台相关实现集中在这里 ——
 * 换 React Native 时替换为 react-native-tts，小程序换成 wx.createInnerAudioContext。
 */

let preferredVoiceName: string | null = null
let preferredLang = 'en-US'
let voicesCache: SpeechSynthesisVoice[] = []

/** 服务端发音地址，由 Vite 代理到 scripts/tts-server.py（127.0.0.1:8791） */
const REMOTE_TTS = '/tts'
let remoteEnabled = true
let currentAudio: HTMLAudioElement | null = null

/** 只有单个英文词值得走服务端；例句、中文一律本地念 */
function isPlainWord(text: string): boolean {
  return /^[A-Za-z][A-Za-z'-]*$/.test(text)
}

export function setVoicePreference(name: string | null, lang = 'en-US'): void {
  preferredVoiceName = name
  preferredLang = lang
}

/** 语音列表是异步加载的，首次调用可能返回空数组 —— 必须等 voiceschanged */
export function getVoices(onChange?: (voices: SpeechSynthesisVoice[]) => void): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return []
  const synth = window.speechSynthesis
  const current = synth.getVoices()
  if (current.length > 0) {
    voicesCache = current
    onChange?.(current)
    return current
  }
  if (voicesCache.length > 0) return voicesCache
  synth.addEventListener?.('voiceschanged', () => {
    voicesCache = synth.getVoices()
    onChange?.(voicesCache)
  })
  return []
}

/** 挑一个英语声音：优先指定的 > 指定语言 > 任何英语 > 任何声音 */
export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null
  if (preferredVoiceName) {
    const exact = voices.find((v) => v.name === preferredVoiceName)
    if (exact) return exact
  }
  const byLang = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === preferredLang.toLowerCase())
  if (byLang.length > 0) return sortByQuality(byLang)[0]
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  if (english.length > 0) return sortByQuality(english)[0]
  return voices[0]
}

/**
 * 排序倾向：Windows 上 Edge 的 neural 语音明显优于 Chrome 的 SAPI 语音，
 * 名字里带 Natural/Neural/Enhanced/Premium 的优先。
 */
function sortByQuality(list: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const score = (v: SpeechSynthesisVoice) => {
    const n = v.name.toLowerCase()
    let s = 0
    if (/natural|neural/.test(n)) s += 100
    if (/enhanced|premium|optimized/.test(n)) s += 50
    if (/google/.test(n)) s += 30
    if (/siri/.test(n)) s += 20
    if (v.localService) s += 5
    if (/microsoft| sapi/.test(n)) s -= 10
    return s
  }
  return [...list].sort((a, b) => score(b) - score(a))
}

export function isTtsAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/**
 * 朗读。**优先走服务端**（`scripts/tts-server.py`，Kokoro 离线合成，音质比本机
 * 那几个 SAPI 声音自然得多，而且 Web / App / 小程序三端共用同一套发音）；
 * 服务端拿不到就回退到浏览器自带的 speechSynthesis。
 *
 * 一次只播一个：播之前先掐掉上一次（无论本地还是远程），否则切词会叠音。
 * 远程失败后本次会话直接走本地，不再反复发废请求。
 */
export function speak(text: string, voices?: SpeechSynthesisVoice[]): void {
  if (!text) return
  stopSpeaking()

  if (remoteEnabled && isPlainWord(text) && typeof Audio !== 'undefined') {
    const audio = new Audio(`${REMOTE_TTS}/${encodeURIComponent(text)}`)
    currentAudio = audio
    let settled = false

    const fallback = (serverBroken: boolean) => {
      if (settled) return
      settled = true
      if (serverBroken) remoteEnabled = false
      if (currentAudio === audio) currentAudio = null
      audio.pause()
      speakLocal(text, voices)
    }

    audio.addEventListener('error', () => fallback(true), { once: true })
    // play() 被浏览器手势策略拦下不算服务端故障，只换本地念、不关掉远程
    void audio.play().catch(() => fallback(false))
    return
  }

  speakLocal(text, voices)
}

function speakLocal(text: string, voices?: SpeechSynthesisVoice[]): void {
  if (!isTtsAvailable() || !text) return
  const synth = window.speechSynthesis
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const v = pickVoice(voices ?? getVoices())
  if (v) {
    u.voice = v
    u.lang = v.lang
  } else {
    u.lang = preferredLang
  }
  u.rate = 0.95
  u.pitch = 1
  synth.speak(u)
}

export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause()
    currentAudio.removeAttribute('src')
    currentAudio = null
  }
  if (isTtsAvailable()) window.speechSynthesis.cancel()
}
