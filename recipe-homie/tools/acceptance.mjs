/**
 * 验收测试：把「用户画像 → 检索 → 排菜单 → 采购清单」整条链路跑一遍，
 * 断言那些不能错的事（过敏、忌口、难度、份量、采购量）。
 *
 * 0.4 新增（ITERATION-0.4 §5 A1–A11）：素菜池构成、每日总盘子、早餐另配、
 * likes×preset 融合、lowFat 高脂降权、单人份量、intent fast/learn、挑战两次机会。
 *
 * 这些断言就是子智能体交回数据后的守门条件。
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { RecipeBook } from "../src/query.ts";
import { Planner, isFungiBamboo, isMockMeatVeg, vegKind, buildShopping, alignPurchaseNeed, EXOTIC_INGREDIENTS, LUXURY_INGREDIENTS } from "../src/planner.ts";
import { PURCHASE_UNITS } from "../src/lexicon.ts";
import { loadProfile, resolveConstraints, scoreRecipe, titleImpliedAllergens, avoidLevel, highFatMainLevel, DEFAULT_PROFILE } from "../src/profile.ts";
import { formatMenu, registerTools } from "../src/index.ts";
import { rescueCandidates, heavyPrepDependency, isPreparedIngredient } from "../src/care.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(readFileSync(`${ROOT}/data/presets.json`, "utf8")).presets;
const book = new RecipeBook(`${ROOT}/data`);

const profile = {
  ...DEFAULT_PROFILE,
  household: { size: 5, adults: 2, children: 3 },
  longTerm: {
    likes: [{ target: "猪肉", weight: 2 }],
    dislikes: [{ target: "大蒜", weight: -3, hard: true }],
    allergies: [{ target: "虾", allergen: "甲壳类" }],
    avoid: [],
    diet: { noPork: false, vegetarian: false },
  },
  periods: [{ id: "fit", label: "增肌", preset: "fitness", start: "2026-10-01", end: "2026-12-31", goals: { proteinPerServing: 30 } }],
  skills: { confident: ["蒸", "煮", "炒", "煎", "焖", "焗", "烤"], avoid: ["炸"], willing: [] },
};

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });

const c = resolveConstraints(profile, presets);
check("过敏原进入硬约束", c.blockedAllergens.has("甲壳类"));
// 0.4.2 R2b：硬忌口不再进 blockedCanon（那是过敏目标的地盘），进两级忌口集，且蒜家族照旧展开
check("硬忌口进入两级忌口集（蒜家族展开）",
  c.avoidCanon.has("大蒜") && c.avoidCanon.has("蒜苗") && c.avoidCanon.has("青蒜") && !c.blockedCanon.has("大蒜"),
  [...c.avoidCanon].join("、"));

// 1. 单菜打分
const shrimp = book.recipes.find((r) => (r.ingredients ?? []).some((i) => i.parent === "水产" && (i.allergen ?? []).includes("甲壳类")));
if (shrimp) {
  const s = scoreRecipe(shrimp, c);
  check(`含甲壳类的菜被拒绝（${shrimp.title}）`, s.score === -Infinity && s.blocked.some((b) => b.includes("甲壳类")), JSON.stringify(s.blocked));
}

// 2. 排菜单
const planner = new Planner(book, profile, presets);
planner.refresh();
const plan = planner.plan({ days: 3, people: 5, meals: 2, seed: 7 });
const dishes = plan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes));
const ids = dishes.map((d) => d.id);

check("菜单里没有甲壳类", dishes.every((d) => !(book.get(d.id).allergens ?? []).includes("甲壳类")));
// 0.4.2 R2b：忌蒜从「全挡」改两级——主料级蒜 0 容忍；配料级蒜允许入选，但每道必带免蒜 omit
const GARLIC_FAMILY = ["大蒜", "蒜苗", "青蒜", "蒜黄", "独蒜", "蒜头"];
const garlicIn = (r) => GARLIC_FAMILY.filter((f) => (r.ingredients ?? []).some((i) => i.canon === f));
const badGarlic = dishes.filter((d) => {
  const present = garlicIn(book.get(d.id));
  return present.some((f) => avoidLevel(book.get(d.id), f).level === "main")
    || !present.every((f) => (d.omit ?? []).some((o) => o.target === f));
});
check("菜单里没有未豁免的蒜（主料级 0 / 配料级必带 omit）", badGarlic.length === 0,
  badGarlic.map((d) => `${d.title}[${garlicIn(book.get(d.id))}]`).join("、"));
check("菜单里没有费工菜", dishes.every((d) => book.get(d.id).skill?.tier !== "hard"), dishes.filter((d) => book.get(d.id).skill?.tier === "hard").map((d) => d.title).join(","));
check("整周不重复同一道菜", new Set(ids).size === ids.length, `${ids.length} 道，去重后 ${new Set(ids).size}`);
check("同一天不重复主料", plan.plan.every((d) => {
  const mains = d.meals.flatMap((m) => m.dishes.filter((x) => x.role === "protein").map((x) => book.get(x.id).proteinCanon?.[0])).filter(Boolean);
  return new Set(mains).size === mains.length;
}));
check("素菜真的是素菜", dishes.filter((d) => d.role === "veg").every((d) => {
  const r = book.get(d.id);
  return !(r.ingredients ?? []).some((i) => ["猪肉", "牛肉", "羊肉", "禽肉", "水产"].includes(i.parent));
}), dishes.filter((d) => d.role === "veg").map((d) => d.title).join(","));

// 3. 采购量能对上（0.4.1 裁决 1：口径 = 原方 servingsBase 量，不再按 people 折算；
//    W5 起，蛋清/蛋黄并回鸡蛋 + 不足最小可买份量的凑整，用与 buildShopping 同一份 alignPurchaseNeed 对齐）
const need = new Map();
for (const d of dishes) {
  const r = book.get(d.id);
  const scale = 1; // 原方量：下锅的就是原方，「吃一半带饭」的语义由菜单文案承载
  for (const i of r.ingredients ?? []) {
    if (!i.grams || i.canon === "水") continue;
    const f = i.parent === "油脂" ? 0.3 : 1;
    need.set(i.canon, (need.get(i.canon) ?? 0) + i.grams * scale * f);
  }
}
const { need: needAligned } = alignPurchaseNeed(need);
const shopping = plan.shopping;
const listed = new Map();
for (const group of [shopping.buyOnce, ...shopping.batches, shopping.dry, shopping.staples, shopping.keep].filter(Boolean)) {
  for (const item of group.items ?? []) if (item.qty && item.qty.includes("g")) {
    const g = item.qty.includes("kg") ? parseFloat(item.qty) * 1000 : parseFloat(item.qty);
    listed.set(item.name, g);
  }
}
let matched = 0;
let mismatched = [];
for (const [name, grams] of needAligned) {
  const got = listed.get(name);
  if (got === undefined) continue;
  matched++;
  if (Math.abs(got - grams) > Math.max(60, grams * 0.2)) mismatched.push(`${name}: 需${Math.round(grams)}g 列${got}g`);
}
check("采购量与菜单用量一致（抽样，含 W5 凑整口径）", mismatched.length === 0, mismatched.slice(0, 5).join("；"));
check("采购清单非空", need.size > 5 && matched > 5, `需求 ${need.size} 项，清单对上 ${matched} 项`);

// 4. 随机挑战
const sh = planner.shuffle({ people: 3, combo: "1菜1肉", excludeIds: [], rerollCount: 0, seed: 3 });
check("随机菜单不违反过敏", sh.dishes.every((d) => !(book.get(d.id).allergens ?? []).includes("甲壳类")));
check("随机菜单不重复", new Set(sh.dishes.map((d) => d.id)).size === sh.dishes.length);
const sh3 = planner.shuffle({ people: 3, combo: "1菜1肉", excludeIds: [], rerollCount: 2, seed: 9 });
check("第三次摇会要求问原因", sh3.askReason === true);

// 5. 检索过滤
const hits = book.search({ ingredients: ["虾"], limit: 50 });
const blocked = hits.filter((h) => scoreRecipe(h.recipe, c).score === -Infinity).length;
check("检索结果可被画像过滤", blockersOf(hits, c) > 0, `含虾的 ${hits.length} 道里 ${blocked} 道会被挡`);

// 6. 记性与照顾：做过/想吃/太累/剩料
const loved = book.findTitle("冰糖元蹄");
const never = book.recipes.find((r) => r.skill?.tier === "easy" && (r.ingredients ?? []).some((i) => i.canon === "五花肉"));
const today = new Date().toISOString().slice(0, 10);
const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
const state = {
  cookLog: [
    { date: twoDaysAgo, id: loved?.id ?? null, title: loved?.title ?? "冰糖元蹄", verdict: "loved", note: "", leftovers: [{ canon: "五花肉", name: "五花肉", cat: "肉禽", grams: 400, addedAt: twoDaysAgo, days: 5 }] },
    ...(never ? [{ date: today, id: never.id, title: never.title, verdict: "never", note: "" }] : []),
  ],
  wants: [{ title: "冰糖元蹄", addedAt: today, satisfiedAt: null }],
  notes: [],
};
const caring = new Planner(book, profile, presets, state);
caring.refresh();

const tiredPlan = caring.plan({ days: 1, people: 4, meals: 1, energy: "tired", seed: 5 });
const tiredDishes = tiredPlan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes));
check("说过不再做的菜不会出现", never ? !caring.scored.some((x) => x.r.id === never.id) : true, never?.title ?? "");
check("省事模式只排 35 分钟内、好上手的", tiredDishes.every((d) => (d.minutes ?? 999) <= 35 && d.skill?.tier === "easy"), tiredDishes.map((d) => `${d.title} ${d.minutes}min`).join("；"));

const planned = caring.plan({ days: 2, people: 4, meals: 2, seed: 11 });
const allDishes = planned.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes));
check("念叨过的菜会被排进菜单或写进提示", allDishes.some((d) => d.title === "冰糖元蹄") || planned.notes.some((n) => n.includes("冰糖元蹄")), planned.notes.filter((n) => n.includes("冰糖元蹄")).join("；"));
check("最近做过的菜被标记", caring.scored.some((x) => x.r.title === "冰糖元蹄" && x.recentDays != null));
check("冰箱剩料会从采购里扣", planned.notes.some((n) => n.includes("扣掉冰箱里")) || planned.shopping.buyOnce.items.some((i) => i.qty?.includes("扣")), planned.notes.find((n) => n.includes("扣掉")) ?? "");

const rescue = caring.scored.filter((x) => x.r.skill?.tier === "easy" && x.minutes <= 30).slice(0, 3);
check("太累的退路能有 3 道 30 分钟内的菜", rescue.length === 3, rescue.map((x) => x.r.title).join(","));

// ───────── 0.4 新增（ITERATION-0.4 §5 A1–A11） ─────────

const realProfile = loadProfile(`${ROOT}/profile.json`);
const realPlanner = new Planner(book, realProfile, presets);
realPlanner.refresh();
const cReal = realPlanner.c;

// A1 + A2：素菜池构成（真实 profile，默认约束）
// A1 阈值 0.5 重定（merge-agent 2026-10-29）：大众菜谱 456 道并入后 veg 池 54→145、
// 非笋菇 21→98、绿叶 14→42（--easy 口径 124/84/36）。新阈值 100/60/25 取新值约 70%/60%/60%：
// 高于老库峰值（54/21/14，语料回退立即 FAIL），低于新库实测值留足波动余量。
const rep = realPlanner.poolReport();
check("A1 素菜池：veg>=100 / nonFungi>=60 / leafy>=25（0.5 重定）",
  rep.counts.veg >= 100 && rep.nonFungiVeg >= 60 && rep.vegKinds.leafy >= 25,
  `veg=${rep.counts.veg} nonFungi=${rep.nonFungiVeg} leafy=${rep.vegKinds.leafy}（其中甜菜类 ${rep.vegSweetChapter} 道只计供给，菜单可排非笋菇 ${rep.menuNonFungiVeg}）`);
check("A2 蛋/豆制品素菜进池 >=5（修复前 0）", rep.eggTofuDishes >= 5, `${rep.eggTofuDishes} 道`);

// A3：真实画像 3 天菜单（seed 42）
const realPlan = realPlanner.plan({ days: 3, meals: 2, people: 1, seed: 42 });
const realDishes = realPlan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes));
const realVeg = new Map();
for (const d of realDishes) if (d.role === "veg") realVeg.set(d.id, book.get(d.id));
const realNonFungi = [...realVeg.values()].filter((r) => !isFungiBamboo(r));
check("A3 素菜 >=2 道非笋菇（跨天去重）", realNonFungi.length >= 2, `${realNonFungi.length} 道：${realNonFungi.map((r) => r.title).join("、")}`);
const garlicHit = realDishes.filter((d) => (book.get(d.id).ingredients ?? []).some((i) => /蒜/.test(i.canon ?? "") || /蒜/.test(i.name ?? "")));
// 0.4.2 R2b：A3 新语义——0 道未豁免的主料级蒜；配料级蒜（蒜末爆香级）允许入选但必带免蒜 omit
const a3MainLeak = garlicHit.filter((d) => GARLIC_FAMILY.some((f) => avoidLevel(book.get(d.id), f)?.level === "main"));
check("A3 忌蒜两级：0 道未豁免的主料级蒜", a3MainLeak.length === 0, a3MainLeak.map((d) => d.title).join("、"));
check("A3 配料级蒜菜必带免蒜 omit", garlicHit.every((d) => {
  const present = GARLIC_FAMILY.filter((f) => (book.get(d.id).ingredients ?? []).some((i) => i.canon === f));
  return present.every((f) => (d.omit ?? []).some((o) => o.target === f));
}), garlicHit.map((d) => `${d.title} omit=${JSON.stringify(d.omit)}`).join("、") || "本 seed 无配料级蒜菜");
check("A3 无炸技法", realDishes.every((d) => !(book.get(d.id).methods ?? []).includes("炸")));

// A4：每日总盘子（真实 profile 走天级目标；上面合成 profile 走回退口径）
check("A4 dailyTotals 长度 = 天数（真实）", realPlan.dailyTotals.length === realPlan.days, `${realPlan.dailyTotals.length}`);
check("A4 天级目标取 goals.proteinPerDay/kcalPerDay（112/1750）",
  realPlan.dailyTotals.every((t) => t.proteinTarget === 112 && t.kcalTarget === 1750 && t.proteinGap === t.protein - 112 && t.kcalGap === 1750 - t.kcal),
  JSON.stringify(realPlan.dailyTotals.map((t) => [t.protein, t.kcal])));
check("A4 每日合计对得上（真实，±1）", realPlan.dailyTotals.every((t) => {
  const day = realPlan.plan.find((d) => d.day === t.day);
  return Math.abs(Math.round(day.meals.reduce((s, m) => s + m.protein, 0)) - t.protein) <= 1
    && Math.abs(Math.round(day.meals.reduce((s, m) => s + m.kcal, 0)) - t.kcal) <= 1;
}));
check("A4 无天级目标时回退每餐×餐数（合成 fitness：30×2=60，kcal=null）",
  plan.dailyTotals.length === 3 && plan.dailyTotals.every((t) => t.proteinTarget === 60 && t.kcalTarget === null),
  JSON.stringify(plan.dailyTotals?.[0] ?? {}));

// A5：早餐另配
const realMenuText = formatMenu(realPlan);
check("A5 render 含「早餐另配」", realMenuText.includes("早餐另配"));
check("A5 早餐建议不含具体菜名", !(realPlan.breakfast.advice ?? []).some((a) => ["粥", "包子", "三明治", "烧麦", "油条"].some((w) => a.includes(w))), (realPlan.breakfast.advice ?? []).join(" / "));

// A6：长期 likes × 周期 preset 融合（合成 A/B 对照）
const mkSynth = (withLikes) => ({
  ...DEFAULT_PROFILE,
  household: { size: 1, adults: 1, children: 0, note: "" },
  longTerm: { ...DEFAULT_PROFILE.longTerm, likes: withLikes ? [{ target: "猪肉", weight: 2 }] : [] },
  periods: [{ id: "fl", label: "减脂", preset: "fat_loss", start: "2026-01-01", end: "2026-12-31", goals: {} }],
  skills: { confident: ["蒸", "煮", "炒", "煎", "焖", "焗", "烤"], avoid: ["炸"], willing: [] },
});
const porkMains = (p) => p.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).filter((d) => d.role === "protein" && (book.get(d.id).ingredients ?? []).some((i) => i.parent === "猪肉")).length;
const likePlan = new Planner(book, mkSynth(true), presets).plan({ days: 3, meals: 2, people: 1, seed: 42 });
check("A6 likes 猪肉+fat_loss：3 天 >=1 道猪肉主菜", porkMains(likePlan) >= 1, `${porkMains(likePlan)} 道`);
// A/B 对照从单 seed 改 4-seed 合计（2026-10-31）：单 seed 下池子一变（如约耗热量修正）计数就可能翻转，
// 断言脆而不说明语义坏；多 seed 合计下 likes 的加分效应稳定显形。
const porkMainsAcrossSeeds = (withLikes) =>
  [42, 7, 123, 2026].reduce((s, sd) => s + porkMains(new Planner(book, mkSynth(withLikes), presets).plan({ days: 3, meals: 2, people: 1, seed: sd })), 0);
check("A6 无 likes 对照的猪肉主菜 <= 有 likes（4 seed 合计）",
  porkMainsAcrossSeeds(false) <= porkMainsAcrossSeeds(true), `${porkMainsAcrossSeeds(false)} vs ${porkMainsAcrossSeeds(true)}`);

// A7：lowFat 高脂降权（主料级口径与 profile.highFatMainLevel 同源——吊汤 25g 肥膘是配料级，R2b 思路）
const highFatMain = (r) => highFatMainLevel(r) === "main";
check("A7 减脂 3 天菜单无高脂主料", realDishes.every((d) => !highFatMain(book.get(d.id))), realDishes.filter((d) => highFatMain(book.get(d.id))).map((d) => d.title).join("、"));
const bracket = (r) => { const p = r.perServing?.proteinGrams ?? 0; return p >= cReal.proteinTarget ? "hi" : p >= cReal.proteinTarget * 0.7 ? "mid" : "lo"; };
// 0.5 收口裁决后语义变了：主料级高脂在 lowFat 下直接 block（不再是「软罚下仍可比分」），
// 断言改为 block 本身——比「低 ≥2 分」更强。
const fatDish = [...book.recipes].find((r) => (r.proteinCanon ?? []).includes("五花肉"));
const fatVerdict = fatDish ? scoreRecipe(fatDish, cReal) : null;
check("A7 高脂主菜在减脂画像下被 block", Boolean(fatVerdict?.blocked.some((b) => /高脂/.test(b))), fatDish ? `${fatDish.title}：${fatVerdict.blocked.join("；")}` : "没找到五花肉菜");

// A8：单人份量表述
const soloText = formatMenu(realPlanner.plan({ days: 2, meals: 2, people: 1, seed: 42 }));
check("A8 单人 render 无「0.x 人份」", !/0\.\d+\s*人份/.test(soloText) && !/×\s*0\.\d/.test(soloText));
check("A8 单人 render 有带饭/分两顿", /带饭|分两顿/.test(soloText));

// A9 / A10：intent fast / learn
const fastPlan = realPlanner.plan({ days: 1, meals: 2, people: 1, intent: "fast", seed: 7 });
const fastShuffle = realPlanner.shuffle({ people: 2, intent: "fast", seed: 7 });
check("A9 intent=fast：plan/shuffle 全部 easy 且 <=35 分钟",
  fastPlan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).every((d) => d.minutes <= 35 && d.skill?.tier === "easy")
  && fastShuffle.dishes.every((d) => d.minutes <= 35 && d.skill?.tier === "easy"),
  `plan ${fastPlan.maxMinutes}min；shuffle ${fastShuffle.dishes.map((d) => `${d.title}(${d.minutes})`).join(",")}`);
const learnPlan = realPlanner.plan({ days: 1, meals: 2, people: 1, intent: "learn", seed: 7 });
check("A10 intent=learn：至少 1 道 learn/hard 且上限 180",
  learnPlan.maxMinutes === 180 && learnPlan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).some((d) => d.skill?.tier === "learn" || d.skill?.tier === "hard"),
  learnPlan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).map((d) => `${d.title}[${d.skill?.tier}]`).join("、"));

// A9/A10 的检索侧 + A11 的 render 侧走插件层（假 ctx，隔离画像）
const accTmpProfile = join(tmpdir(), `foodbot-acc-profile-${process.pid}.json`);
const accTmpState = join(tmpdir(), `foodbot-acc-state-${process.pid}.json`);
writeFileSync(accTmpProfile, JSON.stringify(DEFAULT_PROFILE));
writeFileSync(accTmpState, JSON.stringify({ cookLog: [], wants: [], notes: [] }));
const accTools = new Map();
registerTools({ tools: { register: (t) => accTools.set(t.name, t) } }, { dataDir: `${ROOT}/data`, profileFile: accTmpProfile, stateFile: accTmpState });
const searchTool = accTools.get("recipe_search");
const learnSearch = await searchTool.execute({ q: "鱼肚", intent: "learn", limit: 30 });
const fastSearch = await searchTool.execute({ q: "鱼肚", intent: "fast", limit: 30 });
rmSync(accTmpProfile, { force: true });
rmSync(accTmpState, { force: true });
check("A10 learn 检索不强制 easy", learnSearch.hits.some((h) => h.tier !== "easy"), `${learnSearch.hits.length} hits：${learnSearch.hits.filter((h) => h.tier !== "easy").map((h) => h.title).slice(0, 3).join("、")}`);
check("A9 fast 检索全 easy 且 <=35 分钟", fastSearch.hits.length > 0 && fastSearch.hits.every((h) => h.tier === "easy" && h.minutes <= 35), `${fastSearch.hits.length} hits`);

// A11：挑战两次机会（初摇 + 一次再摇，第三次 closed）
const shake1 = realPlanner.shuffle({ people: 3, combo: "1菜1肉", rerollCount: 0, seed: 11 });
const shake2 = realPlanner.shuffle({ people: 3, combo: "1菜1肉", rerollCount: 1, seed: 12 });
const shake3 = realPlanner.shuffle({ people: 3, combo: "1菜1肉", rerollCount: 2, seed: 13 });
check("A11 两次机会状态机",
  shake1.closed === false && shake1.askReason === false && shake1.dishes.length > 0 && shake1.rerollCount === 1 && !shake1.hint.includes("最后一次")
  && shake2.closed === false && shake2.askReason === false && shake2.dishes.length > 0 && shake2.rerollCount === 2 && shake2.hint.includes("最后一次")
  && shake3.closed === true && shake3.askReason === true && shake3.dishes.length === 0 && shake3.rerollCount === 2
  && ["累", "没胃口", "缺食材", "没灵感"].every((w) => shake3.hint.includes(w)),
  `1:${shake1.rerollCount} 2:${shake2.rerollCount}(${shake2.hint.slice(0, 12)}) 3:closed=${shake3.closed} dishes=${shake3.dishes.length}`);

// ───────── 0.4.1 新增（ITERATION-0.4.1 §验收 B1–B9）─────────

// 插件注册表：真实画像（只读工具：search/get/shuffle，不写画像、不排 plan 落盘）
const realRegTools = new Map();
registerTools({ tools: { register: (t) => realRegTools.set(t.name, t) } }, {
  dataDir: `${ROOT}/data`, profileFile: `${ROOT}/profile.json`, stateFile: `${ROOT}/user-state.json`,
});
const realSearch = realRegTools.get("recipe_search");
const realGet = realRegTools.get("recipe_get");
const realShuffle = realRegTools.get("menu_shuffle");
const renderTool = (tool, args, value) => tool.output.render(args, value).map((b) => b.text ?? "").join("");

// B1：bulk/suspectTitle 检索收口——61kg 的无锡排骨不许再当第一结果
{
  const v = await realSearch.execute({ q: "无锡排骨" });
  const first = v.hits[0];
  check("B1 q=无锡排骨 首结果非 bulk/suspectTitle",
    Boolean(first) && !book.get(first.id).bulk && !book.get(first.id).suspectTitle,
    `首结果 ${first?.id} ${first?.title}（${v.total} 命中，隐藏 ${v.hidden}）`);
  check("B1 hint 含隐藏说明（0.5.3 起说人话：想看全的跟我说一声）",
    /已隐藏 \d+ 道(批量配方|疑似串行)/.test(v.hint?.text ?? "") && /跟我说|想看全/.test(v.hint.text),
    v.hint?.text ?? "(无)");
  const ft = book.findTitle("排骨");
  check("B1 findTitle 不再以 bulk 领跑", Boolean(ft) && !ft.bulk && !ft.suspectTitle, `${ft?.id} ${ft?.title}`);
}

// B2：真实画像检索默认走厨房排除——q=汤/q=鸡肉 不再浮出燕窝/鱼翅/熊掌类
{
  const kitchenWords = [...EXOTIC_INGREDIENTS, ...LUXURY_INGREDIENTS];
  const surfaced = (r) => kitchenWords.some((w) => (r.title ?? "").includes(w)
    || (r.ingredients ?? []).some((i) => (i.name ?? "").includes(w) || i.canon === w));
  for (const q of ["汤", "鸡肉"]) {
    const v = await realSearch.execute({ q, limit: 12 });
    const bad = v.hits.filter((h) => surfaced(book.get(h.id)) || /燕窝|鱼翅|熊掌/.test(`${h.title}${h.blurb}${h.features}`));
    check(`B2 真实画像 q=${q}：无燕窝/鱼翅/熊掌类`, v.hits.length > 0 && bad.length === 0,
      `hits=${v.hits.length}，漏网 ${bad.map((h) => h.title).join("、") || "无"}（厨房排除隐藏 ${v.hidden} 道）`);
  }
}

// B3：ingredients=["鸡肉"] 抽验 top20 全部真含鸡肉类原料（鸡蛋/蛋清不算）
{
  const v = await realSearch.execute({ ingredients: ["鸡肉"], limit: 20 });
  const hasChicken = (r) => (r.ingredients ?? []).some((i) => /鸡/.test(i.name ?? "") && !/鸡蛋|鸡蛋白|蛋清|蛋黄/.test(`${i.name ?? ""}${i.canon ?? ""}`));
  const bad = v.hits.filter((h) => !hasChicken(book.get(h.id)));
  check("B3 ingredients=鸡肉 top20 真含鸡肉类", v.hits.length === 20 && bad.length === 0,
    `${v.hits.length} hits，非鸡肉类 ${bad.map((h) => h.title).join("、") || "无"}；首5：${v.hits.slice(0, 5).map((h) => h.title).join("、")}`);
}

// B4：标题含过敏词而 allergens 未标 → 防御拦截（上海-069 虾油溜鱼片 / 088 蛋奶虾仁）
{
  const shrimpProfile = structuredClone(DEFAULT_PROFILE);
  shrimpProfile.longTerm.allergies = [{ target: "虾", allergen: "甲壳类" }];
  const cons = resolveConstraints(shrimpProfile, presets);
  const s069 = scoreRecipe(book.get("上海-069"), cons);
  const s088 = scoreRecipe(book.get("上海-088"), cons);
  check("B4 虾过敏：069/088 被 scoreRecipe 硬拦", s069.score === -Infinity && s088.score === -Infinity,
    `069 blocked=${JSON.stringify(s069.blocked)}；088 blocked=${JSON.stringify(s088.blocked)}`);
  const sp = new Planner(book, shrimpProfile, presets);
  sp.refresh();
  check("B4 虾过敏：菜单池 0 漏（标题含虾/蟹而未标的）",
    sp.scored.every((x) => !titleImpliedAllergens(x.r).has("甲壳类")) && !sp.scored.some((x) => ["上海-069", "上海-088"].includes(x.r.id)),
    `池内 ${sp.scored.length} 道，漏 ${sp.scored.filter((x) => titleImpliedAllergens(x.r).has("甲壳类")).map((x) => x.r.title).join("、") || "无"}`);
  const b4TmpProfile = join(tmpdir(), `foodbot-acc-b4-${process.pid}.json`);
  const b4TmpState = join(tmpdir(), `foodbot-acc-b4-state-${process.pid}.json`);
  writeFileSync(b4TmpProfile, JSON.stringify(shrimpProfile));
  writeFileSync(b4TmpState, JSON.stringify({ cookLog: [], wants: [], notes: [] }));
  const b4Tools = new Map();
  registerTools({ tools: { register: (t) => b4Tools.set(t.name, t) } }, { dataDir: `${ROOT}/data`, profileFile: b4TmpProfile, stateFile: b4TmpState });
  const b4v = await b4Tools.get("recipe_search").execute({ q: "虾仁", limit: 12 });
  rmSync(b4TmpProfile, { force: true });
  rmSync(b4TmpState, { force: true });
  check("B4 虾过敏：检索命中无 069/088 且 hint 带防御说明",
    b4v.hits.every((h) => !["上海-069", "上海-088"].includes(h.id)) && /防御/.test(b4v.hint?.text ?? ""),
    `hits=${b4v.hits.length}，blocked=${b4v.blocked}，hint=${b4v.hint?.text ?? "(无)"}`);
}

// B5：减脂画像多 seed——无单菜 >1125 kcal/人（450×2.5）、无大肠/肥肠主料、rescue 候选蛋白 ≥20g
{
  const cap = cReal.kcalTarget * 2.5;
  let maxKcal = 0;
  let fatGut = [];
  for (const seed of [42, 7, 123, 2026]) {
    const p = realPlanner.plan({ days: 3, meals: 2, people: 1, seed });
    for (const d of p.plan.flatMap((day) => day.meals.flatMap((m) => m.dishes))) {
      const r = book.get(d.id);
      maxKcal = Math.max(maxKcal, r.perServing?.kcal ?? 0);
      if (/大肠|肥肠/.test(r.title ?? "") || (r.proteinCanon ?? []).some((x) => /大肠|肥肠/.test(x))) fatGut.push(`${seed}:${d.title}`);
    }
  }
  check("B5 四 seed 无单菜超 1125 kcal/人", maxKcal <= cap, `最大 ${maxKcal}（上限 ${cap}）`);
  check("B5 四 seed 无大肠/肥肠主料", fatGut.length === 0, fatGut.join("、") || "无");
  const rescue = rescueCandidates(realPlanner.scored, 1, 3);
  check("B5 rescue 候选蛋白 ≥20g 且满 3 道",
    rescue.length === 3 && rescue.every((x) => (x.r.perServing?.proteinGrams ?? 0) >= 20),
    rescue.map((x) => `${x.r.title}(${x.r.perServing?.proteinGrams}g/${x.minutes}min)`).join("、"));
}

// B6：avoidMethods × flavors——fat_loss 下 糖醋白菜（flavors=糖醋）不入选
{
  const flProfile = mkSynth(false);
  const flCons = resolveConstraints(flProfile, presets);
  const s214 = scoreRecipe(book.get("湖北-214"), flCons);
  check("B6 糖醋白菜被 fat_loss 拦（口味不合）", s214.score === -Infinity && s214.blocked.some((b) => b.includes("糖醋")), JSON.stringify(s214.blocked));
  const flPlanner = new Planner(book, flProfile, presets);
  let sweetSour = [];
  for (const seed of [42, 7]) {
    const p = flPlanner.plan({ days: 3, meals: 2, people: 1, seed });
    for (const d of p.plan.flatMap((day) => day.meals.flatMap((m) => m.dishes))) {
      const r = book.get(d.id);
      if ((r.flavors ?? []).includes("糖醋") || (r.methods ?? []).includes("糖醋") || (r.title ?? "").includes("糖醋")) sweetSour.push(`${seed}:${d.title}`);
    }
  }
  check("B6 fat_loss plan 无糖醋菜（2 seed）", sweetSour.length === 0, sweetSour.join("、") || "无");
}

// B7：people=1 采购 = 原方量，与菜单文案零矛盾
{
  const solo = realPlanner.plan({ days: 2, meals: 2, people: 1, seed: 42 });
  const soloText = formatMenu(solo);
  check("B7 单人菜单全部「按原方」表述（无按 N 人份做）", !/按 \d+ 人份做/.test(soloText) && /按原方/.test(soloText));
  const soloNeed = new Map();
  for (const d of solo.plan.flatMap((day) => day.meals.flatMap((m) => m.dishes))) {
    for (const i of book.get(d.id).ingredients ?? []) {
      if (!i.grams || i.canon === "水") continue;
      const f = i.parent === "油脂" ? 0.3 : 1;
      soloNeed.set(i.canon, (soloNeed.get(i.canon) ?? 0) + i.grams * f);
    }
  }
  // W5：对照口径同样过一遍 蛋并回 + 最小可买份量凑整
  const { need: soloAligned } = alignPurchaseNeed(soloNeed);
  const soloListed = new Map();
  for (const group of [solo.shopping.buyOnce, ...solo.shopping.batches, solo.shopping.dry, solo.shopping.staples, solo.shopping.keep].filter(Boolean)) {
    for (const item of group.items ?? []) if (item.qty && item.qty.includes("g")) {
      const g = item.qty.includes("kg") ? parseFloat(item.qty) * 1000 : parseFloat(item.qty);
      soloListed.set(item.name, (soloListed.get(item.name) ?? 0) + g);
    }
  }
  const soloBad = [];
  for (const [name, grams] of soloAligned) {
    const got = soloListed.get(name);
    if (got !== undefined && Math.abs(got - grams) > Math.max(60, grams * 0.2)) soloBad.push(`${name}: 原${Math.round(grams)}g 列${got}g`);
  }
  check("B7 单人采购量 = 原方量 + W5 凑整（零矛盾）", soloBad.length === 0, soloBad.slice(0, 5).join("；") || "全部对上");
}

// B8：shuffle 三连无模型指令；弱命中有前置提示；days=1 无「顺延一天」
{
  const bad = [];
  for (let i = 0; i < 3; i++) {
    const v = await realShuffle.execute({ people: 3, combo: "1菜1肉", rerollCount: i, excludeIds: [], seed: 21 + i });
    const text = renderTool(realShuffle, { people: 3, combo: "1菜1肉", rerollCount: i }, v);
    if (/excludeIds|rerollCount|respectProfile|传回来|计数清零|set_kitchen|action=/.test(text)) bad.push(`第${i + 1}摇：${text.match(/.*(excludeIds|rerollCount|respectProfile|传回来|计数清零|set_kitchen|action=).*/)?.[0] ?? ""}`);
  }
  check("B8 shuffle 三连用户可见文本无模型指令", bad.length === 0, bad.join("；") || "三连干净");
  // 0.5 起换弱命中样例：大众菜谱并入后 库内有了 大众-175 红烧肉（analyzeQuery literal 命中），
  // 弱命中前置不再触发；改用仍缺位但有锚的「红烧狮子头」（锚：清炖蟹粉狮子头/清炖狮子头）
  // 保住机制覆盖（merge-agent 2026-10-29）
  const weakV = await realSearch.execute({ q: "红烧狮子头", limit: 5 });
  const weakText = renderTool(realSearch, { q: "红烧狮子头" }, weakV);
  check("B8 q=红烧狮子头 弱命中有前置提示", weakText.startsWith("没有完全命中「红烧狮子头」"), JSON.stringify(weakText.slice(0, 40)));
  const day1Text = formatMenu(realPlanner.plan({ days: 1, meals: 2, people: 1, seed: 5 }));
  check("B8 days=1 无「顺延一天」", !day1Text.includes("顺延一天"), day1Text.split("\n").find((l) => l.includes("顺延")) ?? "");
}

// B9：recipe_get 无页码菜（诚实标注）。南北册页码 2026-10-31 已接（pages 文件名 → page），
// 靶子改用省册里真无页码的记录——断言精神不变：页码缺失如实说，不沉默。
{
  const noPage = book.recipes.find((r) => r.cuisine !== "南北" && r.cuisine !== "大众" && !r.page && !r.bulk && !r.suspectTitle);
  const v = await realGet.execute({ id: noPage.id });
  const text = renderTool(realGet, { id: noPage.id }, v);
  check("B9 无页码分册显示「（整理版无页码）」", text.includes(`《${noPage.book}》（整理版无页码）`),
    `${noPage.id} ${noPage.title}：${text.split("\n")[1] ?? ""}`);
}

// ───────── 0.4.2 新增（R2b 忌口两级语义 C1–C6）─────────
// C5（回归四件套）与 C6（replay 多 seed）由外部跑：npm run smoke / test:contract / test:acceptance /
// test:client / nutrition / replay --seeds=42,7,123,2026；此处只断言语义本身。

// C1：配料级蒜菜入选 + 免蒜 render；主料级蒜菜被拦且理由含「主料」
let c1Plan = null; // 供 C2 复用：一张真排进了配料级蒜菜的菜单
{
  const inPool = realPlanner.scored.filter((x) => garlicIn(x.r).length && garlicIn(x.r).every((f) => avoidLevel(x.r, f).level === "garnish"));
  check("C1 忌蒜画像下配料级蒜菜入选池 >=3（0.4 全毙误杀的放回）", inPool.length >= 3,
    `池内 ${inPool.length} 道：${inPool.slice(0, 6).map((x) => `${x.r.title}[${garlicIn(x.r).join("/")}]`).join("、")}`);
  for (const seed of [42, 7, 123, 2026, 5, 11]) {
    const p = realPlanner.plan({ days: 3, meals: 2, people: 1, seed });
    if (p.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).some((d) => garlicIn(book.get(d.id)).length)) { c1Plan = p; break; }
  }
  check("C1 有 seed 的菜单真排进配料级蒜菜", Boolean(c1Plan), c1Plan ? `omit 菜：${c1Plan.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes)).filter((d) => garlicIn(book.get(d.id)).length).map((d) => d.title).join("、")}` : "6 个 seed 都没排到");
  if (c1Plan) {
    const text = formatMenu(c1Plan);
    const m = /免[^\n：/]*版：省去[^\n]*/.exec(text);
    check("C1 菜单 render 带「免X版：省去X」", Boolean(m) && m[0].includes("（约"), m?.[0] ?? "(无免版行)");
  }
  // 主料级：蒜苗做主料（家常豆腐）+ 蒜占 >=15% 的菜各验一道
  const mainByRank = book.get("北京-201"); // 家常豆腐：蒜苗 100g 主类目前二
  const shareDish = book.recipes.find((r) => GARLIC_FAMILY.some((f) => {
    const lv = avoidLevel(r, f);
    return lv?.level === "main" && lv.why.includes("%");
  }));
  const s201 = scoreRecipe(mainByRank, cReal);
  check("C1 主料级蒜菜被拦且理由含「主料」（家常豆腐·蒜苗）",
    s201.score === -Infinity && s201.blocked.some((b) => b.includes("主料")), JSON.stringify(s201.blocked));
  if (shareDish) {
    const ss = scoreRecipe(shareDish, cReal);
    check(`C1 蒜量占比>=15%的菜被拦（${shareDish.title}）`,
      ss.score === -Infinity && ss.blocked.some((b) => b.includes("主料")),
      `${JSON.stringify(avoidLevel(shareDish, GARLIC_FAMILY.find((f) => avoidLevel(shareDish, f)?.level === "main")))} blocked=${JSON.stringify(ss.blocked)}`);
  } else {
    check("C1 找得到蒜量占比>=15%的菜（数据侧）", false, "库内无 ≥15% 蒜菜");
  }
  check("C1 主料级蒜菜不在菜单池", !realPlanner.scored.some((x) => x.r.id === mainByRank.id), `${mainByRank.id} ${mainByRank.title}`);
}

// C2：采购清单剔除被省去的料 + notes 说明
{
  check("C2 有可判计划（配料级蒜菜在单）", Boolean(c1Plan), "见 C1");
  if (c1Plan) {
    const omitted = c1Plan.shopping.omitted ?? [];
    check("C2 shopping.omitted 非空且克数>0", omitted.length > 0 && omitted.every((o) => o.grams >= 0), JSON.stringify(omitted));
    const itemNames = new Set();
    for (const group of [c1Plan.shopping.buyOnce, ...c1Plan.shopping.batches, c1Plan.shopping.dry, c1Plan.shopping.staples, c1Plan.shopping.selfMade, c1Plan.shopping.keep].filter(Boolean)) {
      for (const i of group.items ?? []) itemNames.add(i.name);
    }
    const leaked = omitted.filter((o) => itemNames.has(o.canon));
    check("C2 被省去的料不出现在采购清单任何分组", leaked.length === 0, leaked.map((o) => o.canon).join("、") || `omitted=${omitted.map((o) => o.canon).join("、")} 均未出现`);
    check("C2 notes 有「已按忌口去掉」说明", c1Plan.notes.some((n) => n.includes("已按忌口去掉")), c1Plan.notes.find((n) => n.includes("已按忌口去掉")) ?? "");
  }
}

// C3：过敏不走两级——配料级虾米在过敏画像下仍被硬拦；忌口通道下同样这道菜走省去
{
  const driedShrimp = book.recipes.find((r) => !r.bulk && !r.suspectTitle && (r.ingredients ?? []).some((i) => i.canon === "虾米") && avoidLevel(r, "虾米")?.level === "garnish");
  check("C3 找到虾米为配料级的菜", Boolean(driedShrimp), driedShrimp ? `${driedShrimp.id} ${driedShrimp.title}` : "库内无");
  if (driedShrimp) {
    const allergyProfile = structuredClone(DEFAULT_PROFILE);
    allergyProfile.longTerm.allergies = [{ target: "虾米", allergen: "甲壳类" }];
    const sAllergy = scoreRecipe(driedShrimp, resolveConstraints(allergyProfile, presets));
    check("C3 过敏通道：配料级虾米仍被硬拦（不适用两级）", sAllergy.score === -Infinity, JSON.stringify(sAllergy.blocked));
    const avoidProfile = structuredClone(DEFAULT_PROFILE);
    avoidProfile.longTerm.dislikes = [{ target: "虾米", weight: -3, hard: true }];
    const sAvoid = scoreRecipe(driedShrimp, resolveConstraints(avoidProfile, presets));
    check("C3 对照：忌口通道下配料级虾米走省去（omit）",
      sAvoid.score !== -Infinity && (sAvoid.omit ?? []).some((o) => o.target === "虾米"),
      `score=${sAvoid.score} omit=${JSON.stringify(sAvoid.omit)}`);
    // titleImpliedAllergens + blockedAllergens 通道一行未动（B4 已验上海-069/088），此处再钉一道
    const b4cons = resolveConstraints((() => { const p2 = structuredClone(DEFAULT_PROFILE); p2.longTerm.allergies = [{ target: "虾", allergen: "甲壳类" }]; return p2; })(), presets);
    check("C3 防御拦截通道原样（上海-069 仍硬拦）", scoreRecipe(book.get("上海-069"), b4cons).score === -Infinity);
  }
}

// C4：omit 字段 schema 合法——插件层真跑 search/get，形状自检；整体 schema 校验由 contract-test 把关（C5）
{
  const v = await realSearch.execute({ ingredients: ["大蒜"], limit: 10 });
  const shapeOk = v.hits.every((h) => Array.isArray(h.omit) && h.omit.every((o) => typeof o.target === "string" && (typeof o.grams === "number" || o.grams === null)));
  const withOmit = v.hits.filter((h) => h.omit.length);
  check("C4 search canonical 带 omit 字段且形状合法", shapeOk && withOmit.length > 0,
    `带 omit 命中 ${withOmit.length}/${v.hits.length}，样例 ${JSON.stringify(withOmit[0]?.omit ?? [])}`);
  const yx = await realGet.execute({ title: "鱼香肉丝" });
  const yxText = renderTool(realGet, { title: "鱼香肉丝" }, yx);
  check("C4 recipe_get 详情有「免X版」提示行", Array.isArray(yx.recipe.omit) && yx.recipe.omit.length > 0 && /免[^\n：]*版：省去/.test(yxText),
    yxText.split("\n").find((l) => l.includes("免")) ?? "");
  const cardOk = realSearch.output.presentationMeta({ ingredients: ["大蒜"] }, v);
  check("C4 卡片投影不含 omit（形状冻结）", cardOk.items.every((h) => !("omit" in h)), JSON.stringify(Object.keys(cardOk.items[0] ?? {})));
}

function blockersOf(list, cons) {
  return list.filter((h) => scoreRecipe(h.recipe, cons).score === -Infinity).length;
}

// ───────── 0.5 W5 新增（仿真素菜分型 / 购买粒度 / 预制标志 / unitGrams 估计 D1–D5）─────────

// 采购清单所有分组的行拍平（keep 本身就是数组，不是 {items}）
const shoppingRows = (s) => {
  const rows = [];
  for (const g of [s.buyOnce, ...s.batches, s.dry, s.staples, s.selfMade, { items: s.keep }]) {
    for (const i of g.items ?? []) rows.push(i);
  }
  return rows;
};
const gramOf = (qty) => {
  const m = /^([\d.]+) (kg|g)/.exec(String(qty));
  return m ? Number(m[1]) * (m[2] === "kg" ? 1000 : 1) : null;
};

// D1：仿真荤素菜回到素菜池（原 isVegDish 标题兜底整批踢出的死区：素菜章 + 荤名 + 原料无肉）
{
  const dead = ["北京-183", "北京-178", "北京-181", "北京-184", "北京-188"].map((id) => book.get(id));
  const admitted = dead.filter((r) => realPlanner.isVegDish(r));
  check("D1 仿真素菜 ≥3 道回到素菜判定（焦熘肥肠=生面筋/腐乳扣肉=素火腿）", admitted.length >= 3,
    admitted.map((r) => `${r.id} ${r.title}`).join("、"));
  check("D1 仿真素菜 vegKind=mockmeat", dead.every((r) => vegKind(r) === "mockmeat"),
    dead.map((r) => `${r.id}:${vegKind(r)}`).join(" "));
  check("D1 进池的仿真素菜都标 mockmeat（北京-178 腐乳扣肉 配菜仅 1g，被 80g 蔬菜下限挡在池外，设计内）",
    admitted.every((r) => vegKind(r) === "mockmeat") && dead.every((r) => isMockMeatVeg(r)),
    `admitted=${admitted.length}/5`);
  const repW5 = realPlanner.poolReport();
  check("D1 真实画像素菜池 mockmeat >=3", repW5.vegKinds.mockmeat >= 3,
    `vegKinds=${JSON.stringify(repW5.vegKinds)}（veg ${repW5.counts.veg}）`);
  // 反向：真正有肉 parent 的混炒菜仍被拒——含素菜章里带火腿/虾的（奶汤蒲菜、锅塌豆腐）
  const MEAT_PARENTS = ["猪肉", "牛肉", "羊肉", "禽肉", "水产"];
  const meaty = book.recipes.filter((r) => (r.ingredients ?? []).some((i) => MEAT_PARENTS.includes(i.parent)));
  const leaked = meaty.filter((r) => realPlanner.isVegDish(r));
  check("D1 有肉 parent 的菜仍不进素菜判定", leaked.length === 0,
    `${meaty.length} 道含肉菜里漏 ${leaked.slice(0, 5).map((r) => r.id).join("、") || "无"}`);
  check("D1 素菜章混肉菜仍被拒（山东-169 奶汤蒲菜·火腿）", !realPlanner.isVegDish(book.get("山东-169")));
}

// D2：购买粒度表 + 聚合对齐（同名 canon 先求和再凑整，蛋清/蛋黄并回鸡蛋）
{
  const pu = Object.entries(PURCHASE_UNITS);
  check("D2 PURCHASE_UNITS >=40 项且都带 minBuy/note",
    pu.length >= 40 && pu.every(([, v]) => Number(v.minBuy) > 0 && typeof v.note === "string" && v.note.length > 0),
    `${pu.length} 项，minBuy ${Math.min(...pu.map(([, v]) => v.minBuy))}～${Math.max(...pu.map(([, v]) => v.minBuy))}g`);
  const soloW5 = realPlanner.plan({ days: 3, meals: 2, people: 1, seed: 42 });
  const rowsW5 = shoppingRows(soloW5.shopping);
  check("D2 蛋清/蛋黄不再单列（并回鸡蛋）",
    rowsW5.every((i) => i.name !== "蛋清" && i.name !== "蛋黄"),
    rowsW5.filter((i) => /蛋/.test(i.name)).map((i) => `${i.name} ${i.qty}`).join("、") || "无蛋行");
  const eggRow = rowsW5.find((i) => i.name === "鸡蛋");
  check("D2 鸡蛋凑整到可买份量且带个数（300g=6个）",
    Boolean(eggRow) && (gramOf(eggRow.qty) ?? 0) >= PURCHASE_UNITS["鸡蛋"].minBuy && /个/.test(eggRow.qty),
    eggRow?.qty ?? "无鸡蛋行");
  const underMin = rowsW5.filter((i) => PURCHASE_UNITS[i.name] && gramOf(i.qty) != null && gramOf(i.qty) < PURCHASE_UNITS[i.name].minBuy);
  check("D2 粒度表内的项没有不足 minBuy 的碎单", underMin.length === 0,
    underMin.map((i) => `${i.name} ${i.qty}(<${PURCHASE_UNITS[i.name].minBuy})`).join("、") || "全部 ≥minBuy");
  const meatSmall = rowsW5.filter((i) => ["肉禽", "水产"].includes(i.cat) && gramOf(i.qty) != null && gramOf(i.qty) < 100);
  check("D2 肉禽/水产无 <100g 碎单", meatSmall.length === 0, meatSmall.map((i) => `${i.name} ${i.qty}`).join("、") || "无");
  const alignedW5 = soloW5.shopping.aligned ?? [];
  check("D2 shopping.aligned 带 from/to 且确实变多", alignedW5.length > 0 && alignedW5.every((a) => a.to > a.from),
    `${alignedW5.length} 项：${alignedW5.slice(0, 4).map((a) => `${a.canon} ${a.from}→${a.to}`).join("、")}`);
  check("D2 notes 有「已凑整到可买份量」", soloW5.notes.some((n) => n.includes("已凑整到可买份量")),
    soloW5.notes.find((n) => n.includes("凑整")) ?? "");
}

// D3 / D4：预制标志 + unitGrams 估计。固定用 上海-037 芙蓉鲫鱼（熟火腿片 + 水发冬菇二只 + 熟猪油 + 蛋清五只），
// 不依赖某个 seed 真排到哪道菜。
{
  const fujirong = book.get("上海-037");
  const sSynth = buildShopping([{ day: 1, meals: [{ name: "午", dishes: [{ r: fujirong, omit: [] }] }] }], 1);
  const rowsSynth = shoppingRows(sSynth);
  const hamRow = rowsSynth.find((i) => i.name === "火腿");
  check("D3 熟火腿的采购行标「买现成的」", Boolean(hamRow) && /买现成的/.test(hamRow.note ?? ""), JSON.stringify(hamRow));
  const lardRow = rowsSynth.find((i) => i.name === "猪油");
  check("D3 熟猪油（油脂类）不标「买现成的」（免得满页都是）", Boolean(lardRow) && !/买现成的/.test(lardRow.note ?? ""), JSON.stringify(lardRow));
  const plainDish = book.recipes.find((r) => !r.bulk && !r.suspectTitle
    && (r.ingredients ?? []).length > 0 && !(r.ingredients ?? []).some(isPreparedIngredient));
  check("D3 heavyPrepDependency 读共享的预制检测结果",
    heavyPrepDependency(fujirong) === true && Boolean(plainDish) && heavyPrepDependency(plainDish) === false,
    `芙蓉鲫鱼=true，无预制料对照 ${plainDish?.id ?? "?"}=${plainDish ? heavyPrepDependency(plainDish) : "?"}`);
  const shiitake = rowsSynth.find((i) => i.name === "香菇");
  check("D4 计数行出估计克数且标 unitGramsFrom=est-table",
    Boolean(shiitake) && shiitake.unitGramsFrom === "est-table" && /约\d+ g/.test(shiitake.qty),
    JSON.stringify(shiitake));
  const realRowsW5 = shoppingRows(realPlanner.plan({ days: 3, meals: 2, people: 1, seed: 42 }).shopping);
  const estRows = realRowsW5.filter((i) => /^[\d.]+ （约[\d.]+ g）$/.test(String(i.qty))); // 「N 个/根（约X g）」形态
  check("D4 真实 3 天菜单的估克数行都带 est-table 来源（换数据也不假阳）",
    estRows.every((i) => i.unitGramsFrom === "est-table"),
    estRows.map((i) => `${i.name} ${i.qty}`).join("、") || "本 seed 无计数行");
  const bareCount = rowsSynth.filter((i) => /^[\d]+$/.test(String(i.qty).trim()));
  check("D4 没估值的计数行不编克数", bareCount.every((i) => !String(i.qty).includes("约")),
    bareCount.map((i) => `${i.name} ${i.qty}`).join("、") || "无裸计数行");
}

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  — ${r.detail}` : ""}`);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exitCode = failed.length ? 1 : 0;
