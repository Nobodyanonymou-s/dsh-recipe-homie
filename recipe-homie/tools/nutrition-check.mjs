/**
 * 营养数据闸门：对 data/recipes.processed.jsonl 校验 v0.3 营养不变量（ITERATION-0.3 §4）。
 *
 * 硬不变量（违规 → 退出码 1）：
 *   1. |kcal − (4p + 4c + 9f)| ≤ 1.2（用库内字段；三字段各 1 位小数 + kcal 取整的容差上限，
 *      enrich 端 kcal 直接由入库宏量重算，库内实际 ≤0.5）
 *   2. perServing 与整道/servingsBase 一致（kcal 差 ≤1、蛋白差 ≤0.2）
 *   3. 纯糖类原料蛋白贡献 = 0：用当前代码 + 当前导入表逐条重算全库 p/f/c，与库值对照
 *      （漂移 > 0.5 即「代码/表换了数据没重建」），并断言导入表中蛋白=0 的条目（纯糖）贡献为 0
 *      —— 0.5 起重算与 enrich 同源：W7a 可食部折算、W6 约耗净口径（enrich.mjs 导出同一组函数）
 *   4. kcal = 0 只允许出现在已知白名单（W1 后 6 道，见下方 KCAL_ZERO_ALLOW）
 *   5. 已知形态回归表（W1 新增）：两钱/斤两/约重/约耗/括号净重等形态的锚定行 grams 必须等于
 *      首原理折算值——恒等式验不出输入错误（两钱 bug 时期 841 行 stored 全错仍 PASS），这是补丁
 *      （W6 后约耗行的入库 grams 仍是整锅值，约耗值在 consumedGrams 字段）
 *
 * 影响面统计（只打印，不影响退出码）：
 *   - 原文含「约耗」的菜数/条数（油量口径未单独解析的暴露面）
 *   - 湿淀粉折算条数、涉及碳水与 kcal 影响（对照 IMPORT_META.wetStarch）
 *   - 碳水 > 总重 50% 的菜数
 *
 * 旧数据（无 carbGrams）会在这里失败——这正是防「改了代码没重建」的闸门语义。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nutrition } from "../src/ingredients.ts";
import { isWetStarch, WET_STARCH_FACTOR, ediblePctOf, oilConsumedDeltaOf, OIL_ATTACHMENT } from "../src/enrich.mjs";
import { IMPORT_META, REF_OVERRIDES } from "../src/nutrition-ref.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.FOODBOT_DATA_DIR ? resolve(process.env.FOODBOT_DATA_DIR) : join(ROOT, "data");
const file = join(DATA, "recipes.processed.jsonl");
if (!existsSync(file)) {
  console.error(`找不到 ${file}（可用 FOODBOT_DATA_DIR 指向别处）`);
  process.exit(1);
}
const L = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// kcal=0 白名单：0.4 基线 11 道，ITERATION-0.5 W1（2026-10-29）修复其中 5 道：
//   北京-098/128/185、广东-202 走 work/repairs.json（原料节在 OCR 原文存在，串位/丢节头丢掉了），
//   上海-152 走 parse.ts 脚注守卫（原料表中间的「* …制法：」脚注不再打断原料节）。
// 剩 6 道为 OCR 文本层不可恢复（清单在版面插图内或整节未被识别），主料无任何计量，修了也是假营养：
const KCAL_ZERO_ALLOW = new Set([
  "上海-160", // 蜜枣扒山药：42.md「原 料」节头后直接是「制法」，清单未识别
  "浙江-117", // 蛋蓉蝤蛑：33.md 标题后仅存三条调味（精盐/味精/熟猪油），蝤蛑/鸡蛋/鸡汤主料全失
  "浙江-137", // 糟鸡：39.md 无原料节，主料越鸡全文无重量
  "山东-009", // 糟蒸肉：8.md「原 料」节头被做法正文顶掉，清单未识别
  "湖北-210", // 冰糖青豆泥：58.md 末行即标题、59.md 直入制法，清单在插图内
  "湖南-213", // 糖酥桃仁：64.md 标题后即制法，清单在插图内
  // 0.5 大众菜谱批次（merge-agent 2026-10-29）：全书克数直取，这 5 道主料行确实无可用计量——
  // 215/216 原料以「见 糖醋排骨(一)」引用（ingredientsRef 2 条，0.5.1 批次带证据门控补挂）；
  // 278/422 全书按条/块/汤匙计数且 CANON 无单重（不编数）；290 是解析行粘连（「包鱼头（花鲢头）700克·水发冬菇」
  // 700g 被吞进原料名），0.5.1 候补行级重切——修好前按白名单口径不参与营养断言
  "大众-215", // 糖醋排骨（二）：原料整节以引用指向（一），本轮 ingredientsRef 不入库
  "大众-216", // 糖醋排骨（三）：同上
  "大众-278", // 干煎带鱼：大带鱼 2 条（无单重），其余全 适量/少许
  "大众-290", // 酸辣鱼脑：原料行粘连，700克未落 grams（0.5.1 行级重切候补）
  "大众-422", // 砂锅豆腐：块/个/汤匙/碗 全计数单位，无可用单重
  // 0.5 国际菜谱批次（2026-10-31）：国际册「做法即配方」体例——半成品/接续工序在做法里描述
  // 引用料（「把腌好的猪排（527）…」），书里本就没有【用料】节；忠实原文，不为凑数编营养。
  // 005 辣根少司是唯一例外（有 1 行但全无计量）；1251 修波浪线引用号后已恢复计量。
  "国际-005", "国际-269", "国际-272", "国际-273", "国际-274", "国际-293", "国际-374", "国际-383",
  "国际-483", "国际-529", "国际-960", "国际-1043", "国际-1044", "国际-1045", "国际-1046",
  "国际-1139", "国际-1176", "国际-1237",
]);

// 已知形态回归表（ITERATION-0.5 W1 新增，门禁盲区补丁）：
// E1–E3 三份测评确认恒等式闸门验不出输入错误——两钱 bug 时期 841 行 stored 全错仍 PASS。
// 每行锚定「原文形态 → 必须克数」（市制十两制：斤500/两50/钱5/分0.5），按 id+amount 精确定位。
// 改锚定值必须附原文证据；改折算逻辑必须先过 tools/amounts-test.mjs。
const REGRESSION_TABLE = [
  // 两钱复合（E3：0.4 期汉字版 825/825 全错，两处病灶 parseAmount + toGrams）
  { id: "江苏-112", amount: "一两五钱", grams: 75,   form: "两钱" },  // 熟鸡皮片 50+25
  { id: "江苏-112", amount: "二两五钱", grams: 125,  form: "两钱" },  // 猪肥膘 100+25
  { id: "上海-182", amount: "二两五钱", grams: 125,  form: "两钱" },  // 熟猪坐臀肉
  { id: "上海-125", amount: "三两五钱", grams: 175,  form: "两钱" },  // 光嫩仔鸡 150+25
  { id: "江苏-109", amount: "一两二钱", grams: 60,   form: "两钱" },  // 熟鸡皮 50+10
  // 斤两复合（0.4 已对，防回退）
  { id: "江苏-112", amount: "一斤五两", grams: 750,  form: "斤两复合" }, // 水发海参/鸡清汤 500+250
  { id: "浙江-063", amount: "四斤五两", grams: 2250, form: "斤两复合·断裂" }, // 白糖：0.4 斤段吞进名称只剩 250
  { id: "上海-182", amount: "一斤六两", grams: 800,  form: "斤两复合·断裂" }, // 肉清汤：0.4 存 300
  // 约重括号（括号质量=真实重量）
  { id: "上海-002", amount: "一只（约重一斤半）", grams: 750, form: "约重" },
  { id: "上海-036", amount: "一条（约重一斤半）", grams: 750, form: "约重" },
  { id: "浙江-073", amount: "一条(约重一斤三两)", grams: 650, form: "约重·半角括号" }, // 0.4 抽取失败整道 kcal=16
  // 约耗括号（整锅质量入库，括号附着量不许顶掉；consumed 锚定约耗值——verify-w58 检查4 教训：
  // consumedMassGrams 曾把「两」当数字吞掉，256 道平均少计 583 kcal，恒等式拦不住，必须锚数值）
  { id: "江苏-187", amount: "一斤五两（约耗一两）", grams: 750, consumed: 50, form: "约耗" },  // 花生油
  { id: "上海-002", amount: "二斤（约耗二两）", grams: 1000, consumed: 100, form: "约耗" },    // 熟猪油
  { id: "上海-014", amount: "二斤（约耗一两五钱）", grams: 1000, consumed: 75, form: "约耗·两钱复合" }, // 桂花肉熟猪油
  // 括号净重（无「约重」字样，覆盖计数默认单重）
  { id: "湖南-063", amount: "一个（四斤）", grams: 2000, form: "括号净重" }, // 鲜鳙鱼头：0.4 存 1500
  { id: "北京-141", amount: "一只(约净重八两)", grams: 400,  form: "括号净重·半角" }, // 雏鸡：覆盖 lexicon 单重 1250
  { id: "江苏-131", amount: "一只（二斤）", grams: 1000, form: "括号净重" },  // 去毛嫩母鸡
];

const round1 = (x) => Math.round(x * 10) / 10;
const refRow = (x) => (Array.isArray(x) ? x : x?.v);

const bad = { kcalFormula: [], perServing: [], drift: [], sugarProtein: [], kcalZero: [], regression: [] };
let maxKcalDev = 0;

// 影响面统计
let yuehaoRecipes = new Set();
let yuehaoLines = 0;
let yuehaoGrams = 0;
let cgLines = 0;            // W6：consumedGrams 已字段化的原料行
const cgRecipes = new Set();
let cgGrams = 0;
let cgOffOil = 0;           // 其中非油脂行（0.5 只对油料入字段，应为 0）
let cgMissed = 0;           // 有约耗文本但没字段的油脂行（应为 0，出现即 parse 识别回退）
let wetLines = 0;
let wetRecipes = new Set();
let wetCarbFull = 0; // 湿淀粉条目按干淀粉口径的碳水（未折算）
let zeroProteinLines = 0; // 导入表里蛋白=0（纯糖类）的原料条目
const carbHeavy = [];

for (const r of L) {
  const n = r.nutrition ?? {};
  const label = `${r.id} ${r.title ?? ""}`;

  // ---- 不变量 1：kcal 恒等式 ----
  if (!["proteinGrams", "fatGrams", "carbGrams", "kcal"].every((k) => Number.isFinite(n[k]))) {
    bad.kcalFormula.push(`${label}: nutrition 缺数值列（v0.3 起应有 p/f/c/kcal）`);
  } else {
    const calc = 4 * n.proteinGrams + 4 * n.carbGrams + 9 * n.fatGrams;
    const dev = Math.abs(n.kcal - calc);
    if (dev > maxKcalDev) maxKcalDev = dev;
    if (dev > 1.2) bad.kcalFormula.push(`${label}: kcal=${n.kcal} ≠ 4p+4c+9f=${calc.toFixed(1)}（差 ${dev.toFixed(2)}）`);
  }

  // ---- 不变量 2：perServing 一致性 ----
  if (r.perServing && r.servingsBase && Number.isFinite(n.kcal)) {
    if (Math.abs(r.perServing.kcal - n.kcal / r.servingsBase) > 1) {
      bad.perServing.push(`${label}: perServing.kcal=${r.perServing.kcal} vs 整道 ${n.kcal}/${r.servingsBase}`);
    }
    if (Number.isFinite(n.proteinGrams) && Math.abs(r.perServing.proteinGrams - n.proteinGrams / r.servingsBase) > 0.2) {
      bad.perServing.push(`${label}: perServing 蛋白 ${r.perServing.proteinGrams} vs 整道 ${n.proteinGrams}/${r.servingsBase}`);
    }
  }

  // ---- 不变量 3：重算漂移 + 纯糖蛋白=0 ----
  // 用当前代码 + 当前导入表重算（含 W7a 可食部折算、湿淀粉 0.35 折算与 W6 约耗口径，与 enrich 同源）
  let p = 0, f = 0, c = 0, f_oil = 0, oilDelta = 0, sugarP = 0;
  for (const i of r.ingredients ?? []) {
    if (!i.canon) continue;
    const grams = i.grams ?? 0;
    const pct = ediblePctOf(i.canon);
    // 非油料「约耗」净口径（2026-10-31，与 enrich 同源）：介质类按实耗、主料固体按全量减损耗
    let baseG = grams;
    if (i.parent !== "油脂" && Number.isFinite(i.consumedGrams) && i.consumedGrams > 0) {
      const solidMain = ["猪肉", "牛肉", "羊肉", "禽肉", "水产", "蛋", "豆制品"].includes(i.parent);
      baseG = solidMain ? Math.max(0, grams - i.consumedGrams) : i.consumedGrams;
    }
    const v = nutrition({ id: i.canon, parent: i.parent }, pct === 100 ? baseG : (baseG * pct) / 100);
    const wet = isWetStarch(i);
    p += v.protein;
    f += v.fat;
    if (i.parent === "油脂") { f_oil += v.fat; oilDelta += oilConsumedDeltaOf(i); }
    c += wet ? v.carb * WET_STARCH_FACTOR : v.carb;
    if (wet) { wetLines++; wetRecipes.add(r.id); wetCarbFull += v.carb; }
    // 导入表逐条命中且蛋白=0 的（纯糖类：冰糖/白糖/…），蛋白贡献必须为 0
    const row = refRow(REF_OVERRIDES[i.canon]);
    if (row && (row[0] ?? 0) === 0 && grams > 0) { zeroProteinLines++; sugarP += v.protein; }
    if (/约耗|实耗|（耗|\(耗/.test(`${i.raw ?? ""}${i.name ?? ""}`)) {
      yuehaoRecipes.add(r.id);
      yuehaoLines++;
      yuehaoGrams += grams;
    }
    // W6 影响面：已字段化的约耗行（consumedGrams）与「有约耗文本但没字段」的漏网行分开数
    if (i.consumedGrams != null) { cgLines++; cgRecipes.add(r.id); cgGrams += i.consumedGrams; if (i.parent !== "油脂") cgOffOil++; }
    else if (i.parent === "油脂" && /约耗|实耗|（耗|\(耗/.test(`${i.raw ?? ""}${i.name ?? ""}`)) cgMissed++;
  }
  if (Number.isFinite(n.proteinGrams)) {
    const ep = round1(p), ef = round1(f - f_oil * 0.85 + oilDelta), ec = round1(c);
    if (Math.abs(n.proteinGrams - ep) > 0.5 || Math.abs(n.fatGrams - ef) > 0.5 || Math.abs(n.carbGrams - ec) > 0.5) {
      bad.drift.push(`${label}: 库值 p/f/c=${n.proteinGrams}/${n.fatGrams}/${n.carbGrams} ≠ 重算 ${ep}/${ef}/${ec}（数据与代码/表不同步）`);
    }
  }
  if (Math.abs(sugarP) > 1e-9) bad.sugarProtein.push(`${label}: 纯糖条目贡献蛋白 ${sugarP.toFixed(2)}g`);

  // ---- 不变量 4：kcal=0 白名单 ----
  if (n.kcal === 0 && !KCAL_ZERO_ALLOW.has(r.id)) {
    bad.kcalZero.push(`${label}: kcal=0 但不在白名单（新出现的零热量菜）`);
  }

  // ---- 统计：碳水 > 总重 50% ----
  if (Number.isFinite(n.carbGrams) && Number.isFinite(r.totalGrams) && r.totalGrams > 0 && n.carbGrams > r.totalGrams * 0.5) {
    carbHeavy.push(`${label}: 碳水 ${n.carbGrams}g / 总重 ${r.totalGrams}g`);
  }
}

const zeroList = L.filter((r) => r.nutrition?.kcal === 0).map((r) => `${r.id} ${r.title}`);

// ---- 不变量 5：已知形态回归表 ----
// 按锚定行核对（id + amount 精确定位）；错一条就是「输入侧」回退，恒等式拦不住的那种
const byId = new Map(L.map((r) => [r.id, r]));
for (const t of REGRESSION_TABLE) {
  const r = byId.get(t.id);
  if (!r) { bad.regression.push(`${t.id} ${t.amount}（${t.form}）: 回归样本菜不存在`); continue; }
  const rows = (r.ingredients ?? []).filter((i) => i.amount === t.amount);
  if (!rows.length) { bad.regression.push(`${t.id}「${t.amount}」（${t.form}）: 找不到该分量行——解析回退`); continue; }
  const gramsSet = [...new Set(rows.map((i) => i.grams))];
  if (gramsSet.length !== 1 || gramsSet[0] !== t.grams) {
    bad.regression.push(`${t.id}「${t.amount}」（${t.form}）: grams=${gramsSet.join("/")} 应 ${t.grams}`);
  }
  if (t.consumed != null) {
    const cs = [...new Set(rows.map((i) => i.consumedGrams))];
    if (cs.length !== 1 || cs[0] !== t.consumed) {
      bad.regression.push(`${t.id}「${t.amount}」（${t.form}）: consumedGrams=${cs.join("/")} 应 ${t.consumed}`);
    }
  }
}
const regForms = {};
for (const t of REGRESSION_TABLE) regForms[t.form] = (regForms[t.form] ?? 0) + 1;

const hardCount = Object.values(bad).reduce((s, a) => s + a.length, 0);
const firstBad = Object.values(bad).find((a) => a.length)?.[0];

console.log(`== nutrition-check（v0.3 营养不变量）==`);
console.log(`数据: ${file}（${L.length} 条）`);
console.log(`导入表: ${IMPORT_META.source ?? "?"}@${IMPORT_META.generatedAt ?? "?"}（matched ${IMPORT_META.matched}/${IMPORT_META.canonTotal}，crossCheck agree/disagree=${IMPORT_META.crossCheck?.agree}/${IMPORT_META.crossCheck?.disagree}）`);
if (IMPORT_META.source === "placeholder") console.log(`⚠ nutrition-ref 还是占位表：碳水值未导入，本工具此刻主要在验「数据是否已按新代码重建」。`);
console.log(`[1] kcal 恒等式 |kcal−(4p+4c+9f)|≤1.2：${L.length - bad.kcalFormula.length}/${L.length} 通过，实测最大偏差 ${maxKcalDev.toFixed(2)}`);
console.log(`[2] perServing 一致性（差≤1/0.2）：${bad.perServing.length ? bad.perServing.length + " 条违规" : "全部通过"}`);
console.log(`[3] 重算漂移 + 纯糖蛋白=0：${bad.drift.length || bad.sugarProtein.length ? `${bad.drift.length} 漂移 / ${bad.sugarProtein.length} 糖蛋白` : "全部通过"}（纯糖条目 ${zeroProteinLines} 条）`);
console.log(`[4] kcal=0 白名单：现有 ${zeroList.length} 道 → ${zeroList.join("、") || "无"}${zeroList.length <= KCAL_ZERO_ALLOW.size ? "" : `（白名单外 ${zeroList.length - KCAL_ZERO_ALLOW.size} 道）`}`);
console.log(`[5] 已知形态回归表：${REGRESSION_TABLE.length} 行 / ${new Set(REGRESSION_TABLE.map((t) => t.id)).size} 道（形态：${Object.entries(regForms).map(([k, v]) => k + "×" + v).join("、")}）${bad.regression.length ? " — " + bad.regression.length + " 行回退" : " 全部锚定"}`);
console.log(`—— 影响面统计（不判退出码）——`);
console.log(`「约耗」：${yuehaoRecipes.size} 道 / ${yuehaoLines} 条，涉及原料量 ${Math.round(yuehaoGrams)}g；W6 已字段化 consumedGrams ${cgLines} 条 / ${cgRecipes.size} 道（约耗合计 ${Math.round(cgGrams)}g，非油料 ${cgOffOil} 条，漏识别 ${cgMissed} 条）；油脂净口径：无约耗 ×${OIL_ATTACHMENT} 附着、有约耗全额`);
console.log(`湿淀粉折算（×${WET_STARCH_FACTOR}）：${wetLines} 条 / ${wetRecipes.size} 道，涉及碳水（干淀粉口径）${wetCarbFull.toFixed(1)}g → 折算后少计 ${Math.round(4 * wetCarbFull * (1 - WET_STARCH_FACTOR))} kcal；IMPORT_META.wetStarch: entries=${IMPORT_META.wetStarch?.entries} estKcalImpact=${IMPORT_META.wetStarch?.estKcalImpact}`);
console.log(`碳水 > 总重 50%：${carbHeavy.length} 道${carbHeavy.length ? `，如 ${carbHeavy.slice(0, 3).join("；")}` : ""}`);

if (hardCount) {
  console.log(`\nFAIL：硬不变量违规 ${hardCount} 条，首条：${firstBad}`);
  const all = [...bad.kcalFormula, ...bad.perServing, ...bad.drift, ...bad.sugarProtein, ...bad.kcalZero, ...bad.regression];
  console.log(all.slice(0, 15).map((x) => `  - ${x}`).join("\n") + (all.length > 15 ? `\n  … 共 ${all.length} 条` : ""));
  process.exitCode = 1;
} else {
  console.log(`\nPASS：${L.length} 条全部通过硬不变量。`);
}
