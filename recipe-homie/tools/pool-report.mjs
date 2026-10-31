/**
 * 素菜池诊断（ITERATION-0.4 §3.1.5 / §4-5）：真实 profile + 默认约束，打印 poolReport()。
 *
 * 用法：
 *   node tools/pool-report.mjs           人话输出 + A1 门禁判定（veg>=100 / nonFungi>=60 / leafy>=25）
 *   node tools/pool-report.mjs --json    原样 JSON
 *   node tools/pool-report.mjs --easy    只看 easy 档（plan 默认口径）
 *
 * A1 阈值 0.5 重定（merge-agent 2026-10-29，大众菜谱 456 道并入后）：
 *   旧值 35/15/14 是 2875 库的口径（当时 veg 54 / nonFungi 21 / leafy 14）；
 *   新库实测 veg 145（easy 口径 124）/ nonFungi 98（84）/ leafy 42（36）。
 *   取新值约 70%/60%/60%：veg>=100、nonFungi>=60、leafy>=25 ——
 *   既显著高于老库峰值（54/21/14，语料回退或池子回归立刻 FAIL），
 *   又给新库留出正常波动余量（--easy 口径 124/84/36 也全部在线上）。
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RecipeBook } from "../src/query.mjs";
import { Planner } from "../src/planner.mjs";
import { loadProfile } from "../src/profile.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(readFileSync(`${ROOT}/data/presets.json`, "utf8")).presets;
const profileFile = process.env.FOODBOT_PROFILE ?? `${ROOT}/profile.json`;
const profile = loadProfile(profileFile);

const planner = new Planner(new RecipeBook(`${ROOT}/data`), profile, presets);
planner.refresh();
const rep = planner.poolReport(process.argv.includes("--easy") ? { tiers: ["easy"] } : {});

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rep, null, 2));
} else {
  const c = planner.c;
  console.log(`画像：${profileFile}（周期：${c.activePeriods.join("、") || "无"}；难度档 ${[...c.allowTiers].join("/")}）`);
  console.log(`分池：主菜 ${rep.counts.protein}｜素菜 ${rep.counts.veg}｜汤 ${rep.counts.soup}｜配菜 ${rep.counts.side}`);
  console.log(`素菜分型：绿叶 ${rep.vegKinds.leafy}｜根茎瓜果 ${rep.vegKinds.sturdy}｜菌菇笋 ${rep.vegKinds.fungi}｜仿真荤 ${rep.vegKinds.mockmeat}｜蛋豆制品 ${rep.vegKinds.eggtofu}｜其他 ${rep.vegKinds.other}`);
  console.log(`非笋菇素菜：${rep.nonFungiVeg} 道（A1 要求 ≥60，0.5 重定）`);
  console.log(`其中甜菜类 ${rep.vegSweetChapter} 道只计供给不进菜单（甜菜守卫）；菜单可排：素菜 ${rep.menuVeg} 道、非笋菇 ${rep.menuNonFungiVeg} 道`);
  console.log(`素菜池里含蛋/豆制品的：${rep.eggTofuDishes} 道（A2 要求 ≥5，修复前 0）`);
  console.log(`素菜主料 Top20：${rep.vegCanonTop.map((x) => `${x.canon}(${x.n})`).join("、")}`);
  for (const [kind, list] of Object.entries(rep.samples)) {
    if (list.length) console.log(`${kind} 样例：${list.join("、")}`);
  }
  const a1 = rep.counts.veg >= 100 && rep.nonFungiVeg >= 60 && rep.vegKinds.leafy >= 25;
  console.log(`A1 门禁：veg>=100 ${rep.counts.veg >= 100 ? "✓" : "✗"}(${rep.counts.veg})｜nonFungi>=60 ${rep.nonFungiVeg >= 60 ? "✓" : "✗"}(${rep.nonFungiVeg})｜leafy>=25 ${rep.vegKinds.leafy >= 25 ? "✓" : "✗"}(${rep.vegKinds.leafy}) → ${a1 ? "PASS" : "FAIL"}`);
  process.exitCode = a1 ? 0 : 1;
}
