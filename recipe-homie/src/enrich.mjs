/**
 * 在解析结果上加派生层：营养、份量、技法难度、过敏原、主料。
 * 全部是"可以重算"的字段 —— 原文永远在 raw / steps 里。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nutrition } from "./ingredients.ts";
import { REF_OVERRIDES } from "./nutrition-ref.ts";

/** W9lite 名菜 tier/minutes 人工标注（id → {tier, minutes, why}），缺文件时为空表。 */
const TIER_OVERRIDES = (() => {
  const stripBom = (s) => s.replace(/^﻿/, "");
  try {
    const raw = JSON.parse(stripBom(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "work", "tier-overrides.json"), "utf8")));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
})();

/** 每人每餐大约吃多少克（用来把老菜谱的份量折算成人数） */
const PER_PERSON = {
  猪肉: 150, 牛肉: 150, 羊肉: 150, 禽肉: 200, 水产: 200, 蛋: 60,
  豆制品: 120, 蔬菜: 150, 菌菇: 100, 谷物: 100, 其他: 150, 干货: 80,
};

// 用户视角的难度：蒸煮炒煎焖焗烤箱空气炸锅算"能上手"；炸麻烦；其余要学
const HARD = ["油炸", "软炸", "干炸", "脆炸", "酥炸", "炸", "拔丝", "挂霜", "熏", "烤鸭", "烧鹅", "蜜汁火方"];
const LEARN = ["干烧", "红烧", "烧", "爆", "熘", "烩", "扣", "瓤", "酿", "贴", "塌", "酥", "冻", "醉", "糟", "炝", "烹"];

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * 湿淀粉折算系数（ITERATION-0.3 §1 裁决 3）：老菜谱的「湿淀粉/水淀粉 X 两」入库克数
 * 按干淀粉计（canon=淀粉），但湿淀粉的干物质只占 1/3 左右（干淀粉:水 ≈ 1:1.5~2，取中值 0.35）。
 * 只有该条的碳水乘此系数；蛋白/脂肪不动。raw/name 都判定不了的保持干淀粉口径，
 * 影响面由 tools/nutrition-check.mjs 对照 IMPORT_META.wetStarch 输出。
 */
export const WET_STARCH_FACTOR = 0.35;
/** 一条原料是否「湿淀粉/水淀粉」（raw 或 name 命中即算；2026-10 全库命中 1423 条，raw 命中 1422） */
export const isWetStarch = (i) => /湿淀粉|水淀粉/.test(`${i.raw ?? ""}${i.name ?? ""}`);

/**
 * W7a 可食部（ITERATION-0.5 W7）：成分表数值是每 100g **可食部**，而库内克数常是整只/带骨毛重
 * （光鸡 1250g、鳙鱼头 1500g）——不折可食部就系统性高估带骨菜。REF_OVERRIDES[canon].edible
 * 是导入表按 foodCode 回填的百分数，缺（ambiguous/兜底条目、油脂调味类）一律按 100。
 * 只用于营养累计：配料行 grams、份量、主料排序、采购口径一律不动（原文克数不改）。
 */
export function ediblePctOf(canon) {
  const e = REF_OVERRIDES[canon]?.edible;
  return Number.isFinite(e) && e > 0 && e <= 100 ? e : 100;
}

/**
 * W6 约耗（ITERATION-0.5 W6）：原料行括号「约耗X／实耗X」由 parse.ts 记进 consumedGrams。
 * 脂肪口径保持与 v0.2/v0.3 同一表达式「全额脂肪 − 油脂整锅 ×0.85」，约耗行只加一项差额：
 *   oilConsumedDeltaOf(i) = 约耗值全额脂肪 − 该行整锅脂肪 ×15%
 * 这样无约耗的记录逐位等于旧值（不动历史数字），有约耗的记录从「整锅 ×15%」改成「约耗值全额」。
 * 油脂类可食部恒为 100，此项不受 W7a 影响（可食部折算仍保留在表达式里，口径统一）。
 */
export const OIL_ATTACHMENT = 0.15;
export function oilConsumedDeltaOf(i) {
  if (i.parent !== "油脂") return 0;
  const consumed = Number.isFinite(i.consumedGrams) && i.consumedGrams > 0 ? i.consumedGrams : null;
  if (consumed == null) return 0;
  const entry = { id: i.canon, parent: i.parent };
  const edible = ediblePctOf(i.canon) / 100;
  const potFat = nutrition(entry, (i.grams ?? 0) * edible).fat;
  return nutrition(entry, consumed * edible).fat - potFat * OIL_ATTACHMENT;
}

export function skillTierOf(recipe) {
  const hay = `${recipe.title} ${(recipe.steps ?? []).join(" ")}`;
  const fryHits = (hay.match(/炸/g) ?? []).length;
  if (HARD.some((w) => recipe.title.includes(w)) || fryHits >= 2) {
    return { tier: "hard", why: "需要起油锅（炸），火候和油温不好控" };
  }
  const learn = LEARN.filter((w) => recipe.title.includes(w) || (w.length > 1 && hay.includes(w)));
  if (learn.length) {
    return { tier: "learn", why: `涉及${[...new Set(learn)].slice(0, 3).join("、")}，要练几次才稳` };
  }
  const easy = ["蒸", "煮", "炒", "煎", "焖", "焗", "烤", "拌", "汆", "涮", "卤", "酱", "炖"].filter((w) => hay.includes(w));
  return { tier: "easy", why: easy.length ? `主要靠${[...new Set(easy)].slice(0, 3).join("、")}` : "步骤简单" };
}

export function enrichRecipe(recipe) {
  const ings = (recipe.ingredients ?? []).filter((i) => i.canon);
  let protein = 0;
  let fat = 0;
  let carb = 0;
  let fatFromOil = 0;        // 油脂行整锅口径脂肪（参与 ×0.85 扣除）
  let oilConsumedDelta = 0;  // W6：约耗行「按约耗值」相对「整锅×15%」的差额
  let salt = 0;
  let oil = 0;
  const allergens = new Set();
  const perParent = new Map();
  const edible = [];

  for (const i of ings) {
    const grams = i.grams ?? 0;
    // W7a：营养累计按可食部折算；grams 本身（配料原文克数）与采购口径不动
    const pct = ediblePctOf(i.canon);
    let effGrams = pct === 100 ? grams : (grams * pct) / 100;
    // 非油料「约耗」（2026-10-31 收尾，原 0.5.1 债）：介质类（腌渍取出/滚沾/炸介质——酱油、
    // 糯米粉、芝麻、白油）营养按实耗计，剩的进了下水道；主料固体（炸制缩水）按全量减损耗。
    // 油脂行不在这里动——沿用 W6 的 oilConsumedDelta 差额口径，保证老值逐位不变。
    if (i.parent !== "油脂" && Number.isFinite(i.consumedGrams) && i.consumedGrams > 0) {
      const solidMain = ["猪肉", "牛肉", "羊肉", "禽肉", "水产", "蛋", "豆制品"].includes(i.parent);
      const base = solidMain ? Math.max(0, grams - i.consumedGrams) : i.consumedGrams;
      effGrams = pct === 100 ? base : (base * pct) / 100;
    }
    const n = nutrition({ id: i.canon, parent: i.parent }, effGrams);
    protein += n.protein;
    fat += n.fat;
    // 湿淀粉/水淀粉可判定时，该条碳水按干物质占比折算，防止按干淀粉计系统性高估
    carb += isWetStarch(i) ? n.carb * WET_STARCH_FACTOR : n.carb;
    if (i.parent === "油脂") {
      oil += grams;
      fatFromOil += n.fat;                 // 整锅口径（与旧表达式同一累加，保证非约耗行逐位不变）
      oilConsumedDelta += oilConsumedDeltaOf(i);   // W6：约耗行改成按约耗值全额的差额
    }
    if (i.canon === "盐") salt += grams;
    for (const a of i.allergen ?? []) allergens.add(a);
    if (grams > 0) {
      perParent.set(i.parent, (perParent.get(i.parent) ?? 0) + grams);
      if (!["调味", "油脂", "汤底"].includes(i.parent)) edible.push({ canon: i.canon, parent: i.parent, grams });
    }
  }

  // 份量：按各食材类别「够几个人」取最大值
  let servings = 0;
  for (const [parent, grams] of perParent) {
    const per = PER_PERSON[parent];
    if (per) servings = Math.max(servings, grams / per);
  }
  servings = servings ? clamp(Math.round(servings), 2, 8) : 4;
  // 源头声明的份量基准优先（国际菜谱全书十份制，2026-10-31）：西餐原料构成走不进
  // PER_PERSON 的每人家常启发式，估出来的份数会把馆子菜错放进家常池（servingsBase≤8 守卫失守）。
  if (Number.isFinite(recipe.servingsBase) && recipe.servingsBase >= 2) servings = recipe.servingsBase;

  const PROTEIN_PARENTS = new Set(["猪肉", "牛肉", "羊肉", "禽肉", "水产", "蛋"]);
  const proteinFoodGrams = [...perParent.entries()]
    .filter(([p]) => PROTEIN_PARENTS.has(p) || p === "豆制品")
    .reduce((s, [, g]) => s + g, 0);
  // 葱姜蒜辣椒这类是调味蔬菜，不能把一道荤菜算成"素菜"
  const SEASONING_VEG = new Set(["葱", "姜", "大蒜", "蒜苗", "香菜", "辣椒", "青椒", "洋葱", "紫苏叶", "荷叶", "葱姜料"]);
  const vegGrams = [...perParent.entries()]
    .filter(([p]) => p === "蔬菜" || p === "菌菇")
    .reduce((s, [, g]) => s + g, 0);
  const vegRealGrams = edible
    .filter((e) => ["蔬菜", "菌菇"].includes(e.parent) && !SEASONING_VEG.has(e.canon))
    .reduce((s, e) => s + e.grams, 0);

  // 先定入库的三位宏量（各 1 位小数）。脂肪仍按旧口径「全额 − 油脂整锅×0.85」（无约耗的记录逐位
  // 等于 v0.5 前的值），约耗行经 oilConsumedDelta 从「整锅×15%」改为「约耗值全额」。
  const proteinGrams = Math.round(protein * 10) / 10;
  const fatGrams = Math.round((fat - fatFromOil * 0.85 + oilConsumedDelta) * 10) / 10;
  const carbGrams = Math.round(carb * 10) / 10;
  // 热量 = 4·蛋白 + 4·碳水 + 9·脂肪（v0.3 起碳水计入，数学上 = 旧 kcal + 4·碳水）。
  // 炸用油整锅计进热量会得出"一人一餐 5000kcal"这种荒唐数，仍按 15% 附着量算（口径不动）。
  // kcal 用上面已舍入的入库宏量重算：若用未舍入累加值，三字段舍入 + kcal 取整的偏差上限是
  // 1.35 kcal，会随机戳穿「|kcal − (4p+4c+9f)| ≤ 1.2」的不变量（沙箱实测 max 1.3）；
  // 从入库值出发则恒 ≤ 0.5。对结果的影响 ≤1.4 kcal，远小于任何验收容差。
  const kcal = Math.round(proteinGrams * 4 + carbGrams * 4 + fatGrams * 9);
  const main = edible.sort((a, b) => b.grams - a.grams).slice(0, 6);
  const veg = edible.filter((e) => ["蔬菜", "菌菇"].includes(e.parent) && !SEASONING_VEG.has(e.canon)).map((e) => e.canon);
  const skill = skillTierOf(recipe);
  // W9lite 名菜 tier/minutes 人工标注（data/work/tier-overrides.json，只收有把握的名菜）：
  // 覆盖后保留 derivedTier 留档；minutes 是给运行时层（care.estimateMinutes 读表）的口径数据，
  // 词表启发式读不出「吊清汤四小时」这种功夫，标注值优先于估算。
  const tierOv = TIER_OVERRIDES[recipe.id];
  const minutesOv = Number.isFinite(tierOv?.minutes) && tierOv.minutes > 0 ? tierOv.minutes : null;
  const skillFinal = tierOv?.tier && tierOv.tier !== skill.tier
    ? { tier: tierOv.tier, why: tierOv.why ?? skill.why, derivedTier: skill.tier }
    : skill;
  // 老菜谱里夹着餐馆批量配方（如「无锡排骨」要一百斤排骨），家常菜单不能用
  const totalGrams = [...perParent.values()].reduce((s, g) => s + g, 0);
  const bulk = totalGrams > 5000 || [...perParent.values()].some((g) => g > 4000);

  return {
    ...recipe,
    nutrition: {
      proteinGrams,
      fatGrams,
      carbGrams,
      kcal,
      saltGrams: Math.round(salt * 10) / 10,
      oilGrams: Math.round(oil * 10) / 10,
    },
    proteinFoodGrams: Math.round(proteinFoodGrams),
    vegGrams: Math.round(vegRealGrams || vegGrams),
    totalGrams: Math.round([...perParent.values()].reduce((s, g) => s + g, 0)),
    servingsBase: servings,
    bulk,
    perServing: {
      proteinGrams: Math.round((protein / servings) * 10) / 10,
      carbGrams: Math.round((carb / servings) * 10) / 10,
      kcal: Math.round(kcal / servings),
    },
    allergens: [...allergens],
    mainCanon: main.map((m) => m.canon),
    proteinCanon: main.filter((m) => ["猪肉", "牛肉", "羊肉", "禽肉", "水产", "蛋", "豆制品"].includes(m.parent)).map((m) => m.canon),
    vegCanon: [...new Set(veg)],
    skill: skillFinal,
    ...(tierOv?.why ? { skillNote: tierOv.why } : {}),
    ...(minutesOv != null ? { minutes: minutesOv } : {}),
    blurb: bulk
      ? `批量配方（${Math.round(totalGrams / 1000)}kg 总量，餐馆份量）`
      : recipe.suspectTitle
        ? `⚠ 同册同名，疑标题串行 · ${servings}人份`
        : `${servings}人份 · 蛋白${Math.round(protein / servings)}g/人 · ${skillFinal.tier === "easy" ? "好上手" : skillFinal.tier === "learn" ? "要练" : "费工"}`,
  };
}
