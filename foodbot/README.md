# dsh-foodbot

把《中国菜谱》各省分册（中国财政经济出版社，1970s–80s，2,877 道）做成一套**能替你决定吃什么**的本地工具：查菜谱、记口味、排周菜单、算采购清单、随机摇一桌。

零第三方依赖，不联网。作为 DSH 插件运行时只依赖 `ctx.tools.register` / `ctx.effect`。

## 从原料到应用（这一层的定位）

**菜谱是原材料，不是产品。** 这个仓库做的是中间的加工：

```
菜谱（原料）         OCR Markdown，17 册 969 页，一字未改的事实
   ↓ 加工
处理后数据          统一 schema、原料归一、克数、营养、难度、变体关系
   ↓
应用                 DSH 插件（现在）／小程序（以后）
```

加工是分任务并行的，每类任务产出独立文件，再由 `src/integrate.mjs` 合成一份可复现的数据：

| 加工任务 | 输入 | 产物 | 状态 |
|---|---|---|---|
| 基础解析 | OCR 切片 | `data/recipes.jsonl` | 已做（2,171 道） |
| 原料本体系 | 33,922 行原料 | `src/lexicon.mjs`（469 标准名 / 2,762 异名） | 已做，尾部 3.9% |
| 新分册摄入（教材体） | 《中国南北名菜谱》110 页 | `data/work/nanbei.jsonl` | 已做：706 道 |
| 重名/变体合并 | 2,171 道 | `data/work/duplicate-groups.json` | 已做：63 组 / 138 条 |
| 词表尾部补全 | guessed 的原料行 | `data/work/lexicon-additions.json` | 已做：368 条合并进源码 |
| 残缺修复 | 24 条无用料 / 57 条无做法 | `data/work/repairs.json` | 已做：86 条（其余被解析器修复覆盖） |

`node src/integrate.mjs` 把上面几份产物合回 `data/recipes.processed.jsonl`，并顺手拍出应用层的两个文件：

- `data/app/cards.json`（约 500 KB）— 首屏卡片：id/菜名/菜系/难度/蛋白/热量/主料/过敏原/页码
- `data/app/facets.json` — 筛选面：菜系、分类、技法、难度、过敏原、高频原料

插件和查询层会自动读最新的那份（`recipes.processed.jsonl` 存在就优先），所以重建数据不必重启宿主。


## 九个工具

| 工具 | 干什么 |
|---|---|
| `recipe_search` | 按食材/菜系/类别/技法/口味/关键词找菜；默认按画像滤掉过敏原、主料级忌口、做不了的技法；配料级忌口的命中带「免 X 版」（0.4.2 两级语义） |
| `recipe_get` | 取完整原文：原始斤两（附克数）、分步做法、特点、出处页码、蛋白/份量；配料级忌口的菜附「免 X 版」提示行，主料级的说明为何不推荐；顺带告诉你上次做过没 |
| `profile_show` | 看画像：人数、长期喜恶、过敏、生效中的周期需求、技能设备、想吃的、冰箱剩料 |
| `profile_update` | 改画像（长期偏好 / 周期需求），也能记下「想吃」和随口一句 |
| `cook_log` | 记一顿真做过的饭：好吃 / 还行 / 别再做了，以及剩了什么 |
| `plan_week` | 排 1–7 天菜单 + 采购清单；每天末尾给当日合计（蛋白/热量对着天级目标），早餐固定模板另配；支持精力档位、`intent: fast/learn`、自动扣冰箱剩料 |
| `menu_shuffle` | 随机挑战：按画像筛范围后摇一桌；一局只有两次机会（初摇 + 一次再摇），用完转「问原因」 |
| `cook_rescue` | 太累/太晚/不想动时的退路：三道半小时内、有蛋白（≥20g/人）、少预制依赖的菜，外加「不做也行」 |
| `show_card` | 把定好的一桌（菜谱 id + 采购清单 + 提醒）压成一张「板书」卡片；对话里出卡，用户可点「钉到侧栏」把它钉在右侧栏当菜谱/采购清单看（0.5.6） |

`plan_week` / `menu_shuffle` / `recipe_search` 都接受 `intent: "fast" | "learn"`（R16 意图感知）：`fast` = 饿的晚上，等价精力 `tired`（≤35 分钟、好上手）；`learn` = 学菜的晚上，时间上限放到 180 分钟、放开 learn 档（hard 档仍要画像允许）。优先级：显式 `maxMinutes` > `energy` > `intent`。

### 工具契约（v0.2）

v0.2 把「工具返回什么」拆成三层（`src/plugin.mjs` 的 `output(schema, render, presentationMeta)`）：

| 层 | 给谁 | 是什么 |
|---|---|---|
| `execute()` 返回值 | 程序 | 结构化 canonical value，由 `output.schema` 声明并校验 |
| `output.render(args, value)` | 模型 | 唯一的自然语言文本（`[{ type: "text", text }]`），模型不再从返回字符串里猜字段 |
| `output.presentationMeta(args, value)` | 浏览器 | 卡片 meta；形状与 0.1.2 的 `cardX()` 逐字段一致（`client/client.js` 只认 `kind`） |

**零命中是正常领域结果，不是错误。** `recipe_search` 找不到时返回
`{ hits: [], neighbors, hint: { code: "no_hit" | "no_anchor" | "all_blocked", text } }`；
`recipe_get` 取不到时返回 `{ found: false, recipe: null, suggestions, hint: { code: "not_found", text } }`。
只有基础设施故障（读不到数据文件、内部异常）才 throw，框架据此记 `isError`。

`recipe_search` 的 value：

```jsonc
{
  "hits": [{
    "id": "江苏-003", "title": "清汤火方", "book": "中国菜谱·江苏",
    "cuisine": "江苏", "chapter": "肉菜类", "page": 7,
    "minutes": 150, "servings": 8,
    "proteinPerServing": 88, "kcalPerServing": 995, "tier": "easy",
    "mainIngredients": ["火腿", "母鸡", "猪爪"],
    "features": "…", "blurb": "…",
    "lineIngredients": [{ "name": "火腿", "raw": "火腿一两五钱", "amount": "一两五钱" }],
    "ingredientCount": 3,
    "omit": [{ "target": "大蒜", "grams": 15 }]   // 0.4.2 R2b：配料级忌口，做的时候省去（render 出「免 X 版」）
  }],
  "total": 105,        // 画像过滤前的真实命中数（v0.2 修正：不再被检索层内部 50 封顶）
  "blocked": 31,       // 被画像硬约束挡掉的数量（过敏/主料级忌口/难度/技法口味/热量硬挡/过敏防御）
  "hidden": 2,         // 隐藏的批量配方/疑似串行菜 + 野味/贵价食材（0.4.1 起默认与菜单层同口径）
  "libraryTotal": 2877,
  "neighbors": [{ "id": "…", "title": "…", "reason": "同食材『鱼肚』" }],
  "hint": { "code": "ok", "text": "已隐藏 2 道批量配方/疑似串行菜，respectProfile=false 可看" }
}
```

`hint.code` 四个分支：`ok`（有命中）、`no_hit`（锚点命中但菜谱没命中，带 ≤5 条确定性的近邻）、
`no_anchor`（连锚点都没有，给库的覆盖范围）、`all_blocked`（有命中但全被画像挡掉，提示 `respectProfile=false` 可放宽）。
近邻是纯函数：无随机、无时钟，同输入同输出。

0.4.1 起 `ok` 分支的 `hint.text` 也可能有话（render 会前置）：

- **弱命中**（E1 Q11）：q 整串在标题/用料/特点里字面不中——「没有完全命中『红烧肉』，以下是按相近字词放宽的结果」；
- **隐藏说明**：批量配方/疑似串行菜被收口（61kg 的无锡排骨不再当第一结果）、过敏防御拦截了多少道。

`recipe_get`：`found: true` 时 `recipe` 带全文用料（含 `grams`）、`steps`、`page` 等，并附 `memory`
（上次做过几天前 / `loved` / `never` / `want`）；`found: false` 时给 ≤3 条同名近邻 `suggestions`，不返回字符串。

`plan_week` / `menu_shuffle` / `cook_rescue` 的 canonical value 就是原来 `cardX()` 消费的结果对象本身；
本版 `output.schema` 故意用宽松的 `{ type: "object", additionalProperties: true }`，字段收紧留 v0.3。
`profile_show` / `profile_update` / `cook_log` 仍是字符串，只换了 helper 签名。

契约测试：`node tools/contract-test.mjs` 覆盖 §5 的 12 条用例（每个工具每个返回分支 + schema 校验 +
`render` 文本卫生 + 卡片 JSON 往返），全绿 exit 0，任一失败 exit 1。

> ⚠️ **宿主的 schema 子集**：`output.schema` 的 `type` 必须是单个类型字符串（**不支持 `type` 数组**），
> `oneOf` 不能和 `properties/required/additionalProperties/items/enum/const` 并列；可空字段写成
> `oneOf: [{ type: "X" }, { type: "null" }]`。超出子集时宿主会拒绝工具注册、插件整体不激活
> （而本地校验器可能仍然全绿）。`tools/contract-test.mjs` 现在按宿主同口径校验。

## 可视化：为什么用客户端卡片

DSH 里有三条路，按代价从低到高：

1. **纯文本**（默认）。工具输出就是模型看到的那段文字，UI 只显示「工具名 + 原始输出」。零成本，但用料表和一周菜单会挤成一大坨。
2. **客户端 toolview 卡片**（本插件采用）。Host 用 `output.presentationMeta` 把「可回放的结构化事实」持久化到 `tool/result.meta`；浏览器侧插件按工具名在 keyed slot `tool.call.toolview` 注册组件，从 meta 渲染卡片。
3. **独立页面 / 侧栏**。适合浏览式界面（菜谱库、周菜单看板），要注册 slot 页面 + Host 路由，等真有浏览需求再做。

有个容易踩的坑，写在 `docs/cookbook/adding-a-tool.md` 里：**内置 Web Client 不消费 `presentCall`/`presentResult`**，只写 Host 展示方法不会长出一张专属卡片。要卡片，必须自己提供浏览器半边。

实现约束（照文档抄的，不是自创）：

- `presentationMeta(args, value)` 必须是**纯函数**：可回放、不做 I/O、不读时钟。所以卡片只放参数和结果里已有的事实。
- 卡片数据**有界**：数组截断（用料 24、步骤 20、搜索 12），长字符串截断到 220 字。
- meta 缺失或结构不对时**回退 generic**，不能白屏，也不能让回放崩掉。
- 零命中 / `all_blocked` 的检索分支只返回结构化 value 和 `hint`，**不发空搜索卡**（`presentationMeta === null`），UI 回退到文本输出——空卡片比没有卡片更糟。`ok` 分支与菜谱 found 分支的卡片形状与 0.1.2 冻结一致。

现在有五张卡（`client/client.js`）：菜谱卡、检索卡、周菜单卡（含折叠的采购清单）、随机挑战卡、退路卡。`tools/test-client.mjs` 用假 React + 假 ModuleLoader 跑 11 条断言，覆盖「五张卡都渲染」和「坏 meta 回退」。

```bash
node tools/test-client.mjs     # 11/11
```

**安装方式不同，卡片出不出来也不同**：当前是按文件路径挂载的，只有 Host 半边。要让浏览器也加载这个包，得把它装进 profile（`pnpm add file:dist/dsh-foodbot-0.2.0.tgz`，并把 `dsh-foodbot` 加进 profile 的 `dsh.profile.bundles`），然后重启 DSH。路径挂载适合改代码，包安装才带得上 `dsh.client` 的浏览器 bundle。

## 照顾是怎么落进代码的

不是把文案写温柔，是三件可执行的事。

**记性**（`src/state.mjs` + `cook_log`）
- `never` 的菜永久不再出现；`loved` 加权；12 天内做过的降权（`(13-天数)*0.35`）
- 「想吃」进 `wants`，规划时优先落位，落位后写一句「排了你之前说想吃的 X」
- 想吃的排不进去时不装没看见：直接说「现有菜谱里没排进去，要不要放宽一次」

**退路**（`src/care.mjs`）
- 精力三档：`tired` 只收 35 分钟内、好上手的；`good` 才放开学着做的
- `cook_rescue` 只从**已过画像过滤**的候选里挑，不会端出一道含过敏原的「省事菜」
- 菜单末尾永远有一句：哪天不想做就顺延，菜单是备选不是任务

**不浪费**
- `cook_log` 记的剩料进「冰箱里还有」，下次采购按克数扣掉，清单上写「冰箱已有 400 g，已扣」
- 份量够两顿的菜会提示「明天可以带饭」

**桌上的人**
- 有小孩且菜里有辣椒 →「孩子那份先盛出来，再放辣椒」
- 孕期 + 含酒/硝水 → 具体动作（少放或换清水、这道直接跳过）
- 低盐周期 →「盐比原方减三分之一，起锅前尝一下」

三条底线写在工具描述里：不评价用户的选择、不算连续天数、用户说不做就接受。


## 三层结构

```
data/recipes.jsonl   菜谱（原文 + 归一后的原料 + 营养/难度/份量）
data/lexicon（src）   原料本体：469 个标准名 ← 2,762 个异名
profile.json         用户画像：长期偏好 + 有窗口的周期需求
```

代码分层（`src/`）：

| 文件 | 职责 |
|---|---|
| `parse.mjs` | OCR Markdown → 菜谱记录，忠实原文 |
| `lexicon.mjs` | 原料标准名、别名、上位类、过敏原 |
| `ingredients.mjs` | 名称归一、分量→克、营养估算（p/f/c，优先成分表导入值） |
| `enrich.mjs` | 派生层：蛋白/碳水/热量/盐/油、份量人数、技法难度、过敏原 |
| `query.mjs` | 倒排 + BM25；只依赖数据文件，小程序可原样复用 |
| `profile.mjs` | 画像读存、周期生效判断、约束解析、单菜打分 |
| `planner.mjs` | 菜单规划、采购清单、随机挑战 |
| `plugin.mjs` | DSH 工具层（不碰 UI/网络） |

## 数据现状（2026-10-25）

| 指标 | 数值 |
|---|---|
| 菜谱 | 2,877（10 册 + 南北名菜谱） |
| 原料行 | 33,965 |
| 已折算克数 | 95.4% |
| 标准原料名 | 469（覆盖 2,762 个异名） |
| 无法归到标准名的词 | 3.9%（其中 94% 来自《中国南北名菜谱》） |
| 难度 | 好上手 1,370 / 要练 304 / 费工（炸为主）488 |

## 原料归一怎么做的

1. **形态词**：末/片/丝/块/粒/条/段/结/汁/泥/茸/丁 → 去掉（`姜末`→`姜`）
2. **修饰词**：熟/生/鲜/干/水发/净/瘦/肥/嫩/老/大小 → 去掉（`水发香菇`→`香菇`）
3. **别名表**：`冬菇`→`香菇`、`玉兰片`→（单列，笋干）、`绍酒`/`料酒`/`花雕`→`绍酒`、`去毛嫩母鸡`→`光鸡`
4. **后缀兜底**：没见过的鱼种/蔬菜/肉，按 `/鱼|虾|蟹|菜|肉|菇/` 归进对应大类，保证采购清单不漏

三条变体原则：**部位不同就分开**（五花肉≠里脊）、**工艺不同就分开**（玉兰片≠鲜笋）、**同物异名就合并**（绍酒=料酒=花雕）。

## 单位

- 市制十两制：1 斤=500g、1 两=50g、1 钱=5g、1 分=0.5g
- `一两五钱`→75g、`一斤半`→750g、`一条（约重一斤半）`→取约重
- 只/条/个：知道单重就折算（鸡蛋 50g、蛋清 33g），不知道就保留个数，**不猜**
- `适量`/`少许` 不折、不进采购量，只在原文里保留

## 营养口径（粗估，用于排序和提示，不是营养标签）

- 蛋白/脂肪/碳水逐条食材取值：优先《中国食物成分表》标准版第 6 版的结构化数据（社区整理、
  LLM 识图校正版，导入到 `src/nutrition-ref.mjs`；**识图校正可能有错，个别条目与纸质原表有出入**），
  导入表没覆盖的回落到类目默认值 + 少量历史手抄覆盖（`src/ingredients.mjs`）
- 热量 = 蛋白×4 + 碳水×4 + 脂肪×9（v0.3 起碳水计入，甜菜/主食不再是数量级错误）；
  **炸用油按附着量计入**：原文标「约耗 X」的油按耗去的量全额计（v0.5 起），未标的按整锅 15% 附着兜底
- **可食部折算（v0.5 起）**：营养计算按《成分表》可食部%（整鸡 63%、鳙鱼 61% 等）——配料表原文克数仍是毛重照登
- **p/f 校准（v0.5 起）**：成分表覆盖的条目蛋白/脂肪采用参考值（腊肉脂肪 20→48.8 等 247 条），6 个歧义名保持原值
- 份量：按各类食材「够几个人」取最大值，2–8 人

已知边界（营养口径，v0.5）：

- 识图校正版的成分表个别条目可能与纸质原表有出入（见上方导入说明）
- **南北册 88 条、大众册 37 条油行的「约耗」尚未进字段**（两册摄入解析器各自的活，0.5.1）；46 条非油料约耗（酱油/面粉/卤水）同样待批
- **湿淀粉按 0.35 折算**：「湿淀粉/水淀粉」入库克数是干淀粉口径，碳水按干物质占比中值 0.35 折
- 蜜枣存疑（参考数据是椰枣条目）、克数区间行取下界——留 0.5.1

> v0.2「碳水未计入热量」的缺陷已于 v0.3 修复（立项评审意见存于仓库根 `意见.md`，2026-10-26，不随 npm 包发布）。

## 画像：长期 vs 周期

```jsonc
{
  "longTerm": {
    "likes":    [{ "target": "猪肉", "weight": 2 }],
    "dislikes": [{ "target": "大蒜", "hard": true }],   // hard = 忌口（0.4.2 起两级：主料级换菜，配料级省去）
    "allergies":[{ "target": "虾", "allergen": "甲壳类" }],
    "diet":     { "noPork": false, "vegetarian": false }
  },
  "periods": [
    { "label": "备赛", "preset": "fitness", "start": "2026-10-01", "end": "2026-12-31",
      "goals": { "proteinPerServing": 35 } }
  ],
  "skills": { "confident": ["蒸","煮","炒","煎","焖","焗","烤"], "avoid": ["炸"] }
}
```

- **长期**：一直不喜欢、过敏、素食——永久生效
- **周期**：健身、减脂、孕期、低盐、有小孩、素食阶段——必须带 `start/end`，过期自动失效但不删除（留痕，好复盘）
- 内置模板（`data/presets.json`）：`fitness` `fat_loss` `pregnancy` `low_salt` `low_fat` `kids` `vegetarian`
- `goals` 支持**天级目标**（0.4）：`proteinPerDay` / `kcalPerDay`，供每日总盘子对账；
  没有时回退「每餐目标 × 餐数」
- 技能决定难度门槛：`confident` 里没有「炸」，费工菜就不进菜单（`intent=learn` 也只放开 learn 档，hard 仍要画像允许）

## 规划规则（`planner.mjs`）

1. **叶菜只在前 2 天**，第 3 天起换根茎/瓜/菌菇/豆制品（一次买菜撑不了一周）
2. **肉、水产一次买够**，按整块/整只算，回家分装冷冻
3. **同一顿饭不重复同一主料**；同一道菜整周不重复；同一主料不连着两天当主菜；同一天两餐的素菜不撞同一蔬菜主料
4. 蛋白不够时**补一个蒸蛋/豆腐小菜**，而不是硬加一道大荤
5. **素菜分型配比（0.4）**：素菜按「绿叶 / 根茎瓜果 / 菌菇笋 / 蛋豆制品」分型；前两天优先绿叶，
   之后根茎瓜果；**一张菜单里非笋菇素菜 ≥2 道**（凑够之前不挑笋菇类）；蛋/豆制品素菜（糖醋溜蛋酪、
   烤麸这类）按「无肉 + 蔬菜 ≥80g」进素菜池，不再被蛋白量挡在门外
6. **甜菜守卫**：甜菜类的荤甜菜/甜汤不进任何池；素甜菜（蜜汁甜藕这类）计入素菜供给口径
   （`pool-report` 的 A1 数字），但菜单永远不排
7. **每日总盘子（0.4）**：每天末尾一行「第 N 天合计：蛋白 Xg（目标 Yg，差 Z）· 热量 K kcal」；
   目标优先取周期 `goals.proteinPerDay` / `kcalPerDay`（天级），没有才回退「每餐目标 × 餐数」——
   否则 85g/天 会被每餐口径误判成超标
8. **早餐另配（0.4，R18）**：语料不含早餐，不硬造菜谱；render 末尾给固定模板（一份蛋白 + 一份主食），
   按周期加一句（低盐别配咸菜 / 有小孩加水果或奶 / 减脂至少加个蛋）
9. 默认剔除：宴席菜（整鸭整鸡拼盘）、野味（狗肉/野鸡/驼峰…）、贵价干货（鱼翅/海参/燕窝…）——可以在画像里放开；
   **0.4.1 起 `recipe_search` 默认走同一套厨房排除**（与菜单口径一致；用户点名要的词不挡——q=鱼肚 就是要鱼肚；
   `respectProfile=false` 全放开）。批量配方（`bulk`，87 道）与疑似串行（`suspectTitle`，10 道）检索侧同样收口
10. 采购清单：炸用油按 30% 附着量计，高汤/芡汤单列「自家熬或用水代替」；**采购量 = 原方 servingsBase 量**
    （0.4.1 口径统一：下锅的就是原方，「吃一半带饭」由菜单文案承载，不再按 people 折半买）
11. 热量预算按 v0.3 口径（含碳水）：甜菜/主食的 `kcalPerServing` 比 0.2 明显变高，
    `maxKcal` / `fat_loss` 预设的命中池相应变小，这是修正不是回归

**口味与周期（0.4）**：长期 likes 权重高于周期 preset（canon +1.2×w / parent +1.0×w，周期 preferParents 只 +0.4），
减脂期不会被模板把猪/牛挤成 0；`goals.lowFat` 时瘦部位（里脊/通脊/鸡胸/牛腱…）+0.8、高脂部位
（大肠/肥肠/板油/肥膘/五花肉…）−4（0.4.1 起：−2.5 压不住大肠，多个 seed 漏进荤位；降权不硬删）。
硬忌口按食材家族生效：忌「大蒜」同株的蒜苗/青蒜一并算。**0.4.2（R2b）起忌口分两级**：主料级换菜
（判定：主类目〔猪牛羊禽水产/蔬菜/蛋豆〕克数前二，或克数 ≥ 全菜 15%；克数缺失保守算主料）、
配料级照常推荐但省去该料——菜单/检索/详情带「免 X 版：省去 X（约 N g）」，采购清单自动剔除并留一句说明；
**过敏不适用两级**：过敏原任何级别任何含量都硬拦（`blockedAllergens` + 过敏目标 canon + 标题防御拦截，一行未动）。
**周期有 kcalPerServing 目标时，单菜超目标 2.5 倍直接出局**
（0.4.1：减脂 450 kcal/餐 → 1125 硬线，麻果肉 1863 这类不再只扣分）；`avoidMethods` 同时比对 `methods` 与
`flavors`（0.4.1：糖醋在口味里，「减脂避糖醋」此前永不生效）。

**单人份量（0.4）**：不再出现「做 ×0.2 份」。按原方 N 人份做、说清怎么吃：
scale ≥0.8 原文案；0.3–0.8「吃一半、另一半明天带饭」；<0.3「这道够 N 人，分两顿/冷冻」。
0.4.1 起菜单与采购同口径说「按原方」：单人采购原方量（吃一半带饭），多人靠选菜时份量贴近人数。

## 随机挑战

先按画像筛范围，再按「几菜几肉」摇（2–3 人默认 1 菜 1 肉）。**一局只有两次机会**（R11/R12）：
初摇（`rerollCount` 返回 1）→ 再摇一次带着 `excludeIds`（返回 2，hint 说明这是最后一次）→
第三次调用返回 `closed: true`、`dishes: []`、`askReason: true`，只给问原因的 hint（累/没胃口/缺食材/没灵感）
和「不做也行」的退路。想再摇只能重新开一局（`rerollCount` 从 0 传起，计数清零）。
0.4.1 起这些「怎么传参数」的话只出现在工具 description 和返回值里，不再漏进用户可见文本（E1 Q10）。

## 右侧栏「这桌」页签（0.5.4–0.5.6）

卡片不只在对话里。0.5.4 起，foodbot 在 Web GUI 注册了一个右侧栏页签类型（`sidebarRightTabs` + `sidebar.right.pane.tab`），菜卡和摇桌卡右上角多一个「钉到侧栏」按钮。

- **内容从会话日志派生**：页签每次渲染都扫本会话 `tool/result` 事件上的 `presentationMeta`，不另存副本——刷新、重开、换窗口都还在，也不会和对话里的卡对不上。
- **优先显示板书**：会话里最近一次 `show_card` 的板书（`kind: "board"`）排在最前，没有就退回「最后一次摇桌 + 最近 4 张菜卡」。
- **空态**：本会话还没出过卡时，页签显示「这桌还是空的」。
- `show_card` 的板书 = 标题 + 菜卡（用料/做法）+ 采购清单（可勾）+ 提醒；同一个 meta 同时给对话里的卡和页签用。

## 本地跑

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node src/build.mjs                 # 建库（十册）
& $node src/integrate.mjs             # 合并 work/* 产物
& $node tools/smoke.mjs               # 九个工具 + 卡片投影
& $node tools/contract-test.mjs       # 13 条契约用例（分支 + schema + 卡片往返）
& $node tools/test-client.mjs         # 客户端六张卡 + 侧栏页签（假 React，25 条断言）
& $node tools/acceptance.mjs          # 81 条端到端断言（0.4 A1–A11 + 0.4.1 B1–B9 + 0.4.2 C1–C6）
& $node tools/nutrition-check.mjs     # 营养不变量闸门（v0.3，需先按新代码重建数据）
& $node tools/pool-report.mjs         # 素菜池构成 + A1 门禁（--json / --easy）
& $node tools/replay-0.4.mjs          # 真实画像重放：菜单 + 每日总盘子 + 断言
& $node tools/replay-0.4.mjs --seeds=42,7,123,2026   # 0.4.1 多 seed 判卷（B5）
& $node tools/audit.mjs               # 数据审计
```

## 安装（包挂载，带浏览器卡片）

要把卡片带进 Web GUI，必须装成包——路径挂载只有 Host 半边：

```powershell
$node = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$pnpm = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"

# 1. 打包（版本号要改，否则 pnpm 认为没变）
& $node $pnpm --dir . pack --pack-destination ./dist

# 2. 装进 profile
& $node $pnpm --dir $profile add "file:<仓库路径>/foodbot/dist/dsh-foodbot-<版本>.tgz"

# 3. profile 的 package.json 里把 "dsh-foodbot" 加进 dsh.profile.bundles
# 4. 重启 DSH
```

包自己的 `cordis.patch.yml` 会把 `dataDir` 指到工作区的活数据，所以：

- **改代码** → 升版本、重打包、重装、重启
- **重建数据** → 什么都不用做，下次查询按 mtime 自动重载

回滚：`~/.dsh/profiles/desktop/` 下有 `*.bak-foodbot-<时间戳>` 的 `package.json` / `cordis.patch.yml` / `cordis.yml`，拷回去重启即可。

## 0.4.2 改动一览（R2b 忌口两级语义）

需求 `../需求总纲.md` R2b（2026-10-28 用户补充的关键域知识）：忌口不是铁板一块——
蒜苗做主料的菜省了蒜苗就不是这道菜（换）；蒜末爆香级的省掉无妨（留）。数据层不动，判定运行时可算：

1. **配料级忌口 → 省去即可**：菜照常入选/命中，canonical 值带 `omit: [{ target, grams }]`，
   render 出「免 X 版：省去 X（约 N g）」（菜单/摇一桌/检索命中/recipe_get 详情四处都有），
   **采购清单剔除该料**（`shopping.omitted` + notes 一句「已按忌口去掉：X N g」）
2. **主料级忌口 → 换一道菜**：blocked，理由写清「主料含忌口：X（主类目克数前二 / 占全菜 N%）」
3. **主料/配料判定**：① 该 canon 在本菜主类目（猪牛羊禽水产/蔬菜/蛋豆，跨类目一张榜、同 canon 合并计量）
   克数排前二；② 克数 ≥ 全菜 totalGrams 的 15%。满足任一即主料级；克数缺失保守判主料（宁换不错荐）
4. **过敏除外**：`blockedAllergens` / 过敏目标 canon / `titleImpliedAllergens` 防御拦截一行未动，
   任何级别任何含量硬拦
5. 0.4 的蒜家族硬过滤（GARLIC_FAMILY 全毙）改为家族展开后走两级：真实画像菜单池 650 → 736 道
   （放回 86 道蒜末爆香级误杀菜：鱼香肉丝、蚝油牛肉、干煸鳝鱼丝…；主料级 73 道仍拦，如家常豆腐/白肉片）
6. `blockedCanon` 现在只装过敏目标（任何含量都拦）；硬 dislikes / 周期 avoidCanon / 蒜家族进新的
   `avoidCanon` 两级集。卡片投影形状不变；`omit` 在 search 命中与 recipe_get 值里已声明进 schema

## 0.4.1 改动一览（手术前产品层收口）

数据层完全不动（那是 0.5 W0 的地盘），只收产品层的暴露面，工单来源 E1/E2/E3 见 `eval-0.5/`：

1. **采购口径统一**：采购 = 原方 servingsBase 量，菜单/采购不再一个说原方一个折半（E1 S2）
2. **bulk/suspectTitle 检索收口**：默认过滤 + hint 说明；`findTitle` 不再让 61kg 的无锡排骨领跑（E3 S-F）
3. **过敏防御**：标题含虾/蟹/贝而 `allergens` 未标 → 对该类过敏的用户直接拦（标签补录在 0.5 W2）（E3 S-E）
4. **检索走厨房排除**：默认与 `practical()` 同源挡野味/贵价干货（用户点名的词不挡）；`respectProfile=false` 全放开（E1 Q3）
5. **减脂高热量硬挡**：单菜超每餐目标 2.5 倍直接出局，不只扣分（E1 Q4）
6. **avoidMethods × 口味**：同时比对 `methods` 与 `flavors`，「减脂避糖醋」生效（E1 Q5）
7. **cook_rescue 看人**：可快出（≤30 分钟）+ 蛋白 ≥20g + 少预制依赖（用料名含 熟/水发/腌/腊/预制 降权），文案与过滤分钟数一致（E1 Q7）
8. **弱命中提示**：q 整串字面不中时前置「没有完全命中」（q=红烧肉 235 条不再装作命中）（E1 Q11）
9. **hint 语料边界**：「南北」不再混进省名；说破没有闽菜分册所以没有佛跳墙（E2 O9）
10. **无页码诚实标注**：`recipe_get` 对 page 缺失分册显示「（整理版无页码）」（E2 S4）
11. **检索去污染**：单字变体取消双向 includes，`ingredients=["鸡肉"]` 不再命中 1,168 道鸡蛋菜（E1 Q2）
12. **杂项**：大肠降权 −2.5→−4（多 seed 不再漏进荤位，E1 Q8）；早餐话术去行话、蛋白缺口给克数换算
    （41g ≈ 6 个鸡蛋或 3 杯希腊酸奶）；closed 分支不再漏模型指令；days=1 不说「顺延一天」；needsTitle 死代码删除

验收：`tools/acceptance.mjs` B1–B9（63 条全绿）+ `tools/replay-0.4.mjs --seeds=42,7,123,2026`。

## 已知边界

- 《中国南北名菜谱》（110 页，教材体）已摄入 706 道，但页码/步骤质量低于各省分册
- 《巧做家庭菜600例》只 OCR 了 4 页；《随园食单》是文言短条
- **早餐在语料外**（R18）：`plan_week` 的早餐建议是固定模板（蛋白 + 主食），不是菜谱；
  库内两餐的蛋白/热量与天级目标之间的缺口会如实报出来，由早餐/主食补
- **非笋菇素菜供给稀缺（数据现实）**：全库无肉、蔬菜 ≥80g、非汤非甜、不含笋菌菇的素菜只有约 21 道
  （1970s 语料的绿叶菜多半是荤菜里的配料）。菜单配比保证每张 ≥2 道非笋菇，但口味多样性受语料上限约束；
  `pool-report` 的 A1 口径含甜菜类素菜（供给口径），菜单可排数字另列
- 63 组同名/近名菜已标出变体关系（same_dish 57 组），但**没有合并记录**：每册各一版，按 `id` 区分
- 归一到 469 个标准名后仍有 3.9% 的词靠后缀兜底（94% 集中在南北名菜谱）；采购清单里会看到原书叫法
- 蛋白/碳水/热量来自成分表结构化估算（社区整理 + LLM 识图校正版，可能有识别误差；毛重未折可食部、
  「约耗」油量未单独处理、湿淀粉按 0.35 折算——见上文营养口径），孕期/肾病这类需要精确营养的场景请以医生和食物成分为准
- 规划默认是「1970s 餐馆菜」，口味偏重（油/糖/盐都高）；低盐低脂场景靠 presets 过滤，但它筛不掉「做法本身重口」

v0.2 契约相关的已知限制（有意取舍，留 v0.3）：

- **大结果集口径修正**：0.1.2 的命中数在检索层被内部 50 封顶，v0.2 的 `total` / render 头部改为真实全量，
  数字变大是修正不是回归
- **零命中分支不发卡**：`no_hit` / `no_anchor` / `all_blocked` 返回结构化领域值但 `presentationMeta = null`，
  UI 回退文本卡，不显示空的搜索卡
- ~~**exotic 过滤 bug 被行为冻结**~~：已于 **0.4.1 修复**——`respectProfile` 默认 true 时同样走厨房排除
  （野味/贵价干货），`respectProfile=false` 才全放开；用户点名的食材不受排除影响
- **schema 只收紧了一半**：`recipe_search` / `recipe_get` 是严格 schema；`plan_week` / `menu_shuffle` /
  `cook_rescue` 仍是 `{ type: "object", additionalProperties: true }`（只校验「是对象」），字段收紧留 v0.3
- **数据折算 bug 待修**：`一两五钱` 被折成 25g（应 75g），共 1,097 条 / 747 道；`render` 保留原文斤两，
  克数仅供参考
- **检索策略仍内建**：easy-only、忌口过滤仍写在 `recipe_search.execute` 里（不是部署策略层），v0.3 外移到
  pre-execute 或参数化

## 版权

《中国菜谱》署名「《中国菜谱》编写组」，版权在中国财政经济出版社，未进入公版。自己用没问题；做成公开小程序分发文本需要先解决授权。
