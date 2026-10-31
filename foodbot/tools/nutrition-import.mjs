#!/usr/bin/env node
/**
 * tools/nutrition-import.mjs —— v0.3 data-agent：碳水参考数据导入。
 *
 * 输入（全部只读）：
 *   ../china-food-composition-data/json_data_v3_20260825_qwen38max_kimi_k3_fixed_en/merged_*.json
 *     （《中国食物成分表》标准版第6版结构化数据，61 类 1,677 条；字段值为字符串，"Tr"→0、"—"→缺失）
 *   src/lexicon.mjs        —— CANON 标准食材词表（BASE + EXTRA 合并）
 *   src/ingredients.mjs    —— nutrition() 取现值（NUTRI_OVERRIDE > NUTRI_PARENT），p/f 冻结基准
 *   data/recipes.processed.jsonl —— 湿淀粉影响面统计（只读）
 *
 * 输出（覆写）：
 *   src/nutrition-ref.mjs          —— REF_OVERRIDES / REF_CATEGORIES / IMPORT_META（ITERATION-0.3.md §3 形状）
 *   ../review-0.3/nutrition-import.md —— 导入报告
 *
 * 运行：node tools/nutrition-import.mjs（项目根，可重复执行，幂等覆盖）
 *
 * 规则要点（与 ITERATION-0.3.md §1 裁决对应）：
 *   §1.2 p/f 冻结：REF_OVERRIDES 的 p/f = 现值（容差 0.1 外的差异记入冻结例外清单，留 0.3.1）
 *   §1.6 纯糖（P1min）：冰糖/白糖/红糖/饴糖/蜂蜜/糖色/糖桂花 → [0, 0, 99.0]（参考数据无食糖类，注明）
 *   §1.4 碳水不手抄：全量从参考数据导入；参考数据没有、审计 §0.3 有的少数果料条目按审计值兜底并注明
 *   消歧：精确/归一化匹配 + 少量显式 curated 挑选（带理由）；消不了的归 ambiguous，不硬配
 *
 * 0.5 增补（ITERATION-0.5 W7）：
 *   W7a 可食部回填：REF_OVERRIDES 条目加 `edible`（参考数据按 foodCode 的可食部%，缺省 100），
 *     enrich 端营养累计按 grams × edible/100 折算（配料原文克数不动）。
 *   W7b `--calibrate`：REF_OVERRIDES 的 v 改用参考值 p/f（note 标「校准」），解除 v0.3 §1.2 的
 *     p/f 冻结；6 个歧义名（虾/蟹/贝/鱼肉/瓜子仁/豆芽）与纯糖/兜底条目仍保持现值。
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CANON } from "../src/lexicon.mjs";
import { nutrition } from "../src/ingredients.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REF_DIR = path.resolve(
  ROOT,
  "../china-food-composition-data/json_data_v3_20260825_qwen38max_kimi_k3_fixed_en"
);
const OUT_MJS = path.join(ROOT, "src", "nutrition-ref.mjs");
const OUT_REPORT = path.resolve(ROOT, "..", "review-0.3", "nutrition-import.md");

/* ───────────────────────── 参考数据加载与清洗 ───────────────────────── */

/** "Tr"→0（痕量），"—"/""→null（缺失），其余→数字 */
function num(v) {
  const s = String(v ?? "").trim();
  if (s === "" || s === "—" || s === "-" || s == null) return null;
  if (s === "Tr" || s === "TR" || s === "tr") return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 把 foodName 拆成 main + 括注段（（）与［］），全部可作为匹配键 */
function parseName(raw) {
  const paren = [...String(raw).matchAll(/（([^）]*)）/g)].flatMap((m) => m[1].split(/[，、,]/));
  const alias = [...String(raw).matchAll(/［([^］]*)］/g)].flatMap((m) => m[1].split(/[，、,]/));
  const main = String(raw)
    .replace(/［[^］]*］/g, "")
    .replace(/（[^）]*）/g, "")
    .replace(/\s+/g, "");
  const keys = new Set([main, ...paren, ...alias].map((s) => s.trim()).filter(Boolean));
  return { main, keys, paren: paren.map((s) => s.trim()), alias: alias.map((s) => s.trim()), plain: main === String(raw).replace(/\s+/g, "") };
}

function loadRef() {
  const entries = [];
  const files = readdirSync(REF_DIR).filter((f) => /^merged_.*\.json$/.test(f));
  for (const f of files) {
    const cat = f.replace(/^merged_/, "").replace(/\.json$/, "");
    for (const e of JSON.parse(readFileSync(path.join(REF_DIR, f), "utf8"))) {
      const parsed = parseName(e.foodName);
      entries.push({
        code: e.foodCode,
        raw: String(e.foodName),
        cat,
        ...parsed,
        p: num(e.protein),
        f: num(e.fat),
        c: num(e.CHO),
        edible: num(e.edible),
      });
    }
  }
  const index = new Map();
  for (const e of entries) for (const k of e.keys) {
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(e);
  }
  return { entries, index, files: files.length };
}

/* ───────────────────────── 消歧配置（显式、可审） ───────────────────────── */

/**
 * curated 挑选：CANON id → { code, why }。只放算法匹配不了/会选错的条目，每条写明理由。
 * code 为参考数据 foodCode（本数据集版本内稳定）。
 */
const CURATED = {
  淀粉: { code: "022104", why: "团粉［芡粉］（词表别名，混合淀粉代表条目）" },
  火腿: { code: "081421", why: "金华火腿（词表别名；火腿多候选，书中火腿以金华火腿为正）" },
  腊肉: { code: "081305", why: "腊肉（生，fat49g）：生腊肉代表条目；培根为西式、fat68 为高脂变种" },
  五花肉: { code: "081105", why: "猪肉（肋条肉）＝五花肉（肋条）" },
  猪瘦肉: { code: "081110", why: "猪肉（瘦）" },
  里脊: { code: "081129", why: "猪肉（里脊）〔词表 parent=猪肉〕" },
  肥膘: { code: "081102", why: "猪肥肉（肥，fat89g）" },
  板油: { code: "191006", why: "猪油（板油）：生鲜板油（有别于熬制猪油）" },
  猪油: { code: "191007", why: "猪油（炼）：库内猪油为熬制熟油" },
  猪腰: { code: "081209", why: "猪肾（fat8g）［猪腰子］" },
  猪肠: { code: "081113", why: "猪大肠（肥肠主用）" },
  猪蹄膀: { code: "081109", why: "猪肉（前肘）：蹄膀＝肘，现 override [16,22] 与前肘最近" },
  蹄筋: { code: "081117", why: "猪蹄筋（词表别名含牛蹄筋，以猪蹄筋为代表）" },
  叉烧: { code: "081321", why: "叉烧肉" },
  肉松: { code: "081317", why: "太仓肉松（传统肉松代表）" },
  蛋清: { code: "111105", why: "鸡蛋白" },
  蛋黄: { code: "111107", why: "鸡蛋黄" },
  鸡肉: { code: "091101x", why: "鸡（代表值）：成分表无「鸡肉」条目" },
  光鸡: { code: "091101x", why: "鸡（代表值）：整鸡" },
  鸡胸: { code: "091112", why: "鸡胸脯肉" },
  乌鸡: { code: "091107", why: "鸡（乌骨鸡）" },
  牛奶: { code: "101101x", why: "纯牛奶（代表值，全脂）" },
  豆奶: { code: "031405", why: "豆浆（成分表无「豆奶」）" },
  豆沙: { code: "033204", why: "红豆沙（去皮）" },
  百叶: { code: "031509", why: "千张［百页］（百叶＝千张）" },
  面筋: { code: "011501", why: "水面筋（排除「面筋（肉馅）」）" },
  四季豆: { code: "042118", why: "扁豆（鲜荚豆通用，词表别名扁豆/芸豆）" },
  青菜: { code: "045120", why: "小白菜［青菜］（上海口径「青菜」＝小白菜；成分表括注别名即青菜）" },
  芹菜: { code: "045331", why: "芹菜（茎）［旱芹，药芹］（词表别名药芹）" },
  笋: { code: "045401", why: "竹笋（鲜）：库内笋混用冬笋/春笋/竹笋，取通用竹笋（与审计口径一致）" },
  雪里蕻: { code: "045205", why: "芥菜（鲜）［雪里红，雪菜］：雪里蕻＝雪菜型芥菜" },
  蒜苗: { code: "044104", why: "青蒜（蒜苗＝青蒜；成分表无蒜苗条目）" },
  青椒: { code: "043124", why: "甜椒［灯笼椒、柿子椒］（词表别名甜椒/灯笼椒）" },
  辣椒: { code: "043109", why: "辣椒（红，小）：鲜辣椒（干辣椒已单列 canon）" },
  干辣椒: { code: "043108", why: "辣椒（红，尖，干）" },
  萝卜: { code: "041101", why: "白萝卜（鲜）［莱菔］（书中白萝卜为主）" },
  海带: { code: "052004", why: "海带（浸）：库内克数按泡发后口径（同水发木耳）" },
  木耳: { code: "051014", why: "木耳（水发）：库内 92/120 条原文为「水发木耳」，按水发计" },
  香菇: { code: "051019", why: "香菇（鲜）：原文 459/595 条为「水发香菇/冬菇」，无水发条目按鲜值近似" },
  海参: { code: "129003", why: "海参（水浸）：原文 62/72 条为「水发海参」" },
  鱿鱼: { code: "129010", why: "鱿鱼（水浸）：原文 21/39 条为「水发鱿鱼」" },
  海蜇: { code: "129004", why: "海蜇皮（蜇皮为主用）" },
  乌龟: { code: "129016", why: "乌龟（肉）（排除龟板）" },
  栗子: { code: "071008", why: "栗子（鲜）［板栗］：书中栗子为鲜品去壳；同名多候选（干/熟/代表×5）不硬配故显式定" },
  芝麻: { code: "072016", why: "芝麻子（白）（黑白两系，白芝麻更常用）" },
  核桃仁: { code: "071004", why: "核桃（干）［胡桃］（词表别名胡桃/核桃）" },
  红枣: { code: "062302", why: "枣（干）：红枣＝干枣" },
  花生米: { code: "072004", why: "花生仁（生）＝花生米" },
  芡实: { code: "072019", why: "芡实米（干）［鸡头米］" },
  蜜柑: { code: "064206", why: "蜜橘（蜜柑＝蜜橘类）" },
  面粉: { code: "011201x", why: "小麦粉（代表值）（面粉＝小麦粉）" },
  大米: { code: "012001x", why: "稻米（代表值）（大米＝稻米）" },
  大米粉: { code: "012405", why: "籼米粉［排米粉］（米粉干类）" },
  赤豆: { code: "033101", why: "赤小豆（干）［小豆，红小豆］（赤豆＝赤小豆）" },
  鲳鱼: { code: "121233", why: "鲳鱼（银鲳鱼）［平鱼］：银鲳为经典鲳鱼（排除刺鲳）" },
  枸杞头: { code: "048079", why: "枸杞菜（鲜）［枸杞，地骨］" },
  羊油: { code: "191005", why: "羊油（炼）：库内为熬制油（排除生板油）" },
};

/** 强制 ambiguous：多品种/多口径混用，消歧不了 → 用类目缺省，不硬配 */
const AMBIGUOUS_FORCE = new Map([
  ["虾", "河虾/海虾/对虾/明虾多品种混用，成分表无「虾（代表值）」条目"],
  ["蟹", "河蟹/梭子蟹/海蟹混用"],
  ["贝", "蛤/蛏/蚶/蚌/扇贝多品种"],
  ["鱼肉", "泛指净鱼肉，多鱼种"],
  ["瓜子仁", "葵花子仁/西瓜子仁两系（词表别名兼有）"],
  ["豆芽", "绿豆芽/黄豆芽两用"],
]);

/** 算法候选里要拒绝的错配（id → Set(foodCode)） */
const REJECT = {
  排骨: new Set(["081322"]), // 酱排骨是成品菜，不是生猪排 → 落类目缺省
  青梅: new Set(["062203"]), // 梅［青梅］是鲜梅；库内青梅为糖渍果料 → 走蜜饯兜底
  山楂糕: new Set(["061301"]), // 红果（鲜山楂）≠ 山楂糕 → 走果糕兜底
  黄花菜: new Set(["045412"]), // 金针菜（鲜）34.9 为鲜蕾值；库内黄花菜为干制品泡发口径 → 落菌菇类缺省
  小茴香: new Set(["045322"]), // 茴香（鲜）［小茴香］是茴香菜（蔬菜）；库内小茴香为香料 → 落调味缺省
  豆豉: new Set(["121407"]), // 鲮鱼（豆豉，熟）括注撞名，是鱼制品 → 落调味缺省
  菜干: new Set(["031511"]), // 豆腐干（菜干）为豆制品；库内菜干为干芥菜 → 落蔬菜缺省
  枸杞: new Set(["048079"]), // 枸杞菜（鲜）是菜；库内枸杞为枸杞子（干） → 走审计兜底 64.1
};

/**
 * 参考数据没有、按外部依据兜底碳水值的条目（§1.4：审计手抄值仅作兜底，不作冲突裁决）。
 * 值全部注明来源；0.3.1 换成分表全量版时应替换为参考条目。
 */
const FALLBACK_CARB = {
  金桔饼: { c: 78.0, why: "参考无此条；取审计 §0.3 手抄值（糖渍金桔饼）" },
  冬瓜糖: { c: 82.0, why: "参考无此条；取审计 §0.3 手抄值" },
  枸杞: { c: 64.1, why: "参考无枸杞子条目（只有枸杞菜/叶）；取审计 §0.3 手抄值" },
  蜜饯: { c: 75.0, why: "参考无蜜饯类；取审计 §0.3 区间 70–80.6 中值" },
  青梅: { c: 70.0, why: "参考无糖渍梅条目；词表别名均为糖渍（蜜饯青梅/糖青梅），按蜜饯口径 70" },
  山楂糕: { c: 65.0, why: "参考无山楂糕；按果糕类估（山楂+蔗糖），留 0.3.1 校准" },
  糕点: { c: 55.0, why: "参考无糕点条目；取审计 §7 复现脚本 PFC 值" },
  面包: { c: 58.6, why: "参考无面包条目；取审计 §7 复现脚本 PFC 值" },
  百合粉: { c: 85.0, why: "参考无百合粉；淀粉类制品，按淀粉 85 口径" },
  虾片: { c: 80.0, why: "参考无龙虾片；油炸淀粉制品，按淀粉口径 80" },
  枣泥: { c: 60.0, why: "参考无枣泥；甜馅类（近豆沙 57/蜜枣口径），估 60" },
  糯米粉: { c: 78.0, why: "参考无糯米粉；按糯米 78.3 口径" },
  // 零卡/近零卡：防止「其他」类目缺省（median 11.8）误加到水和辅料上
  水: { c: 0, why: "水，零卡" },
  非食材辅料: { c: 0, why: "包装/炊具类辅料，零卡" },
  卤水: { c: 0, why: "卤水（盐水），零卡" },
  茶叶: { c: 0, why: "茶叶少量入菜，不计热量" },
  木炭: { c: 0, why: "燃料，非食材" },
  玻璃纸: { c: 0, why: "包装，非食材" },
  糯米纸: { c: 0, why: "微量包装纸" },
  马莲草: { c: 0, why: "捆扎用草" },
};

/** P1min 纯糖名单（§1.6）：蛋白/脂肪归零，碳水 ≈99（参考数据 61 类不含食糖，统一 99.0 并注明） */
const PURE_SUGARS = ["冰糖", "白糖", "红糖", "饴糖", "蜂蜜", "糖色", "糖桂花"];

/** 类目 0 匹配或规则性归零时的手定碳水缺省 */
const CATEGORY_FALLBACK = {
  调味: { c: 0, why: "纯糖已单列 override；剩余调味（盐醋酱油酒香料味精）参考数据无调味品类条目且用量小，取 0（每菜影响 ≲10 kcal）" },
  汤底: { c: 0.2, why: "参考无高汤条目；取审计 §0.3 高汤手抄值" },
  其他: { c: 0, why: "成员为水/茶叶/辅料等近零卡项" },
};

/* ───────────────────────── 匹配与消歧 ───────────────────────── */

const SPECIES = "猪牛羊鸡鸭鹅";
const FRESH_FORM = /鲜|生/;
const DRY_FORM = /干/;
const SOAK_FORM = /水浸|水发/;
const COOKED_FORM = /熟|煮|炒|烤|炸|烧|熏|卤|蒸|扒|酱/;
const JUNK = /罐头|牌|速溶|方便|脱水|强化|配方|婴儿|幼儿|中老年|孕产妇|奶粉|保健/;

function formRank(e, driedFirst) {
  const raw = e.raw;
  if (/代表值|均值/.test(raw)) return 0;
  if (e.plain) return 1;
  if (JUNK.test(raw)) return 9;
  if (COOKED_FORM.test(raw)) return 6;
  if (SOAK_FORM.test(raw)) return driedFirst ? 4 : 2;
  if (DRY_FORM.test(raw)) return driedFirst ? 2 : 4;
  if (FRESH_FORM.test(raw)) return driedFirst ? 4 : 2;
  return 3; // 描述性括注（白皮、红，小 等），居中
}

/** 同分并列：主名完全相同的重复条目（书内常见）取 foodCode 靠前者；主名不同 → ambiguous */
function codeOrder(a, b) {
  const ka = a.replace(/x$/, "");
  const kb = b.replace(/x$/, "");
  return ka === kb ? (a.endsWith("x") ? -1 : b.endsWith("x") ? 1 : 0) : ka < kb ? -1 : 1;
}

function disambiguate(cands, canon, driedFirst) {
  if (cands.length === 1) return { pick: cands[0], how: "唯一候选" };
  const scored = cands.map((e) => {
    let s = (10 - formRank(e, driedFirst)) * 10;
    if (/代表值|均值/.test(e.raw)) s += 200;
    if (e.plain) s += 120;
    if (!/（/.test(e.raw)) s += 60; // 仅带［别名］括注的也视作裸名（如 带鱼［白带鱼、刀鱼］）
    const sp = SPECIES.includes(canon.id[0]);
    if (sp && SPECIES.includes(e.main[0]) && e.main[0] === canon.id[0]) s += 60;
    return { e, s };
  });
  scored.sort((a, b) => b.s - a.s || codeOrder(a.e.code, b.e.code));
  const top = scored.filter((x) => x.s === scored[0].s);
  if (top.length > 1) {
    if (top.every((x) => x.e.main === top[0].e.main)) {
      // 同名重复条目：书内主条目在前（foodCode 靠前），其余为地区/亚种复核值
      const pick = [...top].sort((a, b) => codeOrder(a.e.code, b.e.code))[0].e;
      return { pick, how: `同名重复条目取 foodCode 靠前者（${top.length} 条）` };
    }
    return { pick: null, how: "并列", tie: top.map((x) => x.e) };
  }
  return { pick: scored[0].e, how: `多候选择优（${scored.length} 选 1）` };
}

/* ───────────────────────── 主流程 ───────────────────────── */

// W7b：p/f 校准开关。默认（不带参数）保持 v0.3 的 p/f 冻结口径，产物与历史版本一致。
const CALIBRATE = process.argv.includes("--calibrate");

/** 参考数据的可食部% → 库内口径（0/越界/缺失一律视为「无数据」→ enrich 端按 100） */
const edibleOf = (e) => {
  const v = e?.edible;
  return Number.isFinite(v) && v > 0 && v <= 100 ? Math.round(v) : null;
};

const ref = loadRef();
const byCode = new Map(ref.entries.map((e) => [e.code, e]));

// 库内使用频次（unmatched 排序用）
const freq = new Map();
const recs = readFileSync(path.join(ROOT, "data", "recipes.processed.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));
for (const r of recs)
  for (const i of r.ingredients ?? []) {
    const x = freq.get(i.canon) ?? { rows: 0, grams: 0 };
    x.rows++;
    x.grams += i.grams ?? 0;
    freq.set(i.canon, x);
  }

// 18 个 NUTRI_PARENT 类目（从 ingredients.mjs 源码取键序，保证与现表一致）
const src = readFileSync(path.join(ROOT, "src", "ingredients.mjs"), "utf8");
const npBlock = src.match(/const NUTRI_PARENT = \{([\s\S]*?)\};/)[1];
const CATS = [...npBlock.matchAll(/([^{}:\s,]+):\s*\[/g)].map((m) => m[1]);

const overrides = new Map(); // id -> {v:[p,f,c], edible?, ref, note}
const frozen = [];           // p/f 冻结例外（默认模式）
const calibrated = [];       // W7b 校准采纳清单（--calibrate 模式）
const ambiguous = [];        // {id, reason, cands}
const unmatched = [];        // {id, reason}

for (const e of CANON) {
  const cur = nutrition(e, 100); // 现值（NUTRI_OVERRIDE > NUTRI_PARENT），每100g

  // P1min 纯糖：先看参考数据有没有（当前 61 类无食糖），没有用 99.0
  if (PURE_SUGARS.includes(e.id)) {
    const hit = ref.index.get(e.id)?.filter((x) => x.c != null) ?? [];
    if (hit.length === 1) {
      overrides.set(e.id, { v: [0, 0, hit[0].c], ref: `${hit[0].cat} ${hit[0].code} ${hit[0].raw}`, note: "纯糖（P1min）：p/f 归零" });
    } else {
      overrides.set(e.id, { v: [0, 0, 99.0], ref: "无参考条目（61 类不含食糖）", note: "纯糖（P1min）：p/f 归零；碳水按 ≈99 缺省" });
    }
    continue;
  }

  if (AMBIGUOUS_FORCE.has(e.id)) {
    ambiguous.push({ id: e.id, reason: AMBIGUOUS_FORCE.get(e.id), cands: [] });
    continue;
  }

  // 候选收集
  let cands = [];
  let how = "";
  const cur_ = CURATED[e.id];
  if (cur_) {
    const pick = byCode.get(cur_.code);
    if (!pick) throw new Error(`curated ${e.id} -> ${cur_.code} 不存在`);
    cands = [pick];
    how = `curated：${cur_.why}`;
  } else {
    const raw = (ref.index.get(e.id) ?? []).filter((x) => !REJECT[e.id]?.has(x.code));
    cands = raw;
  }
  const usable = cands.filter((x) => x.c != null);
  if (!usable.length) {
    const fb = FALLBACK_CARB[e.id];
    if (fb) {
      overrides.set(e.id, { v: [cur.protein, cur.fat, fb.c], ref: "无参考条目", note: `碳水兜底：${fb.why}` });
    } else {
      unmatched.push({ id: e.id, reason: cands.length ? "候选碳水值缺失（—）" : "参考数据无此条目" });
    }
    continue;
  }
  const driedFirst = e.cat === "干货";
  const { pick, how: how2, tie } = disambiguate(usable, e, driedFirst);
  if (!pick) {
    ambiguous.push({ id: e.id, reason: `${tie.length} 个候选并列无法消歧`, cands: tie.map((x) => `${x.code} ${x.raw}`) });
    continue;
  }

  // v 的碳水列一律取参考值；蛋白/脂肪两列：默认冻结现值（v0.3 §1.2），--calibrate 时改用参考值
  const v = CALIBRATE
    ? [
        pick.p == null ? cur.protein : Math.round(pick.p * 10) / 10,
        pick.f == null ? cur.fat : Math.round(pick.f * 10) / 10,
        Math.round(pick.c * 10) / 10,
      ]
    : [cur.protein, cur.fat, Math.round(pick.c * 10) / 10];
  const note = [];
  if (how) note.push(how);
  if (how2 && how2 !== "唯一候选" && !how) note.push(how2);
  if (CALIBRATE) {
    const missing = [pick.p == null, pick.f == null].filter(Boolean).length;
    note.push(`W7b 校准：p/f 采用参考值${missing ? `（${missing} 列缺失，沿用现值）` : ""}`);
  }
  const dp = pick.p == null ? null : Math.round((pick.p - cur.protein) * 10) / 10;
  const df = pick.f == null ? null : Math.round((pick.f - cur.fat) * 10) / 10;
  if ((dp != null && Math.abs(dp) > 0.1) || (df != null && Math.abs(df) > 0.1)) {
    if (!CALIBRATE) note.push(`p/f 沿用现值（参考 ${pick.p ?? "—"} / ${pick.f ?? "—"}）`);
    (CALIBRATE ? calibrated : frozen).push({
      id: e.id,
      cur: [cur.protein, cur.fat],
      ref: [pick.p, pick.f],
      rows: freq.get(e.id)?.rows ?? 0,
      grams: Math.round(freq.get(e.id)?.grams ?? 0),
      code: pick.code,
    });
  }
  const ed = edibleOf(pick);
  overrides.set(e.id, {
    v,
    ...(ed != null ? { edible: ed } : {}),
    ref: `${pick.cat} ${pick.code} ${pick.raw}`,
    note: note.join("；"),
  });
}

/* ───────────────────────── 类目缺省值 ───────────────────────── */

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

const categories = new Map();
for (const cat of CATS) {
  const members = CANON.filter((x) => x.parent === cat);
  const matched = members.filter(
    (x) =>
      overrides.has(x.id) &&
      !PURE_SUGARS.includes(x.id) &&
      !FALLBACK_CARB[x.id] &&
      !(overrides.get(x.id).note || "").includes("无参考条目")
  );
  let carbs = matched.map((x) => overrides.get(x.id).v[2]);
  if (cat === "调味") {
    // 淀粉类（carb≥50）已各自 override，不参与调味类中位数
    carbs = carbs.filter((c) => c < 50);
  }
  const cur = nutrition({ id: "§none§", parent: cat }, 100);
  let carb, basis;
  const med = median(carbs);
  if (med == null) {
    const fb = CATEGORY_FALLBACK[cat] ?? { c: 0, why: "无匹配成员，保守取 0" };
    carb = fb.c;
    basis = `matched 0/${members.length}；${fb.why}`;
  } else {
    carb = med;
    basis = `matched ${matched.length}/${members.length}, median ${med}` + (cat === "调味" ? "（纯糖与淀粉类 override 已排除）" : "");
  }
  categories.set(cat, { v: [cur.protein, cur.fat, carb], basis });
}

/* ───────────────────────── 湿淀粉影响面（只统计，不改数据） ───────────────────────── */

const starchCarb = overrides.get("淀粉")?.v[2] ?? 85;
let wetRows = 0;
let wetGrams = 0;
let wetFull = 0;
const wetRecipes = new Set();
for (const r of recs)
  for (const i of r.ingredients ?? []) {
    if (i.canon !== "淀粉") continue;
    if (!/湿淀粉|水淀粉/.test(i.raw ?? "")) continue;
    wetRecipes.add(r.id);
    wetRows++;
    wetGrams += i.grams ?? 0;
    wetFull += ((i.grams ?? 0) * starchCarb * 4) / 100;
  }
const wetDiscounted = wetFull * 0.35;
const wetStarch = {
  entries: wetRows,
  recipes: wetRecipes.size,
  totalGrams: Math.round(wetGrams),
  fullKcal: Math.round(wetFull),
  at035Kcal: Math.round(wetDiscounted),
  estKcalImpact: Math.round(wetFull - wetDiscounted),
};

/* ───────────────────────── 对账：审计 §0.3 手抄表 ───────────────────────── */

/** [canonId, 审计条目名, p, f, c] —— 来源 review-0.3/nutrition-audit.md §0.3（仅用于比对/兜底） */
const AUDIT = [
  ["莲子", "莲子（干）", 17.2, 2.0, 64.2],
  ["糯米", "糯米", 7.3, 1.0, 77.6],
  ["冰糖", "冰糖", 0, 0, 99.3],
  ["白糖", "白糖", 0, 0, 99.9],
  ["猪油", "猪油", 0, 99.6, 0],
  ["板油", "板油", 2.7, 88.7, 0],
  ["腊肉", "腊肉", 11.8, 48.8, 2.9],
  ["火腿", "火腿", 16.4, 27.4, 0],
  ["鸡肉", "鸡肉（均值）", 19.3, 9.4, 1.3],
  ["鲤鱼", "鲤鱼", 17.6, 4.1, 0.5],
  ["鳙鱼", "鳙鱼（胖头鱼）", 15.3, 2.2, 4.7],
  ["高汤", "高汤", 0.5, 0.5, 0.2],
  ["红枣", "红枣（干）", 3.2, 0.5, 67.8],
  ["桂圆肉", "桂圆肉", 5.0, 0.2, 71.5],
  ["金桔饼", "金桔饼", 0.6, 0.3, 78.0],
  ["蜜枣", "蜜饯/蜜枣", 1.3, 0.4, 80.6],
  ["蜜饯", "蜜饯", 0.8, 0.4, 70.0],
  ["冬瓜糖", "冬瓜糖", 0.2, 0.1, 82.0],
  ["葡萄干", "葡萄干", 2.5, 0.4, 83.4],
  ["淀粉", "淀粉（干）", 1.5, 0.2, 85.0],
  ["栗子", "栗子", 4.2, 0.7, 42.2],
  ["花生米", "花生米（生）", 24.8, 44.3, 21.7],
  ["枸杞", "枸杞", 13.9, 1.5, 64.1],
];
const UNRESOLVED = new Set(["蜜枣"]); // 识别差异嫌疑，留人工

const cross = [];
for (const [id, aname, ap, af, ac] of AUDIT) {
  const ov = overrides.get(id);
  const cat = CANON.find((x) => x.id === id)?.parent;
  const myP = ov ? ov.v[0] : categories.get(cat)?.v[0];
  const myF = ov ? ov.v[1] : categories.get(cat)?.v[1];
  const myC = ov ? ov.v[2] : categories.get(cat)?.v[2];
  const src = ov ? ov.ref : `类目缺省（${cat}）`;
  const d = Math.round((myC - ac) * 10) / 10;
  const adopted = /无参考条目/.test(ov?.ref ?? "") || /兜底/.test(ov?.note ?? "") || (!ov && cat === "汤底");
  let verdict;
  if (PURE_SUGARS.includes(id) && Math.abs(d) <= 1.0) verdict = "一致（纯糖缺省 99.0）";
  else if (id === "蜜饯" && myC >= 70 && myC <= 80.6) verdict = "一致（取审计区间 70–80.6 中值）";
  else if (Math.abs(d) <= 0.5) verdict = adopted ? "一致（值取自审计）" : "一致";
  else if (UNRESOLVED.has(id)) verdict = "unresolved";
  else verdict = "不一致→以参考数据为准";
  cross.push({ id, aname, audit: [ap, af, ac], mine: [myP, myF, myC], src, d, verdict, adopted });
}
const crossAgree = cross.filter((x) => x.verdict.startsWith("一致")).length;
const crossDisagree = cross.filter((x) => x.verdict === "不一致→以参考数据为准").length;
const crossUnresolved = cross.filter((x) => x.verdict === "unresolved").length;

/* ───────────────────────── 六样本预演（A 口径速算，验收由 verify-agent 出正式表） ───────────────────────── */

const SIX = [
  ["湖南-153", "冰糖湘莲", [620, 760]],
  ["湖南-164", "八宝果饭", [680, 830]],
  ["湖南-163", "干煎果饭", [1280, 1570]],
  ["湖南-013", "腊味合蒸", [530, 650]],
  ["湖南-103", "五元全鸡", [380, 465]],
  ["湖南-063", "拆烩鳙鱼头", [270, 330]],
];
const canonById = new Map(CANON.map((e) => [e.id, e]));
const carbOfIng = (i) => {
  const o = overrides.get(i.canon);
  if (o) return o.v[2];
  const cat = categories.get(canonById.get(i.canon)?.parent ?? i.parent);
  return cat ? cat.v[2] : 0;
};
const sixRows = SIX.map(([id, name, band]) => {
  const r = recs.find((x) => x.id === id);
  const C = (r.ingredients ?? []).reduce((s, i) => s + ((i.grams ?? 0) * carbOfIng(i)) / 100, 0);
  const a = Math.round(r.nutrition.kcal + 4 * C);
  return { id, name, stored: r.nutrition.kcal, a, per: Math.round(a / r.servingsBase), carb: Math.round(C * 10) / 10, band, in: a / r.servingsBase >= band[0] && a / r.servingsBase <= band[1] };
});

/* ───────────────────────── 生成 src/nutrition-ref.mjs ───────────────────────── */

const matchedCount = [...overrides.keys()].filter(
  (k) => !PURE_SUGARS.includes(k) && !FALLBACK_CARB[k] && !/无参考条目/.test(overrides.get(k).ref)
).length;
const pureSugarCount = PURE_SUGARS.length;
const withEdible = [...overrides.values()].filter((o) => o.edible != null);
const meta = {
  source: "《中国食物成分表》标准版第6版（Sanotsu/china-food-composition-data fixed_en 2026-08-25 双模型交叉+人工矫正版）",
  generatedAt: new Date().toISOString(),
  canonTotal: CANON.length,
  matched: matchedCount,
  pureSugar: pureSugarCount,
  ambiguous: ambiguous.length,
  unmatched: CANON.length - matchedCount - pureSugarCount - ambiguous.length,
  pfSource: CALIBRATE ? "参考值（W7b --calibrate，p/f 解冻）" : "现值冻结（v0.3 §1.2）",
  edible: {
    filled: withEdible.length,
    below100: withEdible.filter((o) => o.edible < 100).length,
    note: "可食部%（W7a 回填）；未回填条目（ambiguous/兜底/纯糖）enrich 端按 100",
  },
  calibrate: CALIBRATE
    ? { enabled: true, adopted: calibrated.length, keptAmbiguous: AMBIGUOUS_FORCE.size, keptAmbiguousIds: [...AMBIGUOUS_FORCE.keys()] }
    : { enabled: false },
  crossCheck: { agree: crossAgree, disagree: crossDisagree, unresolved: crossUnresolved },
  wetStarch,
};

const fmtV = (v) => `[${v.map((x) => (Number.isInteger(x) ? x : Math.round(x * 10) / 10)).join(", ")}]`;
const ovLines = [];
for (const e of CANON) {
  const o = overrides.get(e.id);
  if (!o) continue;
  const parts = [`v: ${fmtV(o.v)}`, `ref: ${JSON.stringify(o.ref)}`];
  if (o.edible != null) parts.push(`edible: ${o.edible}`);
  if (o.note) parts.push(`note: ${JSON.stringify(o.note)}`);
  ovLines.push(`  ${JSON.stringify(e.id)}: { ${parts.join(", ")} },`);
}
const catLines = [...categories.entries()].map(
  ([k, x]) => `  ${JSON.stringify(k)}: { v: ${fmtV(x.v)}, basis: ${JSON.stringify(x.basis)} },`
);
const mjs = `// Generated by tools/nutrition-import.mjs — 手改会被下次导入覆盖
// 来源：《中国食物成分表》标准版第6版（Sanotsu/china-food-composition-data fixed_en，2026-08-25 双模型交叉+人工矫正版）
// v = 每 100g [protein, fat, carb]。p/f 规则（IMPORT_META.pfSource 记本次模式）：
//   默认：与现 NUTRI_OVERRIDE/NUTRI_PARENT 等值（v0.3 §1.2 冻结，容差 0.1），例外记 note；
//   --calibrate（W7b）：p/f 采用参考值（歧义名/纯糖/无参考条目仍保持现值，见 note）。
// edible = 可食部%（W7a 回填，参考数据按 foodCode 取）；未给 edible 的条目消费端按 100 处理，
//   enrich.mjs 营养累计按 grams × edible/100 折算，配料原文克数不动。
export const REF_OVERRIDES = {
${ovLines.join("\n")}
};
export const REF_CATEGORIES = {
${catLines.join("\n")}
};
export const IMPORT_META = ${JSON.stringify(meta, null, 2)};
`;
writeFileSync(OUT_MJS, mjs, "utf8");

/* ───────────────────────── 生成报告 ───────────────────────── */

const pct = ((matchedCount / CANON.length) * 100).toFixed(1);
const unmatchedRows = unmatched
  .map((u) => ({ ...u, rows: freq.get(u.id)?.rows ?? 0, grams: Math.round(freq.get(u.id)?.grams ?? 0) }))
  .sort((a, b) => b.rows - a.rows || b.grams - a.grams);
const frozenRows = frozen.sort((a, b) => b.rows - a.rows || b.grams - a.grams);
const calibratedRows = calibrated.sort((a, b) => b.rows - a.rows || b.grams - a.grams);
const edibleRows = [...overrides.entries()]
  .filter(([, o]) => o.edible != null && o.edible < 100)
  .map(([id, o]) => ({ id, edible: o.edible, rows: freq.get(id)?.rows ?? 0, grams: Math.round(freq.get(id)?.grams ?? 0) }))
  .sort((a, b) => b.rows - a.rows || b.grams - a.grams);

const fmt1 = (x) => (x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(1));

let report = `# 营养参考数据导入报告（data-agent，v0.3）

> 生成：\`tools/nutrition-import.mjs${CALIBRATE ? " --calibrate" : ""}\`（幂等可重跑）· ${meta.generatedAt}
> 参考：《中国食物成分表》标准版第6版结构化数据（${ref.files} 类 ${ref.entries.length} 条）。
> 口径：成分值为每 100g **可食部**；0.5 W7 起可食部随 REF_OVERRIDES.edible 回填，enrich 端营养累计按 grams × edible/100 折算（配料原文克数不动，见 §4.5）。

## 1. 结果速览

| 指标 | 值 |
|---|---|
| CANON 词表总数 | ${meta.canonTotal} |
| 参考数据匹配成功（REF_OVERRIDES） | **${matchedCount}**（${pct}%） |
| 纯糖（P1min，p/f 归零 + carb 99.0） | ${pureSugarCount}（${PURE_SUGARS.join("、")}；参考数据 61 类不含食糖，碳水按 ≈99 缺省） |
| ambiguous（不硬配，走类目缺省） | ${ambiguous.length} |
| unmatched（参考无此条，走类目缺省） | ${meta.unmatched} |
| 对账（审计 §0.3，${cross.length} 项） | 一致 ${crossAgree} / 不一致 ${crossDisagree} / unresolved ${crossUnresolved} |
| p/f 口径（IMPORT_META.pfSource） | ${CALIBRATE ? `**W7b 校准：采用参考值**（采纳 ${calibrated.length} 条，见 §4）；歧义名 ${ambiguous.length} 个保持现值` : `冻结现值，例外 ${frozen.length} 条（见 §4）`} |
| 可食部回填（W7a，IMPORT_META.edible） | REF_OVERRIDES ${withEdible.length} 条带 \`edible\`，其中 <100 的 **${meta.edible.below100}** 条（enrich 端营养累计按 grams × edible/100 折算） |
| 湿淀粉影响面 | ${wetStarch.entries} 条原料 / ${wetStarch.recipes} 道菜；×0.35 折算后少计 **${wetStarch.estKcalImpact.toLocaleString("en-US")} kcal**（见 §6） |

## 2. 匹配规则

1. **精确**：CANON 名 == foodName 主名（去（）［］括注后）。
2. **括注段匹配**：foodName 的（部位）/［别名］分段 == CANON 名（如 里脊→猪肉（里脊）、板油→猪油（板油）、芋艿→芋头［芋艿、毛芋］、桂鱼→鳜鱼［桂鱼…］）。
3. **消歧优先级**：代表值/均值 > 无括注裸名 > 品种一致（猪牛羊鸡鸭鹅首字）> 形态（干货类目干>鲜，其余鲜>干；熟/罐头/品牌靠后）> foodCode 靠前。并列不破 → ambiguous。
4. **curated 表**：${Object.keys(CURATED).length} 条显式挑选（脚本内注释理由，如 火腿→金华火腿、淀粉→团粉［芡粉］、香菇→鲜值因原文 459/595 条为水发）。
5. **纯糖**（§1.6）与**审计兜底**（${Object.keys(FALLBACK_CARB).length} 条，参考无条目：${Object.keys(FALLBACK_CARB).join("、")}）单独处理，note 注明来源。

### ambiguous 清单（${ambiguous.length}）

| CANON | 原因 | 候选 |
|---|---|---|
${ambiguous.map((a) => `| ${a.id} | ${a.reason} | ${(a.cands.length ? a.cands : ["—（无单一对应条目）"]).map((c) => c.replace(/\|/g, "/")).join("；")} |`).join("\n")}

这些条目 p/f 走现值（NUTRI_OVERRIDE/NUTRI_PARENT）、carb 走 REF_CATEGORIES 类目缺省。

### unmatched 清单（${meta.unmatched}，按库内出现频次降序，高频缺失优先处理）

| CANON | 原料行数 | 累计克数 | 原因 |
|---|---|---|---|
${unmatchedRows.map((u) => `| ${u.id} | ${u.rows} | ${u.grams} | ${u.reason} |`).join("\n")}

> 未匹配条的碳水影响评估：调味类（酱油/醋/绍酒/味精等，参考数据无调味品类）合计高频但用量小，按类目 0 计，单菜影响约 ≤10–15 kcal（绍酒 5.1g/100g 为其中最大项）；糕点面包类已按审计兜底；药材/水/辅料近零卡。剩余为小众食材，风险低。

## 3. 类目缺省值（REF_CATEGORIES，p/f = 现类目值冻结）

| 类目 | v = [p, f, carb] | basis |
|---|---|---|
${[...categories.entries()].map(([k, x]) => `| ${k} | ${fmtV(x.v)} | ${x.basis} |`).join("\n")}

- 调味类：纯糖 7 条已各自 override（[0,0,99]），淀粉（85.8）自带 override；剩余调味无参考条目、用量小，类目取 0（说明见 §7 风险 5）。
- 汤底/其他：无匹配成员，手定小值（高汤 0.2 取审计 §0.3；水/辅料 0）。

## 4. p/f 口径（${CALIBRATE ? `W7b 校准模式：采纳参考值 ${calibrated.length} 条` : `冻结现值，例外 ${frozen.length} 条`}）

${
  CALIBRATE
    ? `W7b（ITERATION-0.5）解冻 p/f：下表 |参考−现值| > 0.1 的条目本次**改用参考值**（note 标「W7b 校准」）。
影响最大的是腊肉（f 20 → 48.8）与猪瘦肉/里脊（f 20 → 参考 6–8）——荤菜脂肪口径的系统性偏差由此收敛，腊味/卤腊类菜 kcal 上移是预期方向。

| CANON | 原料行数 | 原 p/f | 参考值 p/f（foodCode，已采纳） |
|---|---|---|---|
${calibratedRows.map((x) => `| ${x.id} | ${x.rows} | ${fmtV(x.cur)} | ${fmtV(x.ref)}（${x.code}） |`).join("\n")}

保持现值（不校准）的三类：**歧义名 ${ambiguous.length} 个**（${[...AMBIGUOUS_FORCE.keys()].join("、")}——品种/口径混用，参考值配不上，p/f 走 NUTRI_OVERRIDE 现值）、**纯糖 7 条**（p/f 归零是 P1min 裁决，非数据冲突）、**审计兜底条目**（参考无条目，无参考值可采）。类目缺省 REF_CATEGORIES 的 p/f 仍冻结现值——类目值是兜底口径，不随单条校准动。`
    : `### 冻结例外清单（${frozen.length} 条，|参考−现值| > 0.1，导入沿用现值，留 0.3.1）

| CANON | 原料行数 | 现 p/f | 参考 p/f（foodCode） |
|---|---|---|---|
${frozenRows.map((x) => `| ${x.id} | ${x.rows} | ${fmtV(x.cur)} | ${fmtV(x.ref)}（${x.code}） |`).join("\n")}

> 裁决（§1.2）：v0.3 只补碳水，p/f 冻结。上表差异全部沿用现值——其中影响最大的是腊肉（f 20 vs 参考 48.8）与猪瘦肉/里脊（f 20 vs 参考 6–8）：荤菜脂肪口径的系统性偏差是既有问题，与本次碳水修复方向相反部分抵消，统一留 0.3.1 处理（0.5 W7b 以 \`--calibrate\` 落地）。`
}

## 4.5 可食部回填（W7a，${edibleRows.length} 条 <100）

成分表数值是每 100g **可食部**，库内克数常是整只/带骨毛重。enrich 端营养累计按 grams × edible/100 折算；
**配料行 grams、份量、主料排序、采购口径一律不动**（原文克数不改）。未回填条目（ambiguous/兜底/纯糖）按 100。

| CANON | edible % | 原料行数 | 累计克数 |
|---|---|---|---|
${edibleRows.map((x) => `| ${x.id} | ${x.edible} | ${x.rows} | ${x.grams} |`).join("\n")}

## 5. 对账：审计 §0.3 手抄成分表（${cross.length} 项）

| 条目 | 审计 [p,f,c] | 导入 [p,f,c] | Δcarb | 裁决 |
|---|---|---|---|---|
${cross.map((x) => `| ${x.id}（${x.aname}） | ${fmtV(x.audit)} | ${fmtV(x.mine)} | ${x.d > 0 ? "+" : ""}${x.d} | ${x.verdict}${x.adopted ? "；来源 " + x.src : ""} |`).join("\n")}

**分歧裁决说明**（裁决倾向：以参考数据为准，它是书的结构化版）：

- **莲子 ${cross.find((x) => x.id === "莲子").d > 0 ? "+" : ""}${cross.find((x) => x.id === "莲子").d}**：参考 072009 莲子（干）CHO 67.2，审计 64.2（旧版/常用值口径）。以参考为准 → 冰糖湘莲碳水略升（+3.0g/100g）。无识别错误嫌疑。
- **桂圆肉 +2.0**：参考 065008 桂圆肉 73.5（065007 桂圆（干）64.8、065021 桂圆（干）76.2，条目间本身差 10+）。审计 71.5 介于其间。以参考「桂圆肉」专名条目为准。
- **蜜枣 +3.8 → unresolved**：参考 062310 为「蜜枣［椰枣］」（dates，果干），而书中蜜枣是糖渍枣制品——**条目识别存疑**，审计区间 70–80.6 更贴合制品口径，但差值 <5%。暂按参考 84.4 导入，标 unresolved 留 0.3.1 人工定夺（或改挂 蜜饯 75 口径）。
- **淀粉 +0.8 / 糯米 +0.7 / 火腿 +0.1 / 鸡肉 −0.4**：条目选择差异（团粉 85.8 vs 审计"淀粉 85.0"；糯米［江米］78.3 vs 77.6），量级无害，以参考为准。
- **板油 +7.2**：参考 191006 猪油（板油）为生鲜板油（含糖原 7.2），审计按纯脂记 0。以参考为准；影响小（板油用量通常 ≤150g/道，且 p/f 冻结在 [0,99]）。
- **白糖 −0.9 / 冰糖 −0.3**：参考数据无食糖类，导入值是 P1min 缺省 99.0，非数据冲突；与审计（99.9/99.3）差 <1%，接受缺省口径。
- **蜜饯 +5.0**：审计给的是区间 70–80.6，导入取中值 75，落在区间内（参考无蜜饯类条目）。
- 一致项中 ${cross.filter((x) => x.adopted).length} 条（金桔饼/冬瓜糖/枸杞/蜜饯/高汤等）的导入值本身取自审计（参考无条目，见 §2.5 兜底），属"来源一致"而非独立交叉验证，已在上表注明。

## 6. 湿淀粉影响面（只统计，不改数据；code-agent 按 ×0.35 折算）

| 指标 | 值 |
|---|---|
| 原文含「湿淀粉/水淀粉」的原料行 | **${wetStarch.entries}** 条（水淀粉 ${recs.reduce((s, r) => s + (r.ingredients ?? []).filter((i) => i.canon === "淀粉" && /水淀粉/.test(i.raw ?? "")).length, 0)} 条） |
| 波及菜数 | ${wetStarch.recipes} 道 |
| 涉及克数合计 | ${wetStarch.totalGrams.toLocaleString("en-US")} g |
| 按干淀粉全量计碳水热量（carb=${starchCarb}） | ${wetStarch.fullKcal.toLocaleString("en-US")} kcal |
| ×0.35 折算后 | ${wetStarch.at035Kcal.toLocaleString("en-US")} kcal |
| **差异（estKcalImpact）** | **${wetStarch.estKcalImpact.toLocaleString("en-US")} kcal**（中位约 ${Math.round(wetStarch.estKcalImpact / Math.max(wetStarch.recipes, 1))} kcal/菜） |

与审计 §5-E2 的 1373 道/9.2 万 kcal 同量级（差异来自统计口径：审计按原文两计 38,505g、本表按解析后克数 ${wetStarch.totalGrams.toLocaleString("en-US")}g 与导入 carb ${starchCarb}）。

## 6.5 六样本预演（用导入表速算，验收正式表由 verify-agent 出）

口径：库 kcal + 4×Σ(克数×carb)/100，每人 = ÷servingsBase。**不含**湿淀粉 ×0.35、P1 纯糖蛋白清零等 code-agent 实现细节，仅为导入数据的 sanity 预演。

| 菜 | 库 kcal | +4C | 碳水 g | 每人 kcal | §5 区间 | 判定 |
|---|---|---|---|---|---|---|
${sixRows.map((x) => `| ${x.name} | ${x.stored} | ${x.a} | ${x.carb} | **${x.per}** | ${x.band[0]}–${x.band[1]} | ${x.in ? "✓ 区间内" : "✗ 超区间"} |`).join("\n")}

${sixRows.every((x) => x.in) ? "六个样本全部落在 §5 验收区间内。" : "存在超区间样本，须书面解释（见 ITERATION-0.3.md §5）。"}

## 7. 已知风险与边界（README 营养口径段应引用）

1. **参考数据本身是 LLM 识图产物**（fixed_en 为双模型交叉+人工矫正版）：个别条目仍有字段噪声（"—"/错行风险），导入值已按 foodCode 可追溯，异常可回查原始 JSON。
2. **可食部只对匹配到的条目生效**（0.5 W7a 已把 \`edible\` 回填进 REF_OVERRIDES，enrich 按 grams × edible/100 折算）：ambiguous/兜底/纯糖条目没有参考条目、无从取可食部，仍按 100——带骨且未匹配的料（少量野味/干货）仍偏高；此外份量/主料排序等采购口径仍按毛重，**是故意的**（买整只鸡就该按整只算份量）。
3. **「约耗」油量**（0.5 W6 已字段化）：parse 记 \`consumedGrams\`，enrich 对油脂行按约耗值全额计脂、不再打 15% 附着折扣；无约耗的油保持整锅 ×15% 口径。采购侧（planner）仍按整锅 ×0.3 估——买油本来就要按整锅买。非油料行（酱油/面粉/卤水等 25 行）的「约耗」未入字段，留 0.5.1。
4. **水发/干口径**：木耳/香菇/海参/鱿鱼/海带按泡发后克数取（水发/浸/鲜）条目，依据是原文「水发」出现占比（92/120、459/595、62/72、21/39）；若个别菜按干料计量则低估。银耳/黄花菜仍按干（或未匹配）。
5. **调味类碳水取 0**（ITERATION-0.3.md §1.6 裁决「酱油/酱/醋/盐等调味不动」）：酱油（≈10g/100g）/醋（≈5）/绍酒（≈5）/甜面酱（≈25）/豆瓣酱（≈16）按 0 计，库级合计少计约 5 万 kcal（占全库总热量 ≈1%），单菜 ≲15 kcal；纯糖已单列故甜菜不受影响。0.3.1 若引入调味品成分数据可整体补上。
6. **纯糖碳水用缺省 99.0**（参考数据 61 类不含食糖/调味品），冰糖实际 ≈99.3、白糖 ≈99.9，误差 <1%。
7. **酒精热量未计**（绍酒/白酒），醉糟类略低估。
8. **无克数原料计 0**（1077 条，审计 §5-E3），本表所有统计是下限口径。

## 8. 复跑与校验

- 重跑：\`node tools/nutrition-import.mjs --calibrate\`（0.5 W7 起的口径：edible 回填 + p/f 校准；不带参数则回到 v0.3 冻结口径。覆写 \`src/nutrition-ref.mjs\` 与本报告；不碰 data/）。
- 导入产物校验：\`node -e "import('./src/nutrition-ref.mjs').then(m => console.log(m.REF_OVERRIDES['莲子'], m.REF_CATEGORIES['蔬菜']))"\`。
- 消费方（code-agent）：nutrition() 取值优先级 REF_OVERRIDES > NUTRI_OVERRIDE > REF_CATEGORIES > NUTRI_PARENT（§4 契约）。
`;
writeFileSync(OUT_REPORT, report, "utf8");

/* ───────────────────────── stdout 摘要 ───────────────────────── */

console.log(`CANON ${meta.canonTotal} | matched ${matchedCount} (${pct}%) | pureSugar ${pureSugarCount} | ambiguous ${ambiguous.length} | unmatched ${meta.unmatched}`);
console.log(`p/f mode: ${meta.pfSource}${CALIBRATE ? ` | adopted ${calibrated.length} | keptAmbiguous ${AMBIGUOUS_FORCE.size}` : ` | frozen exceptions ${frozen.length}`}`);
console.log(`edible(W7a): filled ${meta.edible.filled} / below100 ${meta.edible.below100}`);
console.log(`crossCheck: agree ${crossAgree} / disagree ${crossDisagree} / unresolved ${crossUnresolved}`);
console.log(`wetStarch: ${wetStarch.entries} rows / ${wetStarch.recipes} recipes / impact ${wetStarch.estKcalImpact} kcal`);
console.log(`written: ${path.relative(ROOT, OUT_MJS)} (${(mjs.length / 1024).toFixed(1)} KB), ${path.relative(ROOT, OUT_REPORT)}`);
