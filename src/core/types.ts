export interface BookMeta {
  id: string
  name: string
  desc: string
  /** built-in = 构建期内置；custom = 用户导入 */
  source: 'built-in' | 'custom'
  count: number
  /** 展示顺序。内置词书按考试阶段排（中考→高考→四六级→考研→雅思→托福→GRE），导入的书排在后面 */
  order?: number
}

/**
 * 单本词书的构建产物，**只存词列表**。
 * 词条详情在全局 `words.json` 里去重存一份 —— 否则每加一本书就要把全量词条再复制一遍，
 * 8 本书会把启动加载从 2.6 MB 拖到 10 MB。
 */
export interface BookFile extends BookMeta {
  words: string[]
}

/** 词库中的单词（全局去重，跨词书共享） */
export interface WordRecord {
  word: string
  phonetic: string
  meanings: string[]
  /** 英文释义，可能为空（用户导入的词、ECDICT 未收录的条目） */
  definition: string
  pos: string
  bnc: number
  frq: number
  collins: number
  oxford: boolean
  /** 词形变化（复数/过去式/比较级等），用于拼写题判定 */
  exchange: string
}

export interface BookRecord extends BookMeta {
  createdAt: number
}

export interface BookWordRecord {
  /** `${bookId}::${seq}` */
  id: string
  bookId: string
  seq: number
  word: string
}

/** FSRS 卡片状态（Date 一律序列化为 epoch 毫秒，便于 JSON 备份） */
export interface SrsRecord {
  wordId: string
  state: 0 | 1 | 2 | 3
  stability: number
  difficulty: number
  due: number
  lastReview: number | null
  reps: number
  lapses: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
}

export interface ReviewLogRecord {
  id?: number
  wordId: string
  /** 1=Again 2=Hard 3=Good 4=Easy */
  rating: 1 | 2 | 3 | 4
  at: number
  stateBefore: 0 | 1 | 2 | 3
  stabilityBefore: number
  difficultyBefore: number
  /** 这次评分算出的下次间隔天数 */
  interval: number
}

export interface SessionRecord {
  /** YYYY-MM-DD */
  date: string
  newCount: number
  reviewCount: number
  correct: number
  wrong: number
  durationSec: number
}

export interface Collocation {
  phrase: string
  meaning: string
  /** 该搭配在段落中出现的句子 */
  sentence: string
}

/** 用户给单词打的标记。存在独立表里，不塞进 FSRS 卡片 —— 没学过的词也能被收藏 */
export interface WordFlagRecord {
  /** 单词本身即主键 */
  word: string
  /** 收藏 */
  starred: boolean
  /** 熟练：以后的学习不再排这个词 */
  proficient: boolean
  updatedAt: number
}

/** AI 生成的例句与搭配，按单词缓存，学习卡片和单词详情页共用 */
export interface ExampleRecord {
  word: string
  sentence: string
  translation: string
  /** 例句配套的固定搭配，没有原句上下文，所以不复用 Collocation */
  collocations: { phrase: string; meaning: string }[]
  createdAt: number
}

export interface PassageQuestion {
  question: string
  options: string[]
  answerIndex: number
  explanation: string
}

export interface PassageRecord {
  /** `${date}::${hash}` */
  id: string
  date: string
  hash: string
  createdAt: number
  /** 段落所用的目标词 */
  targets: string[]
  passage: string
  translation: string
  collocations: Collocation[]
  questions: PassageQuestion[]
  /** 生成该段落的模型名 */
  model: string
  /** 生成时用的段落难度；用于「同一天同难度只生成一次」的判断 */
  level?: PassageLevel
}

/** 上游接口协议。中转会把它们统一归一化成 OpenAI 形状，前端只认一种格式 */
export type AiProtocol = 'openai' | 'anthropic'

export const AI_PROTOCOLS: { value: AiProtocol; label: string; hint: string }[] = [
  { value: 'openai', label: 'OpenAI 兼容', hint: 'OpenAI / DeepSeek / Kimi / 智谱 / Ollama 等' },
  { value: 'anthropic', label: 'Anthropic Claude', hint: '走 /v1/messages 接口，x-api-key 鉴权' },
]

/** 阅读段落难度。值会进缓存 key，改难度会重新生成而不是复用旧段落 */
export type PassageLevel = 'basic' | 'standard' | 'advanced'

export const PASSAGE_LEVELS: { value: PassageLevel; label: string; prompt: string }[] = [
  {
    value: 'basic',
    label: '入门（高中 / 四级）',
    prompt:
      '文章难度：高中到四级入门。每句 10-16 个词，以简单句和常见从句为主，除目标词外尽量使用高考/四级范围内的词汇，避免生僻表达。',
  },
  {
    value: 'standard',
    label: '标准（四 / 六级）',
    prompt:
      '文章难度：四六级标准。每句 12-20 个词，包含定语从句、状语从句等常见复合句，词汇量适中，表达自然地道。',
  },
  {
    value: 'advanced',
    label: '挑战（考研 / 雅思）',
    prompt:
      '文章难度：考研、雅思阅读水平。每句 15-25 个词，可以出现长难句、插入语、倒装与较正式的书面表达，观点有一定深度。',
  },
]

export type SettingKey =
  | 'aiBaseUrl'
  | 'aiApiKey'
  | 'aiModel'
  | 'aiProtocol'
  | 'aiEnabled'
  | 'voiceName'
  | 'voiceLang'
  | 'requestRetention'
  | 'dailyNew'
  | 'dailyReview'
  | 'passageLevel'
  /** 首次启动是否设置过（不在 DEFAULTS 里，用"是否为假"判断要不要弹窗） */
  | 'setupDone'
  | 'theme'
  /** 开始学习前选的学习方式：cards = 背单词，passage = AI 段落 */
  | 'studyMode'
  /** 内置词书的数据版本；版本号变了就重新灌内置词书（不影响学习进度） */
  | 'vocabDataVersion'

export type Settings = Partial<Record<SettingKey, string | number | boolean>>

/** 当前选中的词书 id */
export const ACTIVE_BOOK_KEY = 'activeBookId'
