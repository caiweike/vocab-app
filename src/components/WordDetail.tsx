import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Award, Loader2, Sparkles, Star, Volume2 } from 'lucide-react'
import { Badge, Button } from '@/components/ui'
import { useRecentPassages, useWordFlag } from '@/hooks'
import { findSentenceFor, splitAroundWord } from '@/core/exercises'
import { parseExchange } from '@/core/wordforms'
import { autoExample, generateExample, loadExample, type WordExample } from '@/lib/example'
import { speak } from '@/ports/tts'
import { useUiStore } from '@/state/ui'
import { AiError } from '@/ports/ai'
import type { BookRecord, PassageRecord, WordRecord } from '@/core/types'

interface WordDetailProps {
  word: WordRecord
  /** 右上角状态徽标（掌握程度等），由调用方决定 */
  badge?: ReactNode
  /** 这个词属于哪些词书，单词详情页展示 */
  books?: BookRecord[] | null
  /** 详情页用大标题，学习卡片背面用小一号 */
  size?: 'lg' | 'sm'
  /** 标为熟练后自动进入下一题；只有学习卡片传，单词详情页不需要 */
  onProficient?: () => void
}

/**
 * 词条展示：音标、词性、全部义项、英文释义、词形变化、考频徽标，以及「收藏 / 熟练」开关。
 * 单词详情页和「学习」卡片翻面共用，避免两处的释义排版各写一遍。
 */
export function WordDetail({ word, badge, books, size = 'lg', onProficient }: WordDetailProps) {
  const forms = parseExchange(word.exchange)
  const titleSize = size === 'lg' ? 'text-3xl' : 'text-2xl'
  const { starred, proficient, toggle } = useWordFlag(word.word)

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-1">
            <span className={`${titleSize} font-semibold`}>{word.word}</span>
            <button
              onClick={() => speak(word.word)}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"
              title="发音"
            >
              <Volume2 size={size === 'lg' ? 20 : 18} />
            </button>
          </div>
          {word.phonetic ? <div className="mt-1 text-sm text-slate-400">/{word.phonetic}/</div> : null}
        </div>
        {badge}
      </div>

      {word.pos ? <div className="mt-3 text-sm italic text-slate-400">{word.pos}</div> : null}

      {word.meanings.length === 0 ? (
        <div className="mt-1.5 text-sm text-slate-400">词典里没有这个词条的释义</div>
      ) : (
        <>
          {/* 词书给出的主释义：加粗、单独放最前，别和其余义项挤成一串 */}
          <p className="mt-1.5 text-[15px] font-semibold leading-relaxed text-slate-800 dark:text-slate-100">
            {word.meanings[0]}
          </p>
          {word.meanings.length > 1 ? (
            <div className="mt-2 space-y-1 border-t border-slate-100 pt-2 dark:border-slate-800">
              {word.meanings.slice(1).map((m, i) => (
                <div key={i} className="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                  <span className="mr-1.5 text-slate-300 dark:text-slate-600">{i + 2}.</span>
                  {m}
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}

      {word.definition ? (
        <p className="mt-3 text-[13px] leading-relaxed text-slate-500 dark:text-slate-400">
          {word.definition}
        </p>
      ) : null}

      {forms.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {forms.map((f) => (
            <span
              key={f.code}
              className="rounded-md border border-slate-200 px-2 py-0.5 text-xs dark:border-slate-700"
            >
              <span className="text-slate-400">{f.label}</span>{' '}
              <b className="font-medium text-slate-700 dark:text-slate-200">{f.form}</b>
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
        {word.oxford ? <Badge tone="brand">Oxford 3000</Badge> : null}
        {word.collins > 0 ? <Badge tone="amber">Collins {word.collins}★</Badge> : null}
        {word.frq > 0 ? <Badge>COCA #{word.frq}</Badge> : null}
        {word.bnc > 0 ? <Badge>BNC #{word.bnc}</Badge> : null}
        {books && books.length > 0
          ? books.map((b) => (
              <Link key={b.id} to={`/books/${b.id}`}>
                <Badge tone="green">{b.name}</Badge>
              </Link>
            ))
          : null}
        <div className="ml-auto flex gap-1.5">
          <FlagButton
            active={starred}
            activeCls="border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
            onClick={() => void toggle('starred')}
            icon={<Star size={13} fill={starred ? 'currentColor' : 'none'} />}
            label="收藏"
            title={starred ? '取消收藏' : '收藏这个词'}
          />
          <FlagButton
            active={proficient}
            activeCls="border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
            onClick={() => {
              // 标上了才往下走；取消熟练要停在原地让人看清，写失败也不能变成未处理的 promise 拒绝
              void toggle('proficient').then(
                () => {
                  if (!proficient) onProficient?.()
                },
                () => undefined,
              )
            }}
            icon={<Award size={13} />}
            label="熟练"
            title={
              proficient
                ? '取消熟练，重新排进学习'
                : onProficient
                  ? '标为熟练：以后不再学习，并直接进入下一题'
                  : '标为熟练，以后的学习不再出现'
            }
          />
        </div>
      </div>
    </div>
  )
}

function FlagButton({
  active,
  activeCls,
  onClick,
  icon,
  label,
  title,
}: {
  active: boolean
  activeCls: string
  onClick: () => void
  icon: ReactNode
  label: string
  title: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={title}
      className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium transition-colors ${
        active
          ? activeCls
          : 'border-slate-200 text-slate-500 hover:border-slate-300 hover:text-slate-700 dark:border-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  )
}

interface ExampleBlockProps {
  word: WordRecord
  passages?: PassageRecord[] | null
  /** 学习卡片背面空间紧，去掉标题 */
  showTitle?: boolean
  /** 学习卡片背面：只给一句例句，避免段落语境句和 AI 例句堆在一起重复 */
  single?: boolean
}

/**
 * 例句与固定搭配，两个来源：当天 AI 段落里含该词的句子，以及 AI 生成的例句。
 *
 * `single`（学习卡片背面）只展示一句——优先带翻译和固定搭配的 AI 例句，
 * 没有才退回段落里的语境句；单词详情页两个都给，那里是查词、信息全一点没关系。
 * AI 例句按单词缓存进 examples 表，两个页面共用，不重复调模型。
 */
export function ExampleBlock({ word, passages, showTitle = true, single = false }: ExampleBlockProps) {
  const fallback = useRecentPassages(20)
  const list = passages ?? fallback
  const toast = useUiStore((s) => s.showToast)

  // 带上 word 一起存：换词时能立刻判定缓存不属于当前词，不用在 effect 里同步 setState
  const [cached, setCached] = useState<{ word: string; example: WordExample | null }>({
    word: '',
    example: null,
  })
  const [loading, setLoading] = useState(false)
  /** 这个词的例句查完了没有（查缓存本身也要时间，期间不能显示成"还没有例句"） */
  const resolved = cached.word === word.word
  const example = resolved ? cached.example : null

  useEffect(() => {
    let alive = true
    const load = async () => {
      const hit = await loadExample(word.word)
      if (!alive) return hit
      // 学习里不让人手点：没缓存就自己生成；查词页保留按钮，浏览单词时别乱调模型
      if (!hit && single) return await autoExample(word)
      return hit
    }
    void load().then((e) => {
      if (alive) setCached({ word: word.word, example: e })
    })
    return () => {
      alive = false
    }
    // 只按词字符串重跑：`word` 对象在一次作答内不该变，挂上它反而可能触发重复请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word.word, single])

  async function onGenerate() {
    setLoading(true)
    try {
      setCached({ word: word.word, example: await generateExample(word) })
    } catch (e) {
      toast(e instanceof AiError ? e.message : (e as Error).message, 5000)
    } finally {
      setLoading(false)
    }
  }

  const sentence = list ? findSentenceFor(word.word, list) : null
  // 单句模式：生成中先不摆段落句，免得 AI 例句来了又得撤掉；两源都有时也只留一句
  const showPassage = sentence !== null && (!single || (resolved && example === null))
  const showLoading = single && !resolved
  const showEmpty = resolved && !example && !showPassage
  // 详情页一直留着按钮（可以重新生成）；卡片背面空间紧，已有 AI 例句就收起来
  const showButton = resolved && (showTitle || !example)

  const button = showButton ? (
    <Button size="sm" variant="outline" onClick={() => void onGenerate()} disabled={loading}>
      {loading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
      {showTitle ? 'AI 生成' : 'AI 例句'}
    </Button>
  ) : null

  return (
    <div>
      {showTitle ? (
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-500">例句与固定搭配</h2>
          {button}
        </div>
      ) : button ? (
        <div className="mb-3 flex justify-end">{button}</div>
      ) : null}

      {showLoading ? (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 size={14} className="animate-spin" />
          例句生成中…
        </p>
      ) : null}

      {showPassage && sentence ? (
        <div className="mb-3">
          <p className="text-[15px] leading-relaxed">
            <MarkedSentence sentence={sentence} word={word.word} />
          </p>
          <p className="mt-1 text-xs text-slate-400">来自你的 AI 段落</p>
        </div>
      ) : null}

      {example ? (
        <div className="space-y-3">
          <div>
            <p className="text-[15px] leading-relaxed">
              <MarkedSentence sentence={example.sentence} word={word.word} />
            </p>
            {example.translation ? (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{example.translation}</p>
            ) : null}
          </div>
          {example.collocations.length > 0 ? (
            <div className="space-y-1.5 border-t border-slate-100 pt-3 dark:border-slate-800">
              {example.collocations.map((c) => (
                <div key={c.phrase} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <b className="text-brand-700 dark:text-brand-300">{c.phrase}</b>
                  <span className="text-slate-500">{c.meaning}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {showEmpty ? (
        <p className="text-sm text-slate-400">
          {showTitle ? '还没有例句。点击「AI 生成」，用你配置的模型造句并列出常见搭配。' : '还没有例句'}
        </p>
      ) : null}
    </div>
  )
}

/** 例句渲染：把目标词用与段落页一致的 `.target-word` 样式划出来 */
function MarkedSentence({ sentence, word }: { sentence: string; word: string }) {
  return (
    <>
      {splitAroundWord(sentence, word).map((seg, i) =>
        seg.hit ? (
          <mark key={i} className="target-word">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  )
}
