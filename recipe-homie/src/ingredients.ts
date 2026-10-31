/**
 * 原料归一 + 单位换算 + 营养估算。
 *
 * 三步走：
 *   1. 原名 → 标准名（lexicon 里的 aliases，加上「去形态词/修饰词」的规则兜底）
 *   2. 分量文本 → 克 / 个数（市制换算，拿不准就留空，绝不猜）
 *   3. 标准名 + 克数 → 蛋白质/脂肪/碳水粗估（优先成分表导入值，缺省按类目，个别覆盖）
 */
import { CANON, type LexEntry } from "./lexicon.ts";
import { REF_OVERRIDES, REF_CATEGORIES } from "./nutrition-ref.ts";

const byAlias = new Map<string, LexEntry>();
const byId = new Map<string, LexEntry>();
for (const e of CANON) {
  byId.set(e.id, e);
  byAlias.set(e.id, e);
  for (const a of e.aliases ?? []) byAlias.set(a.replace(/\s+/g, ""), e);
}

export const LEXICON_STATS: { canon: number; aliases: number } = { canon: CANON.length, aliases: byAlias.size };

const QUAL = /^(熟|生|鲜|干|水发|水浸|浸发|发制|净|瘦|肥|嫩|老|土|大|小|细|粗|上|好|精|纯|淡|白|红|青|黄|黑|绿|金|银|去骨|带皮|去皮|无皮|整|新|陈|特|水|鲜制|自制)/;
const FORM = /(末|片|丝|块|粒|条|段|结|汁|泥|茸|丁|碎|米|花|皮|骨|汤)$/;

function cleanName(raw: unknown): string {
  return String(raw ?? "")
    .replace(/\$\s*\\textcircled\{[^}]*\}\s*\$/g, "")
    .replace(/\$[^$]*\$/g, "")
    .replace(/〔[^〕]*〕/g, "")
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[*＊]/g, "")
    .replace(/\s+/g, "")
    .replace(/^[料、：:，。]+/, "")
    .trim();
}

/**
 * 原名 → 标准条目。找不到时按后缀给一个合理归类，保证不漏（宁可能粗，不可丢）。
 */
export function lookup(raw: unknown): LexEntry | null {
  const name = cleanName(raw);
  if (!name) return null;
  const direct = byAlias.get(name);
  if (direct) return direct;

  // 逐层剥形态词/修饰词，最多三轮
  let s = name;
  for (let i = 0; i < 3; i++) {
    const t = s.replace(FORM, "");
    if (t === s) break;
    s = t;
    const hit = byAlias.get(s);
    if (hit) return hit;
  }
  s = name;
  for (let i = 0; i < 3; i++) {
    const t = s.replace(QUAL, "");
    if (t === s) break;
    s = t;
    const hit = byAlias.get(s);
    if (hit) return hit;
  }

  // 兜底：按后缀判断大类（新鱼种、新菜名都能落进采购分区）
  const guess = (parent: string, cat: string, allergen: string[], unit = "g"): LexEntry => ({
    id: name, parent, cat, unit, allergen, aliases: [], guessed: true,
  });
  if (/鱼/.test(name)) return guess("水产", "水产", ["鱼类"]);
  if (/虾/.test(name)) return guess("水产", "水产", ["甲壳类"]);
  if (/蟹/.test(name)) return guess("水产", "水产", ["甲壳类"]);
  if (/贝|蛤|蛏|螺|蚶/.test(name)) return guess("水产", "水产", ["贝类"]);
  if (/菇|菌|耳|蘑/.test(name)) return guess("菌菇", "菌菇", []);
  if (/菜|苗|笋|瓜|豆|薯|芋|藕|萝卜|茄|椒|葱|蒜|姜/.test(name)) return guess("蔬菜", "蔬菜", []);
  if (/肉|肚|肝|腰|肠|蹄|排骨|骨/.test(name)) return guess("猪肉", "肉禽", []);
  if (/鸡/.test(name)) return guess("禽肉", "肉禽", []);
  if (/鸭|鹅|鸽/.test(name)) return guess("禽肉", "肉禽", []);
  if (/蛋/.test(name)) return guess("蛋", "蛋奶", ["蛋类"]);
  if (/奶|酪|油$/.test(name)) return guess("乳", "蛋奶", ["乳"]);
  if (/粉|面|米|饭|团/.test(name)) return guess("谷物", "粮油", []);
  if (/汤/.test(name)) return guess("汤底", "其他", []);
  if (/酱|醋|酒|糖|盐|精|椒|香|桂|茴|姜末/.test(name)) return guess("调味", "调味", []);
  return guess("其他", "其他", []);
}

const UNIT_G: Record<string, number> = { 千克: 1000, 公斤: 1000, 克: 1, 斤: 500, 两: 50, 钱: 5, 分: 0.5 };
const COUNT_UNITS = new Set(["只", "条", "个", "片", "块", "根", "棵", "朵", "束", "张", "对", "碗", "杯", "汤匙", "匙", "把", "头", "支"]);
const NUM_CN: Record<string, number> = { 零: 0, 〇: 0, O: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cnNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  let num = 0;
  let tmp = 0;
  for (const ch of s) {
    if (ch === "百") { num += (tmp || 1) * 100; tmp = 0; }
    else if (ch === "十") { num += (tmp || 1) * 10; tmp = 0; }
    else if (NUM_CN[ch] !== undefined) { tmp = NUM_CN[ch] ?? 0; }
  }
  return num + tmp;
}

const QUALIFIERS = ["适量", "少许", "少量", "酌量", "随意", "若干", "视需要", "按需要", "适量（约", "一点"];

/** 分量解析结果（grams/count 拿不准就是 null，绝不编） */
export type ParsedAmount = {
  grams: number | null;
  count: number | null;
  unit?: string | null;
  qualifier: string | null;
};

/**
 * 分量文本 → { grams, count, unit, qualifier }
 * 「一斤半」「一两五钱」「二斤（约耗二两）」「一条（约重一斤半）」「一个（四斤）」「适量」都能处理。
 */
export function parseAmount(amountText: unknown, entry: LexEntry | null): ParsedAmount {
  const text = String(amountText ?? "").replace(/\s+/g, "");
  if (!text) return { grams: null, count: null, qualifier: null };

  for (const q of QUALIFIERS) {
    if (text.includes(q)) return { grams: null, count: null, qualifier: q };
  }

  // 「约重一斤半」优先当作真实重量（鱼、蹄膀这类按只卖的）
  const approx = text.match(/约重([^）)]+)/);
  const paren = approx ? null : text.match(/[（(]([^）)]*)[）)]/);
  const body = approx ? approx[1] ?? "" : text.replace(/[（(][^）)]*[）)]/g, "");

  let grams = 0;
  let count = 0;
  let sawMass = false;
  let sawCount = false;
  let lastUnit: string | null = null;
  let lastWasMass = false;

  // 「两」在这里只是单位，不是数字——数字字符类不含「两」。否则「二两三钱」会被贪婪吞成
  // 数字「二两三」+单位「钱」，cnNumber 取尾字得 3 → 15g（应 100+15=115g，E3 实测病灶）。
  // 单独当数字用的「两斤/两钱」（=2斤/2钱）由独立分支「两」处理（此时「两」后跟别的单位）。
  // 外层小数（W2 P3）：主表只认「d.d」形态的单小数（「2.5斤」→1250，南北 5 行实测），
  // 且前后都不能再贴数字——「446.2钱」这种 OCR 压行噪声（南北-558「芽菜 446.\n2钱」）
  // 不能被当成 446.2 钱折成 2.2kg，落回尾段「2钱」的既有口径。
  const re = /(半|两|(?<!\d)\d\.\d(?!\d)|[0-9]+|[零〇一二三四五六七八九十百]+)(千克|公斤|克|斤|两|钱|分|只|条|个|片|块|根|棵|朵|束|张|对|碗|杯|汤匙|匙|把)/g;
  for (const m of body.matchAll(re)) {
    const tok = m[1] ?? "";
    const unit = m[2] ?? "";
    // 「三、四朵」这种区间取第一个数；小数 token 直接 Number（cnNumber 只认汉字/整数）
    const n = tok === "半" ? 0.5 : /^\d+(?:\.\d+)?$/.test(tok) ? Number(tok) : cnNumber(tok);
    if (!Number.isFinite(n)) continue;
    if (unit in UNIT_G) {
      grams += n * (UNIT_G[unit] ?? 0);
      sawMass = true;
      lastUnit = unit;
      lastWasMass = true;
    } else if (COUNT_UNITS.has(unit)) {
      count += n;
      sawCount = true;
      lastUnit = unit;
      lastWasMass = false;
      if (entry?.unitGrams) grams += n * entry.unitGrams;
    }
  }

  // 「一斤半」「一两五钱」的尾巴
  if (/半$/.test(body) && lastUnit && !/半[^,，]*$/.test(body.match(re)?.at(-1)?.[0] ?? "")) {
    if (lastWasMass) grams += 0.5 * (UNIT_G[lastUnit] ?? 0);
    else if (entry?.unitGrams) grams += 0.5 * entry.unitGrams;
  }

  // 「一个（四斤）」「一只（二钱）」「1付（重2斤）」「二尾（约一斤半）」：个数后面的括号净重
  // 按括号里的质量折（半角/全角括号都认），覆盖按个计数的 unitGrams 默认单重。
  // 「（约耗二两）」是附着口径、「（每个二两）」是单个口径，都不能当整条净重（耗/每/各/共 排除）。
  // 外层已有质量（如「二斤（约耗…）」剥离后剩二斤）时不启用。
  if (paren && !sawMass && !/[耗每各共]/.test(paren[1] ?? "")) {
    // 括号里允许阿拉伯小数（「约3.5斤」）和「约一斤半」的半尾巴，主表没有这两个形态
    const reP = /(半|两|[0-9]+(?:\.[0-9]+)?|[零〇一二三四五六七八九十百]+)(千克|公斤|克|斤|两|钱|分|只|条|个|片|块|根|棵|朵|束|张|对|碗|杯|汤匙|匙|把)/g;
    let pg = 0;
    let pm = false;
    let pc = false;
    let pLastUnit: string | null = null;
    for (const m of (paren[1] ?? "").matchAll(reP)) {
      const tok = m[1] ?? "";
      const unit = m[2] ?? "";
      const n = tok === "半" ? 0.5 : /^\d/.test(tok) ? Number(tok) : cnNumber(tok);
      if (!Number.isFinite(n)) continue;
      if (unit in UNIT_G) { pg += n * (UNIT_G[unit] ?? 0); pm = true; pLastUnit = unit; }
      else pc = true;
    }
    if (pm && !pc) {
      if (/半$/.test(paren[1] ?? "") && pLastUnit) pg += 0.5 * (UNIT_G[pLastUnit] ?? 0);
      grams = pg;          // 覆盖（不叠加）外层个数折出的默认单重
      sawMass = true;
    }
  }

  // 纯个数且不知道单重：克数留空，别编；知道单重（鸡蛋 50g）就折进去
  const knownCountGrams = sawCount && Boolean(entry?.unitGrams);
  const outGrams = sawMass || knownCountGrams ? Math.round(grams * 10) / 10 : null;
  return {
    grams: outGrams,
    count: sawCount ? count : null,
    unit: lastUnit,
    qualifier: null,
  };
}

/**
 * 营养：每 100g 的 [蛋白质, 脂肪, 碳水]，按类目默认，个别覆盖。
 * 蛋白/脂肪两列自 v0.2 冻结不动；碳水列在本表里一律是 0 占位——真实值来自
 * nutrition-ref.mjs（《中国食物成分表》标准版第6版导入表），取值优先级：
 *   REF_OVERRIDES[名] > NUTRI_OVERRIDE[名] > REF_CATEGORIES[类目] > NUTRI_PARENT[类目]
 * 即：导入表逐条值最优先；其次历史手抄覆盖；再导入表的类目值；最后本表兜底。
 * 只有前三级都没给到碳水的条目才吃到本表第三列（= 0，同 v0.2 口径，不会更差）。
 */
const NUTRI_PARENT: Record<string, number[]> = {
  猪肉: [17, 20, 0], 牛肉: [20, 8, 0], 羊肉: [19, 10, 0], 禽肉: [20, 10, 0], 蛋: [13, 11, 0],
  水产: [17, 4, 0], 蔬菜: [1.5, 0.2, 0], 菌菇: [2.5, 0.3, 0], 豆制品: [12, 6, 0], 谷物: [8, 2, 0],
  乳: [3.2, 3, 0], 油脂: [0, 99, 0], 调味: [2, 1, 0], 干货: [15, 2, 0], 坚果: [20, 50, 0],
  水果: [1, 0.2, 0], 汤底: [2, 2, 0], 其他: [1, 1, 0],
};
const NUTRI_OVERRIDE: Record<string, number[]> = {
  五花肉: [14, 30, 0], 肥膘: [3, 88, 0], 板油: [0, 99, 0], 猪皮: [22, 3, 0], 火腿: [16, 28, 0],
  蛋清: [11, 0, 0], 蛋黄: [16, 32, 0], 豆腐: [8, 4, 0], 豆腐干: [16, 8, 0], 腐竹: [45, 22, 0],
  面筋: [25, 1, 0], 花生米: [26, 45, 0], 核桃仁: [15, 60, 0], 莲子: [17, 2, 0], 淀粉: [0.5, 0, 0],
  面粉: [10, 1.5, 0], 大米: [7, 0.8, 0], 糯米: [7, 1, 0], 猪蹄膀: [16, 22, 0], 猪蹄: [17, 18, 0],
  牛肉: [20, 8, 0], 鸡胸: [24, 2, 0], 鸡肉: [20, 10, 0], 虾: [18, 1, 0], 蟹: [16, 2, 0],
  // 蔬菜里蛋白质突出的
  毛豆: [13, 5, 0], 蚕豆: [9, 0.7, 0], 豌豆: [7, 0.3, 0],
};

// nutrition-ref 的行是 { v: [蛋白,脂肪,碳水], ref, note }（导入契约 §3）；本表两级是裸数组。
// 统一取行、容忍缺第三列（缺碳水按 0，见优先级注释）。
const refRow = (x: any): any => (Array.isArray(x) ? x : x?.v);
const withCarb = (row: any): [number, number, number] => [row?.[0] ?? 0, row?.[1] ?? 0, row?.[2] ?? 0];

export function nutrition(entry: any, grams: number): { protein: number; fat: number; carb: number } {
  if (!entry || !grams) return { protein: 0, fat: 0, carb: 0 };
  const [p, f, c] = withCarb(
    refRow(REF_OVERRIDES[entry.id])
      ?? NUTRI_OVERRIDE[entry.id]
      ?? refRow(REF_CATEGORIES[entry.parent])
      ?? NUTRI_PARENT[entry.parent]
      ?? NUTRI_PARENT.其他,
  );
  return { protein: (grams * p) / 100, fat: (grams * f) / 100, carb: (grams * c) / 100 };
}

/** 过敏原：条目自身标签 + 上位类兜底 */
export function allergensOf(entry: any): string[] {
  if (!entry) return [];
  return entry.allergen ?? [];
}
