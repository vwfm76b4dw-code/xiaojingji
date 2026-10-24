# curriculum 词库说明（版本权威等级）

## app 实际引用了哪些文件

**20 册全部随包发布**（2026-09-25 起：北京版 4 册 + 北京课改版 8 册下架，换入
外研社版小学 8 册），但**按需加载**：册次注册表在
`pack-curriculum/utils/curriculum-books.js`（id → 加载函数，每个函数体一个静态 `require`），
教材导入页（`pack-curriculum/pages/curriculum/curriculum`）只列出书名和词数，
学生点开哪一册才 `require` 哪一册 —— 打包时 20 册都进包（点开即有，不用等网络），
但内存里只留点开过的那册，不会一进页面就把 6000+ 个词全读进来。

同目录的 `missing.json` 与本 README、**以及全部词书 json** 都在 `project.config.json`
的 `packOptions.ignore` 里排除（进包的是 `pack-curriculum/data/curriculum/` 下的 .js 包装，
见 `tools/build-curriculum-modules.py` 的说明）。

> ⚠️ 改动注意：往本目录**新增/移除**词书文件后，必须同步做三件事，漏一件都有后果：
> ① `pack-curriculum/utils/curriculum-books.js` 登记/注销（否则学生在册次列表里看不到它）；
> ② **`project.config.json` 的 `packOptions.ignore` 增删对应条目** ——
>    2026-09-25 实测推翻了本文早先"ignore 已废弃"的说法：没登记的 json 会原样打进
>    **主包**（8 册 json ≈ 190 KB，主包直接逼近 2048 KB 硬限）。它是按文件逐条枚举的，新增册必须登记；
> ③ 跑 `python tools/build-curriculum-modules.py --apply` 生成分包 .js。
> 门禁 `node tools/verify-textbooks.js` 会把这三件事一起盯住。

## 2026-09-25 教材替换（外研社版小学 8 册，Agent B）

| 文件 | 内容 | 词数 | 置信度 |
|---|---|---|---|
| `wy3s.json` / `wy3x.json` | **外研版 2024 新版小学**三年级上/下册（三起点，Unit 结构，每词带 mnemonic 钩子） | 206 / 197 | medium（2024 新版暂无第二来源交叉核对） |
| `wy4s.json`…`wy6x.json` | 外研版小学（2012 课标版）四上~六下（三起点，Module 结构） | 130~150 | high（与 koolearn 词书逐册交叉核对重合 90%+） |
| `wy6s.json` | 六上另收 koolearn 独有 25 词（`6A 补充词汇` 档） | 106 | medium |

- 生产脚本 `tools/build-wy-primary.py`（规范化 + 钩子挂载），钩子表 `data/curriculum/wy-hooks.json`
  （944 词每词一条，跨册共用）。
- 为什么选三起点：与保留的外研版初中 7 册同一条教材轨道（3上→9下顺次衔接）。
  g1/g2 无册次是三起点体系的天然边界，不是缺数据。
- 被替换的 12 册原文件归档在 `out/curriculum_retired_bj_kj/`；已导入它们的学生的
  旧数据仍可在教材管理页删除（注册表 `RETIRED_BOOK_NAMES` 承接）。

## ⭐ 现行教材版（对齐现行课本，演示用这套）

| 文件 | 内容 | 验证方式 |
|---|---|---|
| `wy7s_2024.json` | **外研版 2024 新版七年级上册**（7A Starter + Unit 1-6，295 条，含单元/词性/释义） | 作者本人口述首尾词验证：开头 ready/textbook/eraser/junior/geography ✓ 结尾 as happy as a clam ✓（该词为 Unit 5 末条） |
| `wy7a2024_raw.txt`（data/curriculum/ 下） | 上表原始文本（知乎《2024外研版英语七年级上册完整单词表》存档） | — |

这也是首次启动预置的那一册（`data/textbook-7a.js`，295 词）。
所以学生进教材页选中它时，导入页会直接说「这一册的词已经在你的词库里了」，
不再报「跳过 294 个」—— 判定逻辑见 `pages/curriculum/curriculum.js` 的重合率检查。

### 接入时的两条硬约束（改导入页前必读）

1. **导入路径必须绕开 `normalizeItems()`**（`utils/ai-core.js` 与
   `cloudfunctions/aiProxy/index.js` 各有一份）。它的 `WORD_RE` 有「最多 3 个词」
   的上限 —— 那是为挡住模型把整句英文当单词返回而设的，套在教材数据上属于用错场景：
   本册有 18 条合法多词短语（`as dead as a dodo`、`stop someone from doing something`、
   `all over the world`…），套上会被**静默丢弃**，不报错、不进 `skipped`、界面上无感。
   正确路径：读 JSON → 直接构造 `[{word, meaning}]` → `store.addItems()`
   （`addItems` 只校验 word/meaning 非空 + 按 word 查重，不做 `WORD_RE` 校验）。
2. **不得为过校验把短语改成 3 个词** —— 它们是教材合法内容，对短语题的价值不低于单词。

### 已知数据瑕疵（接入时接受，未改数据文件）

- `race` 在本册出现两次（`7A Unit 3`：`v. 比赛` 与 `n. 赛车`）。
  词库按 word 查重，导入时会**合并成一条**（保留先出现的 `v. 比赛`），
  所以选 Unit 3（42 词）实际入库 41 条、跳过 1 条 —— 这是预期行为，不是缺陷。
- 19 条无 `pos`（多为短语与复合词，如 `junior high`、`die out`），
  释义因此不带词性前缀，属正常。

## 旧版 19 册（2026-09-17 起放行，清洗后接入）

`tools/clean-curriculum.js` 修掉了 8 条 koolearn 错义（PE / UK / Ms 三类，
涉及 `bsd7s`、`bsd7x`、`kj4s`、`kj6s`、`wy7s`、`wy9s` 六个文件，
改过的文件带 `cleaned_at` / `cleaned_note` 字段，条目带 `_cleaned` 标记）。

| 情况 | 说明 |
|---|---|
| 无 `unit` | 进不了单元筛选，导入页把整册收进「全部单词」一格 |
| 无 `pos` | 释义无词性前缀，与现行版口径不一致 |
| 无 `source` | 来源不可追溯 |

- `wy7s~wy9x.json`：外研旧版（2012-2014 教材）词书
- `bsd7s~bsd9.json`：北师大 2013 版词书
- ~~`bj1s.json` + `kj3x~kj6x.json`：北京版一上 + 北京课改版老教材词书~~
  （**2026-09-25 下架**，换成外研社版小学 8 册；归档在 `out/curriculum_retired_bj_kj/`）

### 2026-09-19 新增 4 册（词表来源为 51jiaoxi 英语朗读宝，正版授权数据）

| 文件 | 内容 | 置信度 |
|---|---|---|
| `bj1x.json` | 北京版小学英语一年级下册，48 词（6 单元，目录经 dzkbw 电子课本网核对一致） | high |
| `bj2s.json` | 北京版小学英语二年级上册，76 词（目录经 Scribd 二上教材概述核对一致） | high |
| `bj2x.json` | 北京版小学英语二年级下册，78 词（目录经 dzkbw 核对、Unit 1 词经步步高词典核对） | high |
| `kj3s.json` | 北京课改版英语三年级上册，160 词（**2024 新版**教材词表，单一来源） | medium |

每册 JSON 带 `_source` / `_confidence` 字段记录出处。**课改版 1-2 年级册次
（kj1s/kj1x/kj2s/kj2x）未收录**：「北京课改版」即北京出版社一起点教材的别称
（百度百科、亚马逊书目均如此标注），与 bj 系列同书 —— 重复收录只会让同一批词
以两个"册次"出现两次。koolearn 的「北京课改版」3-6 下词量特征（60-70 词/册）
与一起点教材不符，其对应教材版本存疑，故 kj3s 采用现行 2024 新版词表并降级为 medium。
- `missing.json`：占位/缺口记录，非词书

### ✅ 错义已全部修完（2026-09-30）

原先此节列的 10 条**早已由 `tools/clean-curriculum.js --apply` 修完**
（现在 `node tools/clean-curriculum.js` 输出「修正条目: 0 条」即为已修净的证据）。
2026-09-30 又做了一次**全量排查**（32 册 / 7148 条），新查出 6 条
「释义整个属于另一个词」的错误，也已修掉：

| 册 | 词 | 修前释义 | 实际是 | 已修为 |
|---|---|---|---|---|
| `bsd7s`、`wy9s` | `beside` | 不中（目标）；不对（题）；与…无关 | besides（除…之外） | 在……旁边；在……附近 |
| `bsd7s`、`wy7s` | `next to` | 几乎 | almost | 在……近旁；紧邻；靠近 |
| `bsd7s`、`wy7x` | `plane` | 水平 | level | 飞机；平面 |
| `bsd8s`、`wy9s` | `wonder` | 奇妙的 | wonderful | 想知道；奇迹 |
| `bsd8s` | `monster` | 巨大的；庞大的 | huge | 怪物；怪兽 |
| `wy7x_2024` | `ride` | v.漂浮 | float | 骑；乘；驾驭 |

这一批比前三批更隐蔽 —— **释义属于另一个词，通顺但错**，
学生背下来的是另一个词的意思，怎么背都对不上。判别依据不是语感，是四条可复核的证据：

1. **同项目另一册教材给出矛盾释义**：`beside` 在 `wy4s` 是「在旁边（附近）」；
2. **与词条自带mnemonic 自相矛盾**：`wy7x_2024` 的 `ride` 钩子是
   「骑：跨上自行车蹬起来」，释义却写「v.漂浮」；
3. **音标与释义不匹配**：51jiaoxi 原始数据（`out/curriculum_raw_wy/jjx2026_raw.json`）
   里 `ride` 的音标是 `raɪd`（完全正确），释义却是 float 的意思
   → 证明是**词条串行**，不是「义项选得偏」；
4. **抓取缓存里有同样的错误串**：`out/curriculum_cache/wd_*.json` 里
   `beside`/`plane`/`next to`/`wonder`/`monster` 的缓存释义就是错的
   → 错在**抓取侧**，不在组装侧。

### ⚠️ 修错义必须修在 tools/clean-curriculum.js，不能改 .json、也不能改 fill.json

这是本目录最容易踩空的一点，三条路只有一条是通的：

| 做法 | 能不能修错义 | 为什么 |
|---|---|---|
| 直接改 `miniprogram/data/curriculum/*.json` | ❌ 下次构建就没了 | 这些 json 是**生成产物** |
| 改 `data/curriculum/fill.json` | ❌ 根本不生效 | `build-curriculum.py:154` 是 `meanings.get(wd,'') or fills.get(...)`：**抓取释义非空时 fill.json 永远不生效**，而错义恰恰是「非空的错」 |
| **改 `tools/clean-curriculum.js` 的 `FIXES`** | ✅ | 它是 assemble 之后的**幂等清洗层**，对全部 32 册生效，与哪个管线产出的无关 |

改法：`FIXES` 加一条 `{correct, why}`，同时在 `WRONG_MARKS` 加一条**只匹配该错误值**
的正则，然后 `node tools/clean-curriculum.js --apply`。
`WRONG_MARKS` 的存在意义就是「只改确实串味的那一册」——
例如 `ride` 在 koolearn 系 4 册里的「乘；骑；驾」是**对的**，
正则只匹配「漂浮」，所以只有 `wy7x_2024` 被改，其余 4 册一个字都不动。

**注意 assemble 会抹掉字段**：`build-curriculum.py:159` 只写 `{word, meaning}`，
所以对 20 册 koolearn 册次重跑 assemble 会**丢掉 `unit`/`pos`/`mnemonic`**。
现行 `wy*_qy` / `wy7x_2024` / `wy7s_2024` 由 `tools/build-expand2026.py` /
`tools/parse-wy2024.py` 产出，重跑 `assemble` 不影响它们；
但**无论走哪条管线，最后都必须再跑一次 `clean-curriculum.js`** ——
它是唯一的清洗收口。

### 关于「该册词表有修订」的学生提示（建议，未实施）

现状：清洗是**静默**的。学生选了 `wy7x_2024`，`ride` 的错义被修好了，
但他不会知道自己曾经（假如早几天导入）背错过。
判断是**收益有限**：`clean-curriculum.js` 从 2026-09-17 起就在修，
而这批册次的导入量与留存都很小；而为了说一句话而给所有册次加
「版本 + 修订记录」元数据 + 导入页比对逻辑，成本与复杂度都不小。

若将来要做，建议的最小方案是：给词书加 `_revision` 字段，
导入页在**该册已导入过**且 `_revision` 变大时，弹一次
「这一册的词表有更新（N 处释义已修正），要重新导入吗」。
**关键前提**：只有当错义能可靠地被发现与清零时才值得做 ——
一个「修订了 3 处」的提示会让人以为剩下 3000 多条也都核对过，
那比不提示更糟。所以现在**不建议做**，先继续靠清洗层兜住。

## 待补（现行版缺口）
1. 外研 2024 新版：七下（2025 版）、八上（2025 版）、八下、九上（2026 版）、九下 —— 找同系列文本源
2. 外研社小学 2024 新版：四上（2025 秋起滚动出版）出版后逐册替换对应的 2012 版词表
3. 旧版 19 册若要补 `unit` 让单元筛选可用，需要文本源或电子课本逐单元对照；`pos`/`source` 同理

## 工具
- `tools/build-curriculum.py`：koolearn 词书抓取管线（旧版来源）
- `tools/clean-curriculum.js`：错义清洗（PE/UK/Ms 类）
- `tools/parse-wy2024.py`：2024 新版词表原文解析器（知乎源）
- `tools/build-wy-primary.py`：外研社版小学 8 册生产（51jiaoxi 主源 + koolearn 互证 + 钩子挂载）
- `tools/verify-textbooks.js`：教材域门禁（册数/来源/钩子/前缀契约/重命名/自愈/音节覆盖）
- `data/curriculum/fill.json`：人工补义（抓取管线用）
- `data/curriculum/wy-hooks.json`：外研社版小学钩子表（944 词，跨册共用，构建输入）

## 管线源文件（都在 `data/curriculum/` 下，不进小程序）
- `raw/`：koolearn 抓取缓存（20 个 JSON，与本目录同名字典版**不同**——本目录是清洗后的词书，勿混用）
- `wy7a2024_raw.txt`：2024 外研七上词表原始文本
- 重新生成流程：`tools/fetch-koolearn.py` → `tools/build-curriculum.py` → 覆盖本目录对应 JSON；`tools/parse-wy2024.py` 读 `wy7a2024_raw.txt` → 更新 `wy7s_2024.json`
