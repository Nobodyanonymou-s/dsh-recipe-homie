/**
 * 用户画像：长期偏好 + 有窗口的周期性需求。
 *
 * 为什么分两层：喜欢吃猪肉是长期事实；最近健身、孕期是阶段事实。
 * 混在一起会出事——三周后还在按"增肌"配菜，或者把阶段性忌口当成了永久厌恶。
 * 所以 periods 每条都带 start/end，过期自动失效但不删除（留痕，方便复盘）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_PROFILE = {
  version: 1,
  household: { size: 2, adults: 2, children: 0, note: "" },
  longTerm: {
    likes: [],      // [{ target:"猪肉", weight:2 }]
    dislikes: [],   // [{ target:"大蒜", weight:-3, hard:false }]
    allergies: [],  // [{ target:"虾", allergen:"甲壳类" }] 硬约束
    avoid: [],      // [{ target:"香菜" }] 不用整类排除
    diet: { noPork: false, vegetarian: false, noBeef: false, noSeafood: false, halal: false },
  },
  periods: [],      // [{ id, label, preset, start, end, goals, avoidCanon, avoidMethods, note }]
  skills: {
    confident: ["蒸", "煮", "炒", "煎", "焖", "焗", "烤", "空气炸锅"],
    avoid: ["炸"],
    willing: [],
  },
  equipment: ["炒锅", "蒸锅", "电饭煲"],
  updatedAt: null,
};

export function loadProfile(file) {
  if (!file || !existsSync(file)) return structuredClone(DEFAULT_PROFILE);
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    return { ...structuredClone(DEFAULT_PROFILE), ...p, longTerm: { ...DEFAULT_PROFILE.longTerm, ...(p.longTerm ?? {}) } };
  } catch {
    return structuredClone(DEFAULT_PROFILE);
  }
}

export function saveProfile(file, profile) {
  profile.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(profile, null, 2), "utf8");
  return profile;
}

export function activePeriods(profile, now = new Date()) {
  return (profile.periods ?? []).filter((p) => {
    const startOk = !p.start || new Date(p.start) <= now;
    const endOk = !p.end || new Date(`${p.end}T23:59:59`) >= now;
    return startOk && endOk;
  });
}

/**
 * 把画像压成一组可执行的约束。planner 只认这个对象，不直接读 profile。
 */
export function resolveConstraints(profile, presets = {}, now = new Date()) {
  const lt = profile.longTerm ?? {};
  const blockedAllergens = new Set();
  const blockedCanon = new Set();
  const avoidCanon = new Set();  // 两级忌口（R2b）：主料级换菜，配料级省去（omit）
  const bannedMethods = new Set();
  const blockedParents = new Set();
  const preferMethods = new Set();
  const preferParents = new Set();
  const softAvoid = new Map();   // canon → 权重（负）
  const boost = new Map();       // parent → 权重（正）

  for (const a of lt.allergies ?? []) {
    if (a.allergen) blockedAllergens.add(a.allergen);
    // 过敏目标 canon 保持硬拦（R2b：过敏不适用两级——任何含量都不能靠「省去」）
    if (a.target) blockedCanon.add(a.target);
  }
  for (const d of lt.dislikes ?? []) {
    // 硬忌口走两级（R2b，0.4.2）：主料级换菜、配料级省去；软厌恶仍只是降权
    if (d.hard) avoidCanon.add(d.target);
    else softAvoid.set(d.target, (softAvoid.get(d.target) ?? 0) + (d.weight ?? -2));
  }
  for (const a of lt.avoid ?? []) softAvoid.set(a.target, -6);
  for (const l of lt.likes ?? []) boost.set(l.target, (boost.get(l.target) ?? 0) + (l.weight ?? 2));
  // 忌口按食材家族生效：忌「大蒜」的人不该被端上蒜苗/青蒜——同一株植物（ITERATION-0.4 A3）。
  // 0.4.2 R2b：家族展开从「全毙」改成「全两级」——蒜苗做主料的菜照样换掉，蒜末爆香级的照样省去。
  const GARLIC_FAMILY = ["大蒜", "蒜苗", "青蒜", "蒜黄", "独蒜", "蒜头"];
  const hardTargets = [...blockedCanon];
  for (const target of hardTargets) {
    if (GARLIC_FAMILY.includes(target)) for (const g of GARLIC_FAMILY) blockedCanon.add(g);
  }
  const avoidTargets = [...avoidCanon];
  for (const target of avoidTargets) {
    if (GARLIC_FAMILY.includes(target)) for (const g of GARLIC_FAMILY) avoidCanon.add(g);
  }

  const diet = lt.diet ?? {};
  if (diet.vegetarian) for (const p of ["猪肉", "牛肉", "羊肉", "禽肉", "水产"]) blockedParents.add(p);
  if (diet.noPork) blockedParents.add("猪肉");
  if (diet.noBeef) blockedParents.add("牛肉");
  if (diet.noSeafood) blockedParents.add("水产");

  let proteinTarget = 0;
  let kcalTarget = null;
  let saltTarget = null;
  // 天级目标（§3.2.1）：回退口径「每餐目标 × 餐数」会把 85g/天 判成超标，所以 periods 可直接给日目标
  let proteinPerDay = null;
  let kcalPerDay = null;
  let lowFat = false;
  const active = activePeriods(profile, now);
  const notes = [];

  for (const p of active) {
    const preset = presets[p.preset] ?? {};
    const goals = { ...(preset.goals ?? {}), ...(p.goals ?? {}) };
    if (goals.proteinPerServing) proteinTarget = Math.max(proteinTarget, goals.proteinPerServing);
    if (goals.kcalPerServing) kcalTarget = Math.min(kcalTarget ?? Infinity, goals.kcalPerServing);
    if (goals.proteinPerDay) proteinPerDay = Math.max(proteinPerDay ?? 0, goals.proteinPerDay);
    if (goals.kcalPerDay) kcalPerDay = Math.min(kcalPerDay ?? Infinity, goals.kcalPerDay);
    if (goals.lowFat === true) lowFat = true;
    if (goals.lowSalt) saltTarget = Math.min(saltTarget ?? Infinity, 3);
    for (const m of preset.avoidMethods ?? []) bannedMethods.add(m);
    for (const m of p.avoidMethods ?? []) bannedMethods.add(m);
    // 周期层（preset/period）的 avoidCanon 是健康窗口约束（孕期硝水/酒类等），
    // 保守起见一律硬拦——两级"省去"语义只属于长期层的口味忌口（R2b 裁决 2026-10-28）。
    for (const c of preset.avoidCanon ?? []) blockedCanon.add(c);
    for (const c of p.avoidCanon ?? []) blockedCanon.add(c);
    for (const al of preset.avoidAllergens ?? []) blockedAllergens.add(al);
    for (const par of preset.blockParents ?? []) blockedParents.add(par);
    for (const m of preset.preferMethods ?? []) preferMethods.add(m);
    for (const par of preset.preferParents ?? []) preferParents.add(par);
    if (preset.note) notes.push(`${p.label ?? preset.label}：${preset.note}`);
  }

  // 技能：用户明确"炸麻烦"，就不推炸
  const skills = profile.skills ?? {};
  const confident = new Set(skills.confident ?? []);
  const skillAvoid = new Set(skills.avoid ?? []);
  const allowTiers = new Set(["easy"]);
  if (confident.has("炸") || confident.has("油炸")) allowTiers.add("hard");
  if (skills.willing?.length) for (const t of ["learn", "hard"]) if (skills.willing.includes(t)) allowTiers.add(t);
  const hardFromSkills = [...skillAvoid].some((s) => s.includes("炸"));

  return {
    blockedAllergens,
    blockedCanon,
    avoidCanon,
    blockedParents,
    bannedMethods,
    preferMethods,
    preferParents,
    softAvoid,
    boost,
    proteinTarget,
    kcalTarget,
    saltTarget,
    proteinPerDay,
    kcalPerDay,
    lowFat,
    allowTiers,
    hardFromSkills,
    people: profile.household?.size ?? 2,
    diet,
    activePeriods: active.map((p) => p.label ?? p.preset),
    notes,
  };
}

// 减脂期的瘦部位白名单（§3.3.3）：周期目标改打分不改排除，瘦猪牛保留高权重
const LEAN_PARTS = new Set(["里脊", "通脊", "鸡胸", "鸡脯", "牛腱", "瘦猪肉", "前腿精肉"]);
const LEAN_PARTS_RE = /里脊|通脊|鸡胸|鸡脯|牛腱|瘦猪肉|前腿精肉/;
// 高脂部位（§3.4）：减脂/低脂周期强降权，但不 block——留退路，别硬删
const HIGH_FAT_PARTS = new Set(["大肠", "肥肠", "猪肠", "板油", "肥膘", "五花肉", "猪油", "鸡油", "奶油", "黄油"]);
const HIGH_FAT_RE = /大肠|肥肠|板油|肥膘|五花/;

/** 高脂部位的主料级判定（R2b 同款思路，verify-w58 检查12 教训）：
 *  吊汤用的 25g 肥膘是配料级（trace，轻罚）；整份肥肠/五花才是主料级（main，重罚+断言口径）。
 *  main = 标题点 named 高脂部位，或命中 canon 且（在 proteinCanon 里 或 克数 ≥ 全菜 5%）。 */
export function highFatMainLevel(recipe) {
  const ings = recipe.ingredients ?? [];
  // 烹调介质不算主料：油脂类目 / 带「约耗」的整锅油行（炒三丁的 500g 炸油占 54% 但只是介质）
  const hit = ings.find((i) => HIGH_FAT_PARTS.has(i.canon) && i.parent !== "油脂" && i.consumedGrams == null);
  const titleHit = HIGH_FAT_RE.test(recipe.title ?? "");
  if (!hit && !titleHit) return null;
  const protein = new Set(recipe.proteinCanon ?? []);
  if (titleHit || (hit && protein.has(hit.canon))) return "main";
  const total = recipe.totalGrams || ings.reduce((s, i) => s + (i.grams ?? 0), 0) || 1;
  if (hit && (hit.grams ?? 0) / total >= 0.05) return "main";
  return "trace";
}

// ── 过敏防御（0.4.1 裁决 3，E3 S-E）──
// 数据里有一批「标题自带虾/蟹/贝、allergens 却没标」的菜（虾油溜鱼片、蛋奶虾仁…）。
// 标签补录在 0.5 W2；在那之前按标题字眼防御性拦截：标题含这类词而 allergens 缺标，
// 就当作含该过敏原处理——只对「用户真的过敏于该类」的人生效，其他人不受影响。
const TITLE_ALLERGEN_RULES = [
  [/虾/, "甲壳类"],
  [/蟹/, "甲壳类"],
  [/贝|蛤|蛏|蚶|蚬|蚌|蚝|蛎|鲍|淡菜|干贝/, "贝类"],
];

/** 标题「含过敏词而 allergens 未标」推导出的过敏原集合（防御拦截用）。 */
export function titleImpliedAllergens(recipe) {
  const title = recipe.title ?? "";
  const declared = new Set(recipe.allergens ?? []);
  const implied = new Set();
  for (const [re, allergen] of TITLE_ALLERGEN_RULES) {
    if (!declared.has(allergen) && re.test(title)) implied.add(allergen);
  }
  return implied;
}

// ── 忌口两级语义（R2b，0.4.2）──
// 主类目：猪牛羊禽水产 / 蔬菜 / 蛋豆——克数在这里排得上号的才算主料；
// 调味、油脂、汤底这类天然是配料，不进排行。
const MAIN_PARENTS = new Set(["猪肉", "牛肉", "羊肉", "禽肉", "水产", "蔬菜", "蛋", "豆制品"]);

/**
 * 判定忌口命中的原料在这道菜里是主料级还是配料级（R2b 定案，运行时可算、不动数据层）。
 * 满足任一条即主料级：① 在本菜主类目（猪牛羊禽水产/蔬菜/蛋豆）里克数排前二（同 canon 合并计量）；
 * ② 其克数 ≥ 全菜 totalGrams 的 15%。否则配料级。克数缺失时保守判主料级——宁换不错荐。
 * 返回 null 表示这道菜根本没有该 canon；返回 { level, grams, why }。
 */
export function avoidLevel(recipe, canon) {
  const hits = (recipe.ingredients ?? []).filter((i) => i.canon === canon);
  if (!hits.length) return null;
  const grams = hits.reduce((s, i) => s + (i.grams ?? 0), 0);
  if (!hits.every((i) => typeof i.grams === "number")) {
    return { level: "main", grams: null, why: "克数缺失，保守按主料" };
  }
  if ((recipe.totalGrams ?? 0) > 0 && grams >= recipe.totalGrams * 0.15) {
    return { level: "main", grams, why: `占全菜 ${Math.round((grams / recipe.totalGrams) * 100)}%` };
  }
  // ① 主类目克数前二（跨类目一张榜：肉、菜、蛋豆同场按克数排序）
  const agg = new Map();
  for (const i of recipe.ingredients ?? []) {
    if (!MAIN_PARENTS.has(i.parent)) continue;
    agg.set(i.canon, (agg.get(i.canon) ?? 0) + (typeof i.grams === "number" ? i.grams : 0));
  }
  const ranked = [...agg.entries()].sort((a, b) => b[1] - a[1]);
  const idx = ranked.findIndex(([c]) => c === canon);
  if (idx >= 0 && idx < 2) return { level: "main", grams, why: "主类目克数前二" };
  return { level: "garnish", grams, why: null };
}

/** 配料级忌口清单（做「免 X 版」用）：[{ target, grams }]。c 是 resolveConstraints 的结果。 */
export function omitInfoFor(recipe, c) {
  const out = [];
  for (const canon of c?.avoidCanon ?? []) {
    const lv = avoidLevel(recipe, canon);
    if (lv?.level === "garnish") out.push({ target: canon, grams: lv.grams });
  }
  return out;
}

/** 主料级忌口清单（换菜理由用）：canon 名数组。 */
export function mainAvoidFor(recipe, c) {
  const out = [];
  for (const canon of c?.avoidCanon ?? []) {
    const lv = avoidLevel(recipe, canon);
    if (lv?.level === "main") out.push(canon);
  }
  return out;
}

/** 给 planner 用：这道菜对这个人来不来得及做、能不能吃、爱不爱吃。 */
export function scoreRecipe(recipe, c) {
  let score = 0;
  const reasons = [];
  const blocked = [];

  for (const a of recipe.allergens ?? []) {
    if (c.blockedAllergens.has(a)) blocked.push(`含过敏原：${a}`);
  }
  // 过敏防御（0.4.1 裁决 3）：标题自带虾/蟹/贝而标签没标的，按含该过敏原处理
  for (const a of titleImpliedAllergens(recipe)) {
    if (c.blockedAllergens.has(a)) blocked.push(`标题含${a}食材但过敏原未标注（防御拦截）`);
  }
  for (const i of recipe.ingredients ?? []) {
    if (c.blockedCanon.has(i.canon)) blocked.push(`含忌口：${i.canon}`);
    if (c.blockedParents.has(i.parent)) blocked.push(`饮食限制：${i.parent}`);
  }
  // 两级忌口（R2b）：主料级 → 换一道菜（blocked 理由写清「主料」）；配料级 → 省去（omit 带料名+约克数）
  const omit = [];
  for (const canon of c.avoidCanon ?? []) {
    if (!(recipe.ingredients ?? []).some((i) => i.canon === canon)) continue;
    const lv = avoidLevel(recipe, canon);
    if (lv.level === "main") blocked.push(`主料含忌口：${canon}（${lv.why}）`);
    else omit.push({ target: canon, grams: lv.grams });
  }
  for (const m of recipe.methods ?? []) {
    if (c.bannedMethods.has(m)) blocked.push(`技法不合：${m}`);
  }
  // 口味同权（0.4.1 裁决 6）：糖醋白菜 methods 只有炒/爆，口味在 flavors——
  // avoidMethods 要同时看两处，否则「减脂避开糖醋」永远不生效
  for (const f of recipe.flavors ?? []) {
    if (c.bannedMethods.has(f)) blocked.push(`口味不合：${f}`);
  }
  if (!c.allowTiers.has(recipe.skill?.tier)) blocked.push(`难度：${recipe.skill?.why ?? recipe.skill?.tier}`);
  // 主料级高脂 × lowFat 的 block 必须在下方提前 return 之前 push（否则被难度先拦的菜带不上高脂理由）
  if (c.lowFat === true && highFatMainLevel(recipe) === "main") blocked.push("减脂期高脂主料（奶汤/肥肠类），换一道更合适");
  if (c.kcalTarget) {
    const k = recipe.perServing?.kcal ?? 0;
    // 高热量硬挡（0.4.1 裁决 5）：单菜超每餐目标 2.5 倍直接出局（麻果肉 1863 vs 目标 450），
    // 只扣 2 分压不住随机抽取，减脂期不该靠运气躲开它
    if (k > c.kcalTarget * 2.5) {
      blocked.push(`热量 ${k}kcal/人，超预算（${c.kcalTarget}）2.5 倍以上`);
    }
  }

  if (blocked.length) return { score: -Infinity, blocked: [...new Set(blocked)], reasons: [], omit: [] };

  if (c.proteinTarget) {
    const p = recipe.perServing?.proteinGrams ?? 0;
    if (p >= c.proteinTarget) { score += 4; reasons.push(`蛋白 ${p}g/人，达标`); }
    else if (p >= c.proteinTarget * 0.7) { score += 1.5; reasons.push(`蛋白 ${p}g/人，接近`); }
    else { score -= 1.5; reasons.push(`蛋白 ${p}g/人，偏低`); }
  }
  if (c.kcalTarget && (recipe.perServing?.kcal ?? 0) > c.kcalTarget) {
    score -= 2;
    reasons.push(`热量 ${recipe.perServing.kcal}kcal/人，超预算`);
  }
  if (c.saltTarget && (recipe.nutrition?.saltGrams ?? 0) / (recipe.servingsBase || 4) > c.saltTarget) {
    score -= 1.5;
    reasons.push("盐偏多");
  }
  for (const i of recipe.ingredients ?? []) {
    if (c.softAvoid.has(i.canon)) score += c.softAvoid.get(i.canon);
    // 长期喜好权重高于周期偏好（§3.3）：likes 不被周期 preset 挤掉，只被硬约束挡掉
    if (c.boost.has(i.parent)) score += c.boost.get(i.parent) * 1.0;
    if (c.boost.has(i.canon)) score += c.boost.get(i.canon) * 1.2;
  }
  for (const m of recipe.methods ?? []) {
    if (c.preferMethods.has(m)) score += 0.4;
  }
  // 周期 preferParents 只是辅助加分（§3.3.2），不反向扣减长期 like
  for (const p of recipe.proteinCanon ?? []) {
    if (c.preferParents.has(p)) score += 0.4;
  }
  // 减脂期的部位校准（§3.3.3 / §3.4）：瘦部位 +0.8，高脂部位 -4（0.4.1 裁决 12：-2.5 压不住
  // 奶汤大肠这类高排序菜，多个 seed 都会漏进荤位；降权不 block，留退路）
  if (c.lowFat === true) {
    const canons = new Set([
      ...(recipe.proteinCanon ?? []),
      ...(recipe.ingredients ?? []).map((i) => i.canon).filter(Boolean),
    ]);
    const title = recipe.title ?? "";
    if ([...canons].some((x) => LEAN_PARTS.has(x)) || LEAN_PARTS_RE.test(title)) {
      score += 0.8;
      reasons.push("瘦部位，减脂期优先");
    }
    const hf = highFatMainLevel(recipe);
    if (hf === "trace") {
      // 配料级（吊汤 25g 肥膘）轻罚留退路；main 级已在提前 return 前 block
      score -= 1;
      reasons.push("少量高脂料（吊汤/增香用，可省），轻罚");
    }
  }
  if (recipe.skill?.tier === "easy") score += 0.5;

  return { score, blocked, reasons, omit };  // 0.5 收口：此前返回字面量 blocked:[]，函数内 push 的拦截理由从未传出——奶汤鸡脯漏网的真病根
}
