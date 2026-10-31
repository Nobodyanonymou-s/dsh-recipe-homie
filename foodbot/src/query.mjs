/**
 * 检索层：结构化筛选（食材/菜系/类别/技法/口味）+ 标题/特点的关键词打分。
 * 只依赖 data/recipes.jsonl 与本地词表，不依赖任何第三方库，因此小程序/HTTP 端以后可以原样复用。
 *
 * v0.2 追加的四个接口（给工具「说人话」用，见 ITERATION-0.2-INTERFACE.md §2）：
 *   searchWithTotal()  与 search() 同套筛选/打分，但不截断，额外给 total
 *   analyzeQuery()     q → 词表锚点 / 技法 / 字面命中 / 扩展词
 *   neighbors()        零命中时的确定性近邻（字面优先，其次锚点，没有就 []，不凑数）
 *   facetsOf()         从数据派生的分册/类别/技法清单（hint 的「覆盖范围」）
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { lookup } from "./ingredients.mjs";
import { CANON } from "./lexicon.mjs";

const ALIAS = new Map([
  ["五花肉", ["猪五花", "肋条肉", "方肉"]],
  ["猪肉", ["猪瘦肉", "猪肥膘", "里脊", "肉末"]],
  ["土豆", ["马铃薯", "洋山芋"]],
  ["番茄", ["西红柿"]],
  ["青椒", ["柿子椒", "甜椒"]],
  ["鸡", ["仔鸡", "母鸡", "光鸡", "鸡脯", "鸡腿"]],
  ["葱", ["葱结", "葱段", "葱花", "青葱"]],
  ["姜", ["姜片", "姜末", "姜丝", "老姜"]],
  ["鸡蛋", ["蛋清", "蛋黄", "鸡蛋清"]],
]);

/** 检索键归一：去括号、去修饰前缀、去标点。 */
export function normIngredient(text) {
  return String(text ?? "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/^(宰净|水发|水浸|浸发|熟|生|鲜|干|活|带皮|去皮|嫩|老|净)/, "")
    .replace(/[\s，、。*＊]/g, "")
    .trim();
}

// 单字变体的「全称后缀」校验（0.4.1 裁决 11）：单字「鸡」只认 鸡/鸡肉/鸡丁 这类
// 「字本身 或 字+部位/刀工后缀」的形态，不再用双向 includes 把 鸡蛋/蛋清 吃进来。
const SINGLE_CHAR_SUFFIX = new Set([..."肉丁丝片块条爪翅血肝肫架头皮骨油末"]);

/** 变体与食材键的匹配。多字变体沿用双向 includes；单字变体收窄（见上）。 */
function variantHitsKey(key, v) {
  if (v.length === 1) {
    if (key === v) return true;
    return key.length === 2 && key[0] === v && SINGLE_CHAR_SUFFIX.has(key[1]);
  }
  return key.includes(v) || v.includes(key);
}

function expandQuery(name) {
  const key = normIngredient(name);
  const out = new Set([key]);
  for (const [k, list] of ALIAS) {
    if (!(key.includes(k) || k.includes(key))) continue;
    for (const v of list) out.add(v);
    // 单字主名（鸡/葱/姜）只在查询本身就是它时才进变体集合：
    // 「鸡肉」曾把「鸡」带进来，再经双向 includes 命中 鸡蛋/蛋清（E1 Q2 污染根因）
    if (k.length >= 2 || k === key) out.add(k);
  }
  return [...out].filter(Boolean);
}

const STOP = new Set(["的", "了", "和", "与", "把", "将", "用", "在", "上", "中", "后", "时", "成", "至", "约", "一", "二", "三"]);

/** 中文按 bigram 切，够用且不用词典。 */
function bigrams(text) {
  const clean = String(text ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "");
  const grams = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const g = clean.slice(i, i + 2);
    if (!STOP.has(g)) grams.push(g);
  }
  if (clean.length === 1) grams.push(clean);
  return grams;
}

/** 代码点比较：所有「排序稳定」的地方用它，不依赖 locale。 */
const cmpText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** 清掉标点/空白，只留中文、英文、数字：q 进词表或做子串匹配前先过一遍。 */
function cleanQuery(text) {
  return String(text ?? "").replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, "");
}

// ───────────────────────── 词表索引（q 的锚点抽取） ─────────────────────────
// 和 ingredients.mjs 的 byAlias 同一套优先级：先 id 再别名，后者覆盖前者。
const TERM_ENTRY = new Map();
for (const e of CANON) {
  TERM_ENTRY.set(e.id, e);
  for (const a of e.aliases ?? []) {
    const term = String(a).replace(/\s+/g, "");
    if (term) TERM_ENTRY.set(term, e);
  }
}
// 长词优先：同一位置能匹配「清蒸」就不该只匹配「蒸」
const VOCAB_TERMS = [...TERM_ENTRY.keys()].sort((a, b) => b.length - a.length || cmpText(a, b));
const VOCAB_BY_FIRST = new Map();
for (const term of VOCAB_TERMS) {
  const head = term[0];
  if (!VOCAB_BY_FIRST.has(head)) VOCAB_BY_FIRST.set(head, []);
  VOCAB_BY_FIRST.get(head).push(term);
}

/**
 * q 里按最长匹配抽词表条目，返回 canon id（去重、按出现顺序）。
 * 词表里的条目都是真实收词，所以这里抽出来的 id 天然不是 lookup() 兜底猜的（guessed）。
 */
function matchVocabulary(text) {
  const out = [];
  const seen = new Set();
  let i = 0;
  while (i < text.length) {
    const cands = VOCAB_BY_FIRST.get(text[i]);
    let hit = null;
    if (cands) {
      for (const term of cands) {
        if (text.startsWith(term, i)) { hit = term; break; }
      }
    }
    if (hit) {
      const id = TERM_ENTRY.get(hit).id;
      if (!seen.has(id)) { seen.add(id); out.push(id); }
      i += hit.length;
    } else {
      i += 1;
    }
  }
  return out;
}

/** 一条菜谱在标题/食材名/特点里是否含这段字面。 */
function literalFields(r, needle) {
  return {
    title: (r.title ?? "").includes(needle),
    ingredient: (r.ingredients ?? []).some((i) => (i.name || i.key || "").includes(needle)),
    features: (r.features ?? "").includes(needle),
  };
}

/** 字面命中打分：菜名 > 食材名 > 特点。 */
function literalScore(r, needle) {
  const f = literalFields(r, needle);
  return (f.title ? 6 : 0) + (f.ingredient ? 4 : 0) + (f.features ? 2 : 0);
}

/** 近邻统一排序/截断：分数降序、id 升序，保证同输入同输出。 */
function topNeighbors(list, cap) {
  list.sort((a, b) => b.score - a.score || cmpText(a.r.id, b.r.id));
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.r.id)) continue;
    seen.add(item.r.id);
    out.push({ id: item.r.id, title: item.r.title, reason: item.reason });
    if (out.length >= cap) break;
  }
  return out;
}

export class RecipeBook {
  /** @param {string} dataDir 含 recipes.jsonl（或 recipes.processed.jsonl）的目录 */
  constructor(dataDir) {
    const processed = join(dataDir, "recipes.processed.jsonl");
    const base = join(dataDir, "recipes.jsonl");
    if (!existsSync(base) && !existsSync(processed)) throw new Error(`找不到 ${base}，先跑 npm run build`);
    // 有集成产物就用它（包含补全、修复、新分册、变体关系）；两条都取一下，靠 mtime 挑新的
    const candidates = [processed, base].filter(existsSync).map((p) => ({ p, m: statSync(p).mtimeMs }));
    candidates.sort((a, b) => b.m - a.m);
    this.file = candidates[0].p;
    this.load();
  }

  /** 重建库/集成后不必重启宿主：下次查询发现文件变了（或出现更新的产物）就整体重载。 */
  ensureFresh() {
    const dir = dirname(this.file);
    const newest = [join(dir, "recipes.processed.jsonl"), join(dir, "recipes.jsonl")]
      .filter(existsSync)
      .map((p) => ({ p, m: statSync(p).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return;
    if (newest.p !== this.file || newest.m !== this.mtime) {
      this.file = newest.p;
      this.load();
    }
  }

  load() {
    this.mtime = statSync(this.file).mtimeMs;
    this.recipes = readFileSync(this.file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    this.byId = new Map(this.recipes.map((r) => [r.id, r]));

    // BM25 语料：标题 + 特点 + 食材名
    this.docs = this.recipes.map((r) => {
      const text = `${r.title} ${r.features ?? ""} ${r.ingredients.map((i) => i.key).join(" ")}`;
      const tf = new Map();
      for (const g of bigrams(text)) tf.set(g, (tf.get(g) ?? 0) + 1);
      return { id: r.id, len: [...tf.values()].reduce((a, b) => a + b, 0), tf };
    });
    this.docById = new Map(this.docs.map((d) => [d.id, d]));
    this.df = new Map();
    for (const d of this.docs) for (const g of d.tf.keys()) this.df.set(g, (this.df.get(g) ?? 0) + 1);
    this.avgLen = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1);

    // 技法词表从数据派生（43 个）：analyzeQuery 抽技法、facetsOf 出清单都用它
    this.methodWords = [...new Set(this.recipes.flatMap((r) => r.methods ?? []))]
      .sort((a, b) => b.length - a.length || cmpText(a, b));
  }

  bm25(query, k1 = 1.2, b = 0.75) {
    const grams = bigrams(query);
    const N = this.docs.length;
    const scores = new Map();
    for (const g of grams) {
      const df = this.df.get(g) ?? 0;
      if (!df) continue;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const d of this.docs) {
        const f = d.tf.get(g) ?? 0;
        if (!f) continue;
        const denom = f + k1 * (1 - b + (b * d.len) / (this.avgLen || 1));
        scores.set(d.id, (scores.get(d.id) ?? 0) + idf * ((f * (k1 + 1)) / denom));
      }
    }
    return scores;
  }

  /**
   * q 的检索分数：bigram/BM25 打底，词表锚点加分，bigram 一条都不中时退化到单字/子串匹配。
   * 返回 Map<recipeId, score>；一个都没有时返回空 Map（调用方据此走「没有命中」分支）。
   */
  _textScores(q) {
    const scores = this.bm25(q);
    const analysis = this.analyzeQuery(q);
    const bigramHit = scores.size > 0;

    // 词表一条腿：q 里认出来的食材，按归一后的 canon 命中（异名在 build 时已收敛到 canon）
    if (analysis.ingredients.length) {
      const wanted = new Set(analysis.ingredients);
      for (const r of this.recipes) {
        let n = 0;
        for (const ing of r.ingredients ?? []) if (ing.canon && wanted.has(ing.canon)) n++;
        if (n) scores.set(r.id, (scores.get(r.id) ?? 0) + 2 + Math.min(n, 3));
      }
    }

    // 另一条腿：bigram 命中 0（单字查询、词表外的写法）→ 退化到单字/子串匹配，和词表锚点叠加
    if (!bigramHit) {
      const needle = cleanQuery(q);
      if (needle) {
        for (const r of this.recipes) {
          const s = literalScore(r, needle);
          if (s) scores.set(r.id, (scores.get(r.id) ?? 0) + s);
        }
      }
    }
    return scores;
  }

  /**
   * 全量命中（不按 limit 截断），search() / searchWithTotal() 共用同一套筛选与打分。
   * @param {{ingredients?:string[], cuisine?:string, chapter?:string, method?:string, flavor?:string, q?:string, match?:'all'|'any', skillTier?:string, minProtein?:number, maxKcal?:number}} query
   */
  _hits(query = {}) {
    this.ensureFresh();
    const {
      ingredients = [],
      cuisine, chapter, method, flavor, q,
      match = "all",
      skillTier, minProtein, maxKcal,
    } = query;

    const wanted = ingredients.map(expandQuery);
    const textScores = q ? this._textScores(q) : null;

    const hits = [];
    for (const r of this.recipes) {
      if (cuisine && r.cuisine !== cuisine) continue;
      if (chapter && !(r.chapter ?? "").includes(chapter)) continue;
      if (method && !r.methods.some((m) => m.includes(method) || method.includes(m))) continue;
      if (flavor && !r.flavors.some((f) => f.includes(flavor) || flavor.includes(f))) continue;
      if (skillTier && r.skill?.tier !== skillTier) continue;
      if (minProtein != null && (r.perServing?.proteinGrams ?? 0) < Number(minProtein)) continue;
      if (maxKcal != null && (r.perServing?.kcal ?? 0) > Number(maxKcal)) continue;

      let ingScore = 0;
      let matched = 0;
      if (wanted.length) {
        for (const variants of wanted) {
          const hit = r.ingredients.some((ing) => {
            const key = normIngredient(ing.key || ing.name);
            if (!key) return false;
            return variants.some((v) => v && variantHitsKey(key, v));
          });
          if (hit) { matched++; ingScore += 3; }
        }
        if (match === "all" && matched < wanted.length) continue;
        if (match === "any" && matched === 0) continue;
        ingScore += (matched / wanted.length) * 2;
      }

      const textScore = textScores?.get(r.id) ?? 0;
      if (textScores && textScore === 0 && q) {
        // 关键词完全没命中时，只在没有其他条件的情况下才保留（避免空结果）
        if (!wanted.length && !cuisine && !chapter && !method && !flavor) continue;
      }
      if (!wanted.length && !cuisine && !chapter && !method && !flavor && !q) ingScore = 0;

      hits.push({ recipe: r, score: ingScore + textScore });
    }

    hits.sort((a, b) => b.score - a.score || a.recipe.id.localeCompare(b.recipe.id));
    return hits;
  }

  /**
   * @param {{ingredients?:string[], cuisine?:string, chapter?:string, method?:string, flavor?:string, q?:string, limit?:number, match?:'all'|'any', skillTier?:string, minProtein?:number, maxKcal?:number}} query
   */
  search(query = {}) {
    const { limit = 8 } = query;
    return this._hits(query).slice(0, Math.max(1, Math.min(50, limit)));
  }

  /**
   * 与 search() 同套筛选/打分，但**不截断**（limit 参数被忽略）：调用方自己按 limit 取前 N 条。
   * total = 截断前的命中数，也就是 hits.length，方便算「被画像挡掉多少」。
   * @returns {{hits: Array<{recipe: object, score: number}>, total: number}}
   */
  searchWithTotal(query = {}) {
    const hits = this._hits(query);
    return { hits, total: hits.length };
  }

  /**
   * 把 q 拆成人能用的检索线索。
   * @param {string} q
   * @returns {{ingredients: string[], methods: string[], literal: boolean, expanded: string[]}}
   *   ingredients: q 里对上的库里 CANON id（lookup() 兜底猜的 guessed 条目不算锚点，佛跳墙就是这种）
   *   methods:     q 里对上的技法词（从数据派生的 43 个）
   *   literal:     标题/特点/食材名里有没有 q 的子串（单字也算）
   *   expanded:    词表扩展出的检索词（q=肉/鱼/鸡/汤 这类单字靠它）
   */
  analyzeQuery(q) {
    this.ensureFresh();
    const text = cleanQuery(q);

    const ingredients = [];
    const seen = new Set();
    for (const id of matchVocabulary(text)) {
      if (!seen.has(id)) { seen.add(id); ingredients.push(id); }
    }
    // 整串 lookup 兜一层：带修饰/形态词的写法（水发海参、黄鱼肚）也能落到 canon
    const whole = lookup(text);
    if (whole && whole.guessed !== true && !seen.has(whole.id)) {
      seen.add(whole.id);
      ingredients.push(whole.id);
    }

    return {
      ingredients,
      methods: this._matchMethods(text),
      literal: this._hasLiteral(text),
      expanded: this._expanded(text, ingredients),
    };
  }

  /** q 里按最长匹配抽技法（-长词优先，避免「清蒸」被拆成「清」+「蒸」）。 */
  _matchMethods(text) {
    const out = [];
    const seen = new Set();
    let i = 0;
    while (i < text.length) {
      let hit = null;
      for (const m of this.methodWords) {
        if (text.startsWith(m, i)) { hit = m; break; }
      }
      if (hit) {
        if (!seen.has(hit)) { seen.add(hit); out.push(hit); }
        i += hit.length;
      } else {
        i += 1;
      }
    }
    return out;
  }

  _hasLiteral(text) {
    if (!text) return false;
    for (const r of this.recipes) {
      const f = literalFields(r, text);
      if (f.title || f.ingredient || f.features) return true;
    }
    return false;
  }

  /** 词表扩展词：有锚点给锚点+异名；没锚点就找「含 q 的词表条目」（单字查询靠这条腿）。 */
  _expanded(text, ingredients) {
    const out = [];
    const seen = new Set();
    const push = (t) => {
      const v = String(t ?? "").replace(/\s+/g, "");
      if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    };

    if (ingredients.length) {
      for (const id of ingredients) {
        const entry = TERM_ENTRY.get(id);
        push(id);
        for (const alias of entry?.aliases ?? []) push(alias);
      }
      return out;
    }

    if (!text) return out;
    // 只取「标准名本身含这段字」的条目，避免「汤」扩到「水」这种把全库都带进来的噪声
    const ids = CANON
      .filter((e) => e.id.includes(text))
      .map((e) => e.id)
      .sort(cmpText)
      .slice(0, 24);
    for (const id of ids) push(id);
    return out;
  }

  /**
   * 零命中时的近邻：纯函数（无随机、无时钟），同输入同输出。
   * 字面近邻（菜名/食材名/特点 子串 + bigram 相似度）优先；字面 0 才用锚点（食材按 canon、技法按 methods）。
   * 都没有就是 []——不为了凑数编近邻。
   * @param {string} q
   * @param {{limit?:number, cuisine?:string, chapter?:string, method?:string}} [opts]
   * @returns {Array<{id:string, title:string, reason:string}>}
   */
  neighbors(q, { limit = 5, cuisine, chapter, method } = {}) {
    this.ensureFresh();
    const cap = Math.max(1, Math.min(50, Math.floor(Number(limit)) || 5));
    const needle = cleanQuery(q);
    if (!needle) return [];

    const pool = this.recipes.filter((r) => {
      if (cuisine && r.cuisine !== cuisine) return false;
      if (chapter && !(r.chapter ?? "").includes(chapter)) return false;
      if (method && !(r.methods ?? []).some((m) => m.includes(method) || method.includes(m))) return false;
      return true;
    });

    // 1) 字面近邻：子串命中，其次 bigram 相似度（同名字/近似名）
    const qGrams = new Set(bigrams(needle));
    const literal = [];
    for (const r of pool) {
      const f = literalFields(r, needle);
      let score = 0;
      let reason = null;
      if (f.title) { score += 6; reason = `同名关键词『${needle}』`; }
      if (f.ingredient) { score += 4; reason = reason ?? `同名关键词『${needle}』`; }
      if (f.features) { score += 2; reason = reason ?? `同名关键词『${needle}』`; }
      if (!score && qGrams.size) {
        const doc = this.docById.get(r.id);
        let overlap = 0;
        if (doc) for (const g of qGrams) if (doc.tf.has(g)) overlap++;
        if (overlap && overlap >= Math.ceil(qGrams.size * 0.6)) {
          score = overlap;
          reason = `近似关键词『${needle}』`;
        }
      }
      if (score) literal.push({ r, score, reason });
    }
    if (literal.length) return topNeighbors(literal, cap);

    // 2) 锚点近邻：食材按 canon、技法按 methods
    const analysis = this.analyzeQuery(needle);
    const anchored = [];
    if (analysis.ingredients.length) {
      const wanted = new Set(analysis.ingredients);
      for (const r of pool) {
        const hit = (r.ingredients ?? []).map((i) => i.canon).filter((c) => c && wanted.has(c));
        if (hit.length) anchored.push({ r, score: 3 * hit.length, reason: `同食材『${hit[0]}』` });
      }
    }
    if (!anchored.length && analysis.methods.length) {
      const wanted = new Set(analysis.methods);
      for (const r of pool) {
        const hit = (r.methods ?? []).find((m) => wanted.has(m));
        if (hit) anchored.push({ r, score: 2, reason: `同技法『${hit}』` });
      }
    }
    return topNeighbors(anchored, cap);
  }

  /** 从数据派生的可用维度（去重、代码点排序，结果稳定）：hint 的「覆盖范围」用它，不硬编码分册名。 */
  facetsOf() {
    this.ensureFresh();
    return {
      cuisines: [...new Set(this.recipes.map((r) => r.cuisine).filter(Boolean))].sort(cmpText),
      chapters: [...new Set(this.recipes.map((r) => r.chapter).filter(Boolean))].sort(cmpText),
      methods: [...new Set(this.recipes.flatMap((r) => r.methods ?? []))].sort(cmpText),
    };
  }

  get(id) {
    this.ensureFresh();
    return this.byId.get(id) ?? null;
  }

  /**
   * 按菜名取菜。批量配方（bulk）与疑似串行（suspectTitle）排到最后：
   * 61kg 的无锡排骨不该再当第一结果（0.4.1 裁决 2，E3 S-F）。
   * 只有 bulk 版可用时仍返回它（数据不藏，只是不领路）。
   */
  findTitle(title) {
    this.ensureFresh();
    const t = String(title ?? "").replace(/\s+/g, "");
    const presentable = (r) => !r.bulk && !r.suspectTitle;
    return this.recipes.find((r) => r.title === t && presentable(r))
      ?? this.recipes.find((r) => r.title.includes(t) && presentable(r))
      ?? this.recipes.find((r) => r.title === t)
      ?? this.recipes.find((r) => r.title.includes(t));
  }

  stats() {
    return {
      recipes: this.recipes.length,
      books: [...new Set(this.recipes.map((r) => r.book))],
      cuisines: [...new Set(this.recipes.map((r) => r.cuisine))],
      withPage: this.recipes.filter((r) => r.page).length,
    };
  }
}
