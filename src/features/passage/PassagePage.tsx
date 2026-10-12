import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Loader2, Pencil, RefreshCw, Sparkles, Volume2, Check, X } from 'lucide-react'
import { Badge, Button, Card, SectionTitle } from '@/components/ui'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db'
import { useActiveBookId, useBookWords, useSettings } from '@/hooks'
import { clampDailyNew } from '@/db/settings'
import { chunkTargets, MIN_PASSAGE_WORDS, passageId, WORDS_PER_PASSAGE } from '@/core/passage'
import { newWordsLearnedToday, startOfDay, toDateKey } from '@/core/queue'
import { configIssue, AiError, chatStream } from '@/ports/ai'
import { loadAiConfig } from '@/ports/aiConfig'
import { speak } from '@/ports/tts'
import { splitSentences } from '@/core/exercises'
import { PASSAGE_LEVELS, type Collocation, type PassageLevel, type PassageQuestion, type PassageRecord } from '@/core/types'

interface PassageShape {
  passage: string
  translation: string
  collocations: Collocation[]
  questions: PassageQuestion[]
}

/** 段落至少要几个词，否则串不出一篇像样的短文 */
const MIN_TARGETS = MIN_PASSAGE_WORDS

/**
 * 内容指纹，只作为记录里的元数据保留。
 * 真正的定位靠 `passageId`（日期 + 难度 + 篇号）—— 若用词集当 key，
 * 每多学一个词 key 就变、缓存全失效，接上自动生成就会变成每学一个词调一次模型。
 */
function passageHash(targets: string[], level: PassageLevel): string {
  return hash([...targets].sort().join('|') + '|' + level)
}

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function buildPrompt(targets: string[], level: PassageLevel): { system: string; user: string } {
  const list = targets.map((w, i) => `${i + 1}. ${w}`).join('\n')
  const spec = PASSAGE_LEVELS.find((l) => l.value === level) ?? PASSAGE_LEVELS[1]
  return {
    system:
      '你是英语阅读教学专家。只输出一个 JSON 对象，不要输出任何解释文字，不要使用 markdown 代码块。' +
      'JSON 结构为：{\n' +
      '  "passage": "一段英文短文",\n' +
      '  "translation": "与英文句子逐句对应的中文翻译，句子之间用换行分隔",\n' +
      '  "collocations": [{"phrase": "英文固定搭配", "meaning": "中文释义", "sentence": "该搭配所在的英文原句"}],\n' +
      '  "questions": [{"question": "阅读理解问题", "options": ["A", "B", "C", "D"], "answerIndex": 0, "explanation": "中文解析"}]\n' +
      '}',
    user:
      `请用下面这些单词写一段 150-220 词的英文短文，主题自选但要贴近日常生活或社会话题。
` +
      `${spec.prompt}

` +
      `要求：\n` +
      `1. 每个目标词都必须自然地出现在短文中（允许必要的词形变化，如复数、过去式、-ing）。\n` +
      `2. 短文要自然流畅，不能是单词堆砌，并且要体现这些词的典型固定搭配。\n` +
      `3. 翻译必须与英文逐句对应，一句一行。\n` +
      `4. 从短文中挑出 4-6 个含目标词的固定搭配，每个都给出它所在的英文原句。\n` +
      `5. 出 2 道四选一阅读理解题，答案不同，options 长度必须为 4，answerIndex 为 0-3。\n\n` +
      `目标单词：\n${list}`,
  }
}

/** 流式过程中从"还没写完"的 JSON 里捞出已完成的字段 */
function extractString(partial: string, key: string): string | null {
  const m = partial.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
  if (!m) return null
  return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, '\t').replace(/\\\\/g, '\\')
}

export function PassagePage() {
  const bookId = useActiveBookId()
  const words = useBookWords(bookId)
  const { settings } = useSettings()
  const level = (settings?.passageLevel as PassageLevel | undefined) ?? 'standard'
  /** 目标词数量是用户在首次启动时填的（设置页也能改） */
  /** 目标词数 = 每日新词上限（一个数字同时管背词量和段落用词量） */
  const maxTargets = clampDailyNew(settings?.dailyNew)
  /** 没配好 AI 就不自动调模型，免得一进页面就弹一条配置错误 */
  const aiReady = Boolean(
    settings &&
      settings.aiEnabled !== false &&
      settings.aiBaseUrl &&
      settings.aiApiKey &&
      settings.aiModel,
  )

  const [generated, setGenerated] = useState<PassageRecord | null>(null)
  const [streamText, setStreamText] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealed, setRevealed] = useState(false)

  const targets = useLiveQuery(async () => {
    const dayStart = startOfDay(new Date()).getTime()
    const todayLogs = await db.reviewLog.where('at').aboveOrEqual(dayStart).toArray()
    // 目标词只取**今天第一次学的新词**，不掺复习词 —— 否则段落里全是熟词，
    // 达不到"在语境里认识新词"的目的。不够时再从词书补还没学过的词（同样是新词）。
    const seen = newWordsLearnedToday(todayLogs, dayStart).slice(0, maxTargets)
    if (seen.length >= MIN_TARGETS) return seen

    // 今天学的词不够，从当前词书里取接下来要学的
    if (!words || words.length === 0) return seen
    const srs = await db.srs.bulkGet(words)
    const untouched: string[] = []
    for (let i = 0; i < words.length && untouched.length < maxTargets - seen.length; i++) {
      if (srs[i] === undefined) untouched.push(words[i])
    }
    return [...seen, ...untouched]
  }, [words, maxTargets])

  const todayKey = toDateKey()

  /** 目标词按每篇约 WORDS_PER_PASSAGE 个均分；`chunk` 是当前看第几篇 */
  const chunks = useMemo(() => chunkTargets(targets ?? []), [targets])
  const [chunk, setChunk] = useState(0)
  const activeChunk = Math.min(chunk, Math.max(chunks.length - 1, 0))
  // 必须 useMemo：`?? []` 每次渲染都新建数组，会让下游 memo/callback 每帧失效
  const activeTargets = useMemo(() => chunks[activeChunk] ?? [], [chunks, activeChunk])

  // 必须显式 `?? null`：Dexie 的 get() 查不到返回 undefined，
  // 而下面的守卫靠 `record !== null` 区分"还在查"和"确实没有"，不归零就会一直等下去
  const cached = useLiveQuery(
    async () => (await db.passages.get(passageId(todayKey, level, activeChunk))) ?? null,
    [todayKey, level, activeChunk],
  )

  /** 用户刚生成的优先，否则用当天缓存 */
  const record = generated ?? cached

  const targetSet = useMemo(
    () => new Set((record?.targets ?? activeTargets).map((w) => w.toLowerCase())),
    [record, activeTargets],
  )

  const generate = useCallback(
    async (force = false) => {
      if (activeTargets.length < MIN_TARGETS) {
        setError('今天学习的单词还不够（至少 4 个），先去学几个单词吧。')
        return
      }
      setError(null)
      setGenerated(null)
      setStreamText('')
      setRevealed(false)

      // 一条记录 = 今天 + 这个难度 + 第几篇；重复生成会覆盖同一条，不会越攒越多
      const id = passageId(todayKey, level, activeChunk)
      if (!force) {
        const hit = await db.passages.get(id)
        if (hit) {
          setGenerated(hit)
          return
        }
      }

      let cfg
      try {
        cfg = await loadAiConfig()
      } catch {
        cfg = { baseUrl: '', apiKey: '', model: '' }
      }
      const issue = configIssue(cfg)
      if (issue) {
        setError(`${issue}到「设置」里配好再来。`)
        return
      }

      const { system, user } = buildPrompt(activeTargets, level)
      setStreaming(true)
      try {
        const raw = await chatStream(
          cfg,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          (delta) => {
            setStreamText((prev) => prev + delta)
          },
          { temperature: 0.9 },
        )
        const parsed = parsePassage(raw)
        const rec: PassageRecord = {
          id,
          date: todayKey,
          hash: passageHash(activeTargets, level),
          createdAt: Date.now(),
          level,
          targets: activeTargets,
          passage: parsed.passage,
          translation: parsed.translation,
          collocations: parsed.collocations,
          questions: parsed.questions,
          model: cfg.model,
        }
        await db.passages.put(rec)
        setGenerated(rec)
      } catch (e) {
        setError(e instanceof AiError ? e.message : (e as Error).message)
      } finally {
        setStreaming(false)
        setStreamText('')
      }
    },
    [activeTargets, activeChunk, todayKey, level],
  )

  /**
   * 自动生成：这一篇还没生成就自己跑，省掉那一下点击。
   *
   * - 按「日期 + 难度 + 篇号」记账：切到没生成的篇就跑，已生成的直接复用
   * - `record !== null` 才动手：`undefined` 表示缓存还没查完，等它
   * - `autoKey` 挡住同一篇的重复触发（streaming / generate 引用变化都会重跑这个 effect）
   * - 没配 AI 时不自动跑，免得一进页面就弹配置错误
   */
  const autoKey = useRef<string | null>(null)
  useEffect(() => {
    const key = passageId(todayKey, level, activeChunk)
    if (autoKey.current === key) return
    if (record !== null || streaming || error || !aiReady) return
    if (activeTargets.length < MIN_TARGETS) return
    autoKey.current = key
    // 规则担心的是「effect 里同步 setState 造成级联渲染」；这里 generate 干的是异步请求
    // （清状态 + 调模型 + 流式回填），同步那几行只是清空上一次的 UI，不会级联。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void generate()
  }, [record, streaming, error, aiReady, activeTargets.length, activeChunk, todayKey, level, generate])

  const sentences = useMemo(() => (record ? splitSentences(record.passage) : []), [record])

  if (!settings) return <div className="py-10 text-center text-sm text-slate-500">载入中…</div>

  return (
    <div className="animate-rise mx-auto max-w-3xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="text-brand-500" size={20} /> 今日阅读段落
          </h1>
          <p className="mt-0.5 text-sm text-slate-500">
            把今天学的单词串成一篇短文，在语境里掌握固定搭配和阅读。
          </p>
          <Link
            to="/settings"
            className="mt-1 inline-flex items-center gap-1 text-xs text-slate-400 hover:text-brand-500"
            title="到设置页调整段落难度"
          >
            难度：{PASSAGE_LEVELS.find((l) => l.value === level)?.label}
            <Pencil size={11} />
          </Link>
        </div>
        {record ? (
          <Button variant="outline" size="sm" onClick={() => void generate(true)}>
            <RefreshCw size={14} /> 换一段
          </Button>
        ) : null}
      </div>

      {/* 拆成多篇：每篇约 WORDS_PER_PASSAGE 个词，切到没生成的篇会自动补齐 */}
      {chunks.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-slate-500">篇目</span>
          {chunks.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => {
                setChunk(i)
                // 让 record 落到新篇的缓存上，而不是继续显示上一篇
                setGenerated(null)
              }}
              className={`rounded-lg px-2.5 py-1 text-sm font-medium transition-colors ${
                i === activeChunk
                  ? 'bg-brand-600 text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              第 {i + 1} 篇
            </button>
          ))}
          <span className="text-xs text-slate-400">
            共 {chunks.length} 篇 · 每篇约 {WORDS_PER_PASSAGE} 词
          </span>
        </div>
      ) : null}

      <Card>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">目标词</span>
          {(record?.targets ?? activeTargets).map((w) => (
            <Link key={w} to={`/word/${encodeURIComponent(w)}`}>
              <Badge tone={targetSet.has(w.toLowerCase()) ? 'brand' : 'slate'}>{w}</Badge>
            </Link>
          ))}
          {!record && !streaming ? (
            <span className="ml-auto text-xs text-slate-400">
              {(targets ?? []).length < MIN_TARGETS
                ? '今天学的词还不够 4 个'
                : `共 ${(targets ?? []).length} 个词，分 ${chunks.length} 篇`}
            </span>
          ) : null}
        </div>

        {!record && !streaming && !error ? (
          <div className="mt-4 text-center">
            <Button onClick={() => void generate()} disabled={(targets ?? []).length < MIN_TARGETS}>
              <Sparkles size={16} /> 生成今日段落
            </Button>
          </div>
        ) : null}

        {streaming ? (
          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2 text-sm text-slate-500">
              <Loader2 size={15} className="animate-spin" /> 正在生成…
            </div>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">
              {extractString(streamText, 'passage') ?? <span className="text-slate-400">准备中</span>}
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-brand-500 align-middle" />
            </p>
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">
            <p>{error}</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void generate(true)}>
                重试
              </Button>
              <Link to="/settings">
                <Button size="sm" variant="ghost">去设置</Button>
              </Link>
            </div>
          </div>
        ) : null}
      </Card>

      {record ? (
        <>
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <SectionTitle>短文</SectionTitle>
              <button
                onClick={() => setRevealed((v) => !v)}
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                {revealed ? '隐藏中文' : '显示中文'}
              </button>
            </div>
            <div className="space-y-3 text-[15px] leading-[1.9]">
              {sentences.map((s, i) => (
                <div key={i}>
                  <p>
                    <HighlightTargets text={s} targets={targetSet} />
                    <button
                      onClick={() => speak(s)}
                      className="ml-1.5 rounded p-1 text-slate-300 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
                      title="朗读本句"
                    >
                      <Volume2 size={14} />
                    </button>
                  </p>
                  {revealed ? <p className="mt-0.5 text-sm text-slate-500">{record.translation.split('\n')[i] ?? ''}</p> : null}
                </div>
              ))}
            </div>
          </Card>

          {record.collocations.length > 0 ? (
            <Card>
              <SectionTitle>固定搭配</SectionTitle>
              <div className="space-y-3">
                {record.collocations.map((c, i) => (
                  <div key={`${c.phrase}-${i}`} className="rounded-xl bg-slate-50 p-3 dark:bg-slate-950">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <b className="text-[15px] text-brand-700 dark:text-brand-300">{c.phrase}</b>
                      <span className="text-sm text-slate-500">{c.meaning}</span>
                    </div>
                    {c.sentence ? (
                      <p className="mt-1.5 text-sm italic leading-relaxed text-slate-500">
                        <HighlightTargets text={c.sentence} targets={targetSet} />
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          {record.questions.length > 0 ? (
            <Questions questions={record.questions} />
          ) : null}

          <p className="pb-4 text-center text-xs text-slate-400">由 {record.model} 生成 · 已缓存，重复打开不再调用</p>
        </>
      ) : null}
    </div>
  )
}

function HighlightTargets({ text, targets }: { text: string; targets: Set<string> }) {
  if (targets.size === 0) return <>{text}</>
  const parts = text.split(/(\b[A-Za-z][A-Za-z'-]*\b)/g)
  return (
    <>
      {parts.map((p, i) => {
        const hit = targets.has(p.toLowerCase())
        return hit ? (
          <mark key={i} className="target-word">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      })}
    </>
  )
}

function Questions({ questions }: { questions: PassageQuestion[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({})

  return (
    <Card>
      <SectionTitle>阅读理解</SectionTitle>
      <div className="space-y-5">
        {questions.map((q, qi) => {
          const chosen = picked[qi]
          return (
            <div key={qi}>
              <p className="mb-2 text-[15px] font-medium">
                {qi + 1}. {q.question}
              </p>
              <div className="grid gap-2">
                {q.options.map((opt, oi) => {
                  const done = chosen !== undefined
                  const isAnswer = oi === q.answerIndex
                  const isChosen = chosen === oi
                  let cls = 'opt-idle'
                  if (done && isAnswer) cls = 'opt-correct'
                  else if (done && isChosen) cls = 'opt-wrong'
                  else if (done) cls = 'border-slate-200 bg-white opacity-60 dark:border-slate-800 dark:bg-slate-900'
                  return (
                    <button
                      key={oi}
                      disabled={done}
                      onClick={() => setPicked((p) => ({ ...p, [qi]: oi }))}
                      className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-left text-sm transition-colors ${cls}`}
                    >
                      <span className="w-4 shrink-0 text-xs text-slate-400">{'ABCD'[oi]}</span>
                      <span className="flex-1">{opt}</span>
                      {done && isAnswer ? <Check size={15} className="text-emerald-600" /> : null}
                      {done && isChosen && !isAnswer ? <X size={15} className="text-rose-600" /> : null}
                    </button>
                  )
                })}
              </div>
              {chosen !== undefined ? (
                <p className="mt-2 text-sm text-slate-500">
                  <b className={chosen === q.answerIndex ? 'text-emerald-600' : 'text-rose-600'}>
                    {chosen === q.answerIndex ? '答对了' : '答错了'}
                  </b>
                  {q.explanation ? ` · ${q.explanation}` : ''}
                </p>
              ) : null}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function parsePassage(raw: string): PassageShape {
  let obj: unknown
  try {
    const stripped = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '')
    const start = stripped.indexOf('{')
    obj = JSON.parse(start >= 0 ? stripped.slice(start) : stripped)
  } catch {
    // 模型偶尔输出不合法 JSON：退化成"整段当短文"
    return { passage: raw.trim(), translation: '', collocations: [], questions: [] }
  }
  const o = obj as Record<string, unknown>
  return {
    passage: typeof o.passage === 'string' ? o.passage : '',
    translation: typeof o.translation === 'string' ? o.translation : '',
    collocations: Array.isArray(o.collocations) ? (o.collocations as Collocation[]) : [],
    questions: Array.isArray(o.questions) ? (o.questions as PassageQuestion[]) : [],
  }
}
