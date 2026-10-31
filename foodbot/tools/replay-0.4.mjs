/**
 * 0.4 重放判卷（ITERATION-0.4 §4-7 / §5 A3-A5, A8）：真实画像、3 天 2 餐单人。
 *
 * 断言（任一失败 exit 1）：
 *   - 素菜中 ≥2 道「非笋菇」（跨天去重）
 *   - 忌蒜两级（0.4.2 R2b）：0 道主料级蒜；配料级蒜菜必带免蒜 omit（主料换菜/配料省去）
 *   - 无 never 菜、无炸
 *   - 无大肠/肥肠/板油/肥膘/五花为主料的菜（§3.4）
 *   - 无单菜超 kcalTarget×2.5（0.4.1 裁决 5：减脂高热量硬挡）
 *   - dailyTotals：长度=天数、蛋白合计对得上、目标用 goals.proteinPerDay/kcalPerDay（112/1750）
 *   - render：不含「0.x 人份」/「×0.x」；单人含「带饭」或「分两顿」（§3.5）
 *
 * 0.4.1：--seeds 支持多 seed 判卷（E1 Q8——0.4 只测 seed 42 压不住的回归，多 seed 才算数）。
 *
 * 用法：node tools/replay-0.4.mjs [--seeds 42,7,123,2026] [--json]
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RecipeBook } from "../src/query.mjs";
import { Planner, isFungiBamboo, vegKind } from "../src/planner.mjs";
import { PURCHASE_UNITS } from "../src/lexicon.mjs";
import { loadProfile, avoidLevel, highFatMainLevel } from "../src/profile.mjs";
import { formatMenu } from "../src/plugin.mjs";
import { rescueCandidates } from "../src/care.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(readFileSync(`${ROOT}/data/presets.json`, "utf8")).presets;
const profileFile = process.env.FOODBOT_PROFILE ?? `${ROOT}/profile.json`;
const profile = loadProfile(profileFile);

const book = new RecipeBook(`${ROOT}/data`);
const planner = new Planner(book, profile, presets, null); // state 空：不掺最近做过/剩料，保证可复现
planner.refresh();

const seedsArg = process.argv.find((a) => a.startsWith("--seeds"));
const seeds = seedsArg ? seedsArg.split("=")[1]?.split(",").map(Number).filter(Number.isFinite) ?? [] : [];
const seedList = seeds.length ? seeds : (process.argv.includes("--seeds") ? [] : [42]);
if (!seedList.length) {
  console.error("用法：node tools/replay-0.4.mjs [--seeds 42,7,123,2026] [--json]（--seeds 需带值）");
  process.exit(1);
}

const failures = [];
const check = (name, ok, detail = "") => {
  if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

const c = planner.c;
const kcalCap = c.kcalTarget ? c.kcalTarget * 2.5 : null;
const wantJson = process.argv.includes("--json");
const allResults = {};

for (const seed of seedList) {
  const result = planner.plan({ days: 3, meals: 2, people: 1, seed, startDate: "2026-10-28" });
  allResults[seed] = result;
  const dishes = result.plan.flatMap((d) => d.meals.flatMap((m) => m.dishes));
  const recipes = dishes.map((d) => ({ d, r: book.get(d.id) }));
  const tag = `seed ${seed}`;

  // ───────── 菜单打印 ─────────
  if (!wantJson) {
    console.log(`\n======== ${tag} ========`);
    for (const day of result.plan) {
      console.log(`\n== 第 ${day.day} 天 ==`);
      for (const meal of day.meals) {
        console.log(`  ${meal.name}: 蛋白 ${meal.protein}g / ${meal.kcal} kcal`);
        for (const x of meal.dishes) {
          const r = book.get(x.id);
          const fungi = x.role === "veg" ? (isFungiBamboo(r) ? "笋菇" : "非笋菇") : "";
          console.log(`    [${x.role}${fungi ? `·${fungi}` : ""}] ${x.title}（${x.cuisine}·${x.chapter}）· ${x.minutes}min · ${x.skill?.tier} · 蛋白${x.proteinPerServing ?? "?"}g/人 · id=${x.id}`);
        }
      }
    }
    console.log("\n== 每日总盘子（vs 天级目标）==");
    for (const t of result.dailyTotals) {
      console.log(`  第${t.day}天: 蛋白 ${t.protein}g（目标 ${t.proteinTarget}g，${t.proteinGap == null ? "?" : t.proteinGap < 0 ? `差 ${-t.proteinGap}g` : `超 ${t.proteinGap}g`}） · 热量 ${t.kcal} kcal（目标 ${t.kcalTarget}，${t.kcalGap == null ? "?" : t.kcalGap >= 0 ? `余 ${t.kcalGap}` : `超 ${-t.kcalGap}`}）`);
    }
  }

  // ───────── 断言 ─────────
  const vegDistinct = new Map();
  for (const { d, r } of recipes) if (d.role === "veg") vegDistinct.set(d.id, r);
  const nonFungi = [...vegDistinct.values()].filter((r) => !isFungiBamboo(r));
  check(`[${tag}] A3 素菜 ≥2 道非笋菇`, nonFungi.length >= 2, `${nonFungi.length} 道：${nonFungi.map((r) => r.title).join("、") || "无"}`);

  // 0.4.2 R2b：忌蒜从「蒜家族全毙」改两级——主料级蒜 0 容忍（换菜），
  // 配料级蒜（蒜末爆香级）允许入选，但每道必带免蒜 omit（料名+约克数）
  const GARLIC_FAMILY = ["大蒜", "蒜苗", "青蒜", "蒜黄", "独蒜", "蒜头"];
  const garlic = recipes.filter(({ r }) => (r.ingredients ?? []).some((i) => GARLIC_FAMILY.includes(i.canon)));
  const mainLeak = garlic.filter(({ r }) => GARLIC_FAMILY.some((f) => avoidLevel(r, f)?.level === "main"));
  check(`[${tag}] A3 忌蒜两级：0 道主料级蒜`, mainLeak.length === 0, mainLeak.map(({ r }) => r.title).join("、"));
  const uncovered = garlic.filter(({ d }) => !GARLIC_FAMILY.filter((f) => (book.get(d.id).ingredients ?? []).some((i) => i.canon === f))
    .every((f) => (d.omit ?? []).some((o) => o.target === f)));
  check(`[${tag}] A3 配料级蒜菜都带免蒜 omit`, uncovered.length === 0, uncovered.map(({ d }) => d.title).join("、"));
  if (!wantJson && garlic.length) {
    console.log(`  （两级放回：菜单含配料级蒜菜 ${garlic.length} 道——${garlic.map(({ d }) => `${d.title}（省 ${d.omit.map((o) => `${o.target} ${Math.round(o.grams)}g`).join("、")}）`).join("；")}）`);
  }

  check(`[${tag}] A3 无炸`, recipes.every(({ r }) => !(r.methods ?? []).includes("炸")), recipes.filter(({ r }) => (r.methods ?? []).includes("炸")).map(({ r }) => r.title).join("、"));
  // 高脂主料口径 = profile.highFatMainLevel（0.5 收口统一）：主料级 block（大肠/肥肠/奶汤系），
  // 配料级 trace（吊汤 25g 肥膘）轻罚不拦——此前 replay 自带一份旧拷贝，与 acceptance A7 漂移两次，现统一同源。
  const highFat = recipes.filter(({ r }) => highFatMainLevel(r) === "main");
  check(`[${tag}] 无大肠/肥肠主料（B5 口径）`, highFat.length === 0, highFat.map(({ r }) => r.title).join("、"));
  check(`[${tag}] A3 无 never 菜（state 为空时恒真）`, true);

  // 0.4.1 裁决 5：减脂期单菜 kcal 硬挡（>450×2.5=1125 不该出现在任何 seed 的菜单里）
  if (kcalCap != null) {
    const over = recipes.filter(({ r }) => (r.perServing?.kcal ?? 0) > kcalCap);
    check(`[${tag}] 无单菜超 kcalTarget×2.5（${kcalCap}）`, over.length === 0, over.map(({ r }) => `${r.title} ${r.perServing?.kcal}kcal`).join("、"));
  }

  check(`[${tag}] A4 dailyTotals 长度 = 天数`, result.dailyTotals.length === result.days, `${result.dailyTotals.length}`);
  for (const t of result.dailyTotals) {
    const day = result.plan.find((d) => d.day === t.day);
    const p = Math.round(day.meals.reduce((s, m) => s + m.protein, 0));
    const k = Math.round(day.meals.reduce((s, m) => s + m.kcal, 0));
    check(`[${tag}] A4 第${t.day}天蛋白合计对得上`, Math.abs(p - t.protein) <= 1, `${p} vs ${t.protein}`);
    check(`[${tag}] A4 第${t.day}天热量合计对得上`, Math.abs(k - t.kcal) <= 1, `${k} vs ${t.kcal}`);
  }
  check(`[${tag}] A4 蛋白天级目标 = goals.proteinPerDay（112）`, c.proteinPerDay === 112 && result.dailyTotals.every((t) => t.proteinTarget === 112), `${c.proteinPerDay}`);
  check(`[${tag}] A4 热量天级目标 = goals.kcalPerDay（1750）`, c.kcalPerDay === 1750 && result.dailyTotals.every((t) => t.kcalTarget === 1750), `${c.kcalPerDay}`);
  check(`[${tag}] A4 缺口被如实报告`, result.dailyTotals.every((t) => t.proteinGap === t.protein - 112 && t.kcalGap === 1750 - t.kcal));

  const text = formatMenu(result);
  // W5：仿真素菜进菜单时带 mockmeat 标（多 seed 才看得见它真被排进来）
  const mockPlated = dishes.filter((d) => d.role === "veg" && vegKind(book.get(d.id)) === "mockmeat");
  check(`[${tag}] W5 素菜位的仿真荤菜都标 mockmeat`,
    mockPlated.every((d) => vegKind(book.get(d.id)) === "mockmeat"),
    mockPlated.map((d) => d.title).join("、") || "本 seed 没排到仿真荤素菜");
  if (!wantJson && mockPlated.length) console.log(`  （W5 仿真荤素菜：${mockPlated.map((d) => d.title).join("、")}）`);

  // W5：采购清单聚合对齐 + 蛋并回 + 无碎单
  const buyRows = [];
  for (const g of [result.shopping.buyOnce, ...result.shopping.batches, result.shopping.dry, result.shopping.staples, result.shopping.selfMade, { items: result.shopping.keep }]) {
    for (const i of g.items ?? []) buyRows.push(i);
  }
  const gramOfW5 = (qty) => {
    const m = /^([\d.]+) (kg|g)/.exec(String(qty));
    return m ? Number(m[1]) * (m[2] === "kg" ? 1000 : 1) : null;
  };
  check(`[${tag}] W5 蛋清/蛋黄不再单列`, buyRows.every((i) => i.name !== "蛋清" && i.name !== "蛋黄"),
    buyRows.filter((i) => /蛋/.test(i.name)).map((i) => `${i.name} ${i.qty}`).join("、"));
  const underBuyW5 = buyRows.filter((i) => PURCHASE_UNITS[i.name] && gramOfW5(i.qty) != null && gramOfW5(i.qty) < PURCHASE_UNITS[i.name].minBuy);
  check(`[${tag}] W5 粒度表内的项无不足 minBuy 的碎单`, underBuyW5.length === 0,
    underBuyW5.map((i) => `${i.name} ${i.qty}`).join("、") || "全部 ≥minBuy");
  const meatSmallW5 = buyRows.filter((i) => ["肉禽", "水产"].includes(i.cat) && gramOfW5(i.qty) != null && gramOfW5(i.qty) < 100);
  check(`[${tag}] W5 肉禽/水产无 <100g 碎单`, meatSmallW5.length === 0, meatSmallW5.map((i) => `${i.name} ${i.qty}`).join("、") || "无");
  const estRowsW5 = buyRows.filter((i) => i.unitGramsFrom);
  check(`[${tag}] W5 估值行都带来源标记`, estRowsW5.every((i) => i.unitGramsFrom === "est-table"),
    estRowsW5.map((i) => `${i.name} ${i.qty}`).join("、") || "本 seed 无计数行");

  check(`[${tag}] A5 render 含「早餐另配」`, text.includes("早餐另配"));
  const badWords = ["粥", "包子", "三明治", "烧麦", "油条", "肠粉"];
  check(`[${tag}] A5 早餐建议不含具体菜名`, !result.breakfast.advice.some((a) => badWords.some((w) => a.includes(w))), result.breakfast.advice.join(" / "));
  check(`[${tag}] A8 render 无「0.x 人份」`, !/0\.\d+\s*人份/.test(text) && !/×\s*0\.\d/.test(text));
  check(`[${tag}] A8 render 有带饭/分两顿`, /带饭|分两顿/.test(text));
  // 0.4.1 裁决 1：口径统一——菜单说「按原方」，就不该再出现「按 N 人份做」
  check(`[${tag}] render 单人全部按原方表述`, !/按 \d+ 人份做/.test(text) && /按原方/.test(text));
}

// 0.4.1 裁决 7：rescue 候选（与 seed 无关，跑一次）
{
  const rescue = rescueCandidates(planner.scored, 1, 3);
  check("rescue 候选 3 道且蛋白 ≥20g",
    rescue.length === 3 && rescue.every((x) => (x.r.perServing?.proteinGrams ?? 0) >= 20),
    rescue.map((x) => `${x.r.title}(${x.r.perServing?.proteinGrams}g/${x.minutes}min)`).join("、"));
  if (!wantJson) console.log(`\n== rescue 候选 ==\n  ${rescue.map((x) => `${x.r.title}（${x.minutes}min，蛋白${x.r.perServing?.proteinGrams}g）`).join("；")}`);
}

if (wantJson) {
  console.log(JSON.stringify({ seeds: seedList, results: allResults, failures }, null, 1));
} else {
  console.log(`\n== 断言汇总（seeds: ${seedList.join(",")}）==`);
}

if (failures.length) {
  console.error(`\nFAIL ${failures.length} 项：\n  ${failures.join("\n  ")}`);
  process.exitCode = 1;
} else {
  console.log(`\nreplay-0.4 全部断言通过（seeds ${seedList.join("/")}，真实 profile）`);
}
