/**
 * 规划引擎：从一个"能吃/能做/爱吃"的候选池里组菜单、算采购、随机摇。
 *
 * 三条硬规则（来自实际做饭的限制，不是口味）：
 *   1. 叶菜类只在第 1–2 天出现，第 3 天起换成根茎/瓜/菌菇/豆制品（菜买一次不可能撑一周）
 *   2. 肉、水产一次买够，按整块/整只买，冷冻分装
 *   3. 同一顿饭不重复同一种主料；同一道菜整周不重复
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConstraints, scoreRecipe, highFatMainLevel } from "./profile.mjs";
import { recentCooks, verdicts, openWants, liveLeftovers } from "./state.mjs";
import { estimateMinutes, tableNotes, energyBudget, breakfastAdvice, isPreparedIngredient } from "./care.mjs";
import { PURCHASE_UNITS } from "./lexicon.mjs";
import { lookup } from "./ingredients.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ───────── 素菜分型词表（ITERATION-0.4 §3.1.1） ─────────
// 肉类 parent：命中即不算素菜（宁可漏，不可错标）
const MEAT_PARENTS = new Set(["猪肉", "牛肉", "羊肉", "禽肉", "水产"]);
// 荤腥标题兜底（原 isVegDish 里的内联正则抽成常量；「素鸡」「素火腿」类仿真素菜由 /素/ 放行）
const MEATY_TITLE_RE = /猪|鸡|鸭|牛|羊|鱼|虾|蟹|肉|火腿|腊|肠|肚|肝|腰|排骨|蹄|肘|膀|掌|舌|脑|血|筋|肫|胗|鳝|鳗/;
// W5 仿真荤素菜：书里自己归进素菜章（chapter/chapterRaw 任一），原料也没有肉 parent，
// 只是菜名借了荤腥的形——北京-183 焦熘肥肠是生面筋、北京-178 腐乳扣肉是素火腿、
// 北京-188 炒鳝鱼丝是香菇丝。这些菜原先被标题兜底整批踢出素菜池（全库 36 道）。
const VEG_CHAPTER_RE = /素菜/;

/** 是否仿真荤素菜（素菜章 + 荤腥标题 + 标题不带「素」 + 原料无肉 parent） */
export function isMockMeatVeg(r) {
  const title = r.title ?? "";
  if (!VEG_CHAPTER_RE.test(r.chapter ?? "") && !VEG_CHAPTER_RE.test(r.chapterRaw ?? "")) return false;
  if (!MEATY_TITLE_RE.test(title) || /素/.test(title)) return false;
  if ((r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent))) return false;
  return true;
}

// 绿叶菜（当天吃最新鲜，第 3 天起不再排）：现有集合 + 上海青/油麦菜/芥蓝/空心菜/苋菜/茼蒿/娃娃菜/西蓝花/莴笋
const LEAFY = new Set([
  "青菜", "菠菜", "油菜", "韭菜", "韭黄", "香菜", "荠菜", "草头", "马兰头", "枸杞头", "生菜", "西洋菜", "紫苏叶", "蒜苗", "芹菜", "豌豆苗", "豆芽", "大白菜",
  "上海青", "油麦菜", "芥蓝", "空心菜", "苋菜", "茼蒿", "娃娃菜", "西蓝花", "西兰花", "莴笋", "雪里蕻", "莼菜", "豌豆尖", "香椿", "冬苋菜", "菜胆", "葵菜", "鸡毛菜", "塌棵菜", "圆生菜",
]);
// 根茎瓜果（vegKind 的 sturdy；菌菇/笋/豆制品不算，见 FUNGI/BAMBOO）
const STURDY_ROOT = new Set([
  "土豆", "山药", "芋艿", "芋头", "藕", "萝卜", "胡萝卜", "冬瓜", "南瓜", "洋葱", "大白菜", "卷心菜", "包菜",
  "茄子", "番茄", "黄瓜", "丝瓜", "苦瓜", "瓠子", "荸荠", "豌豆", "蚕豆", "毛豆", "茭白", "花菜", "菜花", "四季豆", "豆角", "豇豆", "玉米", "红薯", "地瓜", "慈菇", "菱角", "百合", "芦笋",
]);
// 耐放菜（保鲜规则用）：根茎瓜果 + 菌菇 + 笋 + 豆制品，第 3 天起靠它们撑
const STURDY = new Set([...STURDY_ROOT, "木耳", "香菇", "蘑菇", "口蘑", "笋", "玉兰片", "腐竹", "豆腐", "豆腐干", "百叶", "粉丝"]);
// 菌菇（含数据里的变体写法：寒菌/鲜蘑/羊肚菌/花蘑……）
const FUNGI = new Set(["香菇", "蘑菇", "口蘑", "木耳", "银耳", "竹荪", "草菇", "金针菇", "松茸", "猴头菇"]);
const FUNGI_RE = /菇|菌|蘑|竹荪|木耳|银耳|石耳/;
// 笋类（玉兰片是笋干，按笋算）
const BAMBOO_RE = /笋|玉兰片/;

/**
 * 素菜分型（§3.1.4）：leafy 绿叶 / sturdy 根茎瓜果 / fungi 菌菇笋 / eggtofu 蛋豆制品 /
 * mockmeat 仿真荤（W5，面筋素鸡这类素料做荤形）/ other。
 * mockmeat 排最前：仿真荤菜的 vegCanon 只是一把配菜（焦熘肥肠 250g 面筋配 175g 笋菇豌豆），
 * 按 vegCanon 分型会把它们算进 fungi，跟着「非笋菇」的口径一起失真。
 */
export function vegKind(r) {
  if (isMockMeatVeg(r)) return "mockmeat";
  const v = r.vegCanon ?? [];
  if (v.some((x) => LEAFY.has(x))) return "leafy";
  if (v.some((x) => STURDY_ROOT.has(x))) return "sturdy";
  if (v.some((x) => FUNGI.has(x) || FUNGI_RE.test(x) || BAMBOO_RE.test(x))) return "fungi";
  if (v.length === 0 && (r.ingredients ?? []).some((i) => i.parent === "蛋" || i.parent === "豆制品")) return "eggtofu";
  return "other";
}

/** 是否笋/菌菇菜（「非笋菇 ≥2 道」与 poolReport 的 nonFungiVeg 都按这个口径） */
export function isFungiBamboo(r) {
  return (r.vegCanon ?? []).some((x) => FUNGI.has(x) || FUNGI_RE.test(x) || BAMBOO_RE.test(x));
}

const COMBOS = {
  "1菜1肉": [{ role: "protein", n: 1 }, { role: "veg", n: 1 }],
  "2菜1肉": [{ role: "protein", n: 1 }, { role: "veg", n: 2 }],
  "2菜2肉": [{ role: "protein", n: 2 }, { role: "veg", n: 2 }],
  "1菜1肉1汤": [{ role: "protein", n: 1 }, { role: "veg", n: 1 }, { role: "soup", n: 1 }],
  "3菜1肉": [{ role: "protein", n: 1 }, { role: "veg", n: 3 }],
};

const SLOT_NAMES = ["午", "晚"];

/**
 * 意图/精力/时间上限的统一解析（§3.6）。优先级写死：显式 maxMinutes > energy > intent。
 *   intent=fast  → 等价 energy=tired（≤35 分钟、easy）
 *   intent=learn → 等价 energy=good 且上限放到 180 分钟；tier 放开到 easy+learn
 *                  （hard 仍然要画像 allowTiers 允许——「炸麻烦」不该被一个参数绕过）
 */
function resolveRunBudget(opts, allowTiers) {
  const intent = opts.intent === "fast" || opts.intent === "learn" ? opts.intent : null;
  const energy = opts.energy ?? (intent === "fast" ? "tired" : intent === "learn" ? "good" : "normal");
  const budget = energyBudget(energy);
  const explicit = Number(opts.maxMinutes);
  const maxMinutes = Number.isFinite(explicit) && explicit > 0
    ? Math.min(explicit, 240)
    : intent === "learn" ? 180 : budget.maxMinutes;
  let tiers;
  if (intent === "learn") {
    tiers = ["easy", "learn"];
    if (allowTiers.has("hard")) tiers.push("hard");
  } else {
    tiers = budget.tiers.filter((t) => allowTiers.has(t));
    if (!tiers.length) tiers = [...allowTiers];
  }
  return { intent, energy, maxMinutes, tiers };
}

/** 按人数决定一餐配几个菜：2-3 人一菜一肉，4 人一荤两素，5-6 人两荤两素 */
function autoCombo(people) {
  if (people <= 3) return [{ role: "protein", n: 1 }, { role: "veg", n: 1 }];
  if (people === 4) return [{ role: "protein", n: 1 }, { role: "veg", n: 2 }];
  return [{ role: "protein", n: 2 }, { role: "veg", n: 2 }];
}

// 家宴/看盘菜：好看，但一周菜单里放不下（一次要做整鸭整鸡、十几个配料）
const BANQUET = /拼盘|冷盘|花篮|攒盒|孔雀|龙凤|全席|满坛|三套|一品锅|看盘|花鸟|折扇|荷花|牡丹|菊花|兰花/;
// 买不到或不合适的原料（默认不进菜单；想放开就把 kitchen.excludeExotic 设成 false）
const EXOTIC = new Set(["狗肉", "蛇", "果子狸", "穿山甲", "鹿", "狍子", "野鸭", "野鸡", "山鸡", "铁雀", "麻雀", "禾花雀", "鹰", "獐子", "驼峰", "熊掌", "犴鼻", "鹿尾", "猩唇", "豹胎", "虎"]);
// 贵价干货：一周家常菜单里不放（想放开就把 kitchen.excludeLuxury 设成 false）
const LUXURY = new Set(["鱼翅", "鱼肚", "鱼唇", "明骨", "燕窝", "海参", "猴头", "鲍鱼", "鹿筋", "蛤士蟆", "熊掌", "鱼皮", "干贝"]);

export class Planner {
  /**
   * @param {import("./query.mjs").RecipeBook} book
   * @param {object} profile
   * @param {object} presets  data/presets.json 的 presets
   */
  constructor(book, profile, presets = {}, state = null) {
    this.book = book;
    this.profile = profile;
    this.presets = presets;
    this.state = state;
    this.people = profile.household?.size ?? 2;
    this.c = null;
    this.scored = [];
  }

  /** 日常可做性：份量、复杂度、食材可得性。宴席菜和野味默认剔除。 */
  practical(r) {
    const excludeExotic = this.profile.kitchen?.excludeExotic !== false;
    const excludeLuxury = this.profile.kitchen?.excludeLuxury !== false;
    if (!r.servingsBase || r.servingsBase > Math.max(6, this.people + 2)) return false;
    if (r.bulk) return false;   // 餐馆批量配方（一百斤排骨那种）
    if (r.suspectTitle) return false; // 同册同名、疑标题串行
    if ((r.totalGrams ?? 0) > 3000) return false;
    // 减脂周期 × 主料级高脂 → 不进候选（scoreRecipe 的 block 只影响打分展示，
    // 候选池的守门在这里——奶汤鸡脯两次漏进菜单的补丁）
    if (this.c?.lowFat === true && highFatMainLevel(r) === "main") return false;
    // 主料上限随人数走：一只 750g 的蹄膀够 5 个人，两个人吃就太多
    if ((r.proteinFoodGrams ?? 0) > Math.max(400, this.people * 180)) return false;
    if (BANQUET.test(r.title)) return false;
    if ((r.ingredients ?? []).length > 16) return false;
    if (/野味/.test(r.chapter ?? "")) return false;
    const exoticHit = (set) => [...set].some((w) => (r.title ?? "").includes(w) || (r.ingredients ?? []).some((i) => (i.name ?? "").includes(w) || i.canon === w));
    if (excludeExotic && exoticHit(EXOTIC)) return false;
    if (excludeLuxury && exoticHit(LUXURY)) return false;
    return true;
  }

  isProteinDish(r) {
    const p = r.proteinFoodGrams ?? 0;
    const v = r.vegGrams ?? 0;
    return p >= 100 && p >= v * 0.8;
  }

  /** 是不是一道素菜（§3.1.2）：有肉即 false；蔬菜量下限 80g；荤腥标题兜底。不再用蛋白排除蛋/豆制品。 */
  isVegDish(r) {
    if ((r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent))) return false;
    if ((r.vegGrams ?? 0) < 80) return false;
    // W5：仿真荤素菜放行（焦熘肥肠=面筋、腐乳扣肉=素火腿）——素菜章 + 无肉 parent 的，
    // 菜名借荤形不再是出池的理由；蔬菜量下限照样守（面筋/素鸡记在 proteinFoodGrams，
    // 纯豆制品主菜没有 80g 配菜就不算素菜）。真正混了肉的仍被第一条挡住。
    if (isMockMeatVeg(r)) return true;
    // 兜底：非素菜章、菜名里带荤腥的，就算原料没认出来也不当素菜（「素鸡」「素火腿」这类仿真素菜放行）
    if (!/素/.test(r.title) && MEATY_TITLE_RE.test(r.title)) return false;
    return true;
  }

  /** 全量打分一次，结果缓存；画像或状态变了就 refresh() 重建。 */
  refresh() {
    const c = resolveConstraints(this.profile, this.presets);
    const verdict = this.state ? verdicts(this.state) : { never: new Set(), loved: new Set() };
    const recent = this.state ? recentCooks(this.state) : { byId: new Map(), byTitle: new Map() };
    const wants = this.state ? openWants(this.state) : [];
    const wantTitles = new Set(wants.map((w) => w.title).filter(Boolean));
    // §3.6：learn 档（要练但不危险）保留在候选里、默认场景强降权，给 intent=learn 留活口；
    // hard 档（炸为主）仍然只有画像 allowTiers 允许才进得来。默认的 tier 过滤会把它们挡在菜单外。
    const cScore = { ...c, allowTiers: new Set([...c.allowTiers, "learn"]) };
    this.c = c; // 必须在 scored 循环前赋值：循环里的 practical() 依赖 fresh 约束（lowFat 高脂守门曾被旧值/空值放行）
    const scored = [];
    for (const r of this.book.recipes) {
      if (verdict.never.has(r.id) || verdict.never.has(r.title)) continue; // 你说过不想再吃
      const s = scoreRecipe(r, cScore);
      if (s.score === -Infinity) continue;
      if (!this.practical(r)) continue;
      let score = s.score;
      if (r.skill?.tier === "learn" && !c.allowTiers.has("learn")) score -= 6; // 不在技能档内，明显靠后
      if (r.servingsBase <= 4) score += 0.6;          // 家常份量优先
      score += Math.max(0, 3 - Math.abs(r.servingsBase - this.people)) * 0.25; // 份量贴近人数
      if ((r.ingredients ?? []).length <= 10) score += 0.4; // 备料少的优先
      if ((r.proteinFoodGrams ?? 0) > 300) score -= 2;
      // 记性：最近做过的先放一放，说好吃的加分，你念叨过的往前排
      const recentDays = Math.min(recent.byId.get(r.id) ?? 999, recent.byTitle.get(r.title) ?? 999);
      if (recentDays <= 12) score -= (13 - recentDays) * 0.35;
      if (verdict.loved.has(r.id) || verdict.loved.has(r.title)) score += 1.5;
      const isWant = wantTitles.has(r.title);
      if (isWant) score += 6;
      const minutes = estimateMinutes(r);
      if ((r.perServing?.proteinGrams ?? 0) > 60) score -= 1; // 单人一餐吃不下这么多蛋白
      // R2b：配料级忌口的菜照常入选，带 omit（料名+约克数）——render 免 X 版、采购剔除都靠它
      scored.push({ r, score, reasons: s.reasons, minutes, isWant, recentDays: recentDays <= 12 ? recentDays : null, omit: s.omit ?? [] });
    }
    scored.sort((a, b) => b.score - a.score);
    this.scored = scored;
    return this;
  }

  /** 按「主料克数」分池，而不是按人均蛋白——人均会被大份菜稀释，分错池。顺序（§3.1.3）：汤 → 素 → 荤 → 配菜。 */
  pools({ maxMinutes = 999, tiers = null } = {}) {
    const protein = [];
    const veg = [];
    const soup = [];
    const side = [];
    for (const item of this.scored) {
      const { r } = item;
      if (item.minutes > maxMinutes) continue;
      if (tiers && !tiers.includes(r.skill?.tier)) continue;
      const prot = r.proteinFoodGrams ?? 0;
      const vegG = r.vegGrams ?? 0;
      const per = r.perServing?.proteinGrams ?? 0;
      // 甜菜类：荤的甜菜/甜汤不进任何池（不当正餐）；素甜菜（蜜汁甜藕这类）计入素菜供给池，
      // 但菜单选择时有甜菜守卫挡掉——池子口径量供给，菜单口径管吃饭。
      const isSweetChapter = /甜菜/.test(r.chapter ?? "");
      if (isSweetChapter) {
        if (this.isVegDish(r)) veg.push(item);
        continue;
      }
      const hasMeat = (r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent));
      const isSoup = /汤|羹/.test(r.title) && prot < 150;
      if (isSoup) { soup.push(item); continue; }
      // 素菜判定先于荤：豆腐/面筋/蛋即使蛋白主料 ≥100g 也归素（修复"素菜池只剩笋菇"）
      if (this.isVegDish(r)) {
        veg.push(item);
      } else if (hasMeat && prot >= 100 && prot >= vegG * 0.8) {
        protein.push(item);
      }
      // 荤素各半的混炒两边都不进，避免把"方块肉"当素菜；配菜可同时已在素菜池
      if (per >= 8 && per <= 32 && prot <= 200 && (r.ingredients ?? []).length <= 8 && r.skill?.tier === "easy") side.push(item);
    }
    return { protein, veg, soup, side };
  }

  /** 素菜池诊断（§3.1.5）：构成、分型、非笋菇数量、样例。A1 门禁的数字来源。 */
  poolReport({ maxMinutes = 999, tiers = null } = {}) {
    const p = this.pools({ maxMinutes, tiers });
    const vegKinds = { leafy: 0, sturdy: 0, fungi: 0, mockmeat: 0, eggtofu: 0, other: 0 };
    const canonCnt = new Map();
    let nonFungiVeg = 0;
    let eggTofuDishes = 0;
    let vegSweetChapter = 0;
    const samples = { leafy: [], sturdy: [], fungi: [], mockmeat: [] };
    for (const { r } of p.veg) {
      const k = vegKind(r);
      vegKinds[k] += 1;
      if (k === "leafy" && samples.leafy.length < 8) samples.leafy.push(r.title);
      if (k === "sturdy" && samples.sturdy.length < 8) samples.sturdy.push(r.title);
      if (k === "fungi" && samples.fungi.length < 8) samples.fungi.push(r.title);
      if (k === "mockmeat" && samples.mockmeat.length < 8) samples.mockmeat.push(r.title);
      if (!isFungiBamboo(r)) nonFungiVeg += 1;
      if ((r.ingredients ?? []).some((i) => i.parent === "蛋" || i.parent === "豆制品")) eggTofuDishes += 1;
      if (/甜菜/.test(r.chapter ?? "")) vegSweetChapter += 1;
      for (const v of r.vegCanon ?? []) canonCnt.set(v, (canonCnt.get(v) ?? 0) + 1);
    }
    // 菜单口径：甜菜类不进菜单（甜菜守卫），这两个数是菜单真正能排到的素菜
    const menuVeg = p.veg.length - vegSweetChapter;
    const menuNonFungiVeg = p.veg.filter(({ r }) => !isFungiBamboo(r) && !/甜菜/.test(r.chapter ?? "")).length;
    return {
      counts: { protein: p.protein.length, veg: p.veg.length, soup: p.soup.length, side: p.side.length },
      vegKinds,
      vegCanonTop: [...canonCnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([canon, n]) => ({ canon, n })),
      nonFungiVeg,
      eggTofuDishes,
      vegSweetChapter,
      menuVeg,
      menuNonFungiVeg,
      samples,
    };
  }

  /**
   * 组一张周菜单。
   * @param {{days?:number, people?:number, meals?:number, combo?:string, seed?:number, startDate?:string, excludeIds?:string[], intent?:"fast"|"learn"}} opts
   */
  plan(opts = {}) {
    if (!this.c) this.refresh();
    const days = Math.max(1, Math.min(7, opts.days ?? 3));
    const people = opts.people ?? this.people;
    const meals = Math.max(1, Math.min(2, opts.meals ?? 2));
    const seed = opts.seed ?? Date.now() % 100000;
    const rnd = mulberry32(seed);
    // 精力/意图档位：太累只做 35 分钟内好上手的；想学菜放开学着做的（优先级见 resolveRunBudget）
    const { intent, energy, maxMinutes, tiers } = resolveRunBudget(opts, this.c.allowTiers);
    const pools = this.pools({ maxMinutes, tiers });
    const isSturdyAll = (r) => {
      const v = r.vegCanon ?? [];
      return v.length > 0 && v.every((x) => STURDY.has(x));
    };

    const used = new Set(opts.excludeIds ?? []);
    const usedProteinByDay = new Map();
    const usedVegMainByDay = new Map();
    const nonFungiVegIds = new Set(); // 整张菜单里非笋菇素菜（跨天去重，§3.1.4 规则 3）
    const plan = [];
    const notes = [];

    const pick = (pool, filter) => {
      // 你念叨过的菜优先落位：这是"被听见"最直接的方式
      for (const item of pool) {
        if (used.has(item.r.id)) continue;
        if (!item.isWant) continue;
        if (filter && !filter(item.r)) continue;
        return item;
      }
      const start = Math.floor(rnd() * Math.max(1, Math.min(pool.length, 60)));
      for (let i = 0; i < pool.length; i++) {
        const item = pool[(start + i) % pool.length];
        if (used.has(item.r.id)) continue;
        if (filter && !filter(item.r)) continue;
        return item;
      }
      return null;
    };

    const proteinPool = [...pools.protein];
    const vegPool = [...pools.veg];
    const soupPool = [...pools.soup];

    for (let d = 0; d < days; d++) {
      const day = { day: d + 1, meals: [] };
      usedProteinByDay.set(d, new Set());
      usedVegMainByDay.set(d, new Set());
      for (let m = 0; m < meals; m++) {
        const slot = { name: SLOT_NAMES[m] ?? `第${m + 1}餐`, dishes: [] };
        const combo = opts.combo && days === 1 ? COMBOS[opts.combo] : autoCombo(people);
        const cap = Math.max(60, (this.c.proteinTarget || 30) * 1.8);
        for (const spec of combo) {
          const n = spec.n ?? 1;
          for (let k = 0; k < n; k++) {
            if (spec.role === "protein") {
              const proteinOk = (r) => {
                const soFar = slot.dishes.reduce((s, x) => s + (x.r.perServing?.proteinGrams ?? 0), 0);
                if (soFar + (r.perServing?.proteinGrams ?? 0) > cap) return false;
                const main = r.proteinCanon?.[0];
                if (main && usedProteinByDay.get(d).has(main)) return false;
                if (d > 0 && main && plan[d - 1]?.meals?.[m]?.proteinMain === main) return false;
                return true;
              };
              // 学菜的晚上：每天头一道主菜优先挑战一道 learn/hard（§3.6）
              let item = null;
              if (intent === "learn" && m === 0 && k === 0) {
                item = pick(proteinPool, (r) => r.skill?.tier !== "easy" && proteinOk(r));
              }
              if (!item) item = pick(proteinPool, proteinOk);
              if (item) {
                const main = item.r.proteinCanon?.[0];
                if (main) usedProteinByDay.get(d).add(main);
                slot.dishes.push({ ...item, role: "protein" });
                used.add(item.r.id);
              }
            } else if (spec.role === "veg") {
              // 配比（§3.1.4）：前两天优先绿叶，之后根茎瓜果；同一天两餐素菜不撞同一蔬菜主料；
              // 整张菜单非笋菇素菜不足 2 道时先不挑笋菇类
              const later = d >= 2;
              const dayVegMain = usedVegMainByDay.get(d);
              const vegOk = (r) => {
                if (/甜菜/.test(r.chapter ?? "")) return false; // 甜菜守卫：甜品不当正餐
                const main = r.vegCanon?.[0];
                return !(main && dayVegMain.has(main));
              };
              const needNonFungi = nonFungiVegIds.size < 2;
              // mockmeat 的主料是面筋/素鸡（豆制品），耐放——第 3 天起正好顶上来
              const kindOrder = later ? ["sturdy", "fungi", "mockmeat", "eggtofu", "other"] : ["leafy", "sturdy", "fungi", "mockmeat", "eggtofu", "other"];
              let item = null;
              for (const kind of kindOrder) {
                if (later && kind === "leafy") continue; // 第 3 天起不吃绿叶（保鲜规则保留）
                item = pick(vegPool, (r) => vegOk(r) && vegKind(r) === kind && (!needNonFungi || !isFungiBamboo(r)));
                if (item) break;
              }
              if (!item && later) item = pick(vegPool, (r) => vegOk(r) && isSturdyAll(r)); // 大白菜这类「耐放绿叶」放行
              if (!item) item = pick(vegPool, vegOk); // 兜底：别让素菜位空着
              if (item) {
                const main = item.r.vegCanon?.[0];
                if (main) dayVegMain.add(main);
                if (!isFungiBamboo(item.r)) nonFungiVegIds.add(item.r.id);
                slot.dishes.push({ ...item, role: "veg" });
                used.add(item.r.id);
              }
            } else if (spec.role === "soup") {
              const item = pick(soupPool);
              if (item) {
                slot.dishes.push({ ...item, role: "soup" });
                used.add(item.r.id);
              }
            }
          }
        }
        // 蛋白不够就补一个蒸蛋/豆腐类小菜，而不是硬塞一道大荤
        const target = this.c.proteinTarget;
        if (target) {
          const got = slot.dishes.reduce((s, x) => s + (x.r.perServing?.proteinGrams ?? 0), 0);
          const gap = target - got;
          if (gap > target * 0.25) {
            const fits = (r) => (r.perServing?.proteinGrams ?? 0) <= Math.max(15, gap * 1.8) && !slot.dishes.some((x) => x.r.id === r.id);
            // W5：先挑无肉的配菜（蒸蛋/豆腐/仿真荤），真没有才轮到混炒——不然减脂期补蛋白
            // 会补出一道五花肉小炒（肉丝炒葱头曾这样挤进 seed 42 的菜单）
            const add = pick(pools.side, (r) => fits(r) && !(r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent)))
              ?? pick(pools.side, fits);
            if (add) {
              slot.dishes.push({ ...add, role: "side" });
              used.add(add.r.id);
            }
          }
        }
        slot.proteinMain = slot.dishes.find((x) => x.role === "protein")?.r?.proteinCanon?.[0] ?? null;
        slot.protein = Math.round(slot.dishes.reduce((s, x) => s + (x.r.perServing?.proteinGrams ?? 0), 0));
        slot.kcal = Math.round(slot.dishes.reduce((s, x) => s + (x.r.perServing?.kcal ?? 0), 0));
        day.meals.push(slot);
      }
      plan.push(day);
    }

    // 每日总盘子（§3.2.1）：天级目标优先 goals.proteinPerDay/kcalPerDay，没有才回退「每餐目标 × 餐数」
    const proteinTarget = this.c.proteinPerDay ?? (this.c.proteinTarget ? this.c.proteinTarget * meals : null);
    const kcalTarget = this.c.kcalPerDay ?? (this.c.kcalTarget ? this.c.kcalTarget * meals : null);
    const dailyTotals = plan.map((d) => {
      const protein = Math.round(d.meals.reduce((s, m) => s + m.protein, 0));
      const kcal = Math.round(d.meals.reduce((s, m) => s + m.kcal, 0));
      return {
        day: d.day,
        protein,
        kcal,
        proteinTarget,
        kcalTarget,
        proteinGap: proteinTarget != null ? protein - proteinTarget : null, // 负数 = 还缺
        kcalGap: kcalTarget != null ? kcalTarget - kcal : null,             // 正数 = 热量额度还有富余
      };
    });
    const breakfast = breakfastAdvice(this.profile, this.c);

    if (!pools.protein.length) notes.push("没有符合条件的主菜——检查一下忌口/过敏/难度设置是不是把范围压得太窄。");
    if (energy === "tired") {
      // 0.4.1 裁决 12：days=1 没有「其中一天」可顺延，文案分开说
      notes.push(days === 1
        ? `今天是省事模式：只排了 ${maxMinutes} 分钟以内的菜。不想动就换个简单的对付一顿，别硬做。`
        : `今天是省事模式：只排了 ${maxMinutes} 分钟以内的菜。不想动就把其中一天顺延，别硬做。`);
    }
    if (proteinTarget != null) {
      const gaps = dailyTotals.filter((t) => t.proteinGap < 0);
      // 0.4.1 裁决 12：缺口给克数换算（鸡蛋 ≈7g 蛋白、无糖希腊酸奶 ≈14g/杯），
      // 只说「加个蛋」补不上 40g 的缺口
      if (gaps.length) notes.push(`菜单只管午晚两餐：${gaps.map((t) => {
        const g = -t.proteinGap;
        return `第${t.day}天蛋白还差${g}g（约等于 ${Math.max(1, Math.round(g / 7))} 个鸡蛋或 ${Math.max(1, Math.round(g / 14))} 杯无糖希腊酸奶）`;
      }).join("、")}——用早餐补上，别硬塞进晚饭。`);
    }

    const target = this.c.proteinTarget;
    if (target) {
      const low = plan.flatMap((d) => d.meals).filter((s) => s.protein < target);
      if (low.length) notes.push(`${low.length} 餐的蛋白低于 ${target}g/人，可以加一份蛋/豆腐/酸奶补上。`);
    }

    // 你念叨过的菜排进去了没有
    const wants = this.state ? openWants(this.state) : [];
    const plannedTitles = new Set(plan.flatMap((d) => d.meals).flatMap((s) => s.dishes.map((x) => x.r.title)));
    for (const w of wants) {
      if (plannedTitles.has(w.title)) notes.push(`排了你之前说想吃的「${w.title}」。`);
    }
    if (wants.length && !wants.some((w) => plannedTitles.has(w.title))) {
      notes.push(`你提过想吃${wants.map((w) => `「${w.title}」`).join("、")}，现有的菜谱里没排进去——要不要放宽一次条件，或者我按相近的做法找一道？`);
    }

    // 冰箱里的剩料先扣掉，别让你再买一遍
    const pantry = this.state && opts.useLeftovers !== false ? liveLeftovers(this.state) : new Map();
    const shopping = buildShopping(plan, people, pantry);
    if (pantry.size) notes.push(`采购清单已经扣掉冰箱里现有的：${[...pantry.entries()].map(([c, g]) => `${c} ${Math.round(g)}g`).join("、")}。`);
    // R2b：配料级忌口的菜进菜单了——被省去的料不进采购清单，说一句免得对着原方找
    if (shopping.omitted?.length) {
      notes.push(`已按忌口去掉：${shopping.omitted.map((o) => `${o.canon} ${o.grams}g`).join("、")}——这几样不进采购清单，做的时候直接省去。`);
    }
    // W5：不足最小可买份量的项提到了可买的量，免得照单买不齐
    if (shopping.aligned?.length) {
      const head = shopping.aligned.slice(0, 6).map((a) => `${a.canon} ${a.from}g→${a.to}g`).join("、");
      const more = shopping.aligned.length > 6 ? ` 等 ${shopping.aligned.length} 项` : "";
      notes.push(`已凑整到可买份量：${head}${more}——清单上是买得到的量，多的留着下次用。`);
    }

    return {
      seed,
      people,
      days,
      meals,
      maxMinutes,
      intent: intent ?? null,
      energy,
      startDate: opts.startDate ?? new Date().toISOString().slice(0, 10),
      plan: plan.map((d) => ({
        ...d,
        meals: d.meals.map((s) => ({
          ...s,
          dishes: s.dishes.map((x) => ({
            id: x.r.id,
            title: x.r.title,
            role: x.role,
            cuisine: x.r.cuisine,
            chapter: x.r.chapter,
            skill: x.r.skill,
            servingsBase: x.r.servingsBase,
            scale: +(people / (x.r.servingsBase || 4)).toFixed(2),
            proteinFoodGrams: x.r.proteinFoodGrams ?? null,
            vegKind: vegKind(x.r),
            proteinPerServing: x.r.perServing?.proteinGrams,
            kcalPerServing: x.r.perServing?.kcal,
            minutes: x.minutes,
            hasMeat: (x.r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent)),
            isWant: Boolean(x.isWant),
            recentDays: x.recentDays,
            omit: (x.omit ?? []).slice(0, 4),
            tableNotes: tableNotes(x.r, this.profile),
            why: x.reasons?.slice(0, 2),
            blurb: x.r.blurb,
          })),
        })),
      })),
      dailyTotals,
      breakfast,
      shopping,
      notes,
    };
  }

  /**
   * 随机挑战：先按条件筛池子，再按「几菜几肉」组合摇一次。
   * 反疲劳（§3.7，R11/R12）：一局只有两次机会（初摇 + 一次再摇）。第三次来摇不再给菜，
   * 转入问原因；想再摇只能重新开一局（rerollCount 从 0 传起，计数清零）。
   */
  shuffle(opts = {}) {
    if (!this.c) this.refresh();
    const people = opts.people ?? this.people;
    const comboKey = opts.combo ?? (people <= 3 ? "1菜1肉" : people <= 4 ? "2菜1肉" : "2菜2肉");
    const combo = COMBOS[comboKey] ?? COMBOS["1菜1肉"];
    const seed = opts.seed ?? Math.floor(Math.random() * 1e6);
    const rerollCount = opts.rerollCount ?? 0;
    const closed = rerollCount >= 2; // 这一局已经摇过两次：关闭摇的选项，问原因
    if (closed) {
      return {
        seed,
        combo: comboKey,
        people,
        intent: null,
        energy: opts.energy ?? "normal",
        maxMinutes: null,
        dishes: [],
        excludeIds: Array.isArray(opts.excludeIds) ? [...new Set(opts.excludeIds)] : [],
        rerollCount: 2,
        closed: true,
        askReason: true,
        hint: "这局摇完了。先别急着再摇——说说今天是怎么了：累了、没胃口、家里缺食材，还是单纯没灵感？对症了才好帮你；真想再摇就重新开一局。实在想不出就今天先不做，下碗面也不算输。",
      };
    }
    const { intent, energy, maxMinutes, tiers } = resolveRunBudget(opts, this.c.allowTiers);
    const rnd = mulberry32(seed);
    const pools = this.pools({ maxMinutes, tiers });
    const exclude = new Set(opts.excludeIds ?? []);
    const picks = [];

    const take = (pool, role) => {
      const avail = pool.filter((x) => !exclude.has(x.r.id) && !picks.some((p) => p.r.id === x.r.id)
        && !(role === "veg" && /甜菜/.test(x.r.chapter ?? ""))); // 甜菜守卫：甜品不当正餐
      if (!avail.length) return null;
      const item = avail[Math.floor(rnd() * Math.min(avail.length, 40))];
      picks.push({ ...item, role });
      return item;
    };

    for (const spec of combo) {
      for (let i = 0; i < (spec.n ?? 1); i++) {
        if (spec.role === "protein") take(pools.protein, "protein");
        else if (spec.role === "veg") take(pools.veg, "veg");
        else take(pools.soup, "soup");
      }
    }

    return {
      seed,
      combo: comboKey,
      people,
      intent: intent ?? null,
      energy,
      maxMinutes,
      dishes: picks.map((p) => ({
        id: p.r.id,
        title: p.r.title,
        role: p.role,
        cuisine: p.r.cuisine,
        chapter: p.r.chapter,
        skill: p.r.skill,
        minutes: p.minutes,
        hasMeat: (p.r.ingredients ?? []).some((i) => MEAT_PARENTS.has(i.parent)),
        isWant: Boolean(p.isWant),
        recentDays: p.recentDays,
        omit: (p.omit ?? []).slice(0, 4),
        tableNotes: tableNotes(p.r, this.profile),
        blurb: p.r.blurb,
        proteinPerServing: p.r.perServing?.proteinGrams,
        story: p.r.features?.slice(0, 60) ?? "",  // 无 features 的菜是 undefined，宿主要求 canonical value 无损 JSON（关二阻塞 bug，2026-10-30）
        why: (p.reasons ?? []).slice(0, 2),  // 同类雷：reasons 缺失时 ?.slice 产出 undefined，一并加固
      })),
      excludeIds: [...exclude, ...picks.map((p) => p.r.id)],
      rerollCount: rerollCount + 1,
      closed: false,
      askReason: false,
      // 0.4.1 裁决 12：hint 是给用户看的话，参数怎么传（excludeIds/rerollCount）留在
      // 工具 description 与返回值里给模型，不再混进人话
      hint: rerollCount === 0
        ? "不满意可以再摇一次，摇过的菜不会再来烦你。"
        : "这是这局最后一次摇了。还不合心意就跟我说说为什么，咱们换个思路，不硬摇。",
    };
  }
}

// ───────── 采购清单（W5：聚合对齐 + 预制标志 + 计数单位估重） ─────────

// 蛋清/蛋黄并回鸡蛋（蛋清一只 ≈33g、蛋黄 ≈17g）。买的时候只有「鸡蛋」一个选项，
// 原先蛋清、蛋黄、鸡蛋各占一行，同一板蛋要买三遍。
const EGG_ROLLUP = new Set(["蛋清", "蛋黄"]);
const EGG_TARGET = "鸡蛋";
const EGG_UNIT_GRAMS = 50;

/**
 * W5：采购口径的唯一实现——蛋清/蛋黄先并回鸡蛋，再按 PURCHASE_UNITS 的最小可买份量凑整。
 * buildShopping 与 tools/acceptance.mjs 共用这一份，两边的数永远对得上。
 * @param {Map<string,number>} need canon → 克数
 */
export function alignPurchaseNeed(need) {
  const out = new Map();
  const merged = [];
  for (const [canon, grams] of need) {
    if (EGG_ROLLUP.has(canon)) {
      out.set(EGG_TARGET, (out.get(EGG_TARGET) ?? 0) + grams);
      merged.push(canon);
    } else {
      out.set(canon, (out.get(canon) ?? 0) + grams);
    }
  }
  const aligned = [];
  for (const [canon, grams] of out) {
    const minBuy = PURCHASE_UNITS[canon]?.minBuy;
    if (minBuy && grams > 0 && grams < minBuy) {
      out.set(canon, minBuy);
      aligned.push({ canon, from: grams, to: minBuy });
    }
  }
  return { need: out, aligned, merged };
}

// W5：计数单位估重（大众菜谱数据侧产物 intake-大众菜谱/est-unit-grams.json：118 行里 38 行有人工估值）。
// 只在「原方只给个数、没给克数」时拿来折采购量；CANON 已有单重的（鸡蛋 50g、整鱼 350g）
// 在 parse 阶段就折成克数了，不进这张表。表读不到时静默降级，照旧显示个数原文。
let UNIT_EST = null;
function unitGramsEst() {
  if (UNIT_EST) return UNIT_EST;
  UNIT_EST = new Map();
  try {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../intake-大众菜谱/est-unit-grams.json");
    for (const it of JSON.parse(readFileSync(file, "utf8")).items ?? []) {
      const grams = Number(it.proposedGrams);
      if (!Number.isFinite(grams) || grams <= 0) continue;
      const entry = lookup(it.name);
      if (!entry || entry.guessed || entry.unitGrams) continue;
      if (!UNIT_EST.has(entry.id)) UNIT_EST.set(entry.id, grams); // 同一 canon 多个口径时取先出现的
    }
  } catch {
    UNIT_EST = new Map();
  }
  return UNIT_EST;
}

/**
 * 采购清单：按类别汇总，蔬菜按「两天一批」拆开，肉水产一次买够；冰箱里有的先扣掉。
 *
 * 口径（0.4.1 裁决 1，E1 S2）：采购量 = 原方 servingsBase 量，不按 people/servingsBase 折算——
 * 你下锅的就是原方，「按原方做、吃一半带饭」的语义已由菜单文案承载；多人场景靠选菜时
 * 「份量贴近人数」消化误差。此前按 people 折半买，照单采购做不出菜单说的「原方」。
 * people 参数保留只为签名兼容，不再参与计量。
 *
 * W5 加了三件事：
 *   1. 同名 canon 跨天跨菜先求和，总和不到 PURCHASE_UNITS 的最小可买份量就提到 minBuy
 *      （清单 aligned 里带 from/to，plan.notes 会交代一句）；蛋清/蛋黄先并回鸡蛋再对齐。
 *   2. 预制/半成品原料（熟火腿、水发香菇）在分组行上标「买现成的」。
 *   3. 只给个数没给克数的行，用估值表折出约克数并标 unitGramsFrom="est-table"。
 */
export function buildShopping(plan, people, pantry = new Map()) {
  const est = unitGramsEst();
  const items = new Map(); // canon → { canon, cat, grams, count, unitGrams, days:Set, unknown, prep }
  const omittedTotals = new Map(); // canon → 克数（R2b：配料级忌口的料不出现在采购清单，只留一句说明）
  for (const day of plan) {
    for (const slot of day.meals) {
      for (const dish of slot.dishes) {
        const r = typeof dish.r === "object" ? dish.r : dish;
        const scale = 1; // 原方量（见上）
        const omitted = new Set((dish.omit ?? []).map((o) => o.target));
        for (const ing of r.ingredients ?? []) {
          const key = ing.canon;
          if (!key || key === "水") continue;
          if (omitted.has(key)) {
            // 免 X 版：这料做菜时省去，采购里也不买
            if (typeof ing.grams === "number") omittedTotals.set(key, (omittedTotals.get(key) ?? 0) + ing.grams);
            else omittedTotals.set(key, omittedTotals.get(key) ?? 0);
            continue;
          }
          // 只有个数、没有克数的行才用估值表折约克数（lexicon 有单重的不覆盖，已有的行不动）
          const estGrams = !ing.unitGrams && !items.has(key) ? est.get(key) ?? null : null;
          const o = items.get(key) ?? {
            canon: key,
            cat: ing.cat,
            parent: ing.parent,
            grams: 0,
            count: 0,
            unitGrams: ing.unitGrams ?? estGrams,
            unitGramsFrom: ing.unitGrams ? "lexicon" : estGrams != null ? "est-table" : null,
            days: new Set(),
            unknown: false,
            prep: false, // W5：这道菜里这块料是熟制/水发/腌腊的半成品
          };
          // 炸用油整锅计进采购会变成"买 5 斤花生油"，按 30% 附着量估
          const factor = ing.parent === "油脂" ? 0.3 : 1;
          if (ing.grams) o.grams += ing.grams * scale * factor;
          else if (ing.count) o.count += ing.count * scale;
          else o.unknown = true;
          if (isPreparedIngredient(ing)) o.prep = true;
          o.days.add(day.day);
          items.set(key, o);
        }
      }
    }
  }

  // 蛋清/蛋黄并回鸡蛋：克数照搬、天数并集。并完再谈扣冰箱和凑整。
  for (const canon of EGG_ROLLUP) {
    const src = items.get(canon);
    if (!src) continue;
    const egg = items.get(EGG_TARGET) ?? {
      canon: EGG_TARGET,
      cat: src.cat,
      parent: src.parent,
      grams: 0,
      count: 0,
      unitGrams: EGG_UNIT_GRAMS,
      unitGramsFrom: "lexicon",
      days: new Set(),
      unknown: false,
      prep: false,
    };
    egg.grams += src.grams;
    for (const d of src.days) egg.days.add(d);
    egg.prep = egg.prep || src.prep;
    items.set(EGG_TARGET, egg);
    items.delete(canon);
  }

  // 冰箱里已有：从采购量里扣，扣到 0 为止，并留一句说明
  for (const [canon, have] of pantry) {
    const o = items.get(canon);
    if (!o?.grams) continue;
    const cut = Math.min(o.grams, have);
    o.grams -= cut;
    o.had = cut;
  }

  // 凑整到可买份量：扣完冰箱才凑——家里已有的不该被算成「还得买」的量
  const aligned = [];
  for (const o of items.values()) {
    const minBuy = PURCHASE_UNITS[o.canon]?.minBuy;
    if (minBuy && o.grams > 0 && o.grams < minBuy) {
      aligned.push({ canon: o.canon, from: Math.round(o.grams), to: minBuy });
      o.grams = minBuy;
    }
  }
  // 蛋的个数放在这里反推（parse 阶段个数行已经折成克数，逐行累的 count 是残缺的）：
  // 总克数 / 50 = 要买几个，扣过冰箱、凑过整之后算才不会报多。300g 就是 6 个。
  const eggRow = items.get(EGG_TARGET);
  if (eggRow && eggRow.grams > 0) eggRow.count = eggRow.grams / EGG_UNIT_GRAMS;

  const round = (n) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : Math.round(n));
  const fmt = (o) => {
    if (o.grams > 0) {
      const g = round(o.grams);
      const base = g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g} g`;
      // 蛋是按个买的：并回鸡蛋后补回「几个」，别让人对着 300 g 发呆
      const eggs = o.canon === EGG_TARGET && o.count > 0 ? `（约${Math.ceil(o.count)} 个）` : "";
      return `${base}${eggs}${o.had ? `（冰箱已有 ${round(o.had)} g，已扣）` : ""}`;
    }
    if (o.had) return `不用买（冰箱里够）`;
    if (o.count > 0) return `${Math.ceil(o.count)} ${o.unitGrams ? `（约${round(o.count * o.unitGrams)} g）` : ""}`.trim();
    return o.unknown ? "适量" : "—";
  };
  // 行级备注：预制的说买现成的——油脂/调味/汤底这类本来就是买成品的料不提，免得满页都是
  const PREP_SKIP = new Set(["油脂", "调味", "汤底"]);
  const noteOf = (o) => (o.prep && !PREP_SKIP.has(o.parent) ? "买现成的，别买生料回去自己发/自己煮" : undefined);
  // unitGramsFrom 只在「按个数折出来的约克数」那类行上有意义（克数行不靠它）
  const row = (o, extra = {}) => ({
    name: o.canon,
    qty: fmt(o),
    cat: o.cat,
    ...(o.grams <= 0 && o.count > 0 && o.unitGramsFrom ? { unitGramsFrom: o.unitGramsFrom } : {}),
    ...(noteOf(o) ? { note: noteOf(o) } : {}),
    ...extra,
  });

  const PANTRY = new Set(["调味", "油脂", "汤底", "其他"]);
  const SELF_MADE = new Set(["高汤", "芡汤", "水"]);
  const NOT_FOOD = new Set(["非食材辅料"]);
  const list = [...items.values()].filter((o) => !NOT_FOOD.has(o.canon)).sort((a, b) => b.grams - a.grams);
  const perishable = list.filter((o) => ["蔬菜", "菌菇", "豆制品", "蛋奶"].includes(o.cat));
  const staples = list.filter((o) => PANTRY.has(o.cat) && !SELF_MADE.has(o.canon));
  const selfMade = list.filter((o) => SELF_MADE.has(o.canon));
  const meat = list.filter((o) => ["肉禽", "水产"].includes(o.cat));
  const dry = list.filter((o) => ["粮油", "干货"].includes(o.cat) && !PANTRY.has(o.cat));

  // 蔬菜按用到它的天数分批：第 1–2 天一次，第 3–4 天一次，第 5–7 天一次
  const batchOf = (o) => {
    const first = Math.min(...o.days);
    if (first <= 2) return 1;
    if (first <= 4) return 2;
    return 3;
  };
  const leaf = perishable.filter((o) => o.cat !== "蛋奶" && o.cat !== "豆制品");
  const batches = [1, 2, 3].map((n) => ({
    batch: n,
    label: n === 1 ? "第一批（当天～第2天）" : n === 2 ? "第二批（第3～4天）" : "第三批（第5～7天）",
    items: leaf.filter((o) => batchOf(o) === n).map((o) => row(o, { days: [...o.days] })),
  })).filter((b) => b.items.length);

  return {
    buyOnce: {
      label: "一次买够（肉、水产，回家分装冷冻）",
      items: meat.map((o) => row(o, { days: [...o.days] })),
    },
    // R2b：被「免 X 版」省去的料——不在上面任何一组里，单独列出克数供 notes 说明
    omitted: [...omittedTotals.entries()]
      .map(([canon, grams]) => ({ canon, grams: Math.round(grams) }))
      .sort((a, b) => b.grams - a.grams),
    // W5：不足最小可买份量、被凑整的项（canon/from/to），notes 里统一交代
    aligned,
    batches,
    staples: {
      label: "常备调料（先看家里有没有，没有才买）",
      items: staples.map((o) => row(o)),
    },
    dry: {
      label: "粮油干货",
      items: dry.map((o) => row(o)),
    },
    selfMade: {
      label: "高汤/芡汤（自家熬或用水代替，不计入采购）",
      items: selfMade.map((o) => ({ name: o.canon, qty: fmt(o), note: "没有就用水 + 一点鸡精替代" })),
    },
    keep: perishable.filter((o) => o.cat === "蛋奶" || o.cat === "豆制品")
      .map((o) => row(o, { note: [noteOf(o), "蛋奶/豆制品，中途补一次也行"].filter(Boolean).join("；") })),
  };
}

export const COMBOS_LIST = Object.keys(COMBOS);
export const EXOTIC_INGREDIENTS = EXOTIC;
export const LUXURY_INGREDIENTS = LUXURY;
