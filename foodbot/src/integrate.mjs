/**
 * 集成层：把各个子任务的产物合回一条可复现的流水线。
 *
 *   data/recipes.jsonl           基础解析结果（不覆盖）
 *   data/work/nanbei.jsonl       新摄入的分册（教材体）
 *   data/work/repairs.json       从原文补回的残缺字段
 *   data/work/lexicon-additions.json  词表尾部补全
 *   data/work/duplicate-groups.json   重名/变体关系
 *        ↓
 *   data/recipes.processed.jsonl 应用层消费的数据
 *   data/processed-report.json   这次合并做了什么、丢了多少
 *
 * 原则：幂等。重复跑不会叠加；任何一条修改都带来源（work 文件名 + evidence）。
 */
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enrichRecipe } from "./enrich.mjs";
import { consumedGramsOf } from "./parse.mjs";
import { lookup, parseAmount } from "./ingredients.mjs";
import { splitIngredient, deriveTags } from "./parse.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 允许用 FOODBOT_DATA_DIR 指向别处，方便用假数据测集成逻辑
const DATA = process.env.FOODBOT_DATA_DIR ? resolve(process.env.FOODBOT_DATA_DIR) : join(ROOT, "data");
const WORK = join(DATA, "work");

// 子任务可能用 PowerShell 写文件，会带 UTF-8 BOM；读之前先剥掉
const stripBom = (s) => s.replace(/^\uFEFF/, "");
const readJson = (p, fallback) => (existsSync(p) ? JSON.parse(stripBom(readFileSync(p, "utf8"))) : fallback);
const readJsonl = (p) => (existsSync(p) ? stripBom(readFileSync(p, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const base = readJsonl(join(DATA, "recipes.jsonl"));
const nanbei = readJsonl(join(WORK, "nanbei.jsonl"));
const dazhong = readJsonl(join(WORK, "dazhong.jsonl"));
const repairs = readJson(join(WORK, "repairs.json"), []);
const additions = readJson(join(WORK, "lexicon-additions.json"), []);
const dupGroups = readJson(join(WORK, "duplicate-groups.json"), []);
// W3 章节统一映射（chapterRaw 保留原书原文；表由 data/work/chapter-surgery.mjs 生成，lead 过目后落盘）
const chapterMap = readJson(join(WORK, "chapter-map.json"), {});

const report = { at: new Date().toISOString(), base: base.length, nanbei: nanbei.length, dazhong: dazhong.length, repairs: repairs.length, additions: additions.length, dupGroups: dupGroups.length, applied: { repairs: 0, repairsSkipped: 0, lexicon: 0, variants: 0, chapter: 0, drops: 0, chapterMapped: 0 }, warnings: [] };

// ---- 1. 词表补全 ----
const addByRaw = new Map();
for (const a of additions) {
  if (!a?.raw || !a?.canon) continue;
  addByRaw.set(a.raw.replace(/\s+/g, ""), a);
}
const canonTarget = (a) => ({ canon: a.canon, parent: a.parent ?? "其他", cat: a.cat ?? "其他", allergen: a.allergen ?? [] });

// ---- 2. 残缺修复 ----
// id 是按册内顺序生成的，解析规则一改就可能错位；所以每条修复都要用 evidence 回查原文，
// 对不上就丢弃，宁可少补一条，也不能把甲菜的做法贴到乙菜上。
const OCR_DIR = resolve(ROOT, "..", "OCR处理菜谱", "vibe_coding", "output");
const pageCache = new Map();
const pageText = (book, page) => {
  const name = String(book ?? "").replace("中国菜谱·", "中国菜谱 ").replace("中国南北名菜谱", "中国南北名菜谱");
  const key = `${name}__${page}`;
  if (!pageCache.has(key)) {
    const p = join(OCR_DIR, `${name}_split`, page);
    pageCache.set(key, existsSync(p) ? readFileSync(p, "utf8") : "");
  }
  return pageCache.get(key);
};
const squash = (s) => String(s ?? "").replace(/\s+/g, "");
const evidenceOk = (rec, repair) => {
  const ev = squash(repair.evidence);
  if (!ev) return false;
  for (const page of rec?.pages ?? []) {
    if (squash(pageText(rec.book, page)).includes(ev)) return true;
  }
  return false;
};

const baseById = new Map(base.map((r) => [r.id, r]));
const nanbeiById = new Map(nanbei.map((r) => [r.id, r]));

// id 是按册内顺序生成的，解析规则一改就可能错位。所以每条修复都先用 evidence 回查原文；
// 对不上原 id 时，再按「同一页 + 原文能对上」找唯一目标记录。找不到就丢弃——
// 宁可少补一条，也不能把甲菜的做法贴到乙菜上。
// W2 P3 起：南北册记录（有 pages[]，可证据回查）也纳入修复目标域。
const resolvedRepairs = [];
for (const r of repairs) {
  if (!r?.id || !r?.field) continue;
  const direct = baseById.get(r.id) ?? nanbeiById.get(r.id);
  if (direct && evidenceOk(direct, r)) {
    resolvedRepairs.push({ ...r, targetId: r.id });
    continue;
  }
  const candidates = [...base, ...nanbei].filter((x) => (x.pages ?? []).includes(r.page) && evidenceOk(x, r));
  if (candidates.length === 1) {
    report.warnings.push(`修复重定位：${r.id} → ${candidates[0].id}（${r.field}）`);
    resolvedRepairs.push({ ...r, targetId: candidates[0].id });
    continue;
  }
  report.warnings.push(`修复丢弃（evidence 对不上任何记录）：${r.id} ${r.field}`);
  report.applied.repairsSkipped++;
}

const repairById = new Map();
for (const r of resolvedRepairs) repairById.set(`${r.targetId}::${r.field}`, r);

// 子任务写的记录可能没走词表（例如 nanbei 的解析器自带一套），在这里统一过一遍归一
function normalizeIngredient(ing) {
  if (ing.canon && ing.guessed === false) return ing;
  const e = lookup(ing.name || ing.raw || "");
  if (!e) return ing;
  const p = ing.grams == null ? parseAmount(ing.amount ?? "", e) : null;
  return {
    ...ing,
    key: e.id,
    canon: e.id,
    parent: e.parent,
    cat: e.cat,
    allergen: e.allergen ?? [],
    guessed: Boolean(e.guessed),
    grams: ing.grams ?? p?.grams ?? null,
    count: ing.count ?? p?.count ?? null,
    qualifier: ing.qualifier ?? p?.qualifier ?? null,
  };
}

// 南北/大众册摄入早于 W6 约耗字段化（省册在 parse 层做），这里补上：油脂行括号里的
// 「约耗X」→ consumedGrams。只动 parent=油脂 且尚无值的行——enrich 的 oilConsumedDeltaOf
// 只对这类行生效；非油料约耗（酱油/面粉等 46 条）仍按 0.5.1 债务推迟。
let oilConsumedPatched = 0;
function patchOilConsumed(ing) {
  if (ing.parent !== "油脂" || ing.consumedGrams != null) return ing;
  const g = consumedGramsOf(ing.raw ?? "");
  if (!g) return ing;
  oilConsumedPatched++;
  return { ...ing, consumedGrams: g };
}

// 南北册摄入时页码没接：pages 是 "29.md" 形态的文件名，page 全空。取首个文件名的数字
// 当起始页（与省册口径一致：page = 起始页）。
function firstPageOf(pages) {
  for (const p of pages ?? []) {
    const n = parseInt(String(p).replace(/\D/g, ""), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

const records = base.map((r) => {
  const out = structuredClone(r);
  out.ingredients = (out.ingredients ?? []).map(normalizeIngredient);

  // 2a. 词表：把 guessed 的原料改成建议的标准名
  out.ingredients = (out.ingredients ?? []).map((ing) => {
    const a = addByRaw.get(String(ing.name ?? "").replace(/\s+/g, ""));
    if (!a) return ing;
    report.applied.lexicon++;
    const t = canonTarget(a);
    return { ...ing, key: t.canon, canon: t.canon, parent: t.parent, cat: t.cat, allergen: t.allergen, guessed: false, canonSource: "work/lexicon-additions.json" };
  });

  // 2b. 修复：ingredients / steps / grams
  const fixIng = repairById.get(`${out.id}::ingredients`);
  const ingEvidence = fixIng ? evidenceOk(baseById.get(out.id), fixIng) : false;
  if (fixIng && !ingEvidence) {
    report.warnings.push(`修复丢弃（evidence 对不上原文）：${out.id} ingredients`);
    report.applied.repairsSkipped++;
  } else if (fixIng?.value?.length && !(out.ingredients ?? []).length) {
    // 补回来的是一行行原文，仍要走一遍切分/归一，别把原文直接当标准名
    out.ingredients = fixIng.value.map((raw) => ({
      ...splitIngredient(raw),
      recoveredFrom: fixIng.page,
      uncertain: fixIng.uncertain ?? false,
    }));
    report.applied.repairs++;
  } else if (fixIng) {
    report.applied.repairsSkipped++;
  }

  const fixSteps = repairById.get(`${out.id}::steps`);
  const stepEvidence = fixSteps ? evidenceOk(baseById.get(out.id), fixSteps) : false;
  if (fixSteps && !stepEvidence) {
    report.warnings.push(`修复丢弃（evidence 对不上原文）：${out.id} steps`);
    report.applied.repairsSkipped++;
  } else if (fixSteps?.value?.length && !(out.steps ?? []).length) {
    out.steps = fixSteps.value;
    out.recoveredStepsFrom = fixSteps.page;
    report.applied.repairs++;
  } else if (fixSteps) {
    report.applied.repairsSkipped++;
  }

  // 2b'. W4 步骤整组替换（steps-replace）：「steps」只补全空步骤；本字段处理「现存步骤是被
  // 截断的前缀」的场景——北京-127 三鲜瓤鸭膀的步骤 1 断在「把以上」（OCR 把下一行的
  // 「原料」当节标切断），2、3 步被吞进已丢弃的鬼记录北京-128。替换门槛：evidence 回查原文
  // + 每条现存步骤的开头必须能在新步骤里找到（截断前缀校验），防止把好数据盖掉。
  const fixStepsRep = repairById.get(`${out.id}::steps-replace`);
  if (fixStepsRep) {
    if (!evidenceOk(baseById.get(out.id), fixStepsRep)) {
      report.warnings.push(`修复丢弃（evidence 对不上原文）：${out.id} steps-replace`);
      report.applied.repairsSkipped++;
    } else if (Array.isArray(fixStepsRep.value) && fixStepsRep.value.length) {
      const oldHeads = (out.steps ?? []).map((s) => String(s).trim()).filter(Boolean).map((s) => s.slice(0, 12));
      const compatible = oldHeads.every((h) => fixStepsRep.value.some((v) => String(v).includes(h)));
      if (!compatible) {
        report.warnings.push(`修复丢弃（现存步骤不是新步骤的截断前缀，不敢覆盖）：${out.id} steps-replace`);
        report.applied.repairsSkipped++;
      } else {
        out.steps = fixStepsRep.value;
        out.recoveredStepsFrom = fixStepsRep.page;
        report.applied.repairs++;
      }
    }
  }

  // 2d. W3 章节手术：章头被 OCR 吞掉的块（安徽 096..146 禽蛋菜类、山东 169..196 素菜类）
  // 按 repairs 证据门控重挂，chapterRaw 保留原解析值（水产菜类/甜菜类），原书目录是对照证据
  const fixChapter = repairById.get(`${out.id}::chapter`);
  if (fixChapter) {
    report.warnings.push(`章节重挂：${out.id} ${out.chapter} → ${fixChapter.value}（证据页 ${fixChapter.page}）`);
    out.chapterRaw = out.chapter;
    out.chapter = fixChapter.value;
    report.applied.chapter++;
  }

  // 2e. W2 原料行找回（ingredients-append）：标题主料在 OCR 源头就把原料行吞了的
  // （上海-088 蛋奶虾仁无虾仁行、北京-104 油焖大虾无大虾行，制法里都有明证）。
  // 只补行不补克数——原文分量已丢，宁可空着不编数；行自带 canon/allergen，过敏拦截回到数据层。
  const fixIngAdd = repairById.get(`${out.id}::ingredients-append`);
  if (fixIngAdd) {
    if (!evidenceOk(baseById.get(out.id), fixIngAdd)) {
      report.warnings.push(`修复丢弃（evidence 对不上原文）：${out.id} ingredients-append`);
      report.applied.repairsSkipped++;
    } else if (Array.isArray(fixIngAdd.value) && fixIngAdd.value.length) {
      for (const raw of fixIngAdd.value) out.ingredients.push({ ...splitIngredient(raw), recoveredFrom: fixIngAdd.page });
      report.applied.repairs++;
    }
  }

  return out;
});

// ---- 2f. W3 串行鬼record 处置（drop）----
// 北京-128（鸭心卷原料+三鲜瓤鸭膀做法的混合体）、北京-185（三夹火腿的「素火腿」子方被误升格成菜）：
// 两者真身（130 鸭心卷 / 186 干炸黄鱼）完整在库，evidence 核实后整条丢弃，原文仍在 OCR 里不灭。
const droppedIds = new Set(
  resolvedRepairs.filter((x) => x.field === "drop" && x.value !== false).map((x) => x.targetId),
);
const keptRecords = records.filter((r) => {
  if (!droppedIds.has(r.id)) return true;
  report.applied.drops++;
  report.warnings.push(`串行鬼record 丢弃：${r.id} ${r.title}`);
  return false;
});

// ---- 2g. drop 之后重算 suspectTitle（只按省册口径；南北册 9 组同名是跨菜系合法重名，不适用此规则——
// 判定见 work/nanbei-suspect-judgment.json）。build 时的同名对若有一侧被 drop，另一侧解除嫌疑。
const titleCount = new Map();
for (const r of keptRecords) {
  const k = `${r.book}::${r.title}`;
  titleCount.set(k, (titleCount.get(k) ?? 0) + 1);
}
for (const r of keptRecords) r.suspectTitle = (titleCount.get(`${r.book}::${r.title}`) ?? 0) > 1;

const recordsFinal = keptRecords;

// ---- 3. 新分册 ----
const withNew = [...recordsFinal];
for (const r of nanbei) {
  const id = r.id ?? `南北-${String(withNew.length + 1).padStart(3, "0")}`;
  if (withNew.some((x) => x.id === id)) { report.warnings.push(`南北记录 id 冲突：${id}`); continue; }
  withNew.push({
    ...r,
    id,
    page: r.page ?? firstPageOf(r.pages),
    ingredients: (r.ingredients ?? []).map(normalizeIngredient).map(patchOilConsumed),
  });
}

// ---- 3b. 大众菜谱（第 11 来源，0.5 语料批次 2026-10） ----
// 输入 ../intake-大众菜谱/dazhong.jsonl（456 道，克数直取/region 28 城/fryingOil·consumedGrams 已结构化）。
// 章节 B 案映射（lead 裁）：蔬菜/豆腐面筋→素菜类；肉→肉菜类；禽蛋→禽蛋菜类；鱼虾→水产菜类；
// 附录主食→其他菜类；凉菜/汤按主料拆（无荤主料→素菜类，有则按克数最大的荤主料归 猪/牛/羊→肉菜类、
// 禽/蛋→禽蛋菜类、水产→水产菜类）；chapterRaw 一律保留原书章节原文。
const DZ_CHAPTER = { "蔬菜类": "素菜类", "豆腐面筋类": "素菜类", "肉类": "肉菜类", "禽蛋类": "禽蛋菜类", "鱼虾类": "水产菜类", "附录": "其他菜类" };
const DZ_PROTEIN_CH = { "猪肉": "肉菜类", "牛肉": "肉菜类", "羊肉": "肉菜类", "禽肉": "禽蛋菜类", "蛋": "禽蛋菜类", "水产": "水产菜类" };
// 大众册局部归一：两条建议撤出了全局词表（全局化会改写老库 guessed 行——湖南-001「带皮五花猪肉（方形）」
// 经 去皮剥壳+新别名 会命中五花肉、南北-166「扁尖笋」会命中扁尖，违反老库逐字节不变断言），
// 只在本册归一时套用；对应 dazhong 行数 10 + 1。
const DZ_LOCAL_ALIAS = { "五花猪肉": "五花肉", "扁尖笋": "扁尖" };
// 大众册局部类目纠正（2026-10-29）：全书 29 行以「油」结尾且词表无对应的名字会掉进 lookup 的
// /奶|酪|油$/ → 乳 兜底——烹饪油按乳类算 3.2% 蛋白、还带「乳」过敏原，且逃过 enrich 的
// 油脂 85% 附着折扣，三处都错。按「类目级不编数」原则纠正：能挂既有 canon 的直挂
// （酱油系 OCR 变体 / 蠔油=蚝油 / 小磨麻油=芝麻油），挂不上的仅改 parent（素油/猪油之分
// 需逐条读做法，0.5.1 人工核），克数一律保持原值。
const DZ_ING_LINK = { "紅酱油": "酱油", "曰酱油": "酱油", "红色酱油": "酱油", "母油": "酱油", "蠔油": "蚝油", "小磨麻油": "芝麻油" };
const DZ_ING_PARENT = { "油": "油脂", "混合油": "油脂", "食用油": "油脂", "熬化猪油": "油脂", "明油": "油脂", "炸油": "油脂", "糟油": "调味", "白糖、半汤匙香油": "调味" };
// 变体 hints（63 道 74 条）与 ingredientsRef（大众-215/216）需要自己的证据门控，0.5.1 批次再进——读入即忽略。
const dzStats = { chapter: {}, coldSoupSplit: { "素菜类": 0, "肉菜类": 0, "禽蛋菜类": 0, "水产菜类": 0 }, localAlias: 0, ingLink: 0, ingParentFix: 0, unitGramsDerived: 0, guessedRows: 0, deferredVariantHints: 0, deferredIngredientsRef: 0 };

const normalizeDazhongIng = (ing) => {
  const out = { ...ing };
  const name = String(ing.name ?? "").replace(/\s+/g, "");
  let e = lookup(name);
  let viaLocal = false;
  if ((!e || e.guessed) && DZ_LOCAL_ALIAS[name]) {
    const t = lookup(DZ_LOCAL_ALIAS[name]);
    if (t && !t.guessed) { e = t; viaLocal = true; }
  }
  if (e?.guessed && DZ_ING_LINK[name]) {
    const t = lookup(DZ_ING_LINK[name]);
    if (t && !t.guessed) { e = t; viaLocal = true; dzStats.ingLink++; }
  }
  if (e?.guessed && DZ_ING_PARENT[name]) {
    const parent = DZ_ING_PARENT[name];
    e = { ...e, parent, cat: parent === "油脂" ? "粮油" : "调味", allergen: [] };
    out.ingParentFix = `乳兜底纠正→${parent}`;
    dzStats.ingParentFix++;
  }
  if (e) {
    out.key = e.id;
    out.canon = e.id;
    out.parent = e.parent;
    out.cat = e.cat;
    out.allergen = e.allergen ?? [];
    out.guessed = Boolean(e.guessed);
    if (viaLocal) { out.canonSource = "dazhong-local-alias"; dzStats.localAlias++; }
    // 计数行克数：CANON.unitGrams 能推默认单重的推（记录推导来源），推不了留 null——不编数
    if (out.grams == null && Number.isFinite(out.count) && e.unitGrams) {
      out.grams = Math.round(out.count * e.unitGrams * 10) / 10;
      out.unitGramsFrom = `CANON.unitGrams ${out.count}×${e.unitGrams}g`;
      dzStats.unitGramsDerived++;
    }
    if (out.guessed) dzStats.guessedRows++;
  }
  return out;
};

const dazhongChapterOf = (rec, srcChapter) => {
  // 映射键用解析层的 chapter（8 值枚举）；chapterRaw 是原书章头（「蔬菜类菜谱」带菜谱后缀），只留档
  const src = String(srcChapter ?? rec.chapterRaw ?? "").replace(/菜谱$|[。\s]+$/g, "");
  const direct = DZ_CHAPTER[src];
  if (direct) return direct;
  if (src === "凉菜类" || src === "汤菜类") {
    let best = null;
    for (const i of rec.ingredients ?? []) {
      const ch = DZ_PROTEIN_CH[i.parent];
      if (!ch || !(i.grams > 0)) continue;
      if (!best || i.grams > best.grams) best = { grams: i.grams, ch };
    }
    const mapped = best ? best.ch : "素菜类";
    dzStats.coldSoupSplit[mapped] = (dzStats.coldSoupSplit[mapped] ?? 0) + 1;
    return mapped;
  }
  report.warnings.push(`大众章节未映射，兜底其他菜类：${rec.id} ${src}`);
  return "其他菜类";
};

const dazhongRecords = [];
for (const r of dazhong) {
  const id = r.id;
  if (!id || dazhongRecords.some((x) => x.id === id) || withNew.some((x) => x.id === id)) {
    report.warnings.push(`大众记录 id 冲突或缺 id：${id}`);
    continue;
  }
  dzStats.deferredVariantHints += (r.variantHints ?? []).length;
  if (r.ingredientsRef) dzStats.deferredIngredientsRef++;
  const rec = {
    id,
    seq: r.seq ?? null,
    seqNum: r.seqNum ?? null,
    title: r.title,
    cuisine: "大众",
    region: r.region ?? null,
    book: r.book ?? "大众菜谱",
    pages: r.pages ?? [],
    page: r.page ?? null,
    chapterRaw: r.chapterRaw ?? r.chapter ?? null,
    ingredients: (r.ingredients ?? []).map(normalizeDazhongIng).map(patchOilConsumed),
    steps: r.steps ?? [],
    // 大众册的附注在上游是 {text, kind}，其余册是纯字符串；cards/recipe_get 的 schema
    // 只收 string[]，这里统一摊平成文本（kind 不参与展示），否则取详情会在宿主侧
    // output.schema 校验时整体失败（2026-10-31 实测 197 道取不出卡）。
    // 另：OCR 残留的孤立 HTML 标签（`<div align="center">` 之类）不是内容，直接剔掉。
    notes: (r.notes ?? [])
      .map((n) => (typeof n === "string" ? n : n?.text ?? ""))
      .filter((n) => n && !/^<\/?[a-z][a-z0-9]*(\s[^>]*)?>$/i.test(n.trim())),
  };
  rec.chapter = dazhongChapterOf(rec, r.chapter);
  // 技法/口味派生：省册在 parse、南北册在自家解析器里做，大众册没有上游标签——
  // 在这里统一走 parse.mjs 的 deriveTags（同一套 METHOD_WORDS/FLAVOR_WORDS，
  // 不然 fat_loss 的口味拦截对大众册失明，B6 类守卫会漏）。features 传空：附注不是特点行。
  const tags = deriveTags(rec.title, "", rec.steps, rec.ingredients);
  rec.methods = tags.methods;
  rec.flavors = tags.flavors;
  dzStats.chapter[rec.chapter] = (dzStats.chapter[rec.chapter] ?? 0) + 1;
  dazhongRecords.push(rec);
}
report.dazhong = dzStats;

// ---- 3c. 国际菜谱（第 12 来源，2026-10-31 语料批次） ----
// 输入 data/work/guoji.jsonl（北京友谊宾馆 1983，50+ 国 1,253 道；id=国际-书内全局编号）。
// 体例：全书按十份数量计（编者的话）→ servingsBase=10；市制斤两钱分；半成品以书内编号引用
// （奶油少司（274）→ ref 字段）；菜名中英对照（enTitle 保留）。语料线路取向：双线（吃饭+学菜），
// 馆子基础量不进 bulk（与省册宴席的 61kg 批量配方不同，十份是本书统一基准）。
const guoji = readJsonl(join(WORK, "guoji.jsonl"));
const gjStats = { chapter: {}, localAlias: 0, localNew: 0, sauceParent: 0, parentFix: 0, region: 0, formStrip: 0 };
// 局部别名（不动全局词表——老库 guessed 行逐字节不变的纪律，同大众册 DZ_LOCAL_ALIAS）
const GJ_ALIAS = {
  "醋精": "醋", "鲜西红柿": "西红柿", "元白菜": "卷心菜", "蛋青": "鸡蛋清", "老鸡蛋": "鸡蛋",
  "长葱": "葱", "青葱": "葱", "芹菜叶": "芹菜", "玉米粉": "淀粉", "糖粉": "糖", "酸牛奶": "牛奶",
  "米饭": "大米", "油炒面粉": "面粉", "猪通脊": "里脊", "羊肉末": "羊肉", "牛肉末": "牛肉",
  "膨松体奶油": "奶油", "鲜蘑": "蘑菇", "番茄少司": "番茄沙司", "瓶蕃茄少司": "番茄沙司", "蕃茄少司": "番茄沙司",
};
// 本书自有物（全局词表没有、也不该为单册扩全局）：西餐常备。canon=自身，营养按 parent 类目默认。
const GJ_NEW = {
  "香叶": { parent: "调味", cat: "调味" }, "生菜油": { parent: "油脂", cat: "油脂" },
  "计司": { parent: "乳", cat: "乳" }, "板肉": { parent: "猪肉", cat: "肉禽" },
  "结力片": { parent: "调味", cat: "调味" }, "香草片": { parent: "调味", cat: "调味" },
  "白兰地": { parent: "调味", cat: "调味" }, "白兰地酒": { parent: "调味", cat: "调味" },
  "葡萄酒": { parent: "调味", cat: "调味" }, "红葡萄酒": { parent: "调味", cat: "调味" },
  "白葡萄酒": { parent: "调味", cat: "调味" }, "红酒": { parent: "调味", cat: "调味" },
  "酸黄瓜": { parent: "蔬菜", cat: "蔬菜" }, "辣根": { parent: "调味", cat: "调味" },
};
// 煮/熟/净/老 等前置形态词（「煮土豆条」→「土豆条」→lookup 形态词→土豆）；迭代剥最多三层
const GJ_FORM_PREFIX = /^(煮|熟|炸|烤|腌|净|鲜|老|去皮|带皮|去骨)+/;
// 兜底 parent（挂不上 canon 的：素油/清汤/沙司族。canon=自身——enrich 只累计有 canon 的行，
// parent-only 行会被整行跳过营养（2026-10-31 国际册 24 道 0kcal 的根因）。parent 必须是
// NUTRI_PARENT 合法类目：汤底/谷物 都在，别用「面粉/主食」这类不是类目的词）
const GJ_PARENT = {
  "油": "油脂", "清汤": "汤底", "鱼清汤": "汤底", "鸡清汤": "汤底", "木鱼汤": "汤底",
  "面团": "谷物", "混酥面团": "谷物", "甜酥面团": "谷物", "面包": "谷物",
};
const normalizeGuojiIng = (ing) => {
  const out = { ...ing };
  let name = String(ing.name ?? "").replace(/\s+/g, "");
  let e = lookup(name);
  if ((!e || e.guessed) && GJ_ALIAS[name]) { const t = lookup(GJ_ALIAS[name]); if (t && !t.guessed) { e = t; gjStats.localAlias++; } }
  if ((!e || e.guessed)) {
    let stripped = name;
    for (let i = 0; i < 3 && GJ_FORM_PREFIX.test(stripped) && stripped !== stripped.replace(GJ_FORM_PREFIX, ""); i++) {
      stripped = stripped.replace(GJ_FORM_PREFIX, "");
      const t = lookup(stripped);
      if (t && !t.guessed) { e = t; gjStats.formStrip++; break; }
    }
    if (name !== stripped && (!e || e.guessed)) name = stripped;
  }
  if ((!e || e.guessed) && GJ_NEW[name]) {
    out.canon = name; out.key = name; out.parent = GJ_NEW[name].parent; out.cat = GJ_NEW[name].cat;
    out.allergen = []; out.guessed = false; out.grams = out.grams ?? null;
    gjStats.localNew++;
    return out;
  }
  if (e && !e.guessed) {
    const p = ing.grams == null ? parseAmount(ing.amount ?? "", e) : null;
    return { ...out, key: e.id, canon: e.id, parent: e.parent, cat: e.cat, allergen: e.allergen ?? [], guessed: false, grams: ing.grams ?? p?.grams ?? null, count: ing.count ?? p?.count ?? null };
  }
  // 沙司/少司族（含带引用号的「奶油少司」）：不逐个建条目，canon=自身 + parent 调味
  if (/少司|沙司/.test(name)) { out.canon = name; out.key = name; out.parent = "调味"; out.cat = "调味"; out.allergen = []; out.guessed = true; gjStats.sauceParent++; return out; }
  for (const [k, parent] of Object.entries(GJ_PARENT)) {
    if (name === k || name.endsWith(k)) { out.canon = name; out.key = name; out.parent = parent; out.cat = parent; out.allergen = []; out.guessed = true; gjStats.parentFix++; return out; }
  }
  const g = lookup(name); // 后缀大类兜底（鱼/虾/菜/肉/菇）
  if (g) { out.key = g.id; out.canon = g.id; out.parent = g.parent; out.cat = g.cat; out.allergen = g.allergen ?? []; out.guessed = true; }
  return out;
};
// 风格前缀 → 国家/地区（「法式煮鱼白酒鲜蘑少司」→ 法国）
const GJ_REGION = {
  "法": "法国", "德": "德国", "俄": "俄国", "英": "英国", "美": "美国", "意": "意大利", "印度": "印度",
  "朝鲜": "朝鲜", "日": "日本", "土耳其": "土耳其", "南斯拉夫": "南斯拉夫", "捷克": "捷克斯洛伐克",
  "波兰": "波兰", "匈牙利": "匈牙利", "罗马尼亚": "罗马尼亚", "保加利亚": "保加利亚",
  "诺尔曼": "法国", "莫斯科": "俄国", "约旦": "约旦", "叙利亚": "叙利亚", "尼泊尔": "尼泊尔",
  "桑给巴尔": "桑给巴尔", "埃及": "埃及", "埃塞俄比亚": "埃塞俄比亚", "墨西哥": "墨西哥", "巴西": "巴西",
  "智利": "智利", "阿根廷": "阿根廷", "印尼": "印度尼西亚", "越南": "越南", "泰国": "泰国", "缅甸": "缅甸",
  "巴基斯坦": "巴基斯坦", "伊朗": "伊朗", "伊拉克": "伊拉克", "黎巴嫩": "黎巴嫩", "希腊": "希腊",
  "瑞士": "瑞士", "丹麦": "丹麦", "瑞典": "瑞典", "挪威": "挪威", "芬兰": "芬兰", "荷兰": "荷兰",
  "比利时": "比利时", "奥地利": "奥地利", "西班牙": "西班牙", "葡萄牙": "葡萄牙", "蒙古": "蒙古",
};
const guojiRegionOf = (title) => {
  const m = String(title ?? "").match(/^(.{1,5}?)式/);
  if (!m) return null;
  return GJ_REGION[m[1]] ?? m[1];
};
// 章节：冷菜族（沙拉/腌制/胶冻/其它/冷菜/水产）与汤族按主料蛋白拆（同大众册 coldSoupSplit 口径）；
// 猪牛→肉菜类，蛋禽→禽蛋菜类，鱼虾→水产菜类，无荤→素菜类；饭点心/面包→其他菜类，茶点心→甜菜类。
const GJ_CHAPTER = { "猪肉类": "肉菜类", "牛肉类": "肉菜类", "羊肉类": "肉菜类", "蛋品类": "禽蛋菜类", "水产类": "水产菜类", "鱼虾类": "水产菜类", "禽类": "禽蛋菜类", "饭点心": "其他菜类", "面包": "其他菜类", "茶点心": "甜菜类", "点心类": "甜菜类" };
const GJ_COLD = new Set(["沙拉子类", "腌制蔬菜类", "胶冻类", "其 它", "其它", "其他", "冷菜类", "配菜类"]);
const GJ_PROTEIN_CH = { 猪肉: "肉菜类", 牛肉: "肉菜类", 羊肉: "肉菜类", 禽肉: "禽蛋菜类", 蛋: "禽蛋菜类", 水产: "水产菜类" };
const guojiChapterOf = (rec, sectionRaw) => {
  const sec = String(sectionRaw ?? "").replace(/\s+/g, "");
  if (GJ_CHAPTER[sec]) return GJ_CHAPTER[sec];
  const ings = rec.ingredients ?? [];
  const byProtein = ["猪肉", "牛肉", "羊肉"].find((p) => ings.some((i) => i.parent === p))
    ?? (ings.some((i) => i.parent === "禽肉" || i.canon === "鸡蛋" || i.canon === "鸡蛋清") ? "禽肉" : null)
    ?? (ings.some((i) => /鱼|虾|蟹/.test(String(i.canon ?? "")) || i.parent === "水产") ? "水产" : null);
  if (GJ_COLD.has(sec) || sec.startsWith("汤") || /汤类$/.test(sec)) {
    return byProtein ? GJ_PROTEIN_CH[byProtein] : "素菜类";
  }
  return byProtein ? GJ_PROTEIN_CH[byProtein] : "其他菜类";
};
const guojiRecords = [];
for (const r of guoji) {
  const id = r.id;
  if (!id || guojiRecords.some((x) => x.id === id) || withNew.some((x) => x.id === id) || dazhongRecords.some((x) => x.id === id)) {
    report.warnings.push(`国际记录 id 冲突或缺 id：${id}`);
    continue;
  }
  const rec = {
    id,
    seq: r.seq ?? null,
    seqNum: r.seq ?? null,
    title: r.title,
    enTitle: r.enTitle ?? null,
    cuisine: "国际",
    region: r.region ?? guojiRegionOf(r.title),
    book: "国际菜谱",
    pages: r.pages ?? [],
    page: r.page ?? null,
    chapterRaw: [r.section, r.subsection].filter(Boolean).join(" / ") || null,
    servingsBase: 10, // 全书十份基准（编者的话）；单人场景由菜单文案承载「按原方 10 份」
    ingredients: (r.ingredients ?? []).map(normalizeGuojiIng).map(patchOilConsumed),
    steps: r.steps ?? [],
    features: r.features ?? null,
    notes: typeof r.notes === "string" ? r.notes : (r.notes ?? []).map((n) => n?.text ?? n ?? "").filter(Boolean),
  };
  if (rec.region) gjStats.region++;
  rec.chapter = guojiChapterOf(rec, r.section);
  const tags = deriveTags(rec.title, "", rec.steps, rec.ingredients);
  rec.methods = tags.methods;
  rec.flavors = tags.flavors;
  gjStats.chapter[rec.chapter] = (gjStats.chapter[rec.chapter] ?? 0) + 1;
  guojiRecords.push(rec);
}
report.guoji = gjStats;

const pooled = [...withNew, ...dazhongRecords, ...guojiRecords];

// 2c. grams 修复：按 原料名 定位（用重定位后的 targetId）。
// W2 P3 起挪到 withNew 之后——南北册的行（外层小数「2.5斤」4 行）也能走同一证据门。
// （大众册 3b 已并入 pooled，但 repairs 只带省册/南北册 id，不会命中大众行。）
for (const r of resolvedRepairs.filter((x) => x.field === "grams" && typeof x.value === "number")) {
  const rec = pooled.find((x) => x.id === r.targetId);
  if (!rec) { report.warnings.push(`grams 修复找不到记录 ${r.targetId}`); continue; }
  const ing = (rec.ingredients ?? []).find((i) => i.name === r.ingredientName || i.canon === r.ingredientName);
  if (!ing) { report.warnings.push(`${r.targetId} 找不到原料 ${r.ingredientName}`); continue; }
  ing.grams = r.value;
  ing.recoveredFrom = r.page;
  report.applied.repairs++;
}

// ---- 4. 变体关系 ----
// 子任务拿到的 id 可能来自旧版解析（解析规则一改，册内序号会错位）。
// 所以先验证：id 都在、且组名能和其中至少一条对上，否则整组丢弃。
const finalById = new Map(pooled.map((r) => [r.id, r]));
const squashTitle = (s) => String(s ?? "").replace(/[\s*＊·、，,。.（）()]/g, "");
// 不信任子任务给的 confidence，自己按原料名称重算一遍重合度：
// 同一道菜的不同版本，主料该高度重合；同名不同菜应当几乎不重合。
// 用「模糊匹配」而不是严格相等——OCR 出来的名字有「山药 / 淮山」这种差异。
const ingKeys = (r) => [...new Set((r?.ingredients ?? []).flatMap((i) => [i.canon, i.name]).filter(Boolean))];
const similarKey = (a, b) => a === b || (a.length > 1 && b.length > 1 && (a.includes(b) || b.includes(a)));
const overlapOf = (a, b) => {
  const ka = ingKeys(a);
  const kb = ingKeys(b);
  if (!ka.length || !kb.length) return 0;
  const used = new Set();
  let inter = 0;
  for (const x of ka) {
    for (const y of kb) {
      if (used.has(y)) continue;
      if (similarKey(x, y)) { inter++; used.add(y); break; }
    }
  }
  return inter / (ka.length + kb.length - inter);
};
const variantIndex = new Map();
let droppedGroups = 0;
for (const g of dupGroups) {
  if (!g?.ids?.length) continue;
  const ids = [...new Set(g.ids)];
  const missing = ids.filter((id) => !finalById.has(id));
  const titleMatch = ids.some((id) => squashTitle(finalById.get(id)?.title) === squashTitle(g.title));
  if (missing.length || !titleMatch) {
    droppedGroups++;
    report.warnings.push(`变体组丢弃（id 对不上）：${g.title}（缺失 ${missing.join(",") || "无"}；组名匹配 ${titleMatch}）`);
    continue;
  }
  const [first, ...rest] = ids.map((id) => finalById.get(id));
  const overlaps = rest.map((r) => overlapOf(first, r));
  const avg = overlaps.length ? overlaps.reduce((s, x) => s + x, 0) / overlaps.length : 1;
  const min = overlaps.length ? Math.min(...overlaps) : 1;
  const wantSame = g.verdict === "same_dish";
  // 原料太少的记录（OCR 把整块丢了）不能用来否决同名关系，只标注「数据稀薄」
  const sparse = ids.map((id) => ingKeys(finalById.get(id)).length).some((n) => n < 5);
  if (wantSame && min < 0.15 && !sparse) {
    droppedGroups++;
    report.warnings.push(`变体组丢弃（主料几乎不重合 ${min.toFixed(2)}）：${g.title} ${ids.join(",")}`);
    continue;
  }
  if (wantSame && min < 0.15 && sparse) report.warnings.push(`变体组保留但数据稀薄：${g.title} ${ids.join(",")}`);
  if (!wantSame && avg > 0.6) {
    droppedGroups++;
    report.warnings.push(`变体组丢弃（判成分家但主料重合 ${avg.toFixed(2)}）：${g.title} ${ids.join(",")}`);
    continue;
  }
  for (const id of ids) {
    const cur = variantIndex.get(id) ?? [];
    cur.push({ group: g.title, verdict: g.verdict, confidence: g.confidence, others: ids.filter((x) => x !== id), overlap: +avg.toFixed(2) });
    variantIndex.set(id, cur);
  }
  report.applied.variants++;
}

// ---- 5. 重新派生 ----
// 5a. W3 章节枚举统一（31 值两套分类法 → 一套；chapterRaw 保留原书原文）。
// 映射表：work/chapter-map.json 的 map（省册 8 值为主干，南北「菜系 / X类」按 X 归入，
// 「山珍海味类」是南北实有类目、保留为独立值）。查询层 includes 子串匹配天然兼容。
const mapOf = chapterMap?.map ?? {};
let chapterMapped = 0;
const final = pooled.map((r) => {
  const v = variantIndex.get(r.id);
  const mapped = mapOf[r.chapter];
  const rr = mapped && mapped !== r.chapter
    ? { ...r, chapter: mapped, chapterRaw: r.chapterRaw ?? r.chapter }
    : r;
  if (rr !== r) chapterMapped++;
  const enriched = enrichRecipe(rr);
  return v ? { ...enriched, variants: v } : enriched;
});
report.applied.chapterMapped = chapterMapped;

// ---- 5b. 营养不变量断言（fail-fast，放在写盘之前：违规就不落盘）----
// 公式回归 / 表换了没重建 / enrich 改坏，都在这里拦下；首条违规样例直接进错误消息。
const kcalBad = [];
const perBad = [];
for (const r of final) {
  const n = r.nutrition ?? {};
  if (!["proteinGrams", "fatGrams", "carbGrams", "kcal"].every((k) => Number.isFinite(n[k]))) {
    kcalBad.push(`${r.id} ${r.title}: nutrition 缺数值列（v0.3 起应有 p/f/c/kcal）`);
    continue;
  }
  // 不变量 1：|kcal − (4p + 4c + 9f)| ≤ 1.2（库内字段；1.2 是三字段 1 位小数 + 取整的容差）
  const calc = 4 * n.proteinGrams + 4 * n.carbGrams + 9 * n.fatGrams;
  if (Math.abs(n.kcal - calc) > 1.2) kcalBad.push(`${r.id} ${r.title}: kcal=${n.kcal} ≠ 4p+4c+9f=${calc.toFixed(1)}`);
  // 不变量 2：perServing 与 整道/servingsBase 一致（kcal 差 ≤1、蛋白差 ≤0.2）
  if (r.perServing && r.servingsBase) {
    if (Math.abs(r.perServing.kcal - n.kcal / r.servingsBase) > 1) perBad.push(`${r.id} ${r.title}: perServing.kcal=${r.perServing.kcal} vs 整道 ${n.kcal}/${r.servingsBase}`);
    if (Math.abs(r.perServing.proteinGrams - n.proteinGrams / r.servingsBase) > 0.2) perBad.push(`${r.id} ${r.title}: perServing 蛋白 ${r.perServing.proteinGrams} vs 整道 ${n.proteinGrams}/${r.servingsBase}`);
  }
}
if (kcalBad.length || perBad.length) {
  const first = kcalBad[0] ?? perBad[0];
  throw new Error(`营养不变量违规 ${kcalBad.length + perBad.length} 条（kcal 恒等式 ${kcalBad.length} / perServing 一致性 ${perBad.length}）；首条：${first}`);
}

mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "recipes.processed.jsonl"), final.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

// ---- 6. 应用层产物：给 UI 用的轻量卡片与筛选面 ----
// 小程序/网页不需要 8MB 全量数据，先把首屏要的东西拍扁
const APP = join(DATA, "app");
mkdirSync(APP, { recursive: true });
const cards = final.map((r) => ({
  id: r.id,
  title: r.title,
  cuisine: r.cuisine,
  region: r.region ?? null,
  chapter: r.chapter,
  skill: r.skill?.tier,
  protein: r.perServing?.proteinGrams,
  kcal: r.perServing?.kcal,
  servings: r.servingsBase,
  main: (r.mainCanon ?? []).slice(0, 4),
  allergens: r.allergens ?? [],
  page: r.page ?? null,
  hasVariants: Boolean(r.variants?.length),
}));
writeFileSync(join(APP, "cards.json"), JSON.stringify(cards), "utf8");

const count = (keyFn) => {
  const m = new Map();
  for (const r of final) for (const k of [].concat(keyFn(r) ?? [])) if (k) m.set(k, (m.get(k) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
};
const topIng = final.reduce((m, r) => {
  for (const i of r.ingredients ?? []) if (!i.guessed) m.set(i.canon, (m.get(i.canon) ?? 0) + 1);
  return m;
}, new Map());
const facets = {
  total: final.length,
  byCuisine: count((r) => r.cuisine),
  byChapter: count((r) => r.chapter),
  bySkill: count((r) => r.skill?.tier),
  byMethod: count((r) => (r.methods ?? []).slice(0, 3)),
  topIngredients: Object.fromEntries([...topIng.entries()].sort((a, b) => b[1] - a[1]).slice(0, 200)),
  byAllergen: count((r) => r.allergens ?? []),
};
writeFileSync(join(APP, "facets.json"), JSON.stringify(facets, null, 1), "utf8");
report.app = { cards: cards.length, cardsKB: Math.round(readFileSync(join(APP, "cards.json")).length / 1024), facets: Object.keys(facets.byCuisine).length };

const stats = {
  recipes: final.length,
  byCuisine: Object.fromEntries([...final.reduce((m, r) => m.set(r.cuisine, (m.get(r.cuisine) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1])),
  withIngredients: final.filter((r) => r.ingredients?.length).length,
  withSteps: final.filter((r) => r.steps?.length).length,
  ingredients: final.reduce((s, r) => s + (r.ingredients?.length ?? 0), 0),
  guessed: final.reduce((s, r) => s + (r.ingredients ?? []).filter((i) => i.guessed).length, 0),
  hasVariants: final.filter((r) => r.variants?.length).length,
  caloriesMedian: median(final.map((r) => r.perServing?.kcal ?? 0)),
};
report.stats = stats;
report.applied.oilConsumed = oilConsumedPatched;
report.applied.nanbeiPage = withNew.filter((r) => r.cuisine === "南北" && r.page != null).length;
report.mb = +(readFileSync(join(DATA, "recipes.processed.jsonl")).length / 1e6).toFixed(2);

writeFileSync(join(DATA, "processed-report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));

function median(arr) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)] ?? 0;
}
