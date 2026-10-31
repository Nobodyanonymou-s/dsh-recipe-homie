# dsh-recipe-homie

**中文** | [English](./README.en.md)

> DSH 里的中国菜谱插件：检索正派做法、按你的人排菜单、算得出采购清单、治得好"今晚吃什么"。
> *A DSH plugin for Chinese cooking: canonical recipes, menus that fit you, shopping lists that make sense.*

把一批老菜谱书整理成带**原始斤两与页码**的结构化菜谱库：纯本地、无联网，检索/规划/摇桌走原生卡片。仓库附带各品类抽样的示例语料，装完就能用；完整菜谱库自备书源构建。

## 它能替你做什么

- **找菜**：按食材/菜系/技法/手头剩料搜，命中带原文斤两（"一两五钱（≈75g）"）、出处页码、预计时长；同一道菜在别的分册还有版本，详情里直接对照
- **记住你**：长期偏好（喜恶/过敏/技能）与周期需求（减脂/孕期/增肌，带起止日期到期自动失效）分层画像，改一次，处处生效
- **懂忌口**：过敏任何含量都换菜；主料级忌口换一道菜；配料级给"免蒜版：省去 大蒜（约 15g）"照做；少盐少油不拦菜，只在推荐末尾附减量建议
- **排菜单**：≤6 人 3 天/一周，荤素按人数配比；**采购按保鲜组织**——肉一次买够分装冷冻、蔬菜排批次、清单凑整到可买份量（青菜 50g→300g）、熟火腿标"买现成的"
- **说真话**：每日蛋白/热量对着你的天级目标报缺口，缺多少说多少；语料没有早餐就明说"早餐另配"，不硬编
- **治选择疲劳**：随机挑战一局只有两次机会，摇完不纵容继续摇——先问你"累了、没胃口、缺食材，还是没灵感"，按答案给退路
- **能学菜**：说一声"想学难的"放开高难度档；功夫菜有人工校准的真实时长（开水白菜 hard·约 240 分钟，不拿 20 分钟简化版糊弄你）
- **原生体验**：检索卡/菜谱卡/菜单卡/板书卡，定好的一桌可**钉在右侧栏**当菜谱和采购清单用

## 安装

**未上架插件市场，也未发布 npm**——从 GitHub 直装（包在仓库的 `foodbot/` 子目录，用 `#path:` 指过去）：

```sh
dsh plugin --profile desktop add "https://github.com/Nobodyanonymou-s/dsh-recipe-homie#path:foodbot"
```

离线/慢网备选：clone 后打 tarball 本地装：

```sh
git clone https://github.com/Nobodyanonymou-s/dsh-recipe-homie.git
cd dsh-recipe-homie/foodbot
npm pack --pack-destination ./dist
dsh plugin --profile desktop add ./dist/dsh-recipe-homie-<version>.tgz
```

装包后配一下数据目录，二选一：

- **开箱试用**：把 [data-sample](./foodbot/data-sample/)（各品类抽样的示例语料，160 道）复制到一个可写目录——插件会往里面写画像与状态——再把挂载配置（`cordis.patch.yml` 的 `config:`）里 `dataDir` 指过去
- **完整库**：仓库不含完整菜谱数据（派生自编者藏书，不分发）——自备书源跑 `build → integrate` 产出 `data/`，`dataDir` 指过去，并把 [presets.example.json](./foodbot/presets.example.json) 复制为 `data/presets.json`；细节见[技术文档](./foodbot/README.md)

然后重启 DSH。

第一次用：把你的口味和忌口告诉它（或抄一份[画像示例](./画像示例.md)改改），然后问一句"今晚吃什么"。

## 文档

- [画像示例](./画像示例.md)——三个完整画像与"它会怎么照顾你"，改一改就能用
- [技术文档](./foodbot/README.md)——数据流水线、营养口径、工具契约、已知边界

## 设计原则

菜谱是固定的，烹饪是灵活的；菜单是备选，不是任务。问原因，不审判指标；记性有温度，永远留退路。

## 路线图

《随园食单》与更多分册待摄入；国际菜谱（1,253 种 · 50+ 国）已入册。

## 许可

代码以 [Apache-2.0](./LICENSE) 分发。营养参考数据来自[《中国食物成分表》第 6 版社区结构化版](https://github.com/Sanotsu/china-food-composition-data)（事实性数据，含识图校正风险声明）。菜谱语料不随仓库分发。
