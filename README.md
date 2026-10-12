# 背单词 Web App

一个纯网页版背单词应用：FSRS-6 间隔重复、多题型训练、学习统计与打卡，
以及特色功能——**把当天学的单词用 AI 串成一篇英文段落，在语境里学固定搭配、练阅读**。

数据全部存在浏览器本地（IndexedDB），不需要注册、不需要服务器数据库。
唯一的后端是一个只监听 `127.0.0.1` 的轻量 AI 中转服务。

## 快速开始

```bash
npm install          # 安装依赖
npm run fetch:dict   # 下载 ECDICT 词典（62.9 MB，只需一次）
npm run fetch:syllabus # 下载考试大纲释义表（约 1 MB，只需一次）
npm run build:books  # 生成内置词书 src/data/books/*.json
npm run fetch:tts    # 下载 Kokoro 语音模型（337 MB，只需一次）
npm run dev:all      # 同时启动发音服务 + AI 中转 + 前端
```

打开 <http://localhost:5173/>

只跑前端（AI 段落不可用，发音回退到浏览器自带语音）：

```bash
npm run dev
```

其他命令：

| 命令 | 说明 |
|---|---|
| `npm run build` | 类型检查 + 生产构建 |
| `npm run lint` | ESLint |
| `npm test` | Vitest 单元测试 |
| `npm run fetch:dict` | 下载 ECDICT 词典到 `dict/` |
| `npm run fetch:syllabus` | 下载考试大纲释义表到 `dict/` |
| `npm run fetch:tts` | 下载 Kokoro 语音模型到 `models/`（337 MB，一次性） |
| `npm run server` | 只启动 AI 中转（默认 `http://127.0.0.1:8787`） |
| `npm run mock:ai` | 本地 OpenAI 兼容 mock 上游（无 key 联调用） |

## 发音

**优先走服务端**：`scripts/tts-server.py` 用 [Kokoro-82M](https://github.com/hexgrad/kokoro)（Apache-2.0）离线合成，结果按「词 + 音色」落盘到 `tts-cache/`，同一个词只合成一次（首次约 0.3s，之后 <5ms）。

```bash
npm run fetch:tts                    # 下载模型，只需一次
python scripts/tts-server.py         # 起在 127.0.0.1:8791
curl http://127.0.0.1:8791/tts/state # 返回 audio/wav
```

- 换音色：环境变量 `KOKORO_VOICE`（默认 `af_heart` 美式女声，`am_*` 男声）
- `npm run dev:all` 会一并拉起这个服务；**它退出不会影响其它进程**
- 拿不到服务端音频（没跑、没装 Python、没拉模型）时，前端自动回退到浏览器自带的
  `speechSynthesis`，不会让发音功能整体失效
- 三端（Web / App / 小程序）都打同一个 `GET /tts/<word>`，发音口径一致

## 使用 AI 段落功能

到「设置」里配好四项，再到「段落」页 —— **打开就自动生成，不用点按钮**：

- **目标词数 = 「学习计划 → 每日新词上限」**（首次启动会弹窗问一次），一个数字同时决定
  今天背几个新词、段落串几个词。目标词优先取今天学的**新词**，不够就补词书里还没学过的
- 目标词**拆成多篇短文**（每篇约 6 词，见 `src/core/passage.ts`），页首可切换篇目；
  切到没生成的那篇会自动补齐，已生成的直接复用。
  硬把 20 个词塞进一篇会让句子为了塞词而变生硬 —— 拆开质量更高
- 「换一段」按钮强制重生成当前篇（改难度或想换个语境时用）

| 字段 | 说明 |
|---|---|
| 服务商预设 | 一键填好协议与地址：DeepSeek / OpenAI / Anthropic Claude / Kimi / 智谱 / 通义 / Ollama |
| 接口协议 | **OpenAI 兼容** 或 **Anthropic Claude**，两种上游格式都支持 |
| 接口地址 | 可带可不带 `/v1`，中转会自动补全 |
| API Key | 只存在你本机浏览器里，不会离开你的电脑 |
| 模型名 | 点「获取列表」自动拉取上游可用模型后下拉选择，也可手填 |

中转服务会把两种协议的响应**统一归一化成 OpenAI 形状**（`choices[0].message.content`），
Anthropic 的 SSE 事件流也会被转成 OpenAI 的 delta，所以前端只写一套解析。
`/models` 同样由中转适配：OpenAI 用 Bearer，Anthropic 用 `x-api-key` + `anthropic-version`。

填完点「测试连接」确认。

设置页还有**「阅读段落 → 段落难度」**：入门（高中/四级）、标准（四/六级）、挑战（考研/雅思）三档，
控制 AI 生成段落的句子长度与词汇范围。难度会进缓存 key，改难度后当天会重新生成一篇，不会复用旧段落；
段落页标题下方会显示当前难度，点击即可跳去调整。

没有 key 想先看效果，可以起一个本地 mock 上游（同时模拟两种协议）：

```bash
npm run mock:ai   # 另开一个终端，监听 127.0.0.1:9999
```

然后在设置页选预设后手动改：
- 协议 `Anthropic Claude`，Base URL `http://127.0.0.1:9999/v1`，Key 随便填，模型点「获取列表」选 `mock-claude`
- 或协议 `OpenAI 兼容`，同样地址，模型选 `mock-openai`

就能跑通"测试连接 → 生成段落 → 缓存"整条链路。

## 目录结构

```
scripts/
  fetch-ecdict.mjs    下载 ECDICT（多镜像回退）
  build-books.mjs     tag 过滤 → 生成词书 JSON（含音标规范化）
  dev-all.mjs         一键启动前后端
server/
  index.ts            Hono AI 中转（含 SSRF / CORS 防护）
src/
  core/               ★ 无 React、无 DOM 依赖，未来移植 RN/小程序直接复用
    srs.ts            ts-fsrs 封装与卡片序列化
    queue.ts          今日队列构造
    exercises.ts      题型生成器（当前只启用英译中，见 KINDS）
    stats.ts          打卡 / 掌握度 / 保持率统计
    importers.ts      词表文件解析
  db/                 Dexie schema 与查询（唯一 IndexedDB 出入口）
  ports/              平台抽象：tts.ts、ai.ts（换平台只换实现）
  state/              Zustand 会话状态
  features/           页面
  data/books/         构建期生成的内置词书
```

## 关键设计

1. **FSRS 状态按单词全局存储，不按词书存储。**
   四级和考研重合度很高，一个词只有一份记忆状态；词书只是"当前学习范围"的筛选器，
   切换词书不丢进度。

2. **算法用 FSRS-6**（`ts-fsrs`，Anki 现行默认），可直接设定"目标记忆保持率"（默认 90%）。
   答错的词 1–10 分钟后就会再出现，当天可以反复练。

3. **题型**按单词哈希轮换，同一个词每次题型稳定。
   目前只启用英译中四选一；听音辨义、听音选词、中译英拼写三种暂时停用
   （在 `src/core/exercises.ts` 的 `KINDS` 里加回来即可恢复）。

4. **AI 段落按「日期 + 难度 + 篇号」缓存**，一条记录覆盖式写入 —— 重复打开、切篇来回
   都不再调模型；结果含逐句中文翻译、固定搭配表（含原句出处）和 2 道阅读理解题。

5. **AI Key 只存在浏览器里**，请求经本机中转发出。中转只监听 `127.0.0.1`，
   拒绝指向私网/云元数据地址（SSRF 防护）、拒绝 CRLF 注入、限制请求体大小、
   只放行本机前端端口的跨域。

## 词书数据

数据源是 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT 协议）。
词书成员由 `tag` 字段判定，一个数据源同时提供中文释义、音标和 BNC/COCA 频率排序：

| 词书 | tag | 词数 | 考纲释义覆盖 |
|---|---|---|---|
| 中考词汇 | `zk` | 1600 | 1492 |
| 高考词汇 | `gk` | 3674 | 3115 |
| 英语四级 CET-4 | `cet4` | 3846 | 3387 |
| 英语六级 CET-6 | `cet6` | 5406 | 4192 |
| 考研词汇 | `ky` | 4801 | 4532 |
| 雅思词汇 IELTS | `ielts` | 5038 | 3588 |
| 托福词汇 TOEFL | `toefl` | 6970 | 3370 |
| GRE 词汇 | `gre` | 7504 | 2091 |

**数据分两层**（这是能加到 8 本的关键）：

- `src/data/words.json` —— 14930 个词条**跨书去重只存一份**（约 4.5 MB），**只在真正灌库时**动态引入
- `src/data/books/<id>.json` —— 每本只存**词列表**（13–78 KB），`import.meta.glob` 收集，**加新书不用改代码**

以前每本书都重复存全量词条：两本就 2.6 MB，铺到 8 本会变成约 10 MB。
现在 8 本总计约 4.8 MB，且 8 个词书文件各自成 chunk、很小。词书展示顺序由
`BOOKS` 数组的 `order` 决定（中考→高考→四六级→考研→雅思→托福→GRE）。

**义项顺序：考纲释义永远排第一，词典义项跟在后面**（详情页会把第一条加粗顶到最前）。
考纲释义来自 [exam-data/CETVocabulary](https://github.com/exam-data/CETVocabulary)
（四六级大纲 2016，5278 词）与 [exam-data/NETEMVocabulary](https://github.com/exam-data/NETEMVocabulary)
（2024 考研大纲，5530 词），由 `npm run fetch:syllabus` 下载。

> ECDICT 自身**判断不了哪个义项是词纲义**（`pos` 列 77 万行全空），只能靠上面这份数据。
> 覆盖率见上表 —— 差额是因为考纲表是**词根导向**的（有 `educate`/`politics`/`nation`，
> 没有 `education`/`political`/`national`），**不做派生词继承**，否则会把 `govern` 的释义
> 错安到 `government` 头上；未匹配的退回词典首义。两份考纲表合并时四六级优先、考研兜底。
>
> ⚠️ 考纲数据许可为 **CC BY-NC-SA 4.0（禁商用）**，个人学习用没问题，商用需换源或授权。
> 拿不到这两份文件时 `build-books` 会自动退回纯 ECDICT 构建。

改了 `build-books.mjs` 后把 `src/db/seed.ts` 里的 `BUILTIN_DATA_VERSION` +1，
客户端下次启动会重新灌内置词书（只覆盖词表，学习进度和自定义词书不受影响）。

已知数据局限：ECDICT 使用旧式注音，构建脚本会规范化成 IPA，但个别词的音标
仍不标准（如 `lead /liːd.led/` 是两个读音拼在一起）。

## 浏览器支持

Chrome / Edge / Firefox / Safari，移动端浏览器可直接使用（底部导航）。
发音优先用服务端 Kokoro 合成，不可用时回退 Web Speech API。
