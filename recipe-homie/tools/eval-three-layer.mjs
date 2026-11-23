/**
 * recipe-homie 三层评测（L1 数据体检 / L2 契约+红线 / L3 场景重放）。
 *
 * 来源：2026-11-23 评测报告（Projects/文档/recipe-homie-eval-2026-11-23.md）。
 * 判据全部是确定性断言；画像/状态用临时副本，跑完不碰真实画像。
 * 阈值：L1 全绿、红线探针全过、L2 ≥20/21（任一 fail 或 gap 则退出码 1）。
 *
 * 用法：node tools/eval-three-layer.mjs
 * 数据缺失（没跑过 data:build/data:integrate）时打印跳过并退出 0。
 */
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const PROCESSED = join(DATA, "recipes.processed.jsonl");
const LIB = join(ROOT, "lib", "index.js");

function join(...p) { return path.join(...p); }
function skip(msg) { console.log(`SKIP 三层评测：${msg}`); process.exit(0); }
if (!fs.existsSync(LIB)) skip("lib/index.js 不存在（先 pnpm build）");
if (!fs.existsSync(PROCESSED)) skip("data/recipes.processed.jsonl 不存在（先 pnpm data:build && pnpm data:integrate）");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "recipe-homie-eval-"));
const PROFILE = join(TMP, "profile.json");
const STATE = join(TMP, "user-state.json");
for (const f of ["profile.json", "user-state.json"]) {
  if (fs.existsSync(join(ROOT, f))) fs.copyFileSync(join(ROOT, f), join(TMP, f));
}

const results = [];
const add = (layer, id, req, desc, ok, detail = "", status) => {
  results.push({ layer, id, req, desc, ok: !!ok, detail, status: status || (ok ? "pass" : "fail") });
  const mark = ok ? "✅" : status === "gap" ? "⚠️" : "❌";
  console.log(`${mark} [${layer}] ${id} ${req} ${desc}${detail ? " — " + String(detail).slice(0, 140) : ""}`);
};

// ---------- 加载插件（临时画像/状态） ----------
const mod = await import(pathToFileURL(LIB).href);
const tools = {};
mod.apply({
  effect: (f) => { try { f(); } catch { /* 清理失败不阻塞评测 */ } },
  tools: { register: (t) => { tools[t.name] = t; return () => {}; } },
}, { dataDir: DATA, profileFile: PROFILE, stateFile: STATE });
const call = async (name, args) => {
  const t0 = performance.now();
  try { return { out: await tools[name].execute(args), ms: Math.round(performance.now() - t0) }; }
  catch (e) { return { err: e.message, ms: Math.round(performance.now() - t0) }; }
};

// ---------- L1 数据体检（全量） ----------
let snapshot = [];
try {
  snapshot = fs.readFileSync(PROCESSED, "utf8").split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ids = snapshot.map((r) => r.id);
  add("L1", "D-1", "D1", "全量菜谱无重复 id", new Set(ids).size === ids.length, `records=${ids.length}`);

  let ingTotal = 0, gramsNull = 0, rawCount = 0, blank = 0, marked = 0, unparsed = 0, dzBlank = 0, dzTotal = 0;
  const dirty = [];
  for (const r of snapshot) {
    for (const ing of r.ingredients || []) {
      ingTotal++;
      if (ing.grams == null) gramsNull++;
      if (ing.raw) rawCount++;
      if (!ing.amount) {
        blank++;
        if (ing.amountMissing === "absent" || ing.amountMissing === "unparsed") marked++;
        if (ing.amountMissing === "unparsed") unparsed++;
        if (r.cuisine === "大众") dzBlank++;
      }
      if (r.cuisine === "大众") dzTotal++;
      const name = String(ing.name || "");
      // 「药料（见本书第100页）」这类带页码的交叉引用是合法原料名，只有整行是页码/目录才算污染
      if (/…{2,}/.test(name) || /^\d{1,4}\s*[.、．]/.test(name) || /^第\s*\d+\s*页\s*$/.test(name)) {
        if (dirty.length < 5) dirty.push(`${r.id}:${name.slice(0, 40)}`);
      }
    }
  }
  add("L1", "D-2", "D2", "配料克数覆盖率（缺克数比例 < 15%）", gramsNull / ingTotal < 0.15, `missing ${gramsNull}/${ingTotal} = ${Math.round((gramsNull / ingTotal) * 100)}%`);
  add("L1", "D-3", "D2", "原文表述保留（raw 覆盖率 100%）", rawCount === ingTotal, `raw ${rawCount}/${ingTotal}`);
  // F1：无计量的行必须显式标 absent（原文没写）/ unparsed（版面丢了），不许静默填空
  add("L1", "D-3b", "D4", "无量行都有「原文未写/未识别」标记（无静默填空）", blank === marked, `blank=${blank} marked=${marked}`);
  add("L1", "D-3c", "D2", "未解析量比例 < 2%", unparsed / ingTotal < 0.02, `unparsed ${unparsed}/${ingTotal} = ${(unparsed / ingTotal * 100).toFixed(2)}%`);
  add("L1", "D-3d", "D4", "大众册原文计量全部还原（blank = 0）", dzBlank === 0, `大众配料=${dzTotal} blank=${dzBlank}`);
  add("L1", "D-4", "D1", "配料无目录/编号/省略号污染行", dirty.length === 0, dirty.join(" | ") || "ok");

  const cuisines = [...new Set(snapshot.map((r) => r.cuisine))].sort();
  const searchDesc = String(tools.recipe_search.parameters.properties.cuisine.description ?? "");
  // D-5（v1 grader 反向错误修正）：不是「描述必须含四川」，而是「描述里的分册都必须真实存在，
  // 且不能承诺库里没有的分册」——四川在《中国菜谱》里确实没有这一册。
  const claimed = ["上海", "北京", "江苏", "浙江", "广东", "安徽", "山东", "湖北", "湖南", "陕西", "南北", "大众", "国际"];
  const matchesData = claimed.every((c) => cuisines.includes(c)) && cuisines.every((c) => searchDesc.includes(c));
  // 描述里可以写「没有四川等分册」（对模型是有效提示），但不能把四川当可用分册列出来
  const noPhantom = !/(?<!没有)(?<!暂无)四川/.test(searchDesc);
  add("L1", "D-5", "R5/D2", "工具描述的分册清单与数据一致（无四川这类承诺）", matchesData && noPhantom, `实际分册: ${cuisines.join("/")}`);
} catch (e) {
  add("L1", "D-0", "-", "数据加载", false, e.message);
}

const snapMap = new Map(snapshot.map((r) => [r.id, r]));
const canons = (id) => new Set((snapMap.get(id)?.ingredients || []).map((i) => i.canon || i.name));
const garlicish = (id) => [...canons(id)].some((c) => /蒜/.test(c));
const shellish = (id) => [...canons(id)].some((c) => /虾|蟹/.test(c));
const allIds = (plan) => (plan?.plan || []).flatMap((d) => (d.meals || []).flatMap((m) => (m.dishes || []).map((x) => x.id)));

// ---------- L2 契约层 + 红线 ----------
// 红线 1：记住人（画像分层可写可读）
{
  await call("profile_update", { action: "add_period", preset: "low_salt", days: 30, label: "评测临时" });
  const mid = await call("profile_show", {});
  await call("profile_update", { action: "end_period", target: "评测临时" });
  const after = await call("profile_show", {});
  const has = (o, kw) => String(o.out || "").includes(kw);
  add("L2", "RL-1", "红线1/R1", "周期需求可写入并出现在画像，结束可移除",
    (has(mid, "低盐") || has(mid, "周期")) && !has(after, "评测临时"), `写入后片段: ${String(mid.out || "").slice(0, 80)}`);
}
// 红线 2：混线（饿的晚上 ≤35 分钟）
{
  const hungry = await call("recommend", { scene: "hungry", people: 1 });
  const learn = await call("recommend", { scene: "learn", people: 1 });
  const h = hungry.out?.candidates || [];
  add("L2", "RL-2a", "红线2/R16", "饿的晚上：3 候选且全部 ≤35 分钟", h.length === 3 && h.every((c) => c.minutes <= 35), `minutes=${h.map((c) => c.minutes).join("/")}`);
  add("L2", "RL-2b", "红线2/R16", "学菜晚上：不套用 35 分钟上限", (learn.out?.maxMinutes || 0) > 35 || learn.out?.intent === "learn", `maxMinutes=${learn.out?.maxMinutes} intent=${learn.out?.intent}`);
}
// 红线 3：话术不审判 + 永远留退路
{
  const rescue = await call("cook_rescue", { people: 1 });
  const card = await call("show_card", { dishes: ["安徽-001"] });
  const text = JSON.stringify([rescue.out, card.out]);
  const judgeWords = ["超标", "你已超过", "卡路里超标", "热量超标"];
  const bad = judgeWords.filter((w) => text.includes(w));
  const bareFail = /(?<!不是)失败/.test(text);
  add("L2", "RL-3a", "红线3/原则3", "文案不出现指标审判词", bad.length === 0 && !bareFail, `命中: ${[...bad, bareFail ? "失败" : ""].filter(Boolean).join(",") || "无"}`);
  add("L2", "RL-3b", "原则5", "退路存在（不做也行）", !!(rescue.out?.fallback && /不做|面|也行/.test(rescue.out.fallback)), rescue.out?.fallback?.slice(0, 40));
}
// 红线 4：随机收敛 + 过敏硬约束（临时加甲壳类过敏）
{
  await call("profile_update", { action: "allergy", allergen: "甲壳类" });
  const s = await call("menu_shuffle", { combo: "1菜1肉" });
  const r = await call("recommend", { scene: "daily", people: 1 });
  const sIds = (s.out?.dishes || []).map((d) => d.id);
  const rIds = (r.out?.candidates || []).map((d) => d.id);
  const leakS = sIds.filter(shellish), leakR = rIds.filter(shellish);
  add("L2", "RL-4a", "红线4/R10", "摇桌不夹带过敏原（虾/蟹）", leakS.length === 0 && leakR.length === 0, `shuffle=${leakS.join(",") || "ok"} recommend=${leakR.join(",") || "ok"}`);
  // 四层语义：蒜占全菜克数 ≥15%（或主料前二）算主料级，必须换菜；否则应给 omit
  const share = (id) => {
    const ings = snapMap.get(id)?.ingredients || [];
    const total = ings.reduce((x, i) => x + (i.grams || 0), 0) || 1;
    const g = ings.filter((i) => /蒜/.test(i.canon || i.name)).reduce((x, i) => x + (i.grams || 0), 0);
    return g / total;
  };
  const dishes = [...(s.out?.dishes || []), ...(r.out?.candidates || [])];
  const bad = dishes.filter((d) => share(d.id) >= 0.15 || (!((d.omit || []).some((o) => /蒜/.test(o.target))) && [...canons(d.id)].some((c) => /蒜/.test(c))));
  add("L2", "RL-4b", "红线4/R2b", "大蒜按四层处理（主料级换菜 / 配料级 omit）", bad.length === 0, bad.map((d) => `${d.id}: share=${(share(d.id) * 100).toFixed(0)}% omit=${(d.omit || []).map((o) => o.target).join("/")}`).join(" | ") || "ok");
  await call("profile_update", { action: "remove", kind: "allergy", target: "甲壳类" });
}
// 红线 5 / D4：原文保真（原文计量与克数并存；无计量的必须显式标注，不许静默填空）
{
  const ids = ["安徽-001", "上海-001", "大众-138"];
  const checks = [];
  for (const id of ids) {
    const { out } = await call("recipe_get", { id });
    const ings = out?.recipe?.ingredients || [];
    checks.push({
      id,
      amount: ings.filter((i) => i.amount).length,
      blank: ings.filter((i) => !i.amount).length,
      unmarked: ings.filter((i) => !i.amount && !i.amountMissing).length,
      grams: ings.filter((i) => i.grams != null).length,
      total: ings.length,
    });
  }
  const ok = checks.every((c) => c.unmarked === 0 && c.grams / c.total > 0.5)
    && checks.find((c) => c.id === "大众-138").blank === 0; // F1：大众册 raw「名·量」里的量已还原
  add("L2", "RL-5", "红线5/D4", "配料同时保留原文计量与克数（无计量有显式标注）", ok,
    checks.map((c) => `${c.id} amount=${c.amount}/${c.total} blank=${c.blank} unmarked=${c.unmarked} grams=${c.grams}`).join(" | "));
}
// R2b 配料级忌口：菜照常推荐 + omit + 采购剔除（多种子，直到出现配料级命中）
{
  let omitTargets = new Set(), omitted = [], checked = 0, viol = [];
  for (const seed of [1, 2, 3]) {
    const p = await call("plan_week", { days: 2, people: 1, meals: 1, seed });
    const dishes = (p.out?.plan || []).flatMap((d) => (d.meals || []).flatMap((m) => m.dishes || []));
    const om = (p.out?.shopping?.omitted || []).map((x) => x.canon || x.name);
    omitted.push(...om);
    for (const d of dishes) {
      checked++;
      const ings = snapMap.get(d.id)?.ingredients || [];
      const total = ings.reduce((s, i) => s + (i.grams || 0), 0) || 1;
      const g = ings.filter((i) => /蒜|醋/.test(i.canon || i.name)).reduce((s, i) => s + (i.grams || 0), 0);
      if (g / total < 0.15 && g > 0) {
        if (!(d.omit || []).some((o) => /蒜|醋/.test(o.target))) viol.push(d.id);
        (d.omit || []).forEach((o) => omitTargets.add(o.target));
      }
    }
  }
  add("L2", "R2b-1", "R2b", "配料级忌口给出免 X 版（omit 覆盖所有配料级命中）", viol.length === 0 && omitTargets.size > 0, `dishes=${checked} 违规=${viol.join(",") || "无"} targets=${[...omitTargets].slice(0, 6).join("/")}`);
  add("L2", "R2b-2", "R2b", "采购清单剔除被省掉的配料（omitted 带克数）", omitted.length > 0, `omitted=${[...new Set(omitted)].slice(0, 6).join("/")}`);
}
// R8 采购为单位：批次 + 单页结构
{
  const p = await call("plan_week", { days: 3, people: 1, meals: 1 });
  const sh = p.out?.shopping || {};
  const batches = sh.batches || [];
  const okB = batches.length > 0 && batches.every((b) => Array.isArray(b.items) && b.items.length > 0 && b.label);
  add("L2", "R8-1", "R8", "采购清单按批次分组（label + items 非空）", okB, `batches=${batches.length} labels=${batches.map((b) => b.label?.slice(0, 8)).join("/")}`);
  const okS = Array.isArray(sh.buyOnce?.items) && sh.buyOnce.items.length > 0 && Array.isArray(sh.staples?.items ?? sh.staples) && Array.isArray(sh.selfMade?.items ?? sh.selfMade) && Array.isArray(sh.keep?.items ?? sh.keep);
  add("L2", "R8-2", "R8", "清单可一张截图带走（一次买/常备/自制/留存齐全）", okS, `buyOnce=${sh.buyOnce?.items?.length} staples=${sh.staples?.items?.length ?? sh.staples?.length} selfMade=${sh.selfMade?.items?.length ?? sh.selfMade?.length} keep=${sh.keep?.items?.length ?? sh.keep?.length}`);
}
// R9 多样性：同周期不重复
{
  const p = await call("plan_week", { days: 3, people: 1, meals: 1 });
  const ids = allIds(p.out);
  add("L2", "R9-1", "R9", "同一周期内菜品不重复", ids.length === new Set(ids).size, `dishes=${ids.length} unique=${new Set(ids).size}`);
}
// R19 种类预算：人少比人多更克制（多种子取中位）
{
  const avg = (p) => { const ds = (p?.plan || []).flatMap((d) => (d.meals || []).flatMap((m) => m.dishes || [])); return ds.reduce((s, d) => s + (d.variety || 0), 0) / Math.max(1, ds.length); };
  const collect = async (people) => {
    const vals = [];
    for (const seed of [1, 2, 3]) {
      const p = await call("plan_week", { days: 2, people, meals: 1, seed });
      vals.push(avg(p.out));
    }
    return vals.sort((a, b) => a - b)[1];
  };
  const one = await collect(1), four = await collect(4);
  add("L2", "R19-1", "R19", "人少时平均种类数不高于人多时（软约束）", one <= four + 0.5, `中位: 1人=${one.toFixed(1)} 4人=${four.toFixed(1)}`);
}
// R20 推荐：3 候选 + 理由 + 差异
{
  const r = await call("recommend", { scene: "daily", people: 2 });
  const c = r.out?.candidates || [];
  add("L2", "R20-1", "R20", "固定 3 个候选且都带 why", c.length === 3 && c.every((x) => x.why), `n=${c.length}`);
  const chapters = new Set(c.map((x) => x.chapter));
  const proteinSrc = new Set(c.map((x) => (x.mainIngredients || [])[0]));
  add("L2", "R20-2", "R20", "候选之间有差异（蛋白来源或分册不同）", proteinSrc.size > 1 || chapters.size > 1, `蛋白主料=${[...proteinSrc].join("/")} 分册=${[...chapters].join("/")}`);
}
// R11/R12 反疲劳：再摇一次 + 关闭 + 问原因
{
  const s1 = await call("menu_shuffle", { combo: "1菜1肉" });
  const ids1 = (s1.out?.dishes || []).map((d) => d.id);
  const s2 = await call("menu_shuffle", { combo: "1菜1肉", excludeIds: ids1, rerollCount: 1 });
  const ids2 = (s2.out?.dishes || []).map((d) => d.id);
  const s3 = await call("menu_shuffle", { combo: "1菜1肉", rerollCount: 2 });
  add("L2", "R11-1", "R11", "再摇不重复已拒绝的菜", ids2.every((id) => !ids1.includes(id)), `${ids1.join(",")} -> ${ids2.join(",")}`);
  add("L2", "R12-1", "R12", "第三次关闭并问原因", s3.out?.closed === true && s3.out?.askReason === true, `closed=${s3.out?.closed} askReason=${s3.out?.askReason}`);
  add("L2", "R12-2", "R12", "关闭后给「重新开一局」的出路", /重新开一局|重新开始/.test(String(s3.out?.hint || "")), String(s3.out?.hint || "").slice(0, 40));
}
// R17 教学梯度
{
  const g = await call("recipe_get", { id: "安徽-001" });
  const hasVariants = "variants" in (g.out?.recipe || {});
  const hasSkill = !!(g.out?.recipe?.skill);
  add("L2", "R17-1", "R17", "单菜返回变体/技法分级字段", hasVariants && hasSkill, `variants=${hasVariants} skill=${hasSkill}`);
}
// R2c 调料级减量：低盐周期下不拦菜、按实际调料构成给减量建议
{
  await call("profile_update", { action: "add_period", preset: "low_salt", days: 14, label: "评测低盐" });
  const p = await call("plan_week", { days: 2, people: 1, meals: 1, seed: 7 });
  const notes = (p.out?.notes || []).join("\n");
  const hasAdvice = /低盐/.test(notes) && /(减半|减量|低钠)/.test(notes)
    && /(酱油|盐|豆瓣酱|豆酱|腐乳|鱼露|辣酱油|蚝油)\s*\d+\s*g/.test(notes);
  add("L2", "R2c-1", "R2c", "调料级限制给减量建议（含实际调料克数）", hasAdvice, hasAdvice ? "ok" : `notes=${notes.slice(0, 100)}`);
  // 「不拦菜」：低盐预设里的酱类（豆瓣酱等）仍在检索池里——旧行为会整批 blocked
  const s = await call("recipe_search", { ingredients: ["豆瓣酱"], limit: 5 });
  add("L2", "R2c-2", "R2c", "调料级限制不拦菜（豆瓣酱仍可检索到）", (s.out?.hits || []).length > 0, `hits=${(s.out?.hits || []).length} blocked=${s.out?.blocked}`);
  await call("profile_update", { action: "end_period", target: "评测低盐" });
}
// L3 场景重放：疲惫晚上一条链
{
  const rec = await call("recommend", { scene: "hungry", people: 1 });
  const pick = rec.out?.candidates?.[0];
  const get = await call("recipe_get", { id: pick?.id });
  const card = await call("show_card", { dishes: [pick?.id] });
  const text = JSON.stringify(card.out);
  add("L3", "S1", "场景1 疲惫晚上", "推荐→取菜→卡片可渲染（含料/步骤/时间）", !!pick && get.out?.found === true && text.includes("ingredients") && text.includes("steps") && text.includes(String(pick.minutes)), `pick=${pick?.id} ${pick?.title}`);
}
// L3 场景重放：周末采购一条链
{
  const p = await call("plan_week", { days: 3, people: 2, meals: 2 });
  const ids = allIds(p.out);
  const buy = p.out?.shopping?.buyOnce?.items || [];
  add("L3", "S2", "场景2 周末采购", "3 天菜单 + 采购清单同一次返回", ids.length >= 6 && buy.length > 0, `dishes=${ids.length} buyOnce=${buy.length}`);
}
// L3 场景重放：回访（cook_log 后画像里有记录）
{
  await call("cook_log", { title: "安徽-001", verdict: "loved" });
  const s = await call("profile_show", {});
  add("L3", "S3", "场景3 回访基础", "cook_log 写入后画像能看到做饭记录", /做饭记录|最近一次/.test(String(s.out || "")), String(s.out || "").slice(0, 60));
}

// ---------- 汇总 ----------
const byLayer = {};
for (const r of results) {
  const L = (byLayer[r.layer] ||= { pass: 0, fail: 0, gap: 0, total: 0 });
  L.total++;
  if (r.status === "pass") L.pass++;
  else if (r.status === "gap") L.gap++;
  else L.fail++;
}
const total = { pass: 0, fail: 0, gap: 0 };
for (const r of results) { if (r.status === "pass") total.pass++; else if (r.status === "gap") total.gap++; else total.fail++; }
const red = results.filter((r) => r.req.startsWith("红线"));
const redPass = red.filter((r) => r.status === "pass").length;
console.log(`\n== 汇总 ==`);
for (const [k, v] of Object.entries(byLayer)) console.log(`${k}: ${v.pass}/${v.total} pass, ${v.fail} fail, ${v.gap} gap`);
console.log(`TOTAL: ${total.pass}/${results.length} pass, ${total.fail} fail, ${total.gap} gap(未实现)`);
console.log(`红线探针: ${redPass}/${red.length} 通过`);

const l1 = byLayer.L1 ?? { pass: 0, total: 0 };
const l2 = byLayer.L2 ?? { pass: 0, total: 0 };
const pass = total.fail === 0 && total.gap === 0 && l1.pass === l1.total && redPass === red.length && l2.pass >= Math.min(20, l2.total);
console.log(`阈值（L1 全绿 / 红线全过 / L2 ≥20）：${pass ? "通过" : "未通过"}`);

try {
  fs.writeFileSync(join(DATA, "eval-three-layer-report.json"), JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 1), "utf8");
} catch { /* 报告写不下不影响评测结论 */ }
fs.rmSync(TMP, { recursive: true, force: true });
process.exitCode = pass ? 0 : 1;
