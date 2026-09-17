# curriculum 词库说明（版本权威等级）

## app 实际引用了哪些文件

**20 册全部随包发布**（2026-09-17 起），但**按需加载**：册次注册表在
`utils/curriculum-books.js`（id → 加载函数，每个函数体一个静态 `require`），
教材导入页（`pages/curriculum/curriculum`）只列出书名和词数，
学生点开哪一册才 `require` 哪一册 —— 打包时 20 册都进包（点开即有，不用等网络），
但内存里只留点开过的那册，不会一进页面就把 5188 个词全读进来。

同目录的 `missing.json` 与本 README 仍在 `project.config.json` 的
`packOptions.ignore` 里排除（非词书）。

> ⚠️ 改动注意：往本目录**新增**词书文件后，必须同步在
> `utils/curriculum-books.js` 里登记（id / 书名 / 年级 / 词数 / 加载函数），
> 否则学生在册次列表里看不到它。不再需要改 `packOptions.ignore`
> —— 那个机制是"只有一册进包"时代的产物，现已废弃。

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
- `bj1s.json` + `kj3x~kj6x.json`：北京版一上 + 北京课改版老教材词书（现行北京版 2024 新版未收录）
- `missing.json`：占位/缺口记录，非词书

### ⚠️ 残留错义待复核（2026-09-17 扫描发现，未修）

清洗只覆盖了 PE / UK / Ms 三类，**同类错义仍有残留** —— 抓取管线按 `wd` id
匹配释义的老毛病（缩写/专有名词命中别的词条），扫出至少 10 条明显错的：

| 册 | 词 | 当前释义 | 应为 |
|---|---|---|---|
| `bj1s` | `am` | (=amplitude modulation) 调频 | 是（be 的第一人称单数） |
| `bsd7x`、`kj6x` | `OK` | ohne kosten (German) 不计价 | 好的、行 |
| `bsd7x`、`wy7x` | `August` | 尊严的；威严的；令人敬畏的 | 八月 |
| `wy7x` | `hmm` | hidden Markov model 隐马尔科夫模型 | 嗯（语气词） |
| `wy8x` | `Mars` | master attitude reference system | 火星 |
| `wy8x` | `mm` | =megameter | 毫米 |
| `bsd9` | `Wales` | 条痕；选择（wale 的复数） | 威尔士 |
| `bsd9` | `Big Ben` | 大钟；美国得州大本德公园 | 大本钟（后半截是 Big Bend，串味了） |
| `bsd7x` | `Great Wall` | 长城；中国长城计算机集团公司… | 长城（后半截是公司名） |
| `wy9s` | `read out` | 读出器（readout 的过去式） | 朗读、读出 |

这些词现在会随册进入学生词库（选了那册就会导入）。要修的话，
在 `tools/clean-curriculum.js` 的 `FIXES` 表里补条目后
`node tools/clean-curriculum.js --apply` 重跑；修不掉的宁可删条目
（宁可少一个词，不要给错的）。

## 待补（现行版缺口）
1. 外研 2024 新版：七下（2025 版）、八上（2025 版）、八下、九上（2026 版）、九下 —— 找同系列文本源
2. 北京版 2024 新版小学：三上/三下/四上/四下/五上/六上 —— 只有电子课本图片版（dzkbw），文本源或 Computer Use 逐词抄
3. 旧版 19 册若要补 `unit` 让单元筛选可用，需要文本源或电子课本逐单元对照；`pos`/`source` 同理

## 工具
- `tools/build-curriculum.py`：koolearn 词书抓取管线（旧版来源）
- `tools/clean-curriculum.js`：错义清洗（PE/UK/Ms 类）
- `tools/parse-wy2024.py`：2024 新版词表原文解析器（知乎源）
- `data/curriculum/fill.json`：人工补义（抓取管线用）

## 管线源文件（都在 `data/curriculum/` 下，不进小程序）
- `raw/`：koolearn 抓取缓存（20 个 JSON，与本目录同名字典版**不同**——本目录是清洗后的词书，勿混用）
- `wy7a2024_raw.txt`：2024 外研七上词表原始文本
- 重新生成流程：`tools/fetch-koolearn.py` → `tools/build-curriculum.py` → 覆盖本目录对应 JSON；`tools/parse-wy2024.py` 读 `wy7a2024_raw.txt` → 更新 `wy7s_2024.json`
