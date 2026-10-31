/**
 * DSH 插件入口。
 *
 * 工具只做五件事：查菜谱、看/改画像、排周期菜单、随机摇一桌、推荐三个候选。
 * 不碰 UI、不联网；所有状态都是本地文件（data/ 与 profile.json）。
 *
 * 契约（v0.2）：每个工具 = 结构化 canonical value + render（给模型的人话）+ presentationMeta（给浏览器的卡片）。
 *   - execute 返回规范值；基础设施故障才 throw（isError）。
 *   - render(args, value) 产出 [{ type: "text", text }]，是模型唯一看到的文本。
 *   - presentationMeta(args, value) 产出卡片 meta；形状与 0.1.2 的 cardX() 冻结一致。
 *   - 零命中是正常的领域结果（hits: [] + hint），不是错误。
 *
 * 行为约定（写给调用我的模型看）：
 *   - 用户说"随便" → menu_shuffle，别自己编菜；说"给我挑几个/推荐一下" → recommend（固定 3 个，不占摇的次数）
 *   - 摇两次还不满意 → 停下来问原因，不要摇第三次
 *   - 用户提到的"最近/这个月/孕期/减脂"进 periods（有窗口），"一直不喜欢"进 longTerm
 *   - 排菜单的采购清单是给人看的，不是给机器看的：不要改单位、不要合并批次
 */
import { RecipeBook } from "./query.mjs";
import { Planner, EXOTIC_INGREDIENTS, LUXURY_INGREDIENTS } from "./planner.mjs";
import { loadProfile, saveProfile, resolveConstraints, activePeriods, scoreRecipe, titleImpliedAllergens, omitInfoFor, mainAvoidFor, DEFAULT_PROFILE } from "./profile.mjs";
import { loadState, saveState as saveStateFile, openWants, recentCooks, verdicts, leftoversLine, DEFAULT_STATE } from "./state.mjs";
import { estimateMinutes, easyWayOut, portionNote } from "./care.mjs";
import { CANON } from "./lexicon.mjs";
import { lookup } from "./ingredients.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";

export const name = "recipe-homie";
export const inject = ["tools"];

export const Config = await (async () => {
  try {
    const { default: z } = await import("@deepseek-ai/schemastery");
    return z.object({
      dataDir: z.string().default(""),
      profileFile: z.string().default(""),
      limit: z.number().step(1).min(1).max(50).default(8),
    });
  } catch {
    return undefined;
  }
})();

const DEFAULT_DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/**
 * 工具契约三件套。
 *   schema：返回值的规范形状（框架会校验；schema 之外的值一概不许返回）
 *   render：给模型看的文本块
 *   presentationMeta：给浏览器的卡片；无卡片工具不传
 */
const output = (schema, render, presentationMeta) => ({ schema, render, presentationMeta });

/** 字符串工具（无卡片）统一用这个 render。 */
const renderString = (_a, v) => [{ type: "text", text: typeof v === "string" ? v : String(v ?? "") }];

/** 只留中文/英文/数字：与 query.mjs 的 cleanQuery 同口径（那边不导出，这里收一个小函数）。 */
const cleanText = (text) => String(text ?? "").replace(/[^一-龥A-Za-z0-9]+/g, "");

function amountText(ing) {
  if (ing.qualifier) return ing.qualifier;
  if (ing.amount) return ing.amount;
  return "";
}

// ───────── canonical 值 ─────────
// 「模型看什么」由这里定：值里只放有界、可回放的事实；文本由 render 从值派生。
// 值本身必须 JSON 可序列化、同输入同输出。

/** recipe_search 的单条命中（summaryLine 与 cardSearch 都从它派生）。
 *  0.4.2 R2b：omit 由 execute 按当前画像补上（配料级忌口 → 免 X 版），无画像约束时为空数组。 */
function hitValue(h, cons = null) {
  const r = h.recipe;
  return {
    id: r.id,
    title: r.title,
    book: r.book,
    cuisine: r.cuisine,
    chapter: r.chapter ?? "",
    page: r.page ?? null,
    minutes: estimateMinutes(r),
    servings: r.servingsBase ?? null,
    proteinPerServing: r.perServing?.proteinGrams ?? null,
    kcalPerServing: r.perServing?.kcal ?? null,
    tier: r.skill?.tier ?? null,
    mainIngredients: top(r.mainCanon, 4),
    features: r.features ?? "",
    blurb: r.blurb ?? "",
    // summaryLine 的「用料」行：取前 4 条；多出的用 ingredientCount 判断是否补「…」
    lineIngredients: top(r.ingredients, 4).map((i) => ({
      name: i.name ?? null,
      raw: i.raw ?? "",
      amount: amountText(i),
    })),
    ingredientCount: (r.ingredients ?? []).length,
    // R2b：[{ target, grams }]——配料级忌口，做的时候省去（render 出「免 X 版」）
    omit: cons ? omitInfoFor(r, cons) : [],
  };
}

/** recipe_get 的完整菜谱值。字段覆盖 render（原文/斤两/页码）与卡片（clip/top 前的全量）。
 *  0.4.2 R2b：omit（配料级忌口，省去即可）/ avoidMain（主料级忌口，本不该推荐）由 execute 按画像补。 */
function recipeValue(r, cons = null) {
  return {
    id: r.id,
    title: r.title,
    cuisine: r.cuisine,
    chapter: r.chapter ?? "",
    book: r.book,
    page: r.page ?? null,
    seq: r.seq ?? null,
    recoveredTitle: r.recoveredTitle ?? null,
    minutes: estimateMinutes(r),
    servings: r.servingsBase ?? null,
    protein: r.perServing?.proteinGrams ?? null,
    kcal: r.perServing?.kcal ?? null,
    salt: r.nutrition?.saltGrams ?? null,
    allergens: top(r.allergens, Number.MAX_SAFE_INTEGER),
    ingredients: (r.ingredients ?? []).map((i) => ({
      name: i.name,
      // 0.1.2 的 render 用 amount、卡片用 amount||qualifier；本库 qualifier 只与 amount 同时出现，合并后两者逐字一致
      amount: i.amount || i.qualifier || "",
      grams: i.grams ?? null,
    })),
    steps: (r.steps ?? []).slice(),
    features: r.features ?? "",
    notes: (r.notes ?? []).slice(),
    variants: (r.variants ?? []).filter((v) => v.verdict === "same_dish").flatMap((v) => v.others ?? []),
    skill: r.skill?.tier ?? null,
    blurb: r.blurb ?? "",
    nutrition: r.nutrition ?? null,
    // R2b 两级忌口：omit = 配料级（免 X 版：省去 X）；avoidMain = 主料级（菜单/检索不排，详情仅作参考）
    omit: cons ? omitInfoFor(r, cons) : [],
    avoidMain: cons ? mainAvoidFor(r, cons) : [],
  };
}

// ───────── render：从 canonical 值出来的人话 ─────────

/** 免 X 版提示行（R2b）：配料级忌口 → 省去 X（约 N g）。菜单/摇一桌/检索共用一个格式。 */
function omitLine(omit, indent) {
  if (!omit?.length) return "";
  const names = omit.map((o) => o.target).join("/");
  const detail = omit.map((o) => `${o.target}（约 ${Math.round(o.grams)} g）`).join("、");
  return `${indent}免${names}版：省去 ${detail}`;
}

/** recipe_search 的 ok 分支：与 0.1.2 的 summaryLine 版式逐字一致；
 *  0.4.2 R2b 唯一的新增行是命中带 omit 时的「免 X 版」提示（配料级忌口，做法照旧、省去该料）。 */
function summaryLine(h, i) {
  const ing = h.lineIngredients
    .map((x) => (x.name ? `${x.name}${x.amount ? ` ${x.amount}` : ""}` : x.raw))
    .join("、");
  return [
    `${i + 1}. ${h.title}（${h.cuisine}${h.chapter ? `·${h.chapter}` : ""}）${h.blurb}`,
    `   用料：${ing}${h.ingredientCount > 4 ? " …" : ""}`,
    h.features ? `   特点：${h.features.slice(0, 60)}` : "",
    omitLine(h.omit, "   "),
    `   id=${h.id}`,
  ].filter(Boolean).join("\n");
}

/** recipe_get 的 found 分支：与 0.1.2 的 recipeText 逐字一致（含页码、克数原文）。
 *  0.4.1 裁决 10（E2 S4）：page 缺失不再沉默——如实标注「整理版无页码」
 *  （2026-10-31 起南北册 706 条页码已从 pages 文件名接入，此标注只剩省册少数真缺页）。 */
function recipeTextFromValue(r) {
  const head = `《${r.book}》${r.page ? ` p.${r.page}` : "（整理版无页码）"}${r.seq ? ` · 第${r.seq}条` : ""}${r.recoveredTitle ? "（菜名由目录补全）" : ""}`;
  const ing = r.ingredients
    .map((x) => `- ${x.name}${x.amount ? ` ${x.amount}` : ""}${x.grams && x.amount ? `（≈${x.grams}g）` : ""}`)
    .join("\n");
  const steps = r.steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  return [
    `# ${r.title}`,
    head,
    `${r.blurb ?? ""}${r.nutrition ? ` · 蛋白 ${r.nutrition.proteinGrams}g / 总 ${r.nutrition.kcal}kcal` : ""}`,
    "",
    "## 用料",
    ing || "（原文此处未识别到用料）",
    "",
    "## 制法",
    steps || "（原文此处未识别到制法）",
    r.features ? `\n## 特点\n${r.features}` : "",
    (r.notes ?? []).length ? `\n## 附注\n${r.notes.join("\n")}` : "",
    r.variants.length
      ? `\n## 其他版本\n同一道菜在别的分册还有 ${r.variants.length} 个版本：${r.variants.join("、")}`
      : "",
    "",
    "注：克数为按 1斤=500g、1两=50g、1钱=5g 折算；炸用油按附着量计入热量（原文标「约耗」的按耗去的量计）。",
  ].filter(Boolean).join("\n");
}

/** recipe_search 的非 ok 分支：hint 一句话 + 近邻行。 */
function renderSearchMiss(v) {
  const lines = [v.hint?.text ?? ""];
  if (v.neighbors?.length) {
    lines.push("", "相近的：");
    for (const n of v.neighbors) lines.push(`  · ${n.title}（id=${n.id}）——${n.reason}`);
  }
  return lines.join("\n").trim();
}

/** recipe_get 的 not_found 分支：没找到 + 可执行建议。 */
function renderGetMiss(v) {
  const lines = [v.hint?.text ?? "没找到这道菜。"];
  if (v.suggestions?.length) {
    lines.push("", "也许你想找的是：");
    for (const s of v.suggestions) lines.push(`  · ${s.title}（id=${s.id}）——${s.reason}`);
  }
  return lines.join("\n");
}

// ───────── 计划类文本（0.1.2 原文照搬，只改成从 canonical 值取） ─────────

/** 把算出来的计划变成能读的文字（不交给模型二次加工，避免数字被改） */
export function formatMenu(result) {
  const mood = result.energy === "tired" ? "省事模式" : result.energy === "good" ? "有精力" : "日常";
  const lines = [`${result.days} 天菜单 · ${result.people} 人 · ${mood} · 种子 ${result.seed}`, ""];
  for (const day of result.plan) {
    lines.push(`第 ${day.day} 天`);
    for (const meal of day.meals) {
      lines.push(`  ${meal.name}（合计蛋白 ${meal.protein}g/人，热量 ${meal.kcal}kcal）`);
      for (const d of meal.dishes) {
        const tag = d.role === "protein" ? (d.hasMeat ? "荤" : "蛋白") : d.role === "veg" ? "素" : d.role === "soup" ? "汤" : "补";
        // 口径统一（0.4.1 裁决 1，E1 S2）：下锅的就是原方——菜单与采购清单都按原方份量说话，
        // 单人靠 portionNote 的「吃一半带饭」、多人靠选菜时份量贴近人数，不再出现「按 5 人份做」配「原方 4 人份量」的自相矛盾
        const serve = portionNote(d, result.people) ?? `按原方 ${d.servingsBase || 4} 人份做`;
        const badges = [
          d.minutes ? `约${d.minutes}分钟` : "",
          d.isWant ? "你念叨过" : "",
          d.recentDays != null ? `${d.recentDays}天前做过` : "",
        ].filter(Boolean).join(" · ");
        lines.push(`    [${tag}] ${d.title}（${d.cuisine}·${d.chapter}）· ${serve}${badges ? ` · ${badges}` : ""}`);
        const omit = omitLine(d.omit, "        ↳ ");
        if (omit) lines.push(omit);
        for (const note of d.tableNotes ?? []) lines.push(`        ↳ ${note}`);
      }
    }
    // 每日总盘子（§3.2.3）：对着天级目标说实话，缺早餐/主食的缺口摆出来
    const t = (result.dailyTotals ?? []).find((x) => x.day === day.day);
    if (t) {
      const pTxt = t.proteinTarget != null
        ? `（目标 ${t.proteinTarget}g${t.proteinGap == null ? "" : t.proteinGap < 0 ? `，差 ${-t.proteinGap}g` : t.proteinGap > 0 ? `，超 ${t.proteinGap}g` : "，刚好"}）`
        : "";
      const kTxt = t.kcalTarget != null
        ? `（目标 ${t.kcalTarget}${t.kcalGap == null ? "" : t.kcalGap >= 0 ? `，余 ${t.kcalGap}` : `，超 ${-t.kcalGap}`}）`
        : "";
      lines.push(`  第 ${day.day} 天合计：蛋白 ${t.protein}g${pTxt} · 热量 ${t.kcal} kcal${kTxt}`);
    }
    lines.push("");
  }
  lines.push("主食另配：米饭/面食按人数自备，不写进菜里。");
  if (result.breakfast?.advice?.length) {
    lines.push("");
    lines.push("早餐另配：");
    for (const a of result.breakfast.advice) lines.push(`  - ${a}`);
  }
  // 0.4.1 裁决 12：days=1 没有「顺延一天」可言，文案分开说
  lines.push(result.days > 1
    ? "哪天不想做就顺延一天，这不叫失败——菜单是备选，不是任务。"
    : "今天不想做就先不勉强，这不叫失败——菜单是备选，不是任务。");
  if (result.notes?.length) lines.push(`\n提示：\n  ${result.notes.join("\n  ")}`);
  return lines.join("\n");
}

export function formatShopping(s) {
  const lines = ["采购清单", ""];
  const block = (title, items, withDays = false) => {
    if (!items?.length) return;
    lines.push(title);
    for (const i of items) {
      const days = withDays && i.days?.length ? `（第${i.days.join(",")}天）` : "";
      lines.push(`  ${i.name}  ${i.qty}${days}${i.note ? `  ${i.note}` : ""}`);
    }
    lines.push("");
  };
  block(s.buyOnce.label, s.buyOnce.items);
  for (const b of s.batches) block(b.label, b.items, true);
  block(s.dry?.label, s.dry?.items);
  block(s.staples?.label, s.staples?.items);
  block(s.selfMade?.label, s.selfMade?.items);
  block("蛋奶/豆制品", s.keep);
  lines.push("买回来先分装：肉按每餐一袋冷冻；叶菜两天内吃完，第三天起吃根茎/菌菇。");
  return lines.join("\n");
}

/** menu_shuffle 的 render；closed（这局摇完）只输出 hint + 退路。
 *  0.4.1 裁决 12（E1 Q10）：参数怎么传（excludeIds/rerollCount）是给模型的指令，留在工具
 *  description 与返回值里，不再漏进用户可见文本。 */
function formatShuffle(r) {
  if (r.closed) {
    const lines = [`${r.people} 人 · ${r.combo} · 这局摇完了`, ""];
    lines.push(r.hint);
    lines.push("");
    lines.push("想不出就先不做：煮碗面卧个蛋、剩菜热一下也算一顿。真想再摇，就重新开一局，从头再摇两次。");
    return lines.join("\n");
  }
  const lines = [`${r.people} 人 · ${r.combo} · 第 ${r.rerollCount} 次${r.energy === "tired" ? " · 省事模式" : ""}`];
  for (const d of r.dishes) {
    const tag = d.role === "protein" ? (d.hasMeat ? "荤" : "蛋白") : d.role === "veg" ? "素" : d.role === "soup" ? "汤" : "配";
    const badges = [d.minutes ? `约${d.minutes}分钟` : "", d.isWant ? "你念叨过" : "", d.recentDays != null ? `${d.recentDays}天前做过` : ""].filter(Boolean).join(" · ");
    lines.push(`  [${tag}] ${d.title}（${d.cuisine}·${d.chapter}）${badges ? ` · ${badges}` : ""}`);
    if (d.story) lines.push(`      ${d.story}`);
    const omit = omitLine(d.omit, "      ↳ ");
    if (omit) lines.push(omit);
    for (const note of d.tableNotes ?? []) lines.push(`      ↳ ${note}`);
  }
  lines.push("");
  lines.push(r.hint);
  return lines.join("\n");
}

/** recommend 的 render（R20）：固定 3 个候选，每道「为什么推它」+ 主料 + 种类数/蛋白；
 *  结尾给下一步（选定 → recipe_get / show_card），不消耗随机挑战的次数。 */
function formatRecommend(v) {
  if (!v.candidates.length) return [{ type: "text", text: v.hint.text }];
  const sceneTxt = v.scene === "hungry" ? "饿的晚上" : v.scene === "learn" ? "学菜的晚上" : "日常晚饭";
  const occTxt = v.occasion === "banquet" ? " · 宴请" : "";
  const lines = [`${sceneTxt} · ${v.people} 人${occTxt} · 挑一道${Number.isFinite(v.maxMinutes) ? `（${v.maxMinutes} 分钟内）` : ""}`];
  v.candidates.forEach((d, i) => {
    lines.push(`${i + 1}. ${d.title}（${d.cuisine}${d.chapter ? `·${d.chapter}` : ""}）${d.isProtein ? "" : "（素）"}——${d.why}`);
    const main = d.mainIngredients.length ? d.mainIngredients.join("、") : "—";
    lines.push(`   主料：${main}${d.servings ? ` · 原方 ${d.servings} 人份` : ""} · id=${d.id}`);
    const omit = omitLine(d.omit, "   ");
    if (omit) lines.push(omit);
  });
  lines.push("");
  lines.push(v.hint.text);
  return [{ type: "text", text: lines.join("\n") }];
}

/** cook_rescue 的 render。0.4.1 裁决 7（E1 Q7）：文案与实际过滤分钟数一致——过滤 ≤30 分钟。 */
function formatRescue(v) {
  const lines = ["今天不做大餐就不做，这不是欠账。"];
  if (v.dishes.length) lines.push(`三十分钟能出的：\n  ${v.dishes.join("\n  ")}`);
  if (v.leftovers) lines.push(`冰箱里还有 ${v.leftovers}，热一下、或者炒个饭，也算一顿。`);
  lines.push(v.fallback);
  return lines.join("\n");
}

/** show_card 的 render：告诉模型卡里有什么、用户能拿它干什么。 */
function renderBoard(v) {
  if (!v.found) {
    const missing = v.missing?.length ? `没找到：${v.missing.join("、")}。` : "dishes 是空的。";
    return `${missing}先用 recipe_search 找到菜、拿 id 再传过来。`;
  }
  const lines = [`卡片已生成：《${v.title}》· ${v.dishes.length} 道菜${v.shopping.length ? ` · ${v.shopping.length} 项采购` : ""}`];
  for (const d of v.dishes) {
    lines.push(`  · ${d.title}（${d.cuisine}${d.chapter ? `·${d.chapter}` : ""}）${d.minutes ? ` ${d.minutes} 分钟` : ""}${d.protein ? ` · 蛋白 ${d.protein}g/人` : ""}`);
  }
  const groups = new Map();
  for (const s of v.shopping) {
    const g = s.group || "采购";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(`${s.name}${s.qty ? ` ${s.qty}` : ""}${s.note ? `（${s.note}）` : ""}`);
  }
  for (const [g, items] of groups) lines.push(`${g}：${items.join("、")}`);
  for (const n of v.notes) lines.push(`· ${n}`);
  if (v.missing?.length) lines.push(`没找到：${v.missing.join("、")}`);
  lines.push("卡片在对话里显示；用户可以点卡片上的「钉到侧栏」把它钉在右侧栏，做饭时当菜谱和采购清单看。");
  return lines.join("\n");
}

// ───────── 卡片投影 ─────────
// 浏览器看 card：只放「有界、可回放」的事实。形状与 0.1.2 冻结一致：
// 数组截断、字符串截断、不做 I/O、不读时钟——同一次调用重放必须得到同样的卡片。
const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…` : t;
};
const top = (arr, n) => (Array.isArray(arr) ? arr.slice(0, n) : []);

export function cardSearchFromValue(v) {
  return {
    kind: "search",
    // 0.1.2 的卡片 total 是「命中数（过滤后）」；这里用 total - blocked - hidden 复算
    total: v.total - v.blocked - v.hidden,
    blocked: v.blocked,
    items: top(v.hits, 12).map((h) => ({
      id: h.id,
      title: h.title,
      cuisine: h.cuisine,
      chapter: h.chapter ?? "",
      minutes: h.minutes,
      protein: h.proteinPerServing ?? null,
      main: top(h.mainIngredients, 4),
      features: clip(h.features, 60),
      skill: h.tier ?? null,
    })),
  };
}

export function cardRecipeFromValue(r) {
  return {
    kind: "recipe",
    id: r.id,
    title: r.title,
    cuisine: r.cuisine,
    chapter: r.chapter ?? "",
    book: r.book,
    page: r.page ?? null,
    minutes: r.minutes,
    servings: r.servings,
    protein: r.protein ?? null,
    kcal: r.kcal ?? null,
    salt: r.salt ?? null,
    allergens: top(r.allergens, 6),
    ingredients: top(r.ingredients, 24).map((i) => ({
      name: i.name,
      amount: i.amount || "",
      grams: i.grams ?? null,
    })),
    steps: top(r.steps, 20).map((s) => clip(s, 220)),
    features: clip(r.features, 160),
    notes: top(r.notes, 4).map((s) => clip(s, 120)),
    variants: top(r.variants, 6),
    skill: r.skill ?? null,
  };
}

export function cardBoard(v) {
  return {
    kind: "board",
    title: clip(v.title, 40),
    dishes: top(v.dishes, 4).map((r) => cardRecipeFromValue(r)),
    shopping: top(v.shopping, 40).map((s) => ({
      group: s.group ? clip(s.group, 20) : null,
      name: clip(s.name, 40),
      qty: s.qty ? clip(s.qty, 30) : null,
      note: s.note ? clip(s.note, 60) : null,
    })),
    notes: top(v.notes, 6).map((n) => clip(n, 120)),
  };
}

export function cardPlan(result) {
  return {
    kind: "plan",
    days: result.days,
    people: result.people,
    energy: result.energy ?? "normal",
    seed: result.seed,
    maxMinutes: result.maxMinutes ?? null,
    menu: top(result.plan, 7).map((d) => ({
      day: d.day,
      meals: top(d.meals, 2).map((m) => ({
        name: m.name,
        protein: m.protein,
        kcal: m.kcal,
        dishes: top(m.dishes, 4).map((x) => ({
          id: x.id,
          title: x.title,
          role: x.role,
          cuisine: x.cuisine,
          chapter: x.chapter ?? "",
          minutes: x.minutes ?? null,
          note: top(x.tableNotes, 2),
          want: Boolean(x.isWant),
          recent: x.recentDays ?? null,
        })),
      })),
    })),
    shopping: {
      buyOnce: top(result.shopping?.buyOnce?.items, 20).map((i) => ({ name: i.name, qty: i.qty })),
      batches: top(result.shopping?.batches, 3).map((b) => ({ label: b.label, items: top(b.items, 20).map((i) => ({ name: i.name, qty: i.qty, days: top(i.days, 7) })) })),
      staples: top(result.shopping?.staples?.items, 20).map((i) => ({ name: i.name, qty: i.qty })),
      selfMade: top(result.shopping?.selfMade?.items, 5).map((i) => ({ name: i.name, qty: i.qty })),
      keep: top(result.shopping?.keep, 10).map((i) => ({ name: i.name, qty: i.qty })),
    },
    notes: top(result.notes, 6).map((n) => clip(n, 120)),
  };
}

export function cardShuffle(r) {
  return {
    kind: "shuffle",
    people: r.people,
    combo: r.combo,
    rerollCount: r.rerollCount,
    energy: r.energy ?? "normal",
    askReason: Boolean(r.askReason),
    dishes: top(r.dishes, 4).map((d) => ({
      id: d.id,
      title: d.title,
      role: d.role,
      cuisine: d.cuisine,
      chapter: d.chapter ?? "",
      minutes: d.minutes ?? null,
      protein: d.proteinPerServing ?? null,
      want: Boolean(d.isWant),
      note: top(d.tableNotes, 2),
      story: clip(d.story, 80),
    })),
    hint: clip(r.hint, 160),
  };
}

export function cardRescue(dishes, fallback) {
  return {
    kind: "rescue",
    dishes: top(dishes, 4).map((d) => ({ name: d, })).map((x) => x.name),
    fallback: clip(fallback, 160),
  };
}

export function cardRecommend(v) {
  return {
    kind: "recommend",
    scene: v.scene,
    people: v.people,
    occasion: v.occasion ?? "daily",
    items: top(v.candidates, 3).map((d) => ({
      id: d.id,
      title: d.title,
      cuisine: d.cuisine,
      chapter: d.chapter ?? "",
      minutes: d.minutes,
      variety: d.variety,
      protein: d.proteinPerServing ?? null,
      kcal: d.kcalPerServing ?? null,
      skill: d.tier ?? null,
      isProtein: Boolean(d.isProtein),
      why: clip(d.why, 100),
      main: top(d.mainIngredients, 4),
      note: top(d.omit, 2).map((o) => `免${o.target}版：省去 ${o.target}（约 ${Math.round(o.grams ?? 0)} g）`),
    })),
    hint: clip(v.hint.text, 200),
  };
}

// ───────── JSON Schema（只声明实际会返回的形状） ─────────
// ⚠️ 宿主只支持受限的 JSON Schema 子集（dsh-app-boot 的 assertSupportedJsonSchema）：
//   - type 只能是单个字符串，**不支持 type 数组**；
//   - oneOf 不能与 properties/required/additionalProperties/items/enum/const 并列；
//   - 只允许 type/oneOf/properties/required/additionalProperties/items/enum/const +
//     description/title/default/examples 这些关键字。
// 所以「可空」不能写 type:["number","null"]，要写 oneOf:[{type:"number"},{type:"null"}]。
// 0.2.0 第一次装到宿主时就是因为 type 数组导致工具注册被拒、插件不激活；本地契约测试的
// 校验器比宿主宽松，没抓到——tools/contract-test.mjs 现在也按宿主子集校验 schema。
const nullable = (type) => ({ oneOf: [{ type }, { type: "null" }] });
const nullableNumber = nullable("number");
const nullableInteger = nullable("integer");
const nullableString = nullable("string");
const nullableObject = (properties, required, additionalProperties = false) => ({
  oneOf: [
    { type: "object", properties, ...(required ? { required } : {}), additionalProperties },
    { type: "null" },
  ],
});

const neighborSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    reason: { type: "string" },
  },
  required: ["id", "title", "reason"],
  additionalProperties: false,
};

const searchHintSchema = {
  type: "object",
  properties: {
    code: { type: "string", enum: ["ok", "no_hit", "no_anchor", "all_blocked"] },
    text: nullableString,
  },
  required: ["code", "text"],
  additionalProperties: false,
};

const omitItemSchema = {
  type: "object",
  properties: {
    target: { type: "string" },
    grams: nullableNumber,
  },
  required: ["target", "grams"],
  additionalProperties: false,
};

const searchHitSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    book: { type: "string" },
    cuisine: { type: "string" },
    chapter: { type: "string" },
    page: nullableNumber,
    minutes: { type: "number" },
    servings: nullableNumber,
    proteinPerServing: nullableNumber,
    kcalPerServing: nullableNumber,
    tier: nullableString,
    mainIngredients: { type: "array", items: { type: "string" } },
    features: { type: "string" },
    blurb: { type: "string" },
    lineIngredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: nullableString,
          raw: { type: "string" },
          amount: { type: "string" },
        },
        required: ["name", "raw", "amount"],
        additionalProperties: false,
      },
    },
    ingredientCount: { type: "integer" },
    // R2b：配料级忌口（免 X 版要省去的料）；无画像约束时为空数组
    omit: { type: "array", items: omitItemSchema },
  },
  required: ["id", "title", "book", "cuisine", "chapter", "page", "minutes", "servings", "proteinPerServing", "kcalPerServing", "tier", "mainIngredients", "features", "blurb", "lineIngredients", "ingredientCount", "omit"],
  additionalProperties: false,
};

const searchSchema = {
  type: "object",
  properties: {
    hits: { type: "array", items: searchHitSchema },
    total: { type: "integer" },
    blocked: { type: "integer" },
    hidden: { type: "integer" },
    libraryTotal: { type: "integer" },
    neighbors: { type: "array", items: neighborSchema },
    hint: searchHintSchema,
  },
  required: ["hits", "total", "blocked", "hidden", "libraryTotal", "neighbors", "hint"],
  additionalProperties: false,
};

const recipeValueSchema = nullableObject({
  id: { type: "string" },
  title: { type: "string" },
  cuisine: { type: "string" },
  chapter: { type: "string" },
  book: { type: "string" },
  page: nullableNumber,
  seq: nullableString,
  recoveredTitle: nullableString,
  minutes: { type: "number" },
  servings: nullableNumber,
  protein: nullableNumber,
  kcal: nullableNumber,
  salt: nullableNumber,
  allergens: { type: "array", items: { type: "string" } },
  ingredients: {
    type: "array",
    items: {
      type: "object",
      properties: {
        name: nullableString,
        amount: { type: "string" },
        grams: nullableNumber,
      },
      required: ["name", "amount", "grams"],
      additionalProperties: false,
    },
  },
  steps: { type: "array", items: { type: "string" } },
  features: { type: "string" },
  notes: { type: "array", items: { type: "string" } },
  variants: { type: "array", items: { type: "string" } },
  skill: nullableString,
  blurb: { type: "string" },
  nutrition: nullableObject({
    proteinGrams: nullableNumber,
    fatGrams: nullableNumber,
    kcal: nullableNumber,
    saltGrams: nullableNumber,
    oilGrams: nullableNumber,
  }, undefined, true),
  // R2b 两级忌口：omit = 配料级（省去即可）；avoidMain = 主料级（不推荐这道菜）
  omit: { type: "array", items: omitItemSchema },
  avoidMain: { type: "array", items: { type: "string" } },
}, ["id", "title", "cuisine", "chapter", "book", "page", "seq", "recoveredTitle", "minutes", "servings", "protein", "kcal", "salt", "allergens", "ingredients", "steps", "features", "notes", "variants", "skill", "blurb", "nutrition", "omit", "avoidMain"]);

const memorySchema = nullableObject({
  lastDays: nullableInteger,
  loved: { type: "boolean" },
  never: { type: "boolean" },
  want: { type: "boolean" },
}, ["lastDays", "loved", "never", "want"]);

const getHintSchema = nullableObject({
  code: { type: "string" },
  text: { type: "string" },
}, ["code", "text"]);

const getSchema = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    recipe: recipeValueSchema,
    memory: memorySchema,
    suggestions: { type: "array", items: neighborSchema },
    hint: getHintSchema,
  },
  required: ["found", "recipe", "suggestions"],
  additionalProperties: false,
};

const boardShoppingSchema = {
  type: "object",
  properties: {
    group: nullableString,
    name: { type: "string" },
    qty: nullableString,
    note: nullableString,
  },
  required: ["group", "name", "qty", "note"],
  additionalProperties: false,
};

const boardHintSchema = nullableObject({
  code: { type: "string" },
  text: { type: "string" },
}, ["code", "text"]);

const showCardSchema = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    title: { type: "string" },
    dishes: { type: "array", items: recipeValueSchema },
    shopping: { type: "array", items: boardShoppingSchema },
    notes: { type: "array", items: { type: "string" } },
    missing: { type: "array", items: { type: "string" } },
    hint: boardHintSchema,
  },
  required: ["found", "title", "dishes", "shopping", "notes", "missing", "hint"],
  additionalProperties: false,
};

const objectSchema = { type: "object", additionalProperties: true };
const stringSchema = { type: "string" };

// R20 recommend 的候选与返回值。固定 3 个候选（池子撑不起时如实少于 3，由 hint 说破）
const recommendCandidateSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    title: { type: "string" },
    cuisine: { type: "string" },
    chapter: { type: "string" },
    book: { type: "string" },
    page: nullableNumber,
    minutes: { type: "number" },
    tier: nullableString,
    variety: { type: "integer" },
    proteinPerServing: nullableNumber,
    kcalPerServing: nullableNumber,
    servings: nullableNumber,
    mainIngredients: { type: "array", items: { type: "string" } },
    isProtein: { type: "boolean" },
    why: { type: "string" },
    omit: { type: "array", items: omitItemSchema },
    blurb: { type: "string" },
  },
  required: ["id", "title", "cuisine", "chapter", "book", "page", "minutes", "tier", "variety", "proteinPerServing", "kcalPerServing", "servings", "mainIngredients", "isProtein", "why", "omit", "blurb"],
  additionalProperties: false,
};

const recommendHintSchema = {
  type: "object",
  properties: {
    code: { type: "string", enum: ["ok", "thin", "empty"] },
    text: { type: "string" },
  },
  required: ["code", "text"],
  additionalProperties: false,
};

const recommendSchema = {
  type: "object",
  properties: {
    scene: { type: "string", enum: ["hungry", "daily", "learn"] },
    occasion: { type: "string", enum: ["daily", "banquet"] },
    people: { type: "integer" },
    energy: { type: "string" },
    maxMinutes: nullableNumber,
    intent: nullableString,
    candidates: { type: "array", items: recommendCandidateSchema },
    excludeIds: { type: "array", items: { type: "string" } },
    hint: recommendHintSchema,
  },
  required: ["scene", "occasion", "people", "energy", "maxMinutes", "intent", "candidates", "excludeIds", "hint"],
  additionalProperties: false,
};

function profileSummary(profile, presets, state = null) {
  const lt = profile.longTerm ?? {};
  const c = resolveConstraints(profile, presets);
  const lines = [];
  lines.push(`家庭：${profile.household?.size ?? "?"} 人（大人 ${profile.household?.adults ?? "?"}、小孩 ${profile.household?.children ?? 0}）`);
  const likes = (lt.likes ?? []).map((l) => l.target).join("、") || "—";
  const dislikes = (lt.dislikes ?? []).map((d) => `${d.target}${d.hard ? "(硬)" : ""}`).join("、") || "—";
  const allergies = (lt.allergies ?? []).map((a) => `${a.target}${a.allergen ? `→${a.allergen}` : ""}`).join("、") || "—";
  lines.push(`长期：喜欢 ${likes}；不吃 ${dislikes}；过敏 ${allergies}`);
  const active = activePeriods(profile);
  if (active.length) {
    for (const p of active) {
      const preset = presets[p.preset];
      lines.push(`周期：${p.label ?? preset?.label ?? p.preset}（${p.start ?? "—"} → ${p.end ?? "长期"}）${preset?.note ? ` · ${preset.note}` : ""}`);
    }
  } else {
    lines.push("周期：当前没有生效中的阶段性需求");
  }
  const sk = profile.skills ?? {};
  lines.push(`技能：顺手 ${(sk.confident ?? []).join("、") || "—"}；不碰 ${(sk.avoid ?? []).join("、") || "—"}`);
  lines.push(`设备：${(profile.equipment ?? []).join("、") || "—"}`);
  const eff = [];
  if (c.proteinTarget) eff.push(`蛋白 ≥${c.proteinTarget}g/人/餐`);
  if (c.kcalTarget) eff.push(`热量 ≤${c.kcalTarget}kcal/人/餐`);
  if (c.saltTarget) eff.push(`盐 ≤${c.saltTarget}g/人/餐`);
  eff.push(`难度只收 ${[...c.allowTiers].join("/")}`);
  lines.push(`当前生效约束：${eff.join("；")}`);
  // R2b：忌口两级——让模型知道「忌 X」不是把含 X 的菜全毙，主料换菜、配料省去
  if (c.avoidCanon?.size) lines.push(`忌口（两级语义）：${[...c.avoidCanon].join("、")}——主料含它们的菜会被换掉，配料级的菜照常推荐但省去该料（免 X 版）`);
  if (state) {
    const wants = openWants(state);
    if (wants.length) lines.push(`想吃：${wants.map((w) => w.title).filter(Boolean).join("、")}`);
    const left = leftoversLine(state);
    if (left) lines.push(`冰箱里还有：${left}`);
    const v = verdicts(state);
    if (v.never.size) lines.push(`不再做：${[...v.never].filter((x) => !/-\d{3}$/.test(x)).join("、")}`);
    const cooks = (state.cookLog ?? []).length;
    if (cooks) lines.push(`做饭记录：${cooks} 次（最近一次 ${state.cookLog.at(-1)?.date ?? "?"}）`);
  }
  if (profile.updatedAt) lines.push(`更新于 ${profile.updatedAt}`);
  return lines.join("\n");
}

function makeContext(config) {
  const dataDir = config.dataDir || DEFAULT_DATA;
  const profileFile = config.profileFile || join(dirname(dataDir), "profile.json");
  const stateFile = config.stateFile || join(dirname(dataDir), "user-state.json");
  const presetsFile = join(dataDir, "presets.json");
  let book = null;
  let planner = null;
  let profile = null;
  let state = null;
  let profileStamp = null;

  const getBook = () => {
    if (!book) book = new RecipeBook(dataDir);
    else book.ensureFresh();
    return book;
  };
  const getPresets = () => (existsSync(presetsFile) ? JSON.parse(readFileSync(presetsFile, "utf8")).presets : {});
  const getProfile = () => {
    if (!profile) profile = loadProfile(profileFile);
    return profile;
  };
  const getState = () => {
    if (!state) state = loadState(stateFile);
    return state;
  };
  const getPlanner = () => {
    const stamp = JSON.stringify(getProfile()) + JSON.stringify(getState()) + getBook().mtime;
    if (!planner || profileStamp !== stamp) {
      planner = new Planner(getBook(), getProfile(), getPresets(), getState());
      planner.refresh();
      profileStamp = stamp;
    }
    return planner;
  };
  const save = (p) => {
    profile = saveProfile(profileFile, p);
    planner = null;
    return profile;
  };
  const saveState = (s) => {
    state = saveStateFile(stateFile, s);
    planner = null;
    return state;
  };
  const planFile = join(dataDir, "last-plan.json");
  const savePlan = (result) => {
    try {
      mkdirSync(dirname(planFile), { recursive: true });
      writeFileSync(planFile, JSON.stringify(result, null, 1), "utf8");
    } catch { /* 存不下也不影响回答 */ }
  };

  return { getBook, getPresets, getProfile, getState, getPlanner, save, saveState, savePlan, profileFile, stateFile };
}

export function registerTools(ctx, config = {}) {
  const c = makeContext(config);

  const search = {
    name: "recipe_search",
    description: [
      "在《中国菜谱》各省分册里找老菜谱（1970–80 年代原配比）。",
      "默认按用户画像过滤：过敏原、明确不吃、做不了的技法都会被剔除；",
      "画像里没有的东西不会影响结果。找完用 recipe_get 取完整做法。",
      "intent=fast 用于「饿的晚上」（快、家常、35 分钟内）；intent=learn 用于「学菜的晚上」（放开难度，允许要练的菜）。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        ingredients: { type: "array", items: { type: "string" }, description: "手头食材，如 [\"五花肉\",\"冬笋\"]；默认全部命中，match=any 则任一命中。" },
        cuisine: { type: "string", description: "分册，如 上海、广东、四川。" },
        chapter: { type: "string", description: "书的分类：肉菜类、水产菜类、禽蛋菜类、野味菜类、甜菜类、素菜类、其他菜类。" },
        method: { type: "string", description: "技法，如 蒸、烧、炒、炸、炖、焖、爆。" },
        flavor: { type: "string", description: "口味，如 咸鲜、糖醋、麻辣、香酥、酸甜。" },
        q: { type: "string", description: "自由关键词（菜名或特点里的词）。" },
        match: { type: "string", enum: ["all", "any"], description: "多食材匹配方式，默认 all。" },
        skillTier: { type: "string", enum: ["easy", "learn", "hard"], description: "难度：easy 好上手 / learn 要练 / hard 费工。" },
        minProtein: { type: "number", description: "每人蛋白下限（g），找高蛋白菜用。" },
        maxKcal: { type: "number", description: "每人热量上限（kcal），减脂用。" },
        respectProfile: { type: "boolean", description: "是否按用户画像过滤，默认 true。用户明确说“不管忌口”时才关掉。" },
        limit: { type: "integer", description: "返回条数，默认 8，上限 50。" },
        intent: { type: "string", enum: ["fast", "learn"], description: "fast=饿的晚上，快、家常、35 分钟内；learn=学菜的晚上，可以挑战硬菜/考据。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const book = c.getBook();
      const limit = Math.min(50, Math.max(1, Number(args.limit) || Number(config.limit) || 8));
      const intent = args.intent === "fast" || args.intent === "learn" ? args.intent : null;
      const query = {
        ingredients: Array.isArray(args.ingredients) ? args.ingredients : args.ingredients ? [String(args.ingredients)] : [],
        cuisine: args.cuisine || undefined,
        chapter: args.chapter || undefined,
        method: args.method || undefined,
        flavor: args.flavor || undefined,
        q: args.q || undefined,
        match: args.match === "any" ? "any" : "all",
        // intent=fast 补一个 easy 下限（显式 skillTier 优先）；learn 不加过滤
        skillTier: args.skillTier || (intent === "fast" ? "easy" : undefined),
        minProtein: args.minProtein ?? undefined,
        maxKcal: args.maxKcal ?? undefined,
      };

      const { hits, total } = book.searchWithTotal(query);
      const prof = c.getProfile();
      const libraryTotal = book.recipes.length;
      let filtered = hits;
      let blocked = 0;        // 画像硬约束（过敏/忌口/难度/技法口味/热量硬挡）
      let hiddenBulk = 0;     // 批量配方/疑似串行菜（0.4.1 裁决 2，E3 S-F）
      let hiddenKitchen = 0;  // 野味/贵价食材（0.4.1 裁决 4，与 practical() 同源）
      let allergenGuard = 0;  // 标题含虾/蟹/贝而标签未标的防御拦截（0.4.1 裁决 3，E3 S-E）

      // 用户点名的词不做厨房排除：q=鱼肚 就是要鱼肚，别拿「贵价」挡回去（B2 只管顺带浮上来的）
      const named = cleanText(args.q) + (Array.isArray(args.ingredients) ? args.ingredients : args.ingredients ? [String(args.ingredients)] : [])
        .map((s) => cleanText(s)).join("");
      const kitchenExcluded = (r) => {
        if (/野味/.test(r.chapter ?? "") && !named.includes("野味")) return true;
        const words = [];
        if (prof.kitchen?.excludeExotic !== false) words.push(...EXOTIC_INGREDIENTS);
        if (prof.kitchen?.excludeLuxury !== false) words.push(...LUXURY_INGREDIENTS);
        return words.some((w) => !named.includes(w)
          && ((r.title ?? "").includes(w) || (r.ingredients ?? []).some((i) => (i.name ?? "").includes(w) || i.canon === w)));
      };

      // 过滤顺序（0.4.1）：批量/串行 → 画像 → 厨房。bulk 先分桶，61kg 的馆子批量方
      // 无论难不难都记在「隐藏」上，hint 才说得清（口径与菜单层 practical() 一致）。
      // respectProfile=false 时全部放开（0.4.1 裁决 4：厨房排除也不再兜底）。
      let cons = null; // R2b：留着给 hitValue 标「免 X 版」（配料级忌口）
      if (args.respectProfile !== false) {
        cons = resolveConstraints(prof, c.getPresets());
        if (intent === "learn") cons.allowTiers = new Set([...cons.allowTiers, "learn", "hard"]); // 学菜的晚上放开难度档
        const keep = [];
        for (const h of hits) {
          if (h.recipe.bulk || h.recipe.suspectTitle) { hiddenBulk++; continue; }
          const s = scoreRecipe(h.recipe, cons);
          if (s.score === -Infinity) {
            blocked++;
            if (s.blocked.some((b) => b.includes("防御拦截"))) allergenGuard++;
            continue;
          }
          if (kitchenExcluded(h.recipe)) { hiddenKitchen++; continue; }
          keep.push(h);
        }
        filtered = keep;
      }

      // intent=fast：35 分钟内才值得饿着肚子等（§3.6，execute 内过滤，不动 query 层）
      if (intent === "fast") {
        filtered = filtered.filter((h) => estimateMinutes(h.recipe) <= 35);
      }

      const hidden = hiddenBulk + hiddenKitchen;
      const base = { total, blocked, hidden, libraryTotal };

      // 分支 4：有命中但全被策略挡掉
      if (!filtered.length && (blocked > 0 || hidden > 0)) {
        const why = blocked > 0 ? "忌口/难度" : hiddenBulk > 0 ? "批量配方/疑似串行" : "野味/贵价食材";
        const relax = blocked > 0 || hiddenBulk > 0
          ? "想全看看也行，跟我说一句「这次不看忌口」——但那会连过敏一起放开，慎用。"
          : "想见见世面也行，跟我说一声，或者把画像里「不排野味/贵价」的设置关掉再搜。";
        return {
          ...base,
          hits: [],
          neighbors: [],
          hint: { code: "all_blocked", text: `找到 ${total} 道，可惜都被「${why}」先挡下了。${relax}` },
        };
      }

      // 分支 2/3：零命中。有锚点 → no_hit；连锚点都没有 → no_anchor。近邻只为 no_hit 找。
      if (!filtered.length) {
        // 覆盖范围（0.4.1 裁决 9，E2 O9）：「南北」是书名不是省名，单列出来；
        // 并把「为什么没有佛跳墙」说破——不是检索不好，是没有闽菜分册
        const facets = book.facetsOf();
        const provinces = facets.cuisines.filter((x) => x !== "南北");
        const coverage = `《中国菜谱》${provinces.length} 个省分册（${provinces.join("、")}）+《中国南北名菜谱》，暂无闽菜等分册，所以没有佛跳墙这类菜`;
        const analysis = args.q ? book.analyzeQuery(String(args.q)) : { ingredients: [], methods: [], literal: false };
        const anchor = analysis.methods[0] ?? analysis.ingredients[0] ?? (analysis.literal && args.q ? String(args.q) : null);
        const neighbors = anchor && args.q
          ? top(book.neighbors(String(args.q), { limit: 5, cuisine: query.cuisine, chapter: query.chapter, method: query.method }), 5)
          : [];
        if (!anchor) {
          return {
            ...base,
            hits: [],
            neighbors: [],
            hint: {
              code: "no_anchor",
              text: `咱们书架上还没有这道菜，也找不到能搭上边的同类。覆盖范围：${coverage}。想要类似的可以试试技法词（清汤/蒸/煨/坛），或者告诉我你今天想吃个什么路子，我来想办法。`,
            },
          };
        }
        const label = analysis.methods[0] ? `「${analysis.methods[0]}」` : analysis.ingredients[0] ? `「${analysis.ingredients[0]}」` : `「${String(args.q).trim()}」`;
        const found = neighbors.length ? `；按${label}找到这些：${neighbors.map((n) => n.title).join("、")}` : "";
        return {
          ...base,
          hits: [],
          neighbors,
          hint: {
            code: "no_hit",
            text: `没有这道菜${found}。不急——换个叫法、或把部位词去掉再试试。覆盖范围：${coverage}。`,
          },
        };
      }

      // 分支 1：ok。hint 从此可能带话（0.4.1）：
      //   弱命中（裁决 8）：q 整串在标题/用料/特点里字面不中——库内没有这道菜，
      //   结果全是相近字词放宽出来的，必须先说破，别装作命中（q=红烧肉 235 条 top1 烧肉三鲜）。
      //   隐藏说明（裁决 2/3）：批量配方与防御拦截各记一句，数字口径与菜单层一致。
      const notes = [];
      if (args.q && !book.analyzeQuery(String(args.q)).literal) {
        notes.push(`没有完全命中「${String(args.q).trim()}」——库里还没收录这道菜，下面是按相近字词放宽找的，先看看对不对味`);
      }
      if (hiddenBulk > 0) notes.push(`已隐藏 ${hiddenBulk} 道批量配方/疑似串行菜（想看全的跟我说一声就行）`);
      if (allergenGuard > 0) notes.push(`另有 ${allergenGuard} 道标题含虾/蟹/贝但过敏原未标注，已按你的过敏防御过滤`);
      return {
        ...base,
        hits: top(filtered, limit).map((h) => hitValue(h, cons)),
        neighbors: [],
        hint: { code: "ok", text: notes.length ? `${notes.join("；")}。` : null },
      };
    },
    output: output(
      searchSchema,
      (_a, v) => {
        if (v.hits.length) {
          // 0.4.1 裁决 8：弱命中/隐藏说明前置——先说破「没有完全命中」，再列结果
          const head = `命中 ${v.total - v.blocked - v.hidden} 道${v.blocked ? `（另有 ${v.blocked} 道按忌口/难度过滤）` : ""}（共 ${v.libraryTotal} 道）`;
          const pre = v.hint?.text ? `${v.hint.text}\n\n` : "";
          return [{ type: "text", text: [pre + head, "", ...v.hits.map(summaryLine)].join("\n") }];
        }
        return [{ type: "text", text: renderSearchMiss(v) }];
      },
      // 卡片只在 ok 分支投影：零命中/all_blocked 的价值全在 render 的 hint 里，
      // 返回空 search 卡只会渲染「命中 0 道」的空框，让 UI 回退 generic 文本更好（Lead 裁决）。
      (_a, v) => (v.hint?.code === "ok" ? cardSearchFromValue(v) : null),
    ),
  };

  const get = {
    name: "recipe_get",
    description: "取一道菜的完整原文：原始斤两配比（附克数）、分步做法、特点、出处页码、蛋白与份量。",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "菜谱 id，如 上海-001。" },
        title: { type: "string", description: "菜名，可模糊匹配。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const book = c.getBook();
      const r = args.id ? book.get(String(args.id)) : args.title ? book.findTitle(String(args.title)) : null;
      if (!r) {
        const q = String(args.title ?? args.id ?? "").trim();
        const suggestions = q ? top(book.neighbors(q, { limit: 3 }), 3) : [];
        return {
          found: false,
          recipe: null,
          suggestions,
          hint: {
            code: "not_found",
            text: "没找到这道菜。菜名对不上的时候，先用搜索按名字或食材找一找，拿到结果再回来看它。",
          },
        };
      }
      const st = c.getState();
      const recent = recentCooks(st);
      const v = verdicts(st);
      const wants = openWants(st);
      const days = Math.min(recent.byId.get(r.id) ?? 999, recent.byTitle.get(r.title) ?? 999);
      const memory = {
        lastDays: days <= 30 ? days : null,
        loved: v.loved.has(r.id) || v.loved.has(r.title),
        never: v.never.has(r.id) || v.never.has(r.title),
        want: wants.some((w) => w.title === r.title),
      };
      // R2b：对着画像算这道菜的两级忌口——配料级给「免 X 版」提示，主料级说明为何不推荐
      const cons = resolveConstraints(c.getProfile(), c.getPresets());
      return { found: true, recipe: recipeValue(r, cons), memory, suggestions: [] };
    },
    output: output(
      getSchema,
      (_a, v) => {
        if (!v.found) return [{ type: "text", text: renderGetMiss(v) }];
        const lines = [recipeTextFromValue(v.recipe)];
        // R2b 两级忌口提示：配料级 →「免 X 版：省去 X」；主料级 → 说明菜单不排这道
        if (v.recipe.avoidMain?.length) {
          lines.push(`提醒：这道菜的主料含你忌口的 ${v.recipe.avoidMain.join("、")}——主料省了就不是这道菜，菜单和检索都不会推荐它，做法仅作参考。`);
        }
        if (v.recipe.omit?.length) {
          lines.push(`${omitLine(v.recipe.omit, "")}——配料级的量，按做法做到放${v.recipe.omit.length > 1 ? "这些料" : "这料"}的那步直接跳过即可。`);
        }
        const m = v.memory ?? {};
        if (m.lastDays != null && m.lastDays <= 30) {
          lines.push(`\n上次做过：${m.lastDays === 0 ? "今天" : `${m.lastDays} 天前`}${m.never ? "（你说过以后不做了）" : m.loved ? "（你说好吃）" : ""}`);
        }
        if (m.want) lines.push("你之前念叨过想吃这道。");
        lines.push(`预计 ${v.recipe.minutes} 分钟。`);
        return [{ type: "text", text: lines.join("\n") }];
      },
      (_a, v) => (v.found ? cardRecipeFromValue(v.recipe) : null),
    ),
  };

  const show = {
    name: "profile_show",
    description: "看当前用户画像：家庭人数、长期喜恶、过敏、生效中的周期性需求、技能与设备、以及此刻真正生效的约束。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return profileSummary(c.getProfile(), c.getPresets(), c.getState());
    },
    output: output(stringSchema, renderString),
  };

  const update = {
    name: "profile_update",
    description: [
      "改用户画像。区分两件事：长期偏好（喜欢/讨厌/过敏/饮食方式）进 longTerm，",
      "阶段需求（最近健身、孕期、减脂）进 periods 并带时间窗口。",
      "用完把改动说给用户听，尤其是过敏这类硬约束。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_household", "like", "dislike", "allergy", "remove", "set_skills", "set_diet", "set_kitchen", "add_period", "end_period", "set_equipment", "add_want", "satisfy_want", "add_note"],
          description: "要做的改动。add_want=记下想吃的东西；satisfy_want=那个念头实现了；add_note=记一句关于吃的闲话。",
        },
        target: { type: "string", description: "食材或类别名，如 猪肉、大蒜、虾。remove 时填要删的值；end_period 时填标签。" },
        kind: { type: "string", enum: ["like", "dislike", "allergy", "avoid"], description: "remove 时指定删哪一类。" },
        allergen: { type: "string", description: "allergy 用：甲壳类/贝类/鱼类/蛋类/乳/大豆/花生/坚果/芝麻/小麦。" },
        hard: { type: "boolean", description: "dislike 用：true = 完全不要出现。" },
        weight: { type: "number", description: "偏好强度，默认 like +2、dislike -2。" },
        size: { type: "integer", description: "set_household 用：总人数。" },
        adults: { type: "integer", description: "set_household 用：大人数。" },
        children: { type: "integer", description: "set_household 用：小孩数。" },
        confident: { type: "array", items: { type: "string" }, description: "set_skills 用：做得顺手的技法。" },
        avoid: { type: "array", items: { type: "string" }, description: "set_skills 用：不想碰的技法。" },
        willing: { type: "array", items: { type: "string" }, description: "set_skills 用：愿意学的难度 tier（learn/hard）。" },
        diet: { type: "object", description: "set_diet 用，如 {vegetarian:true}、{noPork:true}、{noSeafood:true}、{noBeef:true}。" },
        kitchen: { type: "object", description: "set_kitchen 用，如 {excludeExotic:false}、{excludeLuxury:false}。" },
        equipment: { type: "array", items: { type: "string" }, description: "set_equipment 用：家里的设备。" },
        preset: { type: "string", enum: ["fitness", "fat_loss", "pregnancy", "low_salt", "low_fat", "kids", "vegetarian"], description: "add_period 用：场景模板。" },
        label: { type: "string", description: "add_period 用：给这段时间起个名，如 备赛、产后。" },
        start: { type: "string", description: "add_period 用：开始日期 YYYY-MM-DD，默认今天。" },
        end: { type: "string", description: "add_period 用：结束日期 YYYY-MM-DD。" },
        days: { type: "integer", description: "add_period 用：从今天起持续几天（和 end 二选一）。" },
        goals: { type: "object", description: "add_period 用：覆盖模板目标，如 {proteinPerServing:40}。" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args = {}) {
      const p = structuredClone(c.getProfile());
      const a = String(args.action);
      const today = new Date().toISOString().slice(0, 10);

      // 「想吃的」和「随口一句」进的是 state，不是画像
      if (a === "add_want" || a === "satisfy_want" || a === "add_note") {
        const s = structuredClone(c.getState());
        const target = String(args.target ?? "").trim();
        if (!target) return "需要 target：想吃的那道菜，或要记的那句话。";
        if (a === "add_want") {
          s.wants = [...(s.wants ?? []).filter((w) => w.title !== target), { title: target, note: args.note ?? "", addedAt: today, satisfiedAt: null }];
        } else if (a === "satisfy_want") {
          let hit = false;
          s.wants = (s.wants ?? []).map((w) => {
            if (!w.satisfiedAt && (w.title === target || w.title?.includes(target) || target.includes(w.title))) {
              hit = true;
              return { ...w, satisfiedAt: today };
            }
            return w;
          });
          if (!hit) return `「${target}」这条想吃记录已经划掉了。想看看现在还惦记着哪些菜，跟我说一声就行。`;
        } else {
          s.notes = [...(s.notes ?? []), { date: today, text: target }];
        }
        c.saveState(s);
        return `记下了。\n\n${profileSummary(c.getProfile(), c.getPresets(), c.getState())}`;
      }

      if (a === "set_household") {
        p.household = { ...p.household, size: Number(args.size ?? p.household.size), adults: Number(args.adults ?? p.household.adults ?? args.size ?? p.household.size), children: Number(args.children ?? p.household.children ?? 0) };
      } else if (a === "like" || a === "dislike" || a === "allergy") {
        const target = String(args.target ?? "").trim();
        if (!target) return "需要 target：要记的食材名。";
        if (a === "allergy") {
          p.longTerm.allergies = [...(p.longTerm.allergies ?? []).filter((x) => x.target !== target), { target, allergen: args.allergen ?? null }];
        } else if (a === "like") {
          p.longTerm.likes = [...(p.longTerm.likes ?? []).filter((x) => x.target !== target), { target, weight: Number(args.weight ?? 2) }];
        } else {
          p.longTerm.dislikes = [...(p.longTerm.dislikes ?? []).filter((x) => x.target !== target), { target, weight: Number(args.weight ?? -2), hard: Boolean(args.hard) }];
        }
      } else if (a === "remove") {
        const target = String(args.target ?? "");
        const kind = String(args.kind ?? "dislike");
        const key = kind === "allergy" ? "allergies" : kind === "like" ? "likes" : kind === "avoid" ? "avoid" : "dislikes";
        p.longTerm[key] = (p.longTerm[key] ?? []).filter((x) => x.target !== target);
      } else if (a === "set_skills") {
        p.skills = {
          confident: Array.isArray(args.confident) ? args.confident : p.skills.confident,
          avoid: Array.isArray(args.avoid) ? args.avoid : p.skills.avoid,
          willing: Array.isArray(args.willing) ? args.willing : p.skills.willing,
        };
      } else if (a === "set_diet") {
        p.longTerm.diet = { ...p.longTerm.diet, ...(args.diet ?? {}) };
      } else if (a === "set_kitchen") {
        p.kitchen = { ...(p.kitchen ?? {}), ...(args.kitchen ?? {}) };
      } else if (a === "set_equipment") {
        p.equipment = Array.isArray(args.equipment) ? args.equipment : p.equipment;
      } else if (a === "add_period") {
        const preset = String(args.preset ?? "");
        if (!c.getPresets()[preset]) return `preset 必须是：${Object.keys(c.getPresets()).join("、")}`;
        const end = args.end ?? (args.days ? new Date(Date.now() + Number(args.days) * 86400000).toISOString().slice(0, 10) : null);
        p.periods = [...(p.periods ?? []).filter((x) => x.label !== (args.label ?? c.getPresets()[preset].label)), {
          id: `${preset}-${today}`,
          label: args.label ?? c.getPresets()[preset].label,
          preset,
          start: args.start ?? today,
          end,
          goals: args.goals ?? {},
          avoidCanon: [],
          avoidMethods: [],
        }];
      } else if (a === "end_period") {
        const key = String(args.target ?? args.label ?? "");
        const before = (p.periods ?? []).length;
        p.periods = (p.periods ?? []).filter((x) => x.label !== key && x.preset !== key);
        if (p.periods.length === before) return `没有找到叫「${key}」的周期设置。用 profile_show 看看现有哪些。`;
      } else {
        return `不认识的 action：${a}`;
      }

      c.save(p);
      return `已更新。\n\n${profileSummary(c.getProfile(), c.getPresets(), c.getState())}`;
    },
    output: output(stringSchema, renderString),
  };

  const cookLog = {
    name: "cook_log",
    description: [
      "记一顿真的做过饭：做了什么、好不好吃、剩下什么。",
      "记过之后我会记得——说好吃的高频出现，说不再做的不再推，最近做过的两周内少推；剩下的料会从下次采购里扣掉。",
      "只是记录，不做评价、不打分、不算连续天数。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "菜谱 id（可选，和 title 二选一）。" },
        title: { type: "string", description: "菜名（可模糊匹配；也可以是自己做的、书里没有的菜）。" },
        verdict: { type: "string", enum: ["loved", "ok", "never"], description: "loved 好吃 / ok 还行 / never 以后别做了。" },
        note: { type: "string", description: "一句备注，比如「盐放多了」「孩子没吃」。" },
        date: { type: "string", description: "日期 YYYY-MM-DD，默认今天。" },
        people: { type: "integer", description: "这顿几个人吃。" },
        leftovers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "剩下的东西，如 五花肉。" },
              grams: { type: "number", description: "大约多少克。" },
              days: { type: "integer", description: "还能放几天，默认叶菜 2 天、其他 4 天。" },
            },
            required: ["name"],
          },
          description: "剩料，会进「冰箱里还有」，下次采购自动扣。",
        },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const state = structuredClone(c.getState());
      const book = c.getBook();
      const r = args.id ? book.get(String(args.id)) : args.title ? book.findTitle(String(args.title)) : null;
      const title = r?.title ?? String(args.title ?? "").trim();
      if (!title) return "至少给我一个菜名或 id。";

      const leftovers = (Array.isArray(args.leftovers) ? args.leftovers : []).map((l) => {
        const e = lookup(String(l.name ?? ""));
        return {
          canon: e?.id ?? String(l.name ?? ""),
          name: String(l.name ?? ""),
          cat: e?.cat ?? "其他",
          grams: Number(l.grams) || null,
          days: l.days ?? undefined,
          addedAt: args.date ?? new Date().toISOString().slice(0, 10),
        };
      }).filter((l) => l.canon && l.grams);

      state.cookLog = [...(state.cookLog ?? []), {
        date: args.date ?? new Date().toISOString().slice(0, 10),
        id: r?.id ?? null,
        title,
        verdict: args.verdict ?? "ok",
        note: args.note ?? "",
        people: args.people ?? c.getProfile().household?.size ?? null,
        leftovers,
      }];
      c.saveState(state);

      const lines = [`记下了：${title}（${args.verdict === "loved" ? "好吃" : args.verdict === "never" ? "以后不做了" : "还行"}）`];
      if (args.verdict === "never") lines.push("以后不会再推这道。");
      if (args.verdict === "loved") lines.push("以后会多排几次。");
      if (leftovers.length) lines.push(`剩下的 ${leftovers.map((l) => `${l.name} ${Math.round(l.grams)}g`).join("、")} 记进冰箱了，下次采购会扣掉。`);
      if (r && (r.servingsBase ?? 2) >= 4) lines.push("这道份量够两顿，明天可以带饭。");
      return lines.join("\n");
    },
    output: output(stringSchema, renderString),
  };

  const plan = {
    name: "plan_week",
    description: [
      "排 1–7 天的菜单并给采购清单。会自动遵守画像（过敏/忌口/技能/阶段目标），",
      "把叶菜安排在前两天、耐放蔬菜排到后面，肉和水分一次买够。",
      "每天末尾给出当日合计（蛋白/热量对着天级目标），早餐用固定模板另配（语料不含早餐，不硬造）。",
      "用户问「这周吃什么」「帮我规划采购」时用它；只问「今晚吃什么」用 menu_shuffle。",
      "intent=fast 用于饿的晚上（≤35 分钟家常菜）；intent=learn 用于学菜的晚上（放开 learn/hard 档）。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        days: { type: "integer", description: "天数 1–7，默认 3。" },
        people: { type: "integer", description: "人数，默认取画像里的家庭人数。" },
        meals: { type: "integer", description: "每天几顿正餐 1–2，默认 2。" },
        energy: { type: "string", enum: ["tired", "normal", "good"], description: "今天的精力：tired 只排 35 分钟内、好上手的；good 才放开学着做的。优先级：maxMinutes > energy > intent。" },
        maxMinutes: { type: "integer", description: "单道菜时间上限（分钟），不填按精力档位。优先级高于 energy/intent。" },
        combo: { type: "string", description: "只在 days=1 时生效：1菜1肉 / 2菜1肉 / 2菜2肉 / 1菜1肉1汤 / 3菜1肉。" },
        seed: { type: "integer", description: "想复现同一张菜单时传上次的 seed。" },
        withShopping: { type: "boolean", description: "是否附采购清单，默认 true。" },
        intent: { type: "string", enum: ["fast", "learn"], description: "fast=饿的晚上，快、家常、35 分钟内；learn=学菜的晚上，可以挑战硬菜/考据。" },
        occasion: { type: "string", enum: ["daily", "banquet"], description: "日常默认（人少时候选偏向主辅料种类少的菜，一顿能用完）；宴请放开种类预算、分量不设限。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const planner = c.getPlanner();
      const result = planner.plan({
        days: Number(args.days ?? 3),
        people: Number(args.people ?? planner.people),
        meals: Number(args.meals ?? 2),
        energy: args.energy,
        maxMinutes: args.maxMinutes,
        combo: args.combo,
        seed: args.seed,
        intent: args.intent,
        occasion: args.occasion,
      });
      c.savePlan(result);
      return result;
    },
    output: output(
      objectSchema,
      (args, result) => [{
        type: "text",
        text: `${formatMenu(result)}${args.withShopping === false ? "" : `\n\n${formatShopping(result.shopping)}`}`,
      }],
      (_a, result) => cardPlan(result),
    ),
  };

  const shuffle = {
    name: "menu_shuffle",
    description: [
      "随机挑战：先按画像筛出范围，再按「几菜几肉」摇一桌。用户说「随便」「不想想」时用它。",
      "一局只有两次机会（R11/R12）：初摇 + 一次再摇（excludeIds 原样传回来）。",
      "rerollCount >= 2 时返回 closed=true 且不再给菜——此时要问用户原因（累/没胃口/缺食材/没灵感），",
      "想再摇只能重新开一局（rerollCount 从 0 传起）。别在同一局里摇第三次。",
      "intent=fast=饿的晚上（≤35 分钟）；intent=learn=学菜的晚上。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        people: { type: "integer", description: "人数，默认取画像。" },
        energy: { type: "string", enum: ["tired", "normal", "good"], description: "精力档位，tired 只摇 35 分钟内好上手的。优先级：maxMinutes > energy > intent。" },
        maxMinutes: { type: "integer", description: "单道菜时间上限（分钟）。优先级高于 energy/intent。" },
        combo: { type: "string", enum: ["1菜1肉", "2菜1肉", "2菜2肉", "1菜1肉1汤", "3菜1肉"], description: "组合，默认按人数推。" },
        excludeIds: { type: "array", items: { type: "string" }, description: "上一次返回的 excludeIds，原样传回来避免重复。" },
        rerollCount: { type: "integer", description: "已经摇过几次，默认 0。>=2 会直接 closed。" },
        seed: { type: "integer", description: "可选，指定后结果可复现。" },
        intent: { type: "string", enum: ["fast", "learn"], description: "fast=饿的晚上，快、家常、35 分钟内；learn=学菜的晚上，可以挑战硬菜/考据。" },
        occasion: { type: "string", enum: ["daily", "banquet"], description: "日常默认（人少时偏主辅料种类少的菜）；宴请放开种类预算。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const planner = c.getPlanner();
      return planner.shuffle({
        people: Number(args.people ?? planner.people),
        combo: args.combo,
        energy: args.energy,
        maxMinutes: args.maxMinutes,
        excludeIds: Array.isArray(args.excludeIds) ? args.excludeIds : [],
        rerollCount: Number(args.rerollCount ?? 0),
        seed: args.seed,
        intent: args.intent,
        occasion: args.occasion,
      });
    },
    output: output(
      objectSchema,
      (_a, r) => [{ type: "text", text: formatShuffle(r) }],
      // closed（这局摇完）没有菜可展示：不发空卡，让 UI 回退文本卡（与搜索的 no_hit 同口径）。
      (_a, r) => (r.closed ? null : cardShuffle(r)),
    ),
  };

  const recommend = {
    name: "recommend",
    description: [
      "推荐是一等工具：给固定 3 个候选让用户挑，每道带一句「为什么推它」、时间、主辅料种类数、蛋白/人、主料。",
      "候选之间有差异（主技法或蛋白来源不同）；排序依次遵守画像硬约束 → 场景/精力 → 种类预算（人少偏种类少的菜）→ 长期喜好。",
      "它不消耗随机挑战的两次机会——menu_shuffle 是「不想想」的随机收敛，这个是「给你选」。",
      "同一请求结果稳定（不掺随机）；用户都不满意时把 excludeIds 原样传回来换一批，不重复。",
      "scene: hungry=饿的晚上（快、35 分钟内）/ daily=日常晚饭 / learn=学菜的晚上（放开要练的）。",
      "用户选定后直接 recipe_get 出做法，配齐一桌用 show_card。用户说「推荐几个」「今晚吃什么给我挑」时用它；说「随便/不想想」才用 menu_shuffle。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        scene: { type: "string", enum: ["hungry", "daily", "learn"], description: " hungry=饿的晚上 / daily=日常晚饭（默认）/ learn=学菜的晚上。" },
        people: { type: "integer", description: "几个人吃，默认取画像。人数少时候选偏向主辅料种类少的菜（一顿能用完）。" },
        energy: { type: "string", enum: ["tired", "normal", "good"], description: "精力档位：tired 只给 35 分钟内好上手的。优先级：maxMinutes > energy > scene。" },
        maxMinutes: { type: "integer", description: "单道菜时间上限（分钟）。优先级高于 energy/scene。" },
        occasion: { type: "string", enum: ["daily", "banquet"], description: "日常默认；宴请放开种类预算、分量不设限。" },
        excludeIds: { type: "array", items: { type: "string" }, description: "上一轮返回的 excludeIds 原样传回来，换一批不重复。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const planner = c.getPlanner();
      return planner.recommend({
        scene: args.scene,
        people: Number(args.people ?? planner.people),
        energy: args.energy,
        maxMinutes: args.maxMinutes,
        occasion: args.occasion,
        excludeIds: Array.isArray(args.excludeIds) ? args.excludeIds : [],
      });
    },
    output: output(
      recommendSchema,
      (_a, v) => formatRecommend(v),
      // empty 分支没有候选可展示：不发空卡，让 UI 回退文本（与搜索 no_hit 同口径）
      (_a, v) => (v.candidates.length ? cardRecommend(v) : null),
    ),
  };

  const rescue = {
    name: "cook_rescue",
    description: [
      "用户说太累、太晚、不想动、随便吃点时的退路：给三道半小时内能做、有蛋白、不用预制料的，外加「不做也行」。",
      "不要用正餐菜单回应疲惫——这个工具存在的意义就是允许他不做。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: { people: { type: "integer", description: "几个人吃，默认取画像。" } },
      additionalProperties: false,
    },
    async execute() {
      const planner = c.getPlanner();
      const people = planner.people;
      const r = easyWayOut(planner.scored, people, 3);
      const left = leftoversLine(c.getState());
      return { dishes: r.dishes, fallback: r.fallback, leftovers: left || null };
    },
    output: output(
      objectSchema,
      (_a, v) => [{ type: "text", text: formatRescue(v) }],
      (_a, v) => cardRescue(v.dishes, v.fallback),
    ),
  };

  const showCard = {
    name: "show_card",
    description: [
      "把已经定好的一桌打包成一张卡片：菜 + 采购清单 + 一两句提醒。",
      "卡片在对话里显示成一张卡，用户能点「钉到侧栏」，把它钉在右侧栏当做饭时的菜谱/采购清单。",
      "用户说「就这桌了」「帮我把它做成卡」「钉到侧栏」时用它；只想看某道菜的做法用 recipe_get。",
      "dishes 传菜谱 id（先 recipe_search/recipe_get 拿 id）；shopping 按 group 分组传要买的东西；notes 放提醒。",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "卡片标题，默认「这桌」。" },
        dishes: { type: "array", items: { type: "string" }, description: "菜谱 id 列表，最多 6 道。" },
        shopping: {
          type: "array",
          items: {
            type: "object",
            properties: {
              group: { type: "string", description: "分组名，如「一次买」「家里翻一下」。" },
              name: { type: "string", description: "买什么。" },
              qty: { type: "string", description: "买多少，如「100g」「1 个」。" },
              note: { type: "string", description: "备注，如「买现成的」。" },
            },
            required: ["name"],
            additionalProperties: false,
          },
          description: "采购清单，按 group 分块。",
        },
        notes: { type: "array", items: { type: "string" }, description: "一两句提醒，如「4 个蛋黄别扔」。" },
      },
      additionalProperties: false,
    },
    async execute(args = {}) {
      const book = c.getBook();
      const cons = resolveConstraints(c.getProfile(), c.getPresets());
      const ids = (Array.isArray(args.dishes) ? args.dishes : []).map((x) => String(x)).slice(0, 6);
      const dishes = [];
      const missing = [];
      for (const id of ids) {
        const r = book.get(id);
        if (r) dishes.push(recipeValue(r, cons));
        else missing.push(id);
      }
      const shopping = (Array.isArray(args.shopping) ? args.shopping : [])
        .slice(0, 40)
        .map((x) => ({
          group: x?.group != null ? String(x.group) : null,
          name: String(x?.name ?? "").trim(),
          qty: x?.qty != null ? String(x.qty) : null,
          note: x?.note != null ? String(x.note) : null,
        }))
        .filter((x) => x.name);
      const notes = (Array.isArray(args.notes) ? args.notes : []).slice(0, 6).map((n) => String(n));
      const title = String(args.title ?? "").trim() || "这桌";
      if (!dishes.length) {
        return {
          found: false,
          title,
          dishes,
          shopping,
          notes,
          missing,
          hint: { code: "no_dishes", text: missing.length ? `没找到这些菜谱 id：${missing.join("、")}。` : "dishes 是空的。" },
        };
      }
      return { found: true, title, dishes, shopping, notes, missing, hint: null };
    },
    output: output(
      showCardSchema,
      (_a, v) => [{ type: "text", text: renderBoard(v) }],
      (_a, v) => (v.found ? cardBoard(v) : null),
    ),
  };

  return [ctx.tools.register(search), ctx.tools.register(get), ctx.tools.register(show), ctx.tools.register(update), ctx.tools.register(cookLog), ctx.tools.register(plan), ctx.tools.register(shuffle), ctx.tools.register(recommend), ctx.tools.register(rescue), ctx.tools.register(showCard)];
}

export function apply(ctx, config = {}) {
  ctx.effect(() => registerTools(ctx, config), "recipe-homie.tools()");
}
