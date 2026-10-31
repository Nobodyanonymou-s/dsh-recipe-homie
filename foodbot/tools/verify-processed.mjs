/**
 * 验收器：对 data/recipes.processed.jsonl 做不变量检查。
 * 子智能体交回的任何产物，合进来之后都要过这一关。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.FOODBOT_DATA_DIR ? resolve(process.env.FOODBOT_DATA_DIR) : join(ROOT, "data");
const file = existsSync(join(DATA, "recipes.processed.jsonl")) ? join(DATA, "recipes.processed.jsonl") : join(DATA, "recipes.jsonl");
const L = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

const problems = [];
const warn = [];
const push = (kind, id, msg) => (kind === "err" ? problems : warn).push(`${id}: ${msg}`);

const ids = new Set();
for (const r of L) {
  if (!r.id) { problems.push("记录缺 id"); continue; }
  if (ids.has(r.id)) problems.push(`重复 id ${r.id}`);
  ids.add(r.id);
  if (!r.title || !String(r.title).trim()) push("err", r.id, "缺菜名");
  if (!r.book) push("err", r.id, "缺书名");
  if (!Array.isArray(r.pages) || !r.pages.length) push("err", r.id, "缺 pages（不可回溯）");

  const ings = r.ingredients ?? [];
  if (!ings.length) push("warn", r.id, "无用料");
  for (const i of ings) {
    if (!i.canon) push("err", r.id, `原料「${i.name}」没有 canon`);
    if (i.grams != null && (typeof i.grams !== "number" || !Number.isFinite(i.grams) || i.grams < 0)) push("err", r.id, `原料「${i.name}」克数非法：${i.grams}`);
    if (i.grams > 20000) push("warn", r.id, `原料「${i.name}」克数异常：${i.grams}g`);
    for (const a of i.allergen ?? []) if (!(r.allergens ?? []).includes(a)) push("err", r.id, `过敏原 ${a} 没汇总到食谱级`);
  }
  if (!(r.steps ?? []).length) push("warn", r.id, "无做法");
  if (!r.skill?.tier) push("warn", r.id, "缺难度");
  if (r.servingsBase && (r.servingsBase < 1 || r.servingsBase > 12)) push("warn", r.id, `份量异常 ${r.servingsBase}`);

  // v0.3 营养不变量（ITERATION-0.3 §4）：kcal 恒等式 + perServing 一致性。
  // 旧数据（无 carbGrams）会在这里报错——这是有意的闸门：防「代码改了、数据没重建」。
  const n = r.nutrition ?? {};
  const cols = ["proteinGrams", "fatGrams", "carbGrams", "kcal"];
  if (!cols.every((k) => Number.isFinite(n[k]))) {
    push("err", r.id, `nutrition 缺数值列（v0.3 起应有 p/f/c/kcal）：${JSON.stringify(n)}`);
  } else {
    const calc = 4 * n.proteinGrams + 4 * n.carbGrams + 9 * n.fatGrams;
    if (Math.abs(n.kcal - calc) > 1.2) push("err", r.id, `kcal=${n.kcal} 与 4p+4c+9f=${calc.toFixed(1)} 不一致`);
  }
  if (r.perServing && r.servingsBase && Number.isFinite(n.kcal) && Number.isFinite(n.proteinGrams)) {
    if (Math.abs(r.perServing.kcal - n.kcal / r.servingsBase) > 1) push("err", r.id, `perServing.kcal=${r.perServing.kcal} 与整道 ${n.kcal}/${r.servingsBase} 不符`);
    if (Math.abs(r.perServing.proteinGrams - n.proteinGrams / r.servingsBase) > 0.2) push("err", r.id, `perServing 蛋白 ${r.perServing.proteinGrams} 与整道 ${n.proteinGrams}/${r.servingsBase} 不符`);
  }

  if ((r.variants ?? []).some((v) => v.verdict === "same_dish")) {
    for (const v of r.variants.filter((x) => x.verdict === "same_dish")) {
      for (const other of v.others) {
        const o = L.find((x) => x.id === other);
        if (!o) push("err", r.id, `变体指向不存在的 ${other}`);
        else if (!(o.variants ?? []).some((y) => y.others.includes(r.id))) push("err", r.id, `变体关系不对称：${other}`);
      }
    }
  }
}

// ── W2/W3 手术断言（structure-agent 2026-10-29；违反 = err，与既有不变量同级别） ──
// W3 章节：统一枚举 + 证据门控重挂的锚点
const CHAPTER_ENUM = new Set(["肉菜类", "水产菜类", "禽蛋菜类", "素菜类", "甜菜类", "其他菜类", "野味菜类", "山珍海味类"]);
for (const r of L) {
  if (r.chapter && !CHAPTER_ENUM.has(r.chapter)) push("err", r.id, `chapter 不在统一枚举内：${r.chapter}（chapterRaw=${r.chapterRaw ?? "无"}）`);
}
const byId2 = new Map(L.map((r) => [r.id, r]));
const expectChapter = [
  ["安徽-096", "禽蛋菜类"], ["安徽-146", "禽蛋菜类"], ["山东-169", "素菜类"], ["山东-181", "素菜类"], ["山东-196", "素菜类"],
  ["南北-040", "禽蛋菜类"], ["南北-123", "水产菜类"], ["南北-168", "山珍海味类"], ["南北-680", "甜菜类"],
];
for (const [id, ch] of expectChapter) {
  const r = byId2.get(id);
  if (!r) push("err", id, "W3 锚点记录缺失");
  else if (r.chapter !== ch) push("err", id, `W3 章节锚点不符：${r.chapter} ≠ ${ch}`);
}
// 安徽禽蛋块（096..146）不得再有水产菜类混入
for (let n = 96; n <= 146; n++) {
  const r = byId2.get(`安徽-${String(n).padStart(3, "0")}`);
  if (r && r.chapter === "水产菜类") push("err", r.id, `禽蛋块残留水产菜类：${r.title}`);
}
// W3.5 drop：串行鬼record 不得回流
for (const id of ["北京-128", "北京-185"]) if (byId2.has(id)) push("err", id, "已处置的串行鬼record仍在库");
// W2 蒜 canon 归一：E3#3 名单里的 21 个 guessed 名不得再当 canon
const GARLIC_GHOST = new Set(["大头蒜瓣","蒜各","蒜籽","姜末和蒜米各","嫩蒜心","炸蒜子肉","蒜米各","大蒜各","葱姜蒜末共","姜蒜末","蒜末共","蒜片各","蒜末各","葱姜蒜共","葱姜蒜米","蒜盐","蒜泥水","独蒜","熟蒜泥肠","宵蒜苗段","青蒜凿段"]);
for (const r of L) for (const i of r.ingredients ?? []) {
  if (GARLIC_GHOST.has(i.canon)) push("err", r.id, `蒜 canon 未归一：${i.canon}`);
}
// W2 过敏原：数据层拦截锚点（不再依赖 profile 标题防御）
const expectAllergen = [
  ["上海-069", "甲壳类"], ["上海-088", "甲壳类"], ["北京-104", "甲壳类"],
  ["北京-101", "甲壳类"], ["江苏-091", "甲壳类"], ["上海-093", "甲壳类"],
  ["北京-038", "甲壳类"], ["山东-178", "甲壳类"],
];
for (const [id, a] of expectAllergen) {
  const r = byId2.get(id);
  if (!r) push("err", id, "W2 过敏原锚点记录缺失");
  else if (!(r.allergens ?? []).includes(a)) push("err", id, `W2 过敏原缺标：${a}（allergens=${JSON.stringify(r.allergens)}）`);
}
// W2 P1 宏量复真锚点
const g008 = byId2.get("广东-008");
if (g008) {
  const row = (g008.ingredients ?? []).find((i) => i.name === "猪前脚");
  if (!row || row.canon !== "猪蹄" || row.grams !== 750) push("err", "广东-008", `P1 猪前脚应归猪蹄 750g，实测 canon=${row?.canon} grams=${row?.grams}`);
  if ((g008.nutrition?.carbGrams ?? 0) > 30) push("err", "广东-008", `P1 后碳水仍异常：${g008.nutrition.carbGrams}g`);
}
const g058 = byId2.get("广东-058");
if (g058) {
  const row = (g058.ingredients ?? []).find((i) => /鲈麻/.test(i.name));
  if (!row || row.canon !== "鲈鱼") push("err", "广东-058", `P1 宰净鲈麻应归鲈鱼，实测 canon=${row?.canon}`);
  if (!(g058.allergens ?? []).includes("鱼类")) push("err", "广东-058", "P1 后应带鱼类过敏原");
}
// W2 P3 外层小数锚点
const n342 = byId2.get("南北-342");
if (n342) {
  const row = (n342.ingredients ?? []).find((i) => i.name === "精盐");
  if (!row || row.grams !== 7.5) push("err", "南北-342", `P3 精盐 1.5钱 应 7.5g，实测 ${row?.grams}`);
}

// ── 大众菜谱合并断言（merge-agent 2026-10-29；0.5 语料批次，2875+456=3331） ──
// 0.5 合并口径：cuisine 第 12 值「大众」；region（28 城）只进数据层，plugin 冻结不展示（0.5.1 文案债）；
// 章节 B 案：凉菜/汤按主料拆（无克数荤主料的按素菜处理，如 大众-436 干贻贝 grams=null → 素菜类）
if (L.length !== 3331) push("err", "-", `总数应为 2875(老库)+456(大众)=3331，实测 ${L.length}`);
const dz = L.filter((r) => r.cuisine === "大众");
if (dz.length !== 456) push("err", "-", `大众册应 456 道，实测 ${dz.length}`);
if (dz.some((r) => !r.region)) push("err", "-", "大众册存在缺 region 的记录");
if (new Set(dz.map((r) => r.region)).size < 28) push("err", "-", "大众册 region 城市数应 ≥28");
const expectDzChapter = [
  ["大众-001", "素菜类", "蔬菜直挂"],
  ["大众-336", "素菜类", "凉菜按主料拆（香干拌马兰头，无荤主料）"],
  ["大众-334", "肉菜类", "凉菜按主料拆（酱牛肉）"],
  ["大众-391", "水产菜类", "汤菜按主料拆（开洋冬瓜汤，虾米 15g）"],
  ["大众-436", "素菜类", "汤菜按主料拆（贻贝无克数，主料冬瓜 1000g）"],
  ["大众-209", "肉菜类", "肉类直挂（把子肉）"],
  ["大众-453", "其他菜类", "附录主食（烧饼）"],
];
for (const [id, ch, why] of expectDzChapter) {
  const r = byId2.get(id);
  if (!r) push("err", id, "大众锚点记录缺失");
  else if (r.chapter !== ch) push("err", id, `大众章节锚点不符：${r.chapter} ≠ ${ch}（${why}）`);
}
if (dz.some((r) => !r.chapterRaw)) push("err", "-", "大众册存在缺 chapterRaw 的记录（B 案要求原文留档）");
// bulk 实锤恰 4 道：把子肉（硬骨肉 5000g）+ 烧饼/糖火烧/酥火烧（面粉 4~5kg），多一道少一道都报
const dzBulk = dz.filter((r) => r.bulk).map((r) => r.id).sort();
const wantBulk = ["大众-209", "大众-451", "大众-452", "大众-453"];
if (JSON.stringify(dzBulk) !== JSON.stringify(wantBulk)) push("err", "-", `大众 bulk 应恰为 ${wantBulk.join(",")}，实测 ${dzBulk.join(",") || "无"}`);
// 词表归一后的过敏原：开洋=虾米、卤虾油=虾制品 → 甲壳类；干贻贝 → 贝类
const expectDzAllergen = [["大众-001", "甲壳类"], ["大众-002", "甲壳类"], ["大众-436", "贝类"]];
for (const [id, a] of expectDzAllergen) {
  const r = byId2.get(id);
  if (!r) push("err", id, "大众过敏原锚点记录缺失");
  else if (!(r.allergens ?? []).includes(a)) push("err", id, `大众过敏原缺标：${a}（allergens=${JSON.stringify(r.allergens)}）`);
}
// 大众记录不得携带本轮缓办的 hints 产物（0.5.1 批次再进，带证据门控）
for (const r of dz) {
  if (r.variantHints?.length) push("err", r.id, "variantHints 不应入库（0.5.1 批次）");
  if (r.ingredientsRef) push("err", r.id, "ingredientsRef 不应入库（0.5.1 批次）");
}

const stats = {
  file,
  total: L.length,
  withIngredients: L.filter((r) => r.ingredients?.length).length,
  withSteps: L.filter((r) => r.steps?.length).length,
  ingredients: L.reduce((s, r) => s + (r.ingredients?.length ?? 0), 0),
  guessed: L.reduce((s, r) => s + (r.ingredients ?? []).filter((i) => i.guessed).length, 0),
  hasVariants: L.filter((r) => r.variants?.length).length,
  books: [...new Set(L.map((r) => r.book))].length,
  cuisines: [...new Set(L.map((r) => r.cuisine))].length,
};

console.log(JSON.stringify({ stats, errors: problems.length, warnings: warn.length }, null, 2));
if (problems.length) console.log("\n错误（必须修）：\n" + problems.slice(0, 25).join("\n"));
if (warn.length) console.log("\n警告（可接受）：\n" + warn.slice(0, 15).join("\n"));
process.exitCode = problems.length ? 1 : 0;
