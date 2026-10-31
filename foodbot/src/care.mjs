/**
 * 「照顾」这件事的具体规则：时间预算、给孩子/孕期的分餐提示、太累时的退路。
 *
 * 这里的每一条都必须是**能执行的**，不是安慰话：
 *   - 时间预算要能过滤菜谱，不能只是说"今天简单点"
 *   - 分餐提示要指向具体动作（先盛出来再放辣椒）
 *   - 太累时要有真的退路（剩菜/面/蛋），而不是继续推四菜一汤
 */
import { seqNumber } from "./parse.mjs";

/** 从原文里读时间：优先取文中出现的最长时长（炖/焖/蒸），再加步骤的操作时间。 */
export function estimateMinutes(recipe) {
  // 人工标注过的功夫菜（data/work/tier-overrides.json）直接信标注，别被文本启发式覆盖
  if (Number.isFinite(recipe.minutes)) return recipe.minutes;
  const text = `${recipe.title ?? ""} ${(recipe.steps ?? []).join(" ")}`;
  let longest = 0;
  for (const m of text.matchAll(/([0-9零〇一二三四五六七八九十百两半]+)\s*(小时|钟头|分钟)/g)) {
    const tok = m[1];
    const n = tok === "半" ? 0.5 : /^\d+$/.test(tok) ? Number(tok) : seqNumber(tok);
    if (!Number.isFinite(n) || n <= 0) continue;
    const minutes = m[2] === "分钟" ? n : n * 60;
    if (minutes > longest && minutes <= 600) longest = minutes;
  }
  const steps = (recipe.steps ?? []).length;
  const oil = /炸/.test(recipe.title ?? "") ? 10 : 0;
  const total = 10 + steps * 5 + oil + longest;
  return Math.min(240, Math.round(total / 5) * 5);
}

/**
 * W5：预制/半成品原料。raw 或 name 以这些前缀开头的料，市面买到的就是成品
 * （熟火腿、水发海参、腊肉、风干牛肉、烤鸭）——采购时别当生料回去自己发/自己腌。
 * care.mjs 的重预制判定和 planner.buildShopping 的「买现成的」备注共用这一份，不再各写一套。
 */
export const PREPARED_RE = /^(熟|水发|腌|风干|腊|预制|烤(鸡|鸭))/;

/** 单条原料是否预制/半成品（看 raw 和 name 两处，OCR 常把修饰词留在 raw 里） */
export function isPreparedIngredient(ing) {
  return PREPARED_RE.test(ing?.raw ?? "") || PREPARED_RE.test(ing?.name ?? "");
}

/**
 * 预制依赖启发式（0.4.1 裁决 7，E1 Q7/S3 的检索侧缓解；数据层标志在 0.5 W5）：
 * 用料命中 isPreparedIngredient，或原料节是空的 → 视作重预制依赖，应急时降权
 * （熟火腿当生肉买、要自己发两天海参的菜，不该是「太累了」的答案）。
 */
export function heavyPrepDependency(recipe) {
  const ings = recipe.ingredients ?? [];
  if (!ings.length) return true;
  return ings.some(isPreparedIngredient);
}

/**
 * 太累/太晚时的退路候选（0.4.1 裁决 7）：可快出（≤30 分钟）+ 顶得上饭（蛋白 ≥20g）+ 少预制依赖。
 * 传原始菜谱会挑出忌口菜，所以只接受 planner.scored 这种带 minutes 的条目。
 */
export function rescueCandidates(items, people, limit = 3) {
  return (items ?? [])
    .filter((x) => x.r?.skill?.tier === "easy" && !x.r.bulk && !x.r.suspectTitle
      && x.minutes <= 30 && !/甜菜/.test(x.r.chapter ?? "")
      && (x.r.perServing?.proteinGrams ?? 0) >= 20)
    .sort((a, b) => (heavyPrepDependency(a.r) ? 1 : 0) - (heavyPrepDependency(b.r) ? 1 : 0)
      || a.minutes - b.minutes
      || Math.abs(a.r.servingsBase - people) - Math.abs(b.r.servingsBase - people))
    .slice(0, limit);
}

/** cook_rescue 的输出（字符串行，render/卡片直接用）。 */
export function easyWayOut(items, people, limit = 3) {
  const picks = rescueCandidates(items, people, limit)
    .map((x) => `${x.r.title}（约${x.minutes}分钟，${x.r.servingsBase}人份）`);
  return {
    dishes: picks,
    fallback: "或者干脆不做：煮碗面卧个蛋、剩菜热一下、楼下买点。今天不做饭不是失败。",
  };
}

/** 一桌人里有人不能吃辣/不能吃酒/要低盐时的具体动作 */
export function tableNotes(recipe, profile) {
  const notes = [];
  const hasChili = (recipe.ingredients ?? []).some((i) => ["辣椒", "干辣椒", "辣椒粉", "辣椒油", "豆瓣酱"].includes(i.canon));
  const hasAlcohol = (recipe.ingredients ?? []).some((i) => ["绍酒", "白酒", "香糟", "酒酿"].includes(i.canon));
  const kids = profile.household?.children ?? 0;
  const active = (profile.periods ?? []).filter((p) => p.preset === "pregnancy" || p.preset === "low_salt").map((p) => p.preset);

  if (kids > 0 && hasChili) notes.push("孩子那份先盛出来，再放辣椒");
  if (kids > 0 && (recipe.servingsBase ?? 2) >= 4) notes.push("份量够两顿，明天可以带饭");
  if (active.includes("pregnancy") && hasAlcohol) notes.push("孕期：酒类可少放或换清水，风味差一点但安全");
  if (active.includes("low_salt")) notes.push("盐比原方减三分之一，起锅前尝一下");
  if (active.includes("pregnancy") && (recipe.ingredients ?? []).some((i) => i.canon === "硝水")) notes.push("含硝水，孕期直接跳过这道");
  return notes;
}

/** 精力档位：tired 只收 35 分钟内、无难度的；good 才放开要练的 */
export function energyBudget(energy) {
  if (energy === "tired") return { maxMinutes: 35, tiers: ["easy"], label: "今天只做省事的" };
  if (energy === "good") return { maxMinutes: 120, tiers: ["easy", "learn"], label: "今天有精力" };
  return { maxMinutes: 60, tiers: ["easy"], label: "正常工作日晚饭" };
}

/**
 * 早餐另配建议（§3.2.2，R18 诚实边界；0.4.1 裁决 12 话术去行话）：
 * 菜谱库没有早餐，不硬造菜谱，只给通用建议——但说人话，不把「语料」「模板」这类
 * 内部词端给用户。
 */
export function breakfastAdvice(profile, goals = {}) {
  const advice = ["早餐这边菜谱库管不上，给你个简单搭法：一份蛋白质（鸡蛋、牛奶、豆浆、酸奶挑一样）+ 一份主食（馒头、燕麦、面条都行），几分钟就备好。"];
  const active = new Set((profile.periods ?? []).map((p) => p.preset));
  let extra = null;
  if (goals.saltTarget != null || active.has("low_salt")) extra = "低盐期间，早餐别配咸菜/酱菜。";
  else if (active.has("kids")) extra = "有小孩的话，早餐加一份水果或奶。";
  else if (goals.lowFat === true || active.has("fat_loss") || active.has("low_fat")) extra = "减脂期别只喝咖啡，早餐至少加个蛋。";
  if (extra) advice.push(extra);
  return { covered: false, advice };
}

/**
 * 单人/小份量怎么表述（§3.5）：不做「×0.2 份」的缩放，改说「按原方做、吃一半带饭」。
 * scale >= 0.8 时返回 null——沿用原来的「按 N 人份做」文案。
 * recipe 可以是原始菜谱，也可以是 plan 结果里的 canonical 菜品（都有 servingsBase/proteinFoodGrams）。
 */
export function portionNote(recipe, people = 1) {
  const base = recipe?.servingsBase || 4;
  const scale = people / base;
  if (scale >= 0.8) return null;
  if (scale >= 0.3) {
    const grams = recipe?.proteinFoodGrams;
    const g = Number.isFinite(grams) && grams > 0 ? `（约 ${Math.round(grams)}g 主料）` : "";
    return `按原方 ${base} 人份做${g}，吃一半、另一半明天带饭`;
  }
  return `按原方 ${base} 人份做，这道够 ${base} 人；单人吃就分两顿/冷冻`;
}
