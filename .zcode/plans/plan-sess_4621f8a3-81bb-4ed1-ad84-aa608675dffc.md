# 「学习」页改造：Anki 式卡片流

把 `/learn` 从"答题 → 点四档自评"改成 **答题 → 卡片翻面看详解 → 一次性自评**，并解决你指出的三个问题：错词不能马上重来、切页丢进度、题目与内容质量差。

---

## 0. 先修的三个确定 bug

| 问题 | 根因 |
|---|---|
| **词形变化判定形同虚设** | `isSpellingCorrect` 直接把 `exchange` 按 `/` 切开比对，但真实 ECDICT 数据是 `s:states/p:stated/d:stated/3:states/i:stating` 这种「码:词」形式，`"p:stated" !== "stated"` → 拼写题永远判错词形。单测 `exercises.test.ts:123` 用的假格式 `goes/went/going/gone` 所以测不出来 |
| **进度条永远到不了 100%** | `LearnPage.tsx:249` 用 `value={index}`，最后一题时是 `total-1` |
| **翻面后快捷键全被吞** | `LearnPage.tsx:167-170`：`feedback` 存在时 Enter 只 `preventDefault` 不做事，数字键也不响应 → 答完必须用鼠标点评分按钮 |

---

## 1. 数据层：把词条做厚（`npm run build:books`）

`scripts/build-books.mjs`：
- 新增 `df` 字段 = ECDICT 的 `definition`（英文释义），截断到 200 字符
- `extractMeanings` 的 `limit` 2 → 4（现在 `state` 只存了 2 行，后面 4 个义项全丢了）
- `extractPos` 收集前几行出现的多个词性拼成 `n./v.`（现在只取第一个）

`src/core/types.ts`：`BookWordEntry` 加 `df?: string`，`WordRecord` 加 `definition: string`
`src/db/seed.ts`：映射新字段，`BUILTIN_DATA_VERSION` 3 → 4（只覆盖 words/books/bookWords，不动 srs/reviewLog/sessions）
体积 676K → 约 1MB，仍是独立懒加载 chunk（`seed.ts:12-18`）

---

## 2. 会话持久化：切页不再丢进度

**根因**：`queue` / `exercise` / `feedback` / `typed` 全在 `LearnPage` 的 `useState`，组件一卸载就归零；Zustand 里只有 `index/total/results`。点底部导航去「段落」再回来，队列重建并 `start()` 清空，本轮白做——而且 SRS 已落库、配额已被自己消耗，回来后新词还会变少。

改法：
- `src/state/learn.ts` 扩展为完整会话：`{ bookId, dateKey, queue, cursor, feedback, typed, results, finished, startedAt }`，用 `zustand/middleware` 的 `persist` 落到 localStorage（key `vocab.learn.session`），`partialize` 只存可序列化字段
- 加载时校验 `dateKey === 今天` 且 `bookId` 未变，否则丢弃（跨天/换词书开新局）
- `exercise` 不再存 state，由 `queue[cursor]` 经 `useMemo` 派生 —— `pickKind` 本身按词哈希确定，重建即可得同一道题
- 建队列的 effect 只在「无会话或会话过期」时跑；顺带修 `useSrsMap` 每次渲染新建 Map 导致 effect 依赖抖动（`hooks/index.ts:92` → `useMemo`）
- 时长改为组件卸载时也累加 `addDuration`（现在只在 `finished` 时写，中途离开就丢了）

---

## 3. 错词延后重现

`src/core/queue.ts` 新增纯函数 `requeueAfterFailure(queue, cursor, item, { delay = 4, maxAttempts = 2 })`：
- 答错或评「不认识 / 模糊」→ 插到 `cursor + delay` 位（超出队尾则插队尾）
- `QueueItem` 加 `attempts`，同一词最多重试 2 次，仍不过留给明天（有上限，不会卡死）
- `total` 相应 +1，进度条跟着长

`src/db/review.ts` 的 `recordReview` 加 `countInSession: boolean`：重试只写 `srs + reviewLog`，**不**累加 `sessions` 的 newCount/reviewCount/correct/wrong，避免统计翻倍。`countLearnedToday` 按词去重，配额逻辑不受影响。

---

## 4. 卡片翻面（核心）

抽出共用组件 `src/components/WordDetail.tsx`，`WordPage` 和卡片背面共用（`WordPage.tsx:100-143` 那段词头/义项/徽标直接搬过来），背面内容：

1. 单词大字 + 音标 + 发音按钮 + `Oxford 3000` / `Collins N★` / `COCA #` / `BNC #` 徽标
2. 词性 + **全部义项**分条 + 英文释义（新字段 `df`）
3. **词形变化** chips：新模块 `src/core/wordforms.ts` 的 `parseExchange()` 解析 `s/p/d/3/i/r/t` 码 → 复数/过去式/过去分词/第三人称单数/现在分词/比较级/最高级（第 0 节那个 bug 也靠它修）
4. **语境例句**：优先取 `db.passages` 里含该词的句子（把 `findCloze` 里的句子查找抽成 `findSentenceFor` 复用），有 AI 配置时给「AI 生成例句」按钮
5. 正误标记 + 正确答案

AI 例句从 `WordPage.tsx:44-74` 的 `generateExample` 抽到 `src/features/learn/example.ts`，结果缓存进 Dexie 新表 `examples`（`db/index.ts` `version(1)` → `version(2)`，加法迁移），两个页面共用，不重复调模型。**不自动请求**，只在已配置 AI 时显示按钮，与 WordPage 行为一致。

---

## 5. 题目质量

- 新增 `shortGloss(meaning)`：strip 词性前缀 → 按 `[,，;；]` 切 → 取前 2 项用「；」连 → 超 18 字截断。现在 `primaryMeaning` 拿到的是「州, 状态, 情形, 国家, 政府, 领土, 国务, 社会地位」这种长串直接当选项，四选一变成阅读理解
- `buildOptions`：干扰项文本**去重**（含与正确答案归一化后相同者），候选不足 4 个时从更大池子补 —— 现在完全没去重，两个词主释义一样就会出现重复选项
- `pickDistractors` 先只在同词性内找，不足再跨词性
- 卡片背面显示完整 `meanings`，选项/题干用 `shortGloss`

---

## 6. 交互与完成页

- 自评态：`1-4` 直接评分、`Enter` = 评「认识」、`空格` 发音
- 听力题进入即自动 `speak()`（现在要用户自己点喇叭，容易以为没声音）
- 进度条 `value={cursor + 1}`；顶部加「今日 新词 x / y · 复习 a / b」
- `SessionResult` 加 `correct` 字段，完成页真实正确率不再用 `rating >= Good` 反推（现在自评「认识」会被算成答对，与实际作答无关）
- 完成页加**错词清单**（本轮 rating ≤ Hard），点击跳 `/word/:word`，一键「重做错词」
- 配额耗尽时不再显示「共 0 词，答对 0」，改成「今日新词已学完」并说明剩余复习量

---

## 7. 验证

- `exercises.test.ts`：`isSpellingCorrect` 改用真实 exchange 格式；新增选项去重、`shortGloss` 用例
- 新增 `wordforms` 的 `parseExchange` 测试、`queue` 的 `requeueAfterFailure` 测试（延后位置 / 次数上限 / total 增长）
- `npm run lint`、`npm test`、`npm run build` 全绿
- `npm run dev:all` 手动走一遍：答题 → 翻面 → 自评；答错的词 4 题后重现；切到「段落」再回来进度还在；刷新页面进度还在

## 不做的事

不改 FSRS 参数与队列优先级算法、不改路由结构、不引入新依赖。词表重灌只覆盖词表本身，学习进度不受影响。