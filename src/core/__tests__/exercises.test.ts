import { describe, expect, it } from 'vitest'
import {
  buildOptions,
  findSentenceFor,
  isSpellingCorrect,
  makeExercise,
  pickDistractors,
  pickKind,
  primaryMeaning,
  shortGloss,
  shuffle,
  spellingHint,
  splitAroundWord,
  splitSentences,
} from '@/core/exercises'
import type { PassageRecord, WordRecord } from '@/core/types'

function w(word: string, meaning: string, pos = 'n.', frq = 100): WordRecord {
  return {
    word,
    phonetic: '',
    meanings: [meaning],
    definition: '',
    pos,
    bnc: 0,
    frq,
    collins: 0,
    oxford: false,
    exchange: '',
  }
}

const POOL = [
  w('apple', '苹果', 'n.', 10),
  w('apply', '申请', 'v.', 12),
  w('banana', '香蕉', 'n.', 500),
  w('abandon', '放弃', 'v.', 200),
  w('ability', '能力', 'n.', 15),
  w('absorb', '吸收', 'v.', 600),
]

describe('pickKind', () => {
  it('同一单词每次题型一致（便于形成固定记忆路径）', () => {
    for (const word of ['apple', 'banana', 'zebra']) {
      expect(pickKind(word)).toBe(pickKind(word))
    }
  })

  it('只在启用的题型里轮换，停用的题型一次都不出现', () => {
    const allowed: string[] = ['en2zh']
    const disabled = ['zh2en', 'listen2word', 'listen2zh']
    const kinds = Array.from({ length: 200 }, (_, i) => pickKind(`word${i}`))
    for (const k of kinds) expect(allowed).toContain(k)
    for (const k of disabled) expect(kinds).not.toContain(k)
    expect(new Set(kinds).size).toBe(allowed.length)
  })
})

describe('干扰项与选项', () => {
  it('干扰项不包含正确答案，且互不重复', () => {
    const target = POOL[0]
    const d = pickDistractors(target, POOL, 3)
    expect(d).toHaveLength(3)
    expect(d.map((x) => x.word)).not.toContain(target.word)
    expect(new Set(d.map((x) => x.word)).size).toBe(3)
  })

  it('池子不足 3 个时返回能给多少给多少', () => {
    const small = [w('only', '唯一的'), w('target', '目标')]
    expect(pickDistractors(small[0], small, 3)).toHaveLength(1)
  })

  it('四个选项里恰好一个正确且顺序稳定', () => {
    const target = POOL[0]
    const a = buildOptions(target, POOL, primaryMeaning(target), 'seed-1')
    const b = buildOptions(target, POOL, primaryMeaning(target), 'seed-1')
    expect(a).toHaveLength(4)
    expect(a.filter((o) => o.correct)).toHaveLength(1)
    expect(a.map((o) => o.text)).toEqual(b.map((o) => o.text))
  })

  it('shuffle 是确定性的', () => {
    expect(shuffle([1, 2, 3, 4, 5], 'k')).toEqual(shuffle([1, 2, 3, 4, 5], 'k'))
  })
})

describe('makeExercise', () => {
  it('英译中题的正确选项就是该词释义', () => {
    const e = makeExercise({ word: POOL[0], pool: POOL, kind: 'en2zh' })
    expect(e.kind).toBe('en2zh')
    expect(e.options.some((o) => o.correct && o.text === '苹果')).toBe(true)
  })

  it('中译英题不给选项，answer 是英文词', () => {
    const e = makeExercise({ word: POOL[3], pool: POOL, kind: 'zh2en' })
    expect(e.options).toHaveLength(0)
    expect(e.answer).toBe('abandon')
  })
})

describe('isSpellingCorrect', () => {
  // 真实 ECDICT 格式：`码:词` 用 / 串联（早期实现直接切开比对，导致词形判定从不生效）
  const word: WordRecord = { ...w('go', '去'), exchange: '3:goes/i:going/p:went/d:gone' }

  it('完全匹配算对，忽略大小写与首尾空格', () => {
    expect(isSpellingCorrect(' Go ', 'go', word.exchange)).toBe(true)
  })

  it('词形变化也算对', () => {
    expect(isSpellingCorrect('went', 'go', word.exchange)).toBe(true)
    expect(isSpellingCorrect('GOES', 'go', word.exchange)).toBe(true)
    expect(isSpellingCorrect('gone', 'go', word.exchange)).toBe(true)
  })

  it('指针码的值不是单词，不能算对', () => {
    const run: WordRecord = { ...w('run', '跑'), exchange: '0:run/1:d' }
    expect(isSpellingCorrect('d', 'run', run.exchange)).toBe(false)
  })

  it('空输入与错误答案算错', () => {
    expect(isSpellingCorrect('', 'go', word.exchange)).toBe(false)
    expect(isSpellingCorrect('run', 'go', word.exchange)).toBe(false)
  })
})

describe('shortGloss', () => {
  it('只留前两个义项，用分号连接', () => {
    expect(shortGloss('州, 状态, 情形, 国家, 政府, 领土, 国务, 社会地位')).toBe('州；状态')
    expect(shortGloss('vt. 放弃, 抛弃, 遗弃, 使屈从')).toBe('放弃；抛弃')
  })

  it('单词释义原样返回', () => {
    expect(shortGloss('苹果')).toBe('苹果')
  })

  it('考纲释义用顿号分隔也能正确切分', () => {
    // 考纲表的释义格式是「输出、出口」，和词典的「州, 状态」分隔符不同
    expect(shortGloss('输出、出口、物资、贸易')).toBe('输出；出口')
    expect(shortGloss('部分')).toBe('部分')
  })

  it('过长的单一义项截断，不把选项撑成一段阅读理解', () => {
    const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六'
    expect(shortGloss(long)).toHaveLength(19)
    expect(shortGloss(long).endsWith('…')).toBe(true)
  })
})

describe('选项去重', () => {
  it('干扰项与正确项、彼此之间都不重复', () => {
    const pool = [
      w('target', '苹果', 'n.', 10),
      w('x', '苹果', 'n.', 11),
      w('y', '苹果', 'n.', 12),
      w('z', '香蕉', 'n.', 20),
      w('v', '梨', 'n.', 30),
      w('u', '桃', 'n.', 40),
    ]
    const opts = buildOptions(pool[0], pool, primaryMeaning(pool[0]), 'seed')
    expect(opts).toHaveLength(4)
    expect(new Set(opts.map((o) => o.text)).size).toBe(4)
    expect(opts.filter((o) => o.correct)).toHaveLength(1)
  })

  it('释义只有标点不同时也视为同一项', () => {
    const pool = [
      w('target', '州, 状态', 'n.', 10),
      w('x', '州；状态', 'n.', 11),
      w('z', '国家', 'n.', 20),
      w('v', '政府', 'n.', 30),
    ]
    const opts = buildOptions(pool[0], pool, shortGloss(primaryMeaning(pool[0])), 'seed')
    expect(new Set(opts.map((o) => o.text)).size).toBe(opts.length)
  })
})

describe('选项语言一致', () => {
  const cjk = /[一-鿿]/

  it('听音拼写题四个选项全是英文单词，不混中文释义', () => {
    for (const w of POOL) {
      const e = makeExercise({ word: w, pool: POOL, kind: 'listen2word' })
      expect(e.options).toHaveLength(4)
      for (const o of e.options) expect(o.text).toMatch(/^[A-Za-z][A-Za-z'-]*$/)
      expect(e.options.filter((o) => o.correct).map((o) => o.text)).toEqual([w.word])
    }
  })

  it('释义题（英译中 / 听音辨义）四个选项全是中文', () => {
    for (const kind of ['en2zh', 'listen2zh'] as const) {
      for (const w of POOL) {
        const e = makeExercise({ word: w, pool: POOL, kind })
        expect(e.options).toHaveLength(4)
        for (const o of e.options) expect(cjk.test(o.text)).toBe(true)
      }
    }
  })
})

describe('spellingHint', () => {
  it('逐个揭示字母，level 1 只给首字母', () => {
    expect(spellingHint('apple', 1)).toBe('a _ _ _ _')
    expect(spellingHint('apple', 3)).toBe('a p p _ _')
  })

  it('永远留最后一个字母不揭晓', () => {
    expect(spellingHint('apple', 4)).toBe('a p p l _')
    expect(spellingHint('apple', 99)).toBe('a p p l _')
  })

  it('没点提示时不给任何东西，短词也不直接泄露答案', () => {
    expect(spellingHint('apple', 0)).toBe('')
    expect(spellingHint('go', 9)).toBe('g _')
    expect(spellingHint('a', 3)).toBe('')
  })
})

describe('splitAroundWord', () => {
  it('把命中的词切成 hit 段，拼回去仍是原句', () => {
    const segs = splitAroundWord('Might it work?', 'might')
    expect(segs.map((s) => s.text).join('')).toBe('Might it work?')
    expect(segs[0]).toEqual({ text: 'Might', hit: true })
    expect(segs.filter((s) => s.hit)).toHaveLength(1)
  })

  it('大小写不敏感，句中出现几次划几次', () => {
    const segs = splitAroundWord('Run, run before it is too late.', 'run')
    expect(segs.filter((s) => s.hit).map((s) => s.text)).toEqual(['Run', 'run'])
  })

  it('不满足词边界不算命中，避免把 sunrise 切出 sun', () => {
    expect(splitAroundWord('The sunrise was beautiful.', 'sun')).toEqual([
      { text: 'The sunrise was beautiful.', hit: false },
    ])
  })

  it('空句返回空数组，空词返回整句不命中', () => {
    expect(splitAroundWord('', 'might')).toEqual([])
    expect(splitAroundWord('Might it work?', '  ')).toEqual([{ text: 'Might it work?', hit: false }])
  })
})

describe('findSentenceFor', () => {
  const passage: PassageRecord = {
    id: 'p1',
    date: '2026-10-04',
    hash: 'h',
    createdAt: 0,
    targets: ['apple'],
    passage: 'I ate an apple. It was sweet.',
    translation: '',
    collocations: [],
    questions: [],
    model: 'test',
  }

  it('返回含目标词的句子', () => {
    expect(findSentenceFor('apple', [passage])).toBe('I ate an apple.')
  })

  it('没有语料或没有命中时返回 null', () => {
    expect(findSentenceFor('apple', [])).toBeNull()
    expect(findSentenceFor('banana', [passage])).toBeNull()
    expect(findSentenceFor('', [passage])).toBeNull()
  })
})

describe('splitSentences', () => {
  it('按句末标点拆分', () => {
    expect(splitSentences('One. Two! Three? Four')).toEqual(['One.', 'Two!', 'Three?', 'Four'])
  })
})
