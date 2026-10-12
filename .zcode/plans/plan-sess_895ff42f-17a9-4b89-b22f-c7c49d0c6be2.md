# 背单词 Web App — 实施方案

## 一、目标与范围（第一版）

一个纯网页版背单词应用，**数据全部存在浏览器 IndexedDB**，仅 AI 段落功能走一个只监听本机的 Node 中转。不做账号、不做服务端数据库。

**核心功能**
1. 词书选择：内置「英语四级 CET-4」「考研词汇」两本 + 支持导入自定义词库
2. 间隔重复复习：FSRS-6 算法（Anki 现行默认算法），可设定目标记忆保持率
3. 多种题型训练：英译中选义、中译英拼写、听音辨义/拼写、例句填空
4. 学习统计与打卡：每日任务、连续打卡、掌握进度、遗忘曲线
5. **特色功能**：每日单词由 AI 生成/组织成英文段落，学习固定搭配、练阅读理解
6. 设置页：自定义 AI 接口（Base URL + API Key + 模型名，OpenAI 兼容格式）、发音语音、每日词量、数据备份导入导出

---

## 二、技术栈

| 层 | 选型 | 版本 | 协议 |
|---|---|---|---|
| 运行时 | Node + pnpm | 24.x / 11.x | — |
| 语言 | TypeScript (strict) | 5.x | Apache-2.0 |
| 构建 | Vite + @vitejs/plugin-react | 8.3.x / 6.1.x | MIT |
| 框架 | React | 19.x | MIT |
| 路由 | React Router | 7.x | MIT |
| 状态 | Zustand（仅会话/UI，数据走 Dexie） | 5.x | MIT |
| 本地库 | Dexie + dexie-react-hooks + dexie-export-import | 4.4.x | Apache-2.0 |
| 间隔重复 | **ts-fsrs**（FSRS-6） | 5.4.2 | MIT |
| 样式 | Tailwind CSS + @tailwindcss/vite | 4.3.x | MIT |
| 图表 | Recharts | 3.x | MIT |
| 图标 | lucide-react | — | ISC |
| CSV 导入 | papaparse | 5.7.x | MIT |
| AI 中转 | Hono + @hono/node-server | 4.13.x / 2.1.x | MIT |
| 发音 | Web Speech API（`speechSynthesis`） | 平台内置 | — |
| 测试 | Vitest + Playwright | — | MIT |

**关键选型理由**
- **Vite 而非 Next.js**：数据在客户端、无 SEO 需求，Next 的 SSR/RSC 是纯负担，还会让后续移植变难。
- **React 而非 Vue/Svelte**：你后续要做 App，React Native 能近乎 1:1 复用组件；小程序走 Taro 也支持 React。
- **ts-fsrs 而非 SM-2**：FSRS 提供 `requestRetention` 旋钮（"希望保持 90% 记忆率"），同等记忆率下复习次数更少，是现代 SRS 的标准选择；SM-2 无可调参数，容易出现"间隔暴涨然后集体遗忘"。
- **Dexie 而非原生 idb/RxDB**：自带索引查询与 `useLiveQuery` 响应式渲染，RxDB 过重且核心功能付费。
- **Hono 中转**：因为多数模型服务不允许浏览器跨域直连，必须有中转；Hono 基于 Web 标准、零依赖，50 行内搞定流式转发。

---

## 三、目录结构

```
英语软件/
├─ package.json              # 单包（v1 不做 monorepo，保持简单）
├─ scripts/
│  ├─ fetch-ecdict.mjs       # 下载 ECDICT（多镜像回退）
│  └─ build-books.mjs        # tag 过滤 → 生成词书 JSON
├─ server/
│  └─ index.ts               # Hono AI 中转（localhost）
├─ src/
│  ├─ core/                  # ★ 无 React / 无 DOM 依赖，未来移植 RN/小程序的复用层
│  │  ├─ srs.ts              # ts-fsrs 封装 + Date 序列化
│  │  ├─ queue.ts            # 今日学习队列构造
│  │  ├─ exercises.ts        # 4 种题型生成器
│  │  ├─ stats.ts            # 打卡 / streak / 掌握度统计
│  │  └─ types.ts
│  ├─ db/                    # Dexie schema + 查询封装（唯一 IDB 出入口）
│  ├─ state/                 # Zustand 会话 store
│  ├─ ports/                 # 抽象接口：tts.ts、ai.ts（换平台只换实现）
│  ├─ features/
│  │  ├─ home/  learn/  books/  word/  passage/  stats/  settings/
│  │  └─ import/
│  ├─ data/books/            # 构建期生成的 cet4.json / ky.json
│  └─ routes.tsx
```

---

## 四、数据模型（Dexie v1）

| 表 | 主键 | 关键字段 | 说明 |
|---|---|---|---|
| `words` | `word` | phonetic, meanings[], pos, bnc, frq, collins, oxford, exchange | 全局词表（两本书合并去重） |
| `bookWords` | `[bookId+seq]` → word | bookId, seq | 词书 = 学习范围，按 `frq` 排序 |
| `customBooks` / `customBookWords` | id / `[bookId+seq]` | name, source | 用户导入的自定义词库 |
| `srs` | `wordId` | state, stability, difficulty, due, lastReview, reps, lapses | **FSRS 状态** |
| `reviewLog` | auto | wordId, rating, at, stateBefore, stabilityBefore, interval | 复习流水，供统计与未来调参 |
| `sessions` | `date` | newCount, reviewCount, correct, wrong, durationSec | 每日学习汇总，打卡与统计的数据源 |
| `passages` | `date+hash` | passage, translation, collocations[], targets[], questions[] | AI 段落缓存 |
| `settings` | key | aiBaseUrl, aiApiKey, aiModel, voice, requestRetention, dailyNew, dailyReview, theme | |

**核心设计决策**

1. **FSRS 状态按单词全局存储，不按词书存储**。四级和考研重合度高，一个词只应有一份记忆状态；词书只是"当前学习范围"的筛选器。切换词书不丢进度，同一个词在两本书里共享复习计划。

2. **AI Key 存本地 IndexedDB，中转只监听 `127.0.0.1`**。中转服务校验 `baseUrl` 必须是 https 且不得指向私网/回环地址（防 SSRF），带超时与 body 大小限制，CORS 仅放行本机。Key 不会离开你的电脑。

3. **段落缓存 + 免 AI 兜底**：生成结果按「日期 + 词集哈希」写入 `passages`，重复打开不重复调用；断网或 AI 不可用时读取历史缓存。第一版**不引入第三方例句库**（有道来源的词库无再分发许可，不能打包），例句来自 AI 生成并缓存。

4. **`src/core/` 零框架依赖**，TTS 抽象成 `ports/tts.ts`——以后 App 用 `react-native-tts`、小程序用 `wx.createInnerAudioContext`，只替换实现。

---

## 五、词书数据管线

**数据源：ECDICT**（`skywind3000/ECDICT`，MIT 协议，`ecdict.csv` 62.9MB）

实测其 `tag` 字段值为 `zk / gk / cet4 / cet6 / ky / ielts / toefl / gre`（空格分隔、可叠加），带标签词条的中文释义覆盖率 99.4%、音标覆盖约 96%。`gk` 标签实测正好约 3500 词。无需第二个数据源。

**流程**：`fetch-ecdict.mjs` → `build-books.mjs`
1. 下载并固定 commit hash（本机 `raw.githubusercontent` 不可达，脚本内置多镜像回退：`ghproxy.net` 镜像 → GitHub Release 资产）
2. 用 papaparse 解析（真 CSV，含引号内换行，不能按行切）
3. `tag` 含 `cet4` → 四级书；含 `ky` → 考研书（互不排斥，允许重叠）
4. 字段抽取：`translation` 按 `\n` 拆、取前 2 条释义；词性从释义前缀 `vt./n./adj.` 解析（`pos` 字段是词频分布，不能用）
5. **音标规范化**：ECDICT 是 legacy 音标（`i'rʌpt`、`'erә`、缺重音符），用映射表转成标准 IPA，无法规范化的则不显示
6. 按 `frq`（COCA 频率）升序排列，作为书内学习顺序
7. 输出 `src/data/books/cet4.json`、`ky.json`（预计各 300–500KB，gzip 后更小；62.9MB 原始数据永不进客户端）

**验收**：两本书词数分别在 3400±10%、4500±10%；抽查 20 个词的释义、音标正确。

---

## 六、分阶段实施

### Phase 0 — 脚手架 + 词书数据管线
- Vite 8 + React 19 + TS strict + Tailwind 4 + ESLint 9 + Prettier，建立上述目录骨架
- 写 `fetch-ecdict.mjs`、`build-books.mjs`，产出两本词书 JSON
- **验收**：`pnpm build` 通过，`src/data/books/` 下两本词书生成且数据正确

### Phase 1 — 数据层 + 词书选择
- Dexie schema v1 与 `db/` 查询模块
- 首次启动分块 `bulkPut` 导入词书到 IndexedDB
- 词书列表页、选择当前词书、新建自定义词库
- **验收**：能看到两本书及词数，选择后刷新仍保持

### Phase 2 — 学习核心（最重要）
- `core/srs.ts`：ts-fsrs 封装，`Date` ↔ epoch 序列化（JSON 备份需要）
- `core/queue.ts`：今日队列 = 到期复习词（`Learning` 到期 > `Review` 到期）+ `min(dailyNew, New 词)`
- `core/exercises.ts`：四选一英译中（干扰项取同词书、同词性、频率相近词）；中译英拼写（容忍大小写，用 `exchange` 字段判定词形变化）；听音辨义/听音拼写
- `ports/tts.ts`：`speak(word)`，处理 `getVoices()` 首次返回空（`onvoiceschanged`）、连续播放前 `cancel()`
- `/learn` 页面：卡片 → 作答 → 评分（不认识/模糊/认识/秒懂）→ `fsrs.next` → 下一张 → 结束汇总
- **验收**：连续学 20 词，`due` 正确推进；重开应用后到期词正确出现

### Phase 3 — 词书浏览 / 单词详情 / 导入
- `/books/:id`：三态筛选（全部/未学/已掌握）、搜索、按频率每 200 词分章、进度条
- `/word/:word`：音标、发音、释义、词性、Collins/Oxford 徽标、BNC 频率、该词 FSRS 状态与下次复习时间、所属词书、AI 生成例句
- `/import`：papaparse 解析 CSV，TXT 支持 `word\t释义` 与每行一词；预览 → 确认 → 建自定义词书；重复词检测
- **验收**：导入一份 txt 能变成可学习的自定义词书

### Phase 4 — 统计与打卡
- `sessions` 按日聚合：新学数、复习数、正确率、学习时长
- `/stats`（Recharts）：近 30 天复习量柱状图、掌握状态堆叠图、实际记忆保持率、近 182 天打卡热力图
- `/` 首页：今日任务卡（新词 x / 复习 y）、连续打卡天数、总进度环、继续按钮
- **验收**：学习后数字变化，跨天后 streak 计算正确

### Phase 5 — AI 段落（特色功能）
- `server/index.ts`（Hono）：`POST /api/ai` 转发 OpenAI 兼容 `/chat/completions`，支持 SSE 流式；只绑 `127.0.0.1`；校验 baseUrl 为 https 且非私网 IP；超时 + body 上限 + 仅放行本机 CORS
- `/settings`：Base URL / API Key（密码框）/ 模型名 / 连通性测试 / 每日新词量 / `requestRetention` / 语音选择 / 数据导出导入
- `/passage` 今日段落：取当日 8–15 个目标词 → 结构化 JSON 提示词 → 流式渲染：
  - 英文段落（**目标词高亮**，自然嵌入并体现固定搭配）
  - 逐句中文翻译
  - **固定搭配表**：短语 / 出自段落哪句 / 中文释义
  - 2 道阅读理解选择题
- 结果写入 `passages` 缓存；同时作为"例句填空"题型的语料来源
- **验收**：配好 key 能生成段落且目标词全部出现；断网可读历史段落

### Phase 6 — 打磨
暗色模式、移动端响应式、键盘快捷键（`←/→` 翻卡）、PWA 可安装、导出导入备份、Playwright 冒烟测试、构建体积检查。

---

## 七、风险与备注

- **数据下载**：本机 `raw.githubusercontent.com` 不可达，脚本必须内置镜像回退（`ghproxy.net` → GitHub Release），并固定 commit hash 保证可复现。
- **语音质量**：Windows 上 Edge 的 neural 语音远优于 Chrome，设置页提供语音选择并给出提示；所有 TTS 必须由用户手势触发（iOS Safari 会拒绝）。
- **许可合规**：ECDICT 为 MIT，项目内保留 LICENSE 与归属声明。已排除所有 CC BY-NC-SA 仓库（考试词表）与有道来源词库（无再分发许可），不可打包分发。
- **跨域**：模型服务普遍不允许浏览器直连，这正是中转服务存在的必要性。
- **后续多端**：`src/core/` 无框架依赖 + TTS/网络抽象成 port，App 端用 React Native 直接复用，小程序端用 Taro 转译。