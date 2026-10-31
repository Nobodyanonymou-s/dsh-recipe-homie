# dsh-recipe-homie 技术文档

把老菜谱书（OCR）变成一套**能替你决定吃什么**的本地工具：查菜谱、记口味、排菜单、算采购清单、随机摇一桌。

零第三方依赖，不联网。作为 DSH 插件运行时只依赖 `ctx.tools.register` / `ctx.effect`。

## 数据从哪来

**菜谱是原材料，不是产品。** 仓库不含完整菜谱数据——数据派生自编者藏书 OCR，不分发。仓库带的是：

- 处理管线：`src/parse.mjs`（OCR Markdown → 菜谱记录）→ `src/lexicon.mjs` + `src/ingredients.mjs`（原料归一、斤两→克）→ `src/enrich.mjs`（营养/难度/份量）→ `src/integrate.mjs`（合成 `data/recipes.processed.jsonl`）
- 示例语料：`foodbot/data-sample/`（各品类抽样，克隆即用）；完整库自备书源跑 `build → integrate`

插件和查询层按 mtime 自动读最新的数据文件，重建库不必重启宿主。

## 九个工具

| 工具 | 干什么 |
|---|---|
| `recipe_search` | 按食材/菜系/类别/技法/口味/关键词找菜；默认按画像滤掉过敏原、主料级忌口、做不了的技法；配料级忌口的命中带「免 X 版」 |
| `recipe_get` | 取完整原文：原始斤两（附克数）、分步做法、特点、出处页码、蛋白/份量；顺带告诉你上次做过没 |
| `profile_show` | 看画像：人数、长期喜恶、过敏、生效中的周期需求、技能设备、想吃的、冰箱剩料 |
| `profile_update` | 改画像（长期偏好 / 周期需求），也能记下「想吃」和随口一句 |
| `cook_log` | 记一顿真做过的饭：好吃 / 还行 / 别再做了，以及剩了什么 |
| `plan_week` | 排 1–7 天菜单 + 采购清单；每天末尾给当日合计（蛋白/热量对着天级目标）；支持精力档位、`intent: fast/learn`、自动扣冰箱剩料 |
| `menu_shuffle` | 随机挑战：按画像筛范围后摇一桌；一局只有两次机会，用完转「问原因」 |
| `cook_rescue` | 太累/太晚/不想动时的退路：三道半小时内、有蛋白、少预制依赖的菜，外加「不做也行」 |
| `show_card` | 把定好的一桌压成一张「板书」卡片，可钉在右侧栏当菜谱/采购清单用 |

`plan_week` / `menu_shuffle` / `recipe_search` 都接受 `intent: "fast" | "learn"`：`fast` = 饿的晚上（≤35 分钟、好上手）；`learn` = 学菜的晚上（时间上限 180 分钟、放开 learn 档，hard 档仍要画像允许）。优先级：显式 `maxMinutes` > `energy` > `intent`。

## 工具契约（三层）

工具返回什么拆成三层（`src/plugin.mjs` 的 `output(schema, render, presentationMeta)`）：

| 层 | 给谁 | 是什么 |
|---|---|---|
| `execute()` 返回值 | 程序 | 结构化 canonical value，由 `output.schema` 声明并校验 |
| `output.render(args, value)` | 模型 | 唯一的自然语言文本，模型不从返回字符串里猜字段 |
| `output.presentationMeta(args, value)` | 浏览器 | 卡片 meta；**必须是纯函数**（可回放、不做 I/O、不读时钟），缺失或结构不对时回退 generic 而不是白屏 |

**零命中是正常领域结果，不是错误。** `recipe_search` 找不到时返回
`{ hits: [], neighbors, hint: { code: "no_hit" | "no_anchor" | "all_blocked", text } }`；
`recipe_get` 取不到时返回 `{ found: false, recipe: null, suggestions, hint }`。
只有基础设施故障（读不到数据文件、内部异常）才 throw。近邻是纯函数：无随机、无时钟，同输入同输出。

> ⚠️ **宿主的 schema 子集**：`output.schema` 的 `type` 必须是单个类型字符串（**不支持 `type` 数组**），
> `oneOf` 不能和 `properties/required/additionalProperties/items/enum/const` 并列；可空字段写成
> `oneOf: [{ type: "X" }, { type: "null" }]`。超出子集时宿主会拒绝工具注册、插件整体不激活
> （而本地校验器可能仍然全绿）。`tools/contract-test.mjs` 按宿主同口径校验。

## 客户端卡片

DSH 里有三条路，按代价从低到高：纯文本（默认）→ **客户端 toolview 卡片**（本插件采用：Host 把 `presentationMeta` 持久化到 `tool/result.meta`，浏览器侧按工具名在 keyed slot `tool.call.toolview` 注册组件渲染）→ 独立页面/侧栏。

容易踩的坑：**内置 Web Client 不消费 `presentCall`/`presentResult`**——要卡片必须自己提供浏览器半边（`client/client.js`，classic script，手写 `React.createElement`，无 JSX 无打包器）。

卡片数据有界（用料 24、步骤 20、搜索 12 条，长字符串截到 220 字）；零命中分支不发空搜索卡（`presentationMeta === null`，回退文本）。

现有六张卡：菜谱卡、检索卡、周菜单卡（含折叠采购清单）、随机挑战卡、退路卡、板书卡。

## 照顾是怎么落进代码的

不是把文案写温柔，是几件可执行的事：

- **记性**（`src/state.mjs` + `cook_log`）：`never` 的菜永久不再出现；`loved` 加权；近期做过的降权；「想吃」进 `wants`，规划时优先落位，排不进去时直说，不装没看见
- **退路**（`src/care.mjs`）：精力 `tired` 只收 35 分钟内的；`cook_rescue` 只从已过画像过滤的候选里挑；菜单末尾永远有一句「哪天不想做就顺延，菜单是备选不是任务」
- **不浪费**：`cook_log` 记的剩料进「冰箱里还有」，下次采购按克数扣掉；份量够两顿的菜提示带饭
- **桌上的人**：有小孩且菜里有辣椒 →「孩子那份先盛出来」；孕期 + 含酒/硝水 → 给具体动作；低盐周期 →「盐比原方减三分之一，起锅前尝一下」

三条底线写在工具描述里：不评价用户的选择、不算连续天数、用户说不做就接受。

## 代码结构

```
data/recipes.processed.jsonl   菜谱（原文 + 归一原料 + 营养/难度/份量）
src/lexicon.mjs                原料本体：标准名 ← 异名/形态词/修饰词
profile.json                   用户画像：长期偏好 + 有窗口的周期需求
```

| 文件 | 职责 |
|---|---|
| `parse.mjs` | OCR Markdown → 菜谱记录，忠实原文 |
| `lexicon.mjs` | 原料标准名、别名、上位类、过敏原 |
| `ingredients.mjs` | 名称归一、分量→克、营养估算（优先成分表导入值） |
| `enrich.mjs` | 派生层：蛋白/碳水/热量、份量人数、技法难度、过敏原 |
| `query.mjs` | 倒排 + BM25；只依赖数据文件，可独立复用 |
| `profile.mjs` | 画像读存、周期生效判断、约束解析、单菜打分 |
| `planner.mjs` | 菜单规划、采购清单、随机挑战 |
| `plugin.mjs` | DSH 工具层（不碰 UI/网络） |

## 原料归一

1. **形态词**去掉：末/片/丝/块/粒/条/段/汁/泥/茸/丁（`姜末`→`姜`）
2. **修饰词**去掉：熟/生/鲜/干/水发/净/瘦/肥/嫩/老/大小（`水发香菇`→`香菇`）
3. **别名表**：`冬菇`→`香菇`、`绍酒`/`料酒`/`花雕`→`绍酒`
4. **后缀兜底**：没见过的鱼种/蔬菜/肉按 `/鱼|虾|蟹|菜|肉|菇/` 归大类，保证采购清单不漏

三条变体原则：**部位不同就分开**（五花肉≠里脊）、**工艺不同就分开**（玉兰片≠鲜笋）、**同物异名就合并**（绍酒=料酒=花雕）。

## 单位

- 市制十两制：1 斤=500g、1 两=50g、1 钱=5g、1 分=0.5g；`一两五钱`→75g
- 只/条/个：知道单重就折算（鸡蛋 50g、蛋清 33g），不知道就保留个数，**不猜**
- `适量`/`少许` 不折、不进采购量，只在原文里保留
- 「约耗 X」的油按耗去的量计（不是整锅），未标的按整锅 15% 附着兜底

## 营养口径（粗估，用于排序和提示，不是营养标签）

- 蛋白/脂肪/碳水逐条食材取值：优先《中国食物成分表》标准版第 6 版的结构化数据（社区整理、LLM 识图校正版，导入到 `src/nutrition-ref.mjs`；**识图校正可能有错，个别条目与纸质原表有出入**），没覆盖的回落到类目默认值
- 热量 = 蛋白×4 + 碳水×4 + 脂肪×9；湿淀粉按干物质 0.35 折算
- 营养计算按成分表可食部%（整鸡 63%、鳙鱼 61% 等）；配料表原文克数仍是毛重照登
- 份量：按各类食材「够几个人」取最大值，2–8 人

孕期/肾病这类需要精确营养的场景请以医生和食物成分为准。

## 画像：长期 vs 周期

```jsonc
{
  "longTerm": {
    "likes":    [{ "target": "猪肉", "weight": 2 }],
    "dislikes": [{ "target": "大蒜", "hard": true }],   // hard = 忌口（两级：主料级换菜，配料级省去）
    "allergies":[{ "target": "虾", "allergen": "甲壳类" }],
    "diet":     { "noPork": false, "vegetarian": false }
  },
  "periods": [
    { "label": "备赛", "preset": "fitness", "start": "2026-10-01", "end": "2026-12-31",
      "goals": { "proteinPerServing": 35, "proteinPerDay": 130 } }
  ],
  "skills": { "confident": ["蒸","煮","炒","煎","焖","焗","烤"], "avoid": ["炸"] }
}
```

- **长期**：一直不喜欢、过敏、素食——永久生效
- **周期**：健身、减脂、孕期、低盐、有小孩、素食阶段——必须带 `start/end`，过期自动失效但不删除（留痕好复盘）；周期里的安全类排除（孕期避硝水/绍酒等）一律硬拦
- 内置模板（`presets.json`）：`fitness` `fat_loss` `pregnancy` `low_salt` `low_fat` `kids` `vegetarian`
- `goals` 支持**天级目标** `proteinPerDay` / `kcalPerDay`，供每日总盘子对账；没有时回退「每餐目标 × 餐数」
- 技能决定难度门槛：`confident` 里没有「炸」，费工菜就不进菜单
- 忌口两级语义：**主料级换菜**（该原料在本菜主类目克数前二，或 ≥ 全菜 15%；克数缺失保守算主料），**配料级照常推荐但省去该料**（「免 X 版：省去 X（约 N g）」，采购清单自动剔除）；**过敏不适用两级**——任何含量任何做法都硬拦
- 硬忌口按食材家族生效：忌「大蒜」同株的蒜苗/青蒜一并算

## 规划规则（`planner.mjs`）

1. **叶菜只在前 2 天**，之后换根茎/瓜/菌菇/豆制品（一次买菜撑不了一周）
2. **肉、水产一次买够**，按整块/整只算，回家分装冷冻；采购清单凑整到可买份量（青菜 50g→300g），熟制原料标「买现成的」
3. **同一顿饭不重复同一主料**；同一道菜整周不重复；同一主料不连着两天当主菜
4. 蛋白不够时补一个蒸蛋/豆腐小菜，而不是硬加一道大荤
5. **素菜分型配比**：绿叶 / 根茎瓜果 / 菌菇笋 / 蛋豆制品；前两天优先绿叶，之后根茎瓜果；一张菜单里非笋菇素菜 ≥2 道
6. **甜菜守卫**：甜菜类的荤甜菜/甜汤不进任何池；素甜菜只计供给口径，菜单永远不排
7. **每日总盘子**：每天末尾一行「蛋白 Xg（目标 Yg，差 Z）· 热量 K kcal」——目标优先取天级，否则每餐 × 餐数
8. **早餐另配**：语料不含早餐，不硬造菜谱；render 给固定模板（蛋白 + 主食），按周期加一句
9. 默认剔除宴席菜、野味、贵价干货（画像里可放开）；`recipe_search` 默认走同一套厨房排除，用户点名的词不挡，`respectProfile=false` 全放开
10. **采购量 = 原方 servingsBase 量**：下锅的就是原方，「吃一半带饭」由菜单文案承载，不按人数折半买
11. 周期打分只改权重不改排除：长期 likes 权重高于周期 preset（减脂期猪/牛不会被挤成 0）；`lowFat` 时瘦部位加分、高脂部位强降权；单菜超每餐热量目标 2.5 倍直接出局；`avoidMethods` 同时比对技法与口味（「减脂避糖醋」生效）
12. **单人份量**：不出现「做 ×0.2 份」。按原方 N 人份做、说清怎么吃（scale 0.3–0.8 →「吃一半、另一半明天带饭」）

## 随机挑战

先按画像筛范围，再按「几菜几肉」摇（2–3 人默认 1 菜 1 肉）。**一局只有两次机会**：初摇 → 再摇一次（返回值说明这是最后一次）→ 第三次调用 `closed: true`、只给问原因的 hint（累/没胃口/缺食材/没灵感）和「不做也行」的退路。想再摇只能重新开一局（计数清零）。

## 右侧栏「这桌」页签

卡片不只在对话里：Web GUI 里注册了一个右侧栏页签，菜卡和摇桌卡右上角有「钉到侧栏」。

- **内容从会话日志派生**：每次渲染都扫本会话 `tool/result` 上的 `presentationMeta`，不另存副本——刷新、重开都在，也不会和对话里的卡对不上
- 优先显示最近的板书（`show_card`），没有就退回「最后一次摇桌 + 最近 4 张菜卡」；空态显示「这桌还是空的」
- **默认弹**：新的板书出现时自动打开页签；`callId` 存 localStorage，同一张卡只弹一次，翻历史/刷新不重复

## 本地跑

```sh
node src/build.mjs                 # 建库（自备书源）
node src/integrate.mjs             # 合并 work/* 产物
node tools/smoke.mjs               # 工具冒烟
node tools/contract-test.mjs       # 契约用例（分支 + schema + 卡片往返）
node tools/test-client.mjs         # 客户端卡片（假 React + 假 ModuleLoader）
node tools/acceptance.mjs          # 端到端断言
node tools/nutrition-check.mjs     # 营养不变量闸门
node tools/pool-report.mjs         # 素菜池构成
node tools/audit.mjs               # 数据审计
```

## 安装（包挂载，带浏览器卡片）

路径挂载只有 Host 半边；要让浏览器也加载客户端卡片，必须装成包。GitHub 直装（包在仓库 `foodbot/` 子目录，`#path:` 指过去）：

```sh
dsh plugin --profile desktop add "https://github.com/Nobodyanonymou-s/dsh-recipe-homie#path:foodbot"
```

或本地 tarball：`npm pack --pack-destination ./dist` 后 `dsh plugin add ./dist/dsh-recipe-homie-<version>.tgz`。

`cordis.patch.yml` 的 `config.dataDir` 指向你自己的语料目录（可写——画像与状态写在旁边）；改代码要重打包重装重启，重建数据什么都不用做（mtime 自动重载）。

## 已知边界

- **早餐在语料外**：`plan_week` 的早餐建议是固定模板，不是菜谱；库内两餐与天级目标之间的缺口如实报出，由早餐/主食补
- **非笋菇素菜供给受限**（1970s 语料的绿叶菜多半是荤菜配料）：《大众菜谱》摄入后菜单可排非笋菇素菜已到 72 道，每张菜单保证 ≥2 道，但口味多样性仍受语料上限约束
- 国际菜谱（友谊宾馆 1983）是馆子十份基准：检索/学菜线可用，默认不进家常菜单池（份量守卫挡住），单人场景看 perServing（÷10）
- 《中国南北名菜谱》是教材体：步骤少而长是书的风格，不是数据缺失；页码已接入（来自 OCR 分页文件名）。省册少数 OCR 丢页的菜在 `recipe_get` 里诚实标注「（整理版无页码）」
- 同名/近名菜已标出变体关系（254 组），但**没有合并记录**：每册各一版，按 `id` 区分
- 营养是成分表结构化估算（识图校正版可能有识别误差），不是营养标签
- 规划默认是「1970s 餐馆菜」，口味偏重（油/糖/盐都高）；低盐低脂场景靠 presets 过滤，但它筛不掉「做法本身重口」
- `plan_week` / `menu_shuffle` / `cook_rescue` 的 schema 仍是宽松 object（只校验「是对象」），字段收紧在路线图上

## 版权

代码 Apache-2.0。菜谱语料派生自编者藏书（未进入公版，版权在原出版社），不分发、不随包发布；`data-sample` 为品类抽样演示用途。做成公开应用分发文本需要先解决授权。
