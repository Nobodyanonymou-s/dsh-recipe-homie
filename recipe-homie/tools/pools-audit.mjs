// 池子审计：看主菜/素菜池里混进了什么
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RecipeBook } from "../src/query.ts";
import { Planner } from "../src/planner.ts";
import { DEFAULT_PROFILE } from "../src/profile.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const presets = JSON.parse(readFileSync(`${ROOT}/data/presets.json`, "utf8")).presets;
const profile = { ...DEFAULT_PROFILE, household: { size: 4, adults: 2, children: 2 } };
const planner = new Planner(new RecipeBook(`${ROOT}/data`), profile, presets);
planner.refresh();
const p = planner.pools();
console.log(`主菜 ${p.protein.length}｜素菜 ${p.veg.length}｜汤 ${p.soup.length}｜补 ${p.side.length}`);

const meaty = p.veg.filter((x) => (x.r.ingredients ?? []).some((i) => ["猪肉", "牛肉", "羊肉", "禽肉", "水产"].includes(i.parent)));
console.log(`\n素菜池里含肉/鱼水产的：${meaty.length}`);
console.log(meaty.slice(0, 10).map((x) => `${x.r.title}(prot${x.r.proteinFoodGrams}/veg${x.r.vegGrams})`).join("  "));

const vegless = p.protein.filter((x) => (x.r.proteinFoodGrams ?? 0) < 60);
console.log(`\n主菜池里蛋白主料 <60g 的：${vegless.length}`);
console.log(vegless.slice(0, 10).map((x) => `${x.r.title}(${x.r.proteinFoodGrams}g)`).join("  "));

console.log("\n素菜池前 15：");
console.log(p.veg.slice(0, 15).map((x) => `${x.r.title}[${x.r.chapter}]`).join("·"));
