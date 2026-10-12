import { describe, expect, it } from 'vitest'
import { acceptedForms, parseExchange } from '@/core/wordforms'

describe('parseExchange', () => {
  it('按 复数→三单→现在分词→过去式→过去分词 顺序解析真实 ECDICT 格式', () => {
    const forms = parseExchange('s:states/p:stated/d:stated/3:states/i:stating')
    expect(forms.map((f) => `${f.label}:${f.form}`)).toEqual([
      '复数:states',
      '第三人称单数:states',
      '现在分词:stating',
      '过去式:stated',
      '过去分词:stated',
    ])
  })

  it('不规则变化与比较级最高级', () => {
    expect(parseExchange('i:going/p:went/d:gone/3:goes').map((f) => f.form)).toEqual([
      'goes',
      'going',
      'went',
      'gone',
    ])
    expect(parseExchange('r:worse/t:worst').map((f) => `${f.label}:${f.form}`)).toEqual([
      '比较级:worse',
      '最高级:worst',
    ])
  })

  it('没有词形数据时返回空数组', () => {
    expect(parseExchange('')).toEqual([])
    expect(parseExchange('0')).toEqual([])
    expect(parseExchange('0:run/1:d')).toEqual([])
  })
})

describe('acceptedForms', () => {
  it('拼写题接受词形变化', () => {
    expect(acceptedForms('p:ran/i:running/d:run/0:run/1:d/3:runs/s:runs')).toEqual(
      expect.arrayContaining(['ran', 'running', 'run', 'runs']),
    )
  })

  it('指针码不是可输入的单词', () => {
    // `1:d` 的 d 是"过去分词"这个类型码，不是 run 的一种写法
    expect(acceptedForms('0:run/1:d')).toEqual([])
    expect(acceptedForms('0:run/1:d')).not.toContain('d')
  })

  it('没有码前缀的裸格式照样接受（导入词表/历史数据）', () => {
    expect(acceptedForms('goes/went/going/gone')).toEqual(['goes', 'went', 'going', 'gone'])
  })

  it('结果统一小写', () => {
    expect(acceptedForms('s:Sundays')).toEqual(['sundays'])
  })
})
