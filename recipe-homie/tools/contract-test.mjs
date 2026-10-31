/**
 * v0.2 契约测试：逐条覆盖 ITERATION-0.2.md §5 的 12 条验收用例。
 *
 * 用法：node tools/contract-test.mjs
 *   12 条全绿 → exit 0；任一条失败 → exit 1，并打印「用例 / 断言 / 字段路径」。
 *
 * 做法和 tools/smoke.mjs 一样用 fake ctx，不经过宿主：
 *   registerTools(ctx, {...}) → 按名字取工具 → execute(args) → 用工具自己的 output.schema 校验
 *   → output.render 取文本 → output.presentationMeta 取卡片（JSON.parse(JSON.stringify()) 无损）。
 *
 * 隔离：画像 / 状态 / last-plan.json 全部落在 data/_contract-tmp-<pid>/ 下，跑完递归删除；
 * 不碰真实的 profile.json、user-state.json 和 data/ 里的其它文件（recipes 用硬链接复用，
 * 删临时目录不会动原文件）。用 pid 命名，避免和同时运行的另一次测试互相覆盖。
 *
 * all_blocked fixture 说明：all_blocked 只有当「命中的每一道都能被画像挡掉」时才出现。
 * 但数据里 q=水发海参 的命中含 北京-098 绣球干贝——它 ingredients 为空、allergens 为空、tier=easy，
 * 任何画像组合都挡不掉；单条 hard dislike「海参」也只能挡住命中里带该 canon 的那部分。
 * 所以 fixture 做法是：在候选查询里挑一个「所有命中都至少有一个 canon」的，把这些 canon 全部
 * 记为硬忌口，再断言 all_blocked 真的被触发（候选与 canon 都从当前数据派生，不硬编码）。
 */
import { registerTools } from "../src/plugin.mjs";
import { RecipeBook } from "../src/query.mjs";
import { DEFAULT_PROFILE } from "../src/profile.mjs";
import { DEFAULT_STATE } from "../src/state.mjs";
import { writeFileSync, existsSync, mkdirSync, rmSync, linkSync, copyFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const TMP = join(DATA, `_contract-tmp-${process.pid}`);

// ───────── 临时数据目录 ─────────
function initTmp() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  // recipes 太大，优先硬链接（同一分区、秒出；删临时目录不影响原文件），失败再复制
  for (const f of ["recipes.processed.jsonl", "recipes.jsonl"]) {
    const src = join(DATA, f);
    if (!existsSync(src)) continue;
    try {
      linkSync(src, join(TMP, f));
    } catch {
      copyFileSync(src, join(TMP, f));
    }
  }
  copyFileSync(join(DATA, "presets.json"), join(TMP, "presets.json"));
}
const cleanupTmp = () => {
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch { /* 清不掉也不影响结论 */ }
};

// ───────── 工具注册（每个 fixture 一个独立 context） ─────────
const registries = new Map();

function makeRegistry(label, profile, state) {
  const profileFile = join(TMP, `profile-${label}.json`);
  const stateFile = join(TMP, `state-${label}.json`);
  writeFileSync(profileFile, JSON.stringify(profile, null, 2), "utf8");
  writeFileSync(stateFile, JSON.stringify(state, null, 2), "utf8");
  const tools = new Map();
  const ctx = { tools: { register: (t) => { tools.set(t.name, t); return () => {}; } } };
  registerTools(ctx, { dataDir: TMP, profileFile, stateFile });
  const reg = { label, tools, profileFile, stateFile };
  registries.set(label, reg);
  return reg;
}

/** 默认画像：allowTiers = easy（confident 里没有「炸」），后面 §5 第 5 条要用。 */
function getEasy() {
  if (!registries.has("easy")) makeRegistry("easy", structuredClone(DEFAULT_PROFILE), structuredClone(DEFAULT_STATE));
  return registries.get("easy");
}

/**
 * 全挡 fixture：先挑一个「所有命中都至少有一个 canon」的查询（这样每道都能被硬忌口挡掉），
 * 再把命中菜的 canon 全部记为硬忌口。查询与 canon 都从当前数据派生，不硬编码数据结论。
 */
const BLOCKED_QUERY_CANDIDATES = [
  { ingredients: ["海参"] },
  { ingredients: ["海参"], match: "all" },
  { q: "鱼肚" },
  { q: "水发海参" },
];

function getBlocked() {
  if (!registries.has("blocked")) {
    const book = new RecipeBook(TMP);
    let picked = null;
    const tried = [];
    for (const query of BLOCKED_QUERY_CANDIDATES) {
      const st = book.searchWithTotal({ ...query, limit: 200 });
      const hits = st.hits ?? [];
      if (!hits.length) { tried.push(`${safeJson(query)}: 0 命中`); continue; }
      const canons = [...new Set(hits.flatMap((h) => (h.recipe.ingredients ?? []).map((i) => i.canon).filter(Boolean)))].sort();
      const canonSet = new Set(canons);
      const escapable = hits.filter((h) => !(h.recipe.ingredients ?? []).some((i) => canonSet.has(i.canon)));
      if (!canonSet.size || escapable.length) {
        tried.push(`${safeJson(query)}: ${hits.length} 命中，${escapable.length} 道无 canon 可挡（如 ${escapable[0]?.recipe?.id ?? "?"}）`);
        continue;
      }
      picked = { query, hits: hits.length, canons };
      break;
    }
    if (!picked) {
      throw new Error(`无法构造 all_blocked fixture（候选查询都挡不干净）：${tried.join("；")}`);
    }
    const profile = structuredClone(DEFAULT_PROFILE);
    profile.longTerm.dislikes = picked.canons.map((target) => ({ target, weight: -3, hard: true }));
    const reg = makeRegistry("blocked", profile, structuredClone(DEFAULT_STATE));
    reg.fixture = { query: picked.query, hits: picked.hits, canons: picked.canons.length };
  }
  return registries.get("blocked");
}

// ───────── 调用一次工具：execute → schema → render → presentationMeta ─────────
async function exec(reg, toolName, args, label) {
  const entry = {
    label: label ?? toolName,
    tool: toolName,
    args,
    schema: null,
    hasMeta: false,
    error: null,
    renderError: null,
    metaError: null,
    value: undefined,
    blocks: null,
    text: "",
    meta: null,
  };
  const tool = reg.tools.get(toolName);
  if (!tool) {
    entry.error = `工具未注册：${toolName}（已注册：${[...reg.tools.keys()].join(", ")}）`;
    return entry;
  }
  entry.schema = tool.output?.schema;
  entry.hasMeta = typeof tool.output?.presentationMeta === "function";
  try {
    entry.value = await tool.execute(args ?? {});
  } catch (e) {
    entry.error = `execute 抛错：${e?.message ?? e}`;
    return entry;
  }
  const render = tool.output?.render;
  if (typeof render !== "function") {
    entry.renderError = "output.render 缺失或不是函数";
  } else {
    try {
      entry.blocks = await render(entry.args, entry.value);
    } catch (e) {
      entry.renderError = `render 抛错：${e?.message ?? e}`;
    }
  }
  if (Array.isArray(entry.blocks)) {
    entry.text = entry.blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).join("");
  }
  if (entry.hasMeta) {
    try {
      entry.meta = await tool.output.presentationMeta(entry.args, entry.value);
    } catch (e) {
      entry.metaError = `presentationMeta 抛错：${e?.message ?? e}`;
    }
  }
  return entry;
}

// ───────── 自写 schema 校验器（不引依赖） ─────────
// 支持：type（字符串或数组，含 object/array/string/number/integer/boolean/null）、
// properties、required、items（schema 或 tuple 数组）、enum、const、oneOf/anyOf/allOf、
// additionalProperties（true/false/schema）、minItems/maxItems、minLength/maxLength、pattern、
// minimum/maximum/exclusiveMinimum/exclusiveMaximum/multipleOf。
const SCHEMA_KEYWORDS = new Set([
  "type", "properties", "required", "items", "enum", "const", "oneOf", "anyOf", "allOf",
  "additionalProperties", "minItems", "maxItems", "minLength", "maxLength", "pattern",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "description", "title", "default", "examples", "deprecated", "$schema", "$comment",
]);

function scanSchema(schema, path = "schema", out = []) {
  if (!schema || typeof schema !== "object") return out;
  if (Array.isArray(schema)) {
    schema.forEach((s, i) => scanSchema(s, `${path}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(k)) {
      out.push(`${path}.${k}: 校验器不支持该关键字，无法证明这条断言有效`);
      continue;
    }
    if (k === "properties" && v && typeof v === "object") {
      for (const [pk, pv] of Object.entries(v)) scanSchema(pv, `${path}.properties.${pk}`, out);
    } else if (k === "items") {
      if (Array.isArray(v)) v.forEach((s, i) => scanSchema(s, `${path}.items[${i}]`, out));
      else scanSchema(v, `${path}.items`, out);
    } else if (k === "oneOf" || k === "anyOf" || k === "allOf") {
      if (Array.isArray(v)) v.forEach((s, i) => scanSchema(s, `${path}.${k}[${i}]`, out));
    } else if (k === "additionalProperties" && v && typeof v === "object") {
      scanSchema(v, `${path}.additionalProperties`, out);
    }
  }
  return out;
}

function matchType(v, t) {
  switch (t) {
    case "object": return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array": return Array.isArray(v);
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "null": return v === null;
    case "any": return true;
    default: return true; // 未知 type 由 scanSchema 单独报
  }
}

// ───────── 宿主 JSON Schema 子集校验 ─────────
// dsh-app-boot 的 assertSupportedJsonSchema 只接受受限子集：type 必须是单个类型字符串
// （不支持 type 数组）、oneOf 不能与 properties/required/additionalProperties/items/enum/const 并列。
// 超出子集时宿主会拒绝工具注册、整个插件不激活——0.2.0 首次上宿主就是因为这个静默失效，
// 而本地校验器当时比宿主宽松。这里按宿主同口径校验，避免再出现「本地全绿、宿主不加载」。
const HOST_SCHEMA_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const HOST_KEYWORDS = new Set(["type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const", "description", "title", "default", "examples"]);
const HOST_ONE_OF_FORBIDDEN = ["properties", "required", "additionalProperties", "items", "enum", "const"];
const HOST_TYPE_KEYWORDS = {
  properties: ["object"],
  required: ["object"],
  additionalProperties: ["object"],
  items: ["array"],
  enum: ["string", "number", "integer", "boolean", "null"],
  const: ["string", "number", "integer", "boolean", "null"],
};

function hostSchemaProblems(schema, path = "schema", out = []) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    out.push(`${path}: 必须是 schema 对象`);
    return out;
  }
  for (const key of Object.keys(schema)) {
    if (!HOST_KEYWORDS.has(key)) out.push(`${path}.${key}: 宿主不支持的关键字（只允许 type/oneOf/properties/required/additionalProperties/items/enum/const + description/title/default/examples）`);
  }
  if ("description" in schema && typeof schema.description !== "string") out.push(`${path}.description: 必须是字符串`);
  if ("title" in schema && typeof schema.title !== "string") out.push(`${path}.title: 必须是字符串`);

  const hasType = Object.prototype.hasOwnProperty.call(schema, "type");
  const hasOneOf = Object.prototype.hasOwnProperty.call(schema, "oneOf");
  if (hasType && hasOneOf) {
    out.push(`${path}: 不能同时声明 type 与 oneOf`);
    return out;
  }
  if (!hasType && !hasOneOf) {
    for (const key of HOST_ONE_OF_FORBIDDEN) if (key in schema) out.push(`${path}.${key}: 需要 type 或 oneOf`);
    return out;
  }
  if (hasOneOf) {
    for (const key of HOST_ONE_OF_FORBIDDEN) if (key in schema) out.push(`${path}.${key}: 不能与 oneOf 并列`);
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2) out.push(`${path}.oneOf: 必须是至少 2 个 schema 的数组`);
    else schema.oneOf.forEach((s, i) => hostSchemaProblems(s, `${path}.oneOf[${i}]`, out));
    return out;
  }

  const type = schema.type;
  if (typeof type !== "string") {
    out.push(`${path}.type: 宿主只接受单个类型字符串${Array.isArray(type) ? "（不支持 type 数组，请改用 oneOf）" : ""}`);
    return out;
  }
  if (!HOST_SCHEMA_TYPES.has(type)) {
    out.push(`${path}.type: 未知类型 ${JSON.stringify(type)}`);
    return out;
  }
  for (const [key, allowed] of Object.entries(HOST_TYPE_KEYWORDS)) {
    if (key in schema && !allowed.includes(type)) out.push(`${path}.${key}: 不能用在 type="${type}" 上`);
  }
  if (type === "object") {
    if ("properties" in schema) {
      if (schema.properties === null || typeof schema.properties !== "object" || Array.isArray(schema.properties)) out.push(`${path}.properties: 必须是对象`);
      else for (const [k, v] of Object.entries(schema.properties)) hostSchemaProblems(v, `${path}.properties.${k}`, out);
    }
    if ("required" in schema && (!Array.isArray(schema.required) || !schema.required.every((x) => typeof x === "string"))) {
      out.push(`${path}.required: 必须是字符串数组`);
    }
    if ("additionalProperties" in schema && schema.additionalProperties !== null && typeof schema.additionalProperties === "object") {
      hostSchemaProblems(schema.additionalProperties, `${path}.additionalProperties`, out);
    }
  } else if (type === "array" && "items" in schema) {
    hostSchemaProblems(schema.items, `${path}.items`, out);
  }
  if ("enum" in schema && (!Array.isArray(schema.enum) || schema.enum.length === 0)) out.push(`${path}.enum: 必须是非空数组`);
  return out;
}

function describeValue(v) {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === "string") return `string "${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`;
  if (typeof v === "number") return Number.isNaN(v) ? "number NaN" : `number ${v}`;
  if (typeof v === "object") return `object{${Object.keys(v).slice(0, 6).join(",")}}`;
  return typeof v;
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

function safeJson(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? "undefined" : s;
  } catch {
    return String(v);
  }
}

function validate(value, schema, path = "$", errors = []) {
  if (schema === undefined || schema === null || schema === true) return errors;
  if (schema === false) {
    errors.push(`${path}: schema 为 false，不允许出现任何值（实际 ${describeValue(value)}）`);
    return errors;
  }
  if (typeof schema !== "object") return errors;

  let typeFailed = false;
  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchType(value, t))) {
      errors.push(`${path}: 类型应为 ${types.join("|")}，实际 ${describeValue(value)}`);
      typeFailed = true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !deepEqual(value, schema.const)) {
    errors.push(`${path}: 期望常量 ${safeJson(schema.const)}，实际 ${describeValue(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(value, e))) {
    errors.push(`${path}: 不在 enum ${safeJson(schema.enum)} 中，实际 ${describeValue(value)}`);
  }

  if (!typeFailed) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const req of schema.required ?? []) {
        if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push(`${path}.${req}: 缺少必填字段`);
      }
      const props = schema.properties ?? {};
      for (const [k, v] of Object.entries(value)) {
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          validate(v, props[k], `${path}.${k}`, errors);
        } else if (schema.additionalProperties === false) {
          errors.push(`${path}.${k}: 不允许的额外字段（additionalProperties=false）`);
        } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
          validate(v, schema.additionalProperties, `${path}.${k}`, errors);
        }
      }
    }
    if (Array.isArray(value)) {
      if (Number.isFinite(schema.minItems) && value.length < schema.minItems) errors.push(`${path}: 至少 ${schema.minItems} 项，实际 ${value.length}`);
      if (Number.isFinite(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: 至多 ${schema.maxItems} 项，实际 ${value.length}`);
      if (schema.items !== undefined) {
        if (Array.isArray(schema.items)) {
          value.forEach((v, i) => { if (i < schema.items.length) validate(v, schema.items[i], `${path}[${i}]`, errors); });
        } else {
          value.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors));
        }
      }
    }
    if (typeof value === "string") {
      if (Number.isFinite(schema.minLength) && value.length < schema.minLength) errors.push(`${path}: 长度至少 ${schema.minLength}，实际 ${value.length}`);
      if (Number.isFinite(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}: 长度至多 ${schema.maxLength}，实际 ${value.length}`);
      if (typeof schema.pattern === "string") {
        let re = null;
        try { re = new RegExp(schema.pattern); } catch { /* pattern 本身写错 */ }
        if (re && !re.test(value)) errors.push(`${path}: 不匹配 pattern ${schema.pattern}，实际 ${describeValue(value)}`);
      }
    }
    if (typeof value === "number") {
      if (Number.isFinite(schema.minimum) && value < schema.minimum) errors.push(`${path}: 应 ≥ ${schema.minimum}，实际 ${value}`);
      if (Number.isFinite(schema.maximum) && value > schema.maximum) errors.push(`${path}: 应 ≤ ${schema.maximum}，实际 ${value}`);
      if (Number.isFinite(schema.exclusiveMinimum) && value <= schema.exclusiveMinimum) errors.push(`${path}: 应 > ${schema.exclusiveMinimum}，实际 ${value}`);
      if (Number.isFinite(schema.exclusiveMaximum) && value >= schema.exclusiveMaximum) errors.push(`${path}: 应 < ${schema.exclusiveMaximum}，实际 ${value}`);
      if (Number.isFinite(schema.multipleOf) && schema.multipleOf > 0) {
        const q = value / schema.multipleOf;
        if (Math.abs(q - Math.round(q)) > 1e-9) errors.push(`${path}: 应为 ${schema.multipleOf} 的倍数，实际 ${value}`);
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matched = schema.oneOf.filter((s) => validate(value, s, path, []).length === 0).length;
    if (matched !== 1) errors.push(`${path}: oneOf 期望恰好 1 个分支匹配，实际 ${matched}`);
  }
  if (Array.isArray(schema.anyOf)) {
    const matched = schema.anyOf.filter((s) => validate(value, s, path, []).length === 0).length;
    if (matched < 1) errors.push(`${path}: anyOf 期望至少 1 个分支匹配，实际 ${matched}`);
  }
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) validate(value, s, path, errors);
  return errors;
}

/** presentationMeta 是否经 JSON.parse(JSON.stringify()) 无损（null 视为无损）。 */
function losslessProblems(meta) {
  if (meta === null) return [];
  if (meta === undefined) return ["presentationMeta 返回 undefined（应为 null 或对象，JSON 无法往返）"];
  let text;
  try {
    text = JSON.stringify(meta);
  } catch (e) {
    return [`JSON.stringify 失败：${e?.message ?? e}`];
  }
  if (typeof text !== "string") return [`JSON.stringify 结果不是字符串（${typeof text}）`];
  let back;
  try {
    back = JSON.parse(text);
  } catch (e) {
    return [`JSON.parse 失败：${e?.message ?? e}`];
  }
  return deepEqual(back, meta) ? [] : ["JSON 往返后与原始值不相等（含 undefined / NaN / Infinity 等不可序列化值）"];
}

// ───────── 断言小工具 ─────────
function checkEntry(t, entry, label = entry.label) {
  t.check(`${label}：execute 不抛错`, !entry.error, entry.error ?? "");
  if (entry.error) return false;
  const schemaProblems = entry.schema == null ? ["工具缺少 output.schema"] : validate(entry.value, entry.schema);
  t.check(`${label}：返回值通过 output.schema`, schemaProblems.length === 0, schemaProblems.slice(0, 6).join("；"));
  // 2026-10-30 关二阻塞 bug 教训：宿主要求 canonical value 无损 JSON——
  // menu_shuffle 的 story 曾是 undefined（无 features 的菜），宿主直接拒收。
  // 此前只验 presentationMeta，execute 返回值没有这道闸。
  const valueProblems = losslessProblems(entry.value);
  t.check(`${label}：返回值可 JSON 往返无损`, valueProblems.length === 0, valueProblems.join("；"));
  t.check(`${label}：render 不抛错`, !entry.renderError, entry.renderError ?? "");
  const goodBlocks = !entry.renderError && Array.isArray(entry.blocks) && entry.blocks.length > 0
    && entry.blocks.every((b) => b && b.type === "text" && typeof b.text === "string");
  t.check(`${label}：render 返回 [{ type: "text", text }]`, goodBlocks, entry.renderError
    ?? `实际：${Array.isArray(entry.blocks) ? safeJson(entry.blocks.slice(0, 2)) : describeValue(entry.blocks)}`);
  t.check(`${label}：render 文本非空`, entry.text.trim().length > 0, `实际 ${entry.text.length} 字`);
  return schemaProblems.length === 0 && goodBlocks;
}

function checkMeta(t, entry, label = entry.label) {
  if (entry.metaError) {
    t.check(`${label}：presentationMeta 不抛错`, false, entry.metaError);
    return false;
  }
  const problems = losslessProblems(entry.meta);
  t.check(`${label}：presentationMeta 可 JSON 往返无损`, problems.length === 0, problems.join("；"));
  return problems.length === 0;
}

const hintCode = (entry) => (entry.value && typeof entry.value === "object" ? entry.value.hint?.code : undefined);
const hintText = (entry) => (entry.value && typeof entry.value === "object" ? entry.value.hint?.text : undefined);

// ───────── 用例执行器 ─────────
const caseResults = [];

async function runCase(id, title, fn) {
  const checks = [];
  const notes = [];
  const t = {
    check(name, ok, detail = "") {
      checks.push({ name, ok: Boolean(ok), detail });
      return Boolean(ok);
    },
    note(msg) { notes.push(msg); },
  };
  let fatal = null;
  try {
    await fn(t);
  } catch (e) {
    fatal = e?.stack ?? String(e);
  }
  const failed = checks.filter((c) => !c.ok);
  const ok = !fatal && checks.length > 0 && failed.length === 0;
  caseResults.push({ id, title, ok, checks, notes, fatal });
  const tag = String(id).padStart(2, " ");
  console.log(`${ok ? "PASS" : "FAIL"}  ${tag} ${title}  [${checks.length} 项断言]`);
  if (notes.length) for (const n of notes) console.log(`      · ${n}`);
  if (!ok) {
    if (fatal) console.log(`      ✗ 用例执行中断：${String(fatal).split("\n")[0]}`);
    for (const c of failed) console.log(`      ✗ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (fatal) console.log(String(fatal).split("\n").slice(0, 8).map((l) => `        ${l}`).join("\n"));
  }
  return ok;
}

// ───────── 全工具遍历（用例 11/12 共用一次执行） ─────────
const TRAVERSAL = [
  { label: "search·ok", tool: "recipe_search", args: { q: "肉" }, registry: "easy", expectHint: "ok", expectHits: true },
  { label: "search·no_hit", tool: "recipe_search", args: { q: "海参", cuisine: "火星" }, registry: "easy", expectHint: "no_hit" },
  { label: "search·no_anchor", tool: "recipe_search", args: { q: "zzz" }, registry: "easy", expectHint: "no_anchor" },
  { label: "search·all_blocked", tool: "recipe_search", args: () => getBlocked().fixture.query, registry: "blocked", expectHint: "all_blocked" },
  { label: "get·found", tool: "recipe_get", args: { id: "江苏-112" }, registry: "easy" },
  { label: "get·not_found", tool: "recipe_get", args: { title: "佛跳墙" }, registry: "easy" },
  { label: "profile_show", tool: "profile_show", args: {}, registry: "easy" },
  { label: "profile_update·set_household", tool: "profile_update", args: { action: "set_household", size: 3 }, registry: "easy" },
  { label: "profile_update·add_want", tool: "profile_update", args: { action: "add_want", target: "冰糖元蹄" }, registry: "easy" },
  { label: "cook_log", tool: "cook_log", args: { title: "冰糖元蹄", verdict: "loved", people: 2, leftovers: [{ name: "五花肉", grams: 200 }] }, registry: "easy" },
  { label: "plan_week", tool: "plan_week", args: { days: 2, people: 3, meals: 1, seed: 7 }, registry: "easy" },
  { label: "menu_shuffle", tool: "menu_shuffle", args: { people: 2, seed: 5 }, registry: "easy" },
  { label: "recommend·ok", tool: "recommend", args: { scene: "hungry", people: 2 }, registry: "easy" },
  { label: "recommend·learn", tool: "recommend", args: { scene: "learn", people: 3 }, registry: "easy" },
  { label: "recommend·empty", tool: "recommend", args: { scene: "daily", people: 2, maxMinutes: 1 }, registry: "easy" },
  { label: "cook_rescue", tool: "cook_rescue", args: { people: 2 }, registry: "easy" },
  { label: "show_card", tool: "show_card", args: { title: "今晚这桌", dishes: ["江苏-112"], shopping: [{ group: "一次买", name: "乌参", qty: "1 条", note: "提前泡发" }], notes: ["提前一天泡发"] }, registry: "easy" },
  { label: "show_card·miss", tool: "show_card", args: { dishes: ["不存在-9"] }, registry: "easy" },
  { label: "get·found+记忆", tool: "recipe_get", args: { title: "冰糖元蹄" }, registry: "easy" },
];

let traversal = null;
async function getTraversal() {
  if (traversal) return traversal;
  traversal = [];
  for (const spec of TRAVERSAL) {
    let entry;
    try {
      const reg = spec.registry === "blocked" ? getBlocked() : getEasy();
      const args = typeof spec.args === "function" ? spec.args() : spec.args;
      entry = await exec(reg, spec.tool, args, spec.label);
    } catch (e) {
      entry = { label: spec.label, tool: spec.tool, args: spec.args, error: `准备注册表失败：${e?.message ?? e}` };
    }
    traversal.push({ spec, entry });
  }
  return traversal;
}

/** 过敏 fixture（R20 验收用）：虾/蟹 → 甲壳类硬约束，与 R10 同口径——摇出来/推出来都不得含。 */
function getAllergy() {
  if (!registries.has("allergy")) {
    const profile = structuredClone(DEFAULT_PROFILE);
    profile.longTerm.allergies = [{ target: "虾", allergen: "甲壳类" }, { target: "蟹", allergen: "甲壳类" }];
    makeRegistry("allergy", profile, structuredClone(DEFAULT_STATE));
  }
  return registries.get("allergy");
}

// ───────── 用例 ─────────
async function runAll() {
  await runCase(1, "recipe_search { q:'佛跳墙' }：不抛错、hits 空、hint 可执行、render 说清「没有」+ 覆盖范围", async (t) => {
    const e = await exec(getEasy(), "recipe_search", { q: "佛跳墙" }, "search(q=佛跳墙)");
    checkEntry(t, e);
    if (e.error) return;
    const v = e.value;
    t.check("value.hits 是数组且为空", Array.isArray(v?.hits) && v.hits.length === 0, `实际 ${describeValue(v?.hits)}`);
    t.check("value.neighbors 是数组（≤5 条）", Array.isArray(v?.neighbors) && v.neighbors.length <= 5, `实际 ${describeValue(v?.neighbors)}`);
    t.check("hint.code ∈ {no_hit, no_anchor}", ["no_hit", "no_anchor"].includes(hintCode(e)), `实际 ${safeJson(hintCode(e))}`);
    t.check("hint.text 是非空字符串", typeof hintText(e) === "string" && hintText(e).trim().length > 0, `实际 ${describeValue(hintText(e))}`);
    t.check("render 含「没有」", e.text.includes("没有"), `前 80 字：${e.text.slice(0, 80)}`);
    t.check("render 含「覆盖范围：」（来自 facets，不是硬编码）", /覆盖范围：\S/.test(e.text), `前 120 字：${e.text.slice(0, 120)}`);
    const metaOk = checkMeta(t, e);
    // 注：接口 §3.2 写的是「presentationMeta 必须等于 cardSearch(...)」；实际实现按 Lead 裁决，
    // 零命中/all_blocked 分支不投影空卡（让 UI 回退 generic 文本），只返回 null。这里按裁决断言。
    if (metaOk) t.check("非 ok 分支 presentationMeta === null（不投影空卡）", e.meta === null, `实际 ${safeJson(e.meta)}`);
    t.note(`hint.code=${safeJson(hintCode(e))} neighbors=${v?.neighbors?.length ?? "?"}`);
  });

  await runCase(2, "recipe_search { q:'肉' }：不抛错、hits.length > 0", async (t) => {
    const e = await exec(getEasy(), "recipe_search", { q: "肉" }, "search(q=肉)");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value.hits.length > 0（0.1.2 恒为 0）", Array.isArray(e.value?.hits) && e.value.hits.length > 0, `实际 ${e.value?.hits?.length}`);
    t.check("hint.code === 'ok'", hintCode(e) === "ok", `实际 ${safeJson(hintCode(e))}`);
    const metaOk = checkMeta(t, e);
    if (metaOk) t.check("presentationMeta.kind === 'search'（ok 分支投影卡片）", e.meta?.kind === "search", `实际 ${safeJson(e.meta?.kind)}`);
    t.note(`hits=${e.value?.hits?.length} total=${e.value?.total} blocked=${e.value?.blocked}`);
  });

  await runCase(3, "recipe_search { q:'鱼肚' }：hits.length > 0、首条含 id 与 page", async (t) => {
    const e = await exec(getEasy(), "recipe_search", { q: "鱼肚" }, "search(q=鱼肚)");
    checkEntry(t, e);
    if (e.error) return;
    const hits = e.value?.hits ?? [];
    t.check("value.hits.length > 0", hits.length > 0, `实际 ${hits.length}`);
    const first = hits[0] ?? {};
    t.check("hits[0].id 是非空字符串", typeof first.id === "string" && first.id.length > 0, `实际 ${describeValue(first.id)}`);
    t.check("hits[0] 含 page 字段（number|null）", Object.prototype.hasOwnProperty.call(first, "page") && (typeof first.page === "number" || first.page === null), `实际 ${describeValue(first.page)}`);
    t.note(`hits=${hits.length} 首条=${first.id} p.${first.page ?? "?"} ${first.title ?? ""}`);
  });

  await runCase(4, "recipe_search { cuisine:'火星' }：不抛错、hint.code ∈ {no_hit,no_anchor}、说清覆盖范围", async (t) => {
    const e = await exec(getEasy(), "recipe_search", { cuisine: "火星" }, "search(cuisine=火星)");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value.hits 为空", Array.isArray(e.value?.hits) && e.value.hits.length === 0, `实际 ${describeValue(e.value?.hits)}`);
    t.check("hint.code ∈ {no_hit, no_anchor}", ["no_hit", "no_anchor"].includes(hintCode(e)), `实际 ${safeJson(hintCode(e))}`);
    t.check("render 含「没有」", e.text.includes("没有"), `前 80 字：${e.text.slice(0, 80)}`);
    t.check("render 含「覆盖范围：」", /覆盖范围：\S/.test(e.text), `前 120 字：${e.text.slice(0, 120)}`);
    checkMeta(t, e);
    t.note(`hint.code=${safeJson(hintCode(e))}`);
  });

  await runCase(5, "recipe_search { q:'水发海参' } + 默认 easy 画像：按「若全被挡」条件断言；另用全挡 fixture 真触发 all_blocked", async (t) => {
    // 5a 默认画像（allowTiers=easy）：现 50 条，挡 19 条；条件断言按 §5
    const e = await exec(getEasy(), "recipe_search", { q: "水发海参" }, "search(q=水发海参, 默认easy)");
    checkEntry(t, e);
    if (e.error) return;
    const v = e.value;
    t.check("value.hits 是数组", Array.isArray(v?.hits), `实际 ${describeValue(v?.hits)}`);
    t.check("value.blocked > 0（默认 easy 画像会挡掉 learn/hard）", Number.isFinite(v?.blocked) && v.blocked > 0, `实际 ${safeJson(v?.blocked)}`);
    t.check("value.total ≥ hits.length + blocked（total 是画像过滤前命中数）", Number.isFinite(v?.total) && Array.isArray(v?.hits) && v.total >= v.hits.length + v.blocked, `total=${safeJson(v?.total)} hits=${v?.hits?.length} blocked=${safeJson(v?.blocked)}`);
    if (hintCode(e) === "all_blocked") {
      t.check("若全被挡：hint.code === 'all_blocked' 且 blocked > 0", v.blocked > 0, `blocked=${safeJson(v?.blocked)}`);
    } else {
      t.check("非全挡时：hint.code === 'ok' 且 hits.length > 0", hintCode(e) === "ok" && v.hits.length > 0, `code=${safeJson(hintCode(e))} hits=${v?.hits?.length}`);
    }
    t.note(`默认 easy：hits=${v?.hits?.length} total=${v?.total} blocked=${v?.blocked} code=${safeJson(hintCode(e))}`);

    // 5b 全挡 fixture：命中菜的 canon 全部硬忌口 → 必须走 all_blocked
    const reg = getBlocked();
    t.note(`全挡 fixture 查询 ${safeJson(reg.fixture.query)}：${reg.fixture.hits} 条命中菜的 ${reg.fixture.canons} 个 canon 全记硬忌口`);
    const b = await exec(reg, "recipe_search", reg.fixture.query, "search(全挡fixture)");
    checkEntry(t, b);
    if (b.error) return;
    t.check("全挡 fixture：hits 为空", Array.isArray(b.value?.hits) && b.value.hits.length === 0, `实际 ${describeValue(b.value?.hits)}`);
    t.check("全挡 fixture：hint.code === 'all_blocked'", hintCode(b) === "all_blocked", `实际 ${safeJson(hintCode(b))}`);
    t.check("全挡 fixture：blocked > 0", Number.isFinite(b.value?.blocked) && b.value.blocked > 0, `实际 ${safeJson(b.value?.blocked)}`);
    t.check("全挡 fixture：render 含「都被」+ 放宽建议（0.5.3 起说人话：不看忌口）", b.text.includes("都被") && /不看忌口|跟我说/.test(b.text), `前 160 字：${b.text.slice(0, 160)}`);
    checkMeta(t, b);
    t.note(`全挡 fixture：blocked=${b.value?.blocked} code=${safeJson(hintCode(b))}`);
  });

  await runCase(6, "recipe_get { title:'佛跳墙' }：found=false、suggestions 数组、render 含「没找到」", async (t) => {
    const e = await exec(getEasy(), "recipe_get", { title: "佛跳墙" }, "get(title=佛跳墙)");
    checkEntry(t, e);
    if (e.error) return;
    const v = e.value;
    t.check("found === false", v?.found === false, `实际 ${safeJson(v?.found)}`);
    t.check("recipe === null", v?.recipe === null, `实际 ${describeValue(v?.recipe)}`);
    t.check("suggestions 是数组（≤3 条）", Array.isArray(v?.suggestions) && v.suggestions.length <= 3, `实际 ${describeValue(v?.suggestions)}`);
    t.check("hint.code === 'not_found'", v?.hint?.code === "not_found", `实际 ${safeJson(v?.hint?.code)}`);
    t.check("hint.text 含「没找到」", typeof v?.hint?.text === "string" && v.hint.text.includes("没找到"), `实际 ${describeValue(v?.hint?.text)}`);
    t.check("render 含「没找到」", e.text.includes("没找到"), `前 120 字：${e.text.slice(0, 120)}`);
    t.check("render 提示先用搜索定位（0.5.3 起说人话，不再对用户念工具名）", /先.*搜索/.test(e.text), `前 200 字：${e.text.slice(0, 200)}`);
    checkMeta(t, e);
    t.check("not_found 的 presentationMeta === null（无卡片）", e.meta === null, `实际 ${safeJson(e.meta)}`);
    t.note(`suggestions=${v?.suggestions?.length ?? "?"}`);
  });

  await runCase(7, "recipe_get { id:'江苏-112' }：found=true、recipe.page=157、render 保留「一两五钱」原文", async (t) => {
    const e = await exec(getEasy(), "recipe_get", { id: "江苏-112" }, "get(id=江苏-112)");
    checkEntry(t, e);
    if (e.error) return;
    const r = e.value?.recipe;
    t.check("found === true", e.value?.found === true, `实际 ${safeJson(e.value?.found)}`);
    t.check("recipe.page === 157", r?.page === 157, `实际 ${safeJson(r?.page)}`);
    t.check("render 含原文「一两五钱」（数据折算 bug 本版不改）", e.text.includes("一两五钱"), `前 240 字：${e.text.slice(0, 240)}`);
    t.check("suggestions 为空数组", Array.isArray(e.value?.suggestions) && e.value.suggestions.length === 0, `实际 ${describeValue(e.value?.suggestions)}`);
    checkMeta(t, e);
    t.check("presentationMeta.kind === 'recipe'", e.meta?.kind === "recipe", `实际 ${safeJson(e.meta?.kind)}`);
    t.check("卡片 page 与 canonical 一致（157）", e.meta?.page === 157, `实际 ${safeJson(e.meta?.page)}`);
    t.note(`${r?.title} p.${r?.page} · 用料 ${r?.ingredients?.length} 项 · 步骤 ${r?.steps?.length} 步 · 卡片 ${e.meta?.title}`);
  });

  await runCase(8, "menu_shuffle { people:2 }：value 是对象、render 非空、meta.kind='shuffle'", async (t) => {
    const e = await exec(getEasy(), "menu_shuffle", { people: 2 }, "shuffle(people=2)");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value 是对象", e.value !== null && typeof e.value === "object" && !Array.isArray(e.value), `实际 ${describeValue(e.value)}`);
    checkMeta(t, e);
    t.check("presentationMeta.kind === 'shuffle'", e.meta?.kind === "shuffle", `实际 ${safeJson(e.meta?.kind)}`);
    const rerollHits = (e.text.match(/再摇一次/g) ?? []).length;
    t.check("正常分支 render 的「再摇一次」最多出现 1 次（不重复两句提示）", rerollHits <= 1, `出现 ${rerollHits} 次：…${e.text.slice(-120)}`);
    t.note(`${e.meta?.people} 人 · ${e.meta?.combo} · ${e.meta?.dishes?.length} 道`);

    // closed 分支（这局摇完）：没有菜可展示 → 不发空卡；文案只问原因 + 退路
    const closed = await exec(getEasy(), "menu_shuffle", { people: 2, rerollCount: 2 }, "shuffle(closed)");
    if (closed.error) {
      t.check("closed 分支 execute 不抛错", false, closed.error);
    } else {
      checkEntry(t, closed, "shuffle(closed)");
      t.check("closed 分支 presentationMeta === null（不发空卡）", closed.meta === null, `实际 ${safeJson(closed.meta)}`);
      t.check("closed 分支 value.closed === true 且 dishes 为空", closed.value?.closed === true && Array.isArray(closed.value?.dishes) && closed.value.dishes.length === 0, `实际 closed=${safeJson(closed.value?.closed)} dishes=${describeValue(closed.value?.dishes)}`);
      t.check("closed 分支 render 只问原因 + 退路（不含「再摇一次」指令）", (closed.text.match(/再摇一次/g) ?? []).length <= 1 && closed.text.includes("想不出"), `…${closed.text.slice(-120)}`);
    }
  });

  await runCase(9, "plan_week { days:2 }：value 是对象、render 含「采购清单」、meta.kind='plan'", async (t) => {
    const e = await exec(getEasy(), "plan_week", { days: 2 }, "plan(days=2)");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value 是对象", e.value !== null && typeof e.value === "object" && !Array.isArray(e.value), `实际 ${describeValue(e.value)}`);
    t.check("render 含「采购清单」", e.text.includes("采购清单"), `前 200 字：${e.text.slice(0, 200)}`);
    checkMeta(t, e);
    t.check("presentationMeta.kind === 'plan'", e.meta?.kind === "plan", `实际 ${safeJson(e.meta?.kind)}`);
    t.note(`${e.meta?.days} 天 · ${e.meta?.menu?.length} 天菜单 · 采购一次买够 ${e.meta?.shopping?.buyOnce?.length} 项`);
  });

  await runCase(10, "cook_rescue { people:2 }：value 是对象、meta.kind='rescue'", async (t) => {
    const e = await exec(getEasy(), "cook_rescue", { people: 2 }, "rescue(people=2)");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value 是对象", e.value !== null && typeof e.value === "object" && !Array.isArray(e.value), `实际 ${describeValue(e.value)}`);
    t.check("value.dishes 是数组", Array.isArray(e.value?.dishes), `实际 ${describeValue(e.value?.dishes)}`);
    checkMeta(t, e);
    t.check("presentationMeta.kind === 'rescue'", e.meta?.kind === "rescue", `实际 ${safeJson(e.meta?.kind)}`);
    t.note(`${e.meta?.dishes?.length ?? "?"} 道退路`);
  });

  await runCase(11, "全工具遍历：每个 execute 返回值过自己的 output.schema；presentationMeta JSON 往返无损", async (t) => {
    const trav = await getTraversal();
    const allTools = [...getEasy().tools.keys()];
    const covered = [...new Set(trav.map(({ spec }) => spec.tool))];
    t.check(`遍历覆盖全部已注册工具（${allTools.length} 个）`, allTools.every((n) => covered.includes(n)), `已注册 ${allTools.join(",")}；覆盖 ${covered.join(",")}`);

    // schema 本身：不支持的关键字要显式报出来，否则「通过校验」没有意义
    const scanned = new Set();
    for (const { entry } of trav) {
      if (!entry.tool || scanned.has(entry.tool) || !entry.schema) continue;
      scanned.add(entry.tool);
      const problems = scanSchema(entry.schema, `${entry.tool}.schema`);
      t.check(`${entry.tool}：schema 全部关键字都在校验器支持范围`, problems.length === 0, problems.slice(0, 5).join("；"));
      const hostProblems = hostSchemaProblems(entry.schema, `${entry.tool}.schema`);
      t.check(`${entry.tool}：schema 在宿主支持子集内（type 单值 / oneOf 无并列）`, hostProblems.length === 0, hostProblems.slice(0, 5).join("；"));
    }

    for (const { spec, entry } of trav) {
      const label = `${spec.label}（${spec.tool}）`;
      const entryOk = checkEntry(t, entry, label);
      if (!entry.error) checkMeta(t, entry, label);
      if (spec.expectHint) {
        t.check(`${label}：hint.code === '${spec.expectHint}'`, hintCode(entry) === spec.expectHint, `实际 ${safeJson(hintCode(entry))}`);
      }
      if (spec.expectHits) {
        t.check(`${label}：hits.length > 0`, Array.isArray(entry.value?.hits) && entry.value.hits.length > 0, `实际 ${entry.value?.hits?.length}`);
      }
      if (!entryOk) t.note(`${label}：execute/schema/render 有问题，见上面的 ✗`);
    }

    const codes = new Set(trav.map(({ entry }) => hintCode(entry)).filter(Boolean));
    const wanted = ["ok", "no_hit", "no_anchor", "all_blocked"];
    t.check(`recipe_search 四个分支都被真实触发（${wanted.join("/")}）`, wanted.every((c) => codes.has(c)), `实际 ${[...codes].join(",")}`);
    t.note(`遍历 ${trav.length} 次调用，覆盖 ${covered.length}/${allTools.length} 个工具，search hint.code=${[...codes].join(",")}`);
  });

  await runCase(12, "全工具遍历：render 输出不含 undefined / [object Object] / NaN", async (t) => {
    const trav = await getTraversal();
    for (const { spec, entry } of trav) {
      const label = `${spec.label}（${spec.tool}）`;
      if (entry.error) {
        t.check(`${label}：render 文本可检查`, false, entry.error);
        continue;
      }
      for (const bad of ["undefined", "[object Object]", "NaN"]) {
        const at = entry.text.indexOf(bad);
        const detail = at < 0 ? "" : `出现在第 ${at} 字附近：…${entry.text.slice(Math.max(0, at - 40), at + bad.length + 40).replace(/\n/g, "⏎")}…`;
        t.check(`${label}：render 不含「${bad}」`, at < 0, detail);
      }
    }
  });

  await runCase(13, "show_card：板书带菜卡+采购、坏 id 不发卡", async (t) => {
    const e = await exec(getEasy(), "show_card", {
      title: "今晚这桌",
      dishes: ["江苏-112"],
      shopping: [{ group: "一次买", name: "乌参", qty: "1 条", note: "提前泡发" }],
      notes: ["提前一天泡发"],
    }, "show_card");
    checkEntry(t, e);
    if (e.error) return;
    t.check("value.found === true", e.value?.found === true, `实际 ${safeJson(e.value?.found)}`);
    t.check("value 带回菜谱原文（有做法）", e.value?.dishes?.[0]?.steps?.length > 0, describeValue(e.value?.dishes?.[0]));
    t.check("render 含标题与采购项", e.text.includes("今晚这桌") && e.text.includes("乌参"), e.text.slice(0, 160));
    checkMeta(t, e);
    t.check("presentationMeta.kind === 'board'", e.meta?.kind === "board", `实际 ${safeJson(e.meta?.kind)}`);
    t.check("板书带菜卡与采购", e.meta?.dishes?.[0]?.id === "江苏-112" && e.meta?.shopping?.[0]?.name === "乌参", safeJson({ id: e.meta?.dishes?.[0]?.id, shopping: e.meta?.shopping?.length }));

    const miss = await exec(getEasy(), "show_card", { dishes: ["不存在-9"] }, "show_card(miss)");
    if (miss.error) {
      t.check("坏 id：execute 不抛", false, miss.error);
    } else {
      t.check("坏 id：found=false 且 presentationMeta === null（不发空卡）", miss.value?.found === false && miss.meta === null, safeJson({ found: miss.value?.found, meta: miss.meta }));
      t.check("坏 id：render 说没找到", miss.text.includes("没找到"), miss.text.slice(0, 120));
    }
  });

  await runCase(14, "recommend（R20）：同一请求稳定 3 候选、每道带理由与种类数、候选间有差异、画像硬约束不漏", async (t) => {
    const book = new RecipeBook(TMP);
    const e = await exec(getEasy(), "recommend", { scene: "hungry", people: 2 }, "recommend(hungry,2)");
    checkEntry(t, e);
    if (e.error) return;
    const v = e.value;
    t.check("hint.code === 'ok'", v?.hint?.code === "ok", `实际 ${safeJson(v?.hint?.code)}`);
    t.check("固定 3 个候选", v?.candidates?.length === 3, `实际 ${v?.candidates?.length}`);
    for (const d of v?.candidates ?? []) {
      t.check(`${d.title}：why 是非空人话`, typeof d.why === "string" && d.why.trim().length > 0, `实际 ${describeValue(d.why)}`);
      t.check(`${d.title}：minutes 有限`, Number.isFinite(d.minutes), `实际 ${describeValue(d.minutes)}`);
      t.check(`${d.title}：variety 是 ≥1 整数（R19 种类数）`, Number.isInteger(d.variety) && d.variety >= 1, `实际 ${describeValue(d.variety)}`);
      t.check(`${d.title}：mainIngredients 是数组`, Array.isArray(d.mainIngredients), `实际 ${describeValue(d.mainIngredients)}`);
      t.check(`${d.title}：proteinPerServing 为 number|null`, d.proteinPerServing === null || Number.isFinite(d.proteinPerServing), `实际 ${describeValue(d.proteinPerServing)}`);
      t.check(`${d.title}：id 可回查`, typeof d.id === "string" && Boolean(book.get(d.id)), `实际 ${describeValue(d.id)}`);
    }
    // 确定性：同一请求同一结果（不掺随机）——R20 验收第一条
    const again = await exec(getEasy(), "recommend", { scene: "hungry", people: 2 }, "recommend(again)");
    t.check("同一请求两次结果一致", deepEqual(v?.candidates, again.value?.candidates), "两次 candidates 不一致");
    // 互不雷同：主技法或蛋白来源两两有差异（锚点定义与 planner.recommend 同口径）
    const anchorsOf = (r) => ({
      m: (r.methods ?? [])[0] ?? null,
      s: (() => {
        const main = (r.proteinCanon ?? [])[0];
        const ing = main ? (r.ingredients ?? []).find((i) => i.canon === main) : null;
        if (ing?.parent) return ing.parent;
        const veg = (r.vegCanon ?? [])[0];
        const ving = veg ? (r.ingredients ?? []).find((i) => i.canon === veg) : null;
        return ving?.parent ?? veg ?? null;
      })(),
    });
    const as_ = (v?.candidates ?? []).map((d) => anchorsOf(book.get(d.id))).filter((a) => a);
    let pairwiseOk = true;
    let pairDetail = "";
    for (let i = 0; i < as_.length; i++) {
      for (let j = i + 1; j < as_.length; j++) {
        if (as_[i].m === as_[j].m && as_[i].s === as_[j].s) {
          pairwiseOk = false;
          pairDetail = `${v.candidates[i].title} vs ${v.candidates[j].title}（${safeJson(as_[i])}）`;
        }
      }
    }
    t.check("候选两两「技法或蛋白来源」有差异", pairwiseOk, pairDetail);
    const metaOk = checkMeta(t, e);
    if (metaOk) t.check("presentationMeta.kind === 'recommend'", e.meta?.kind === "recommend", `实际 ${safeJson(e.meta?.kind)}`);

    // 换一批：excludeIds 传回 → 不重复且仍给 3 个
    const next = await exec(getEasy(), "recommend", { scene: "hungry", people: 2, excludeIds: v.excludeIds }, "recommend(换一批)");
    const prevIds = new Set(v.candidates.map((d) => d.id));
    t.check("换一批不重复上一轮", (next.value?.candidates ?? []).every((d) => !prevIds.has(d.id)) && next.value.candidates.length === 3, safeJson(next.value?.candidates?.map((d) => d.id)));

    // 画像硬约束（R10 同口径）：虾/蟹过敏 fixture 下，候选不得含过敏原/忌口 canon/标题防御词
    const a = await exec(getAllergy(), "recommend", { scene: "daily", people: 2 }, "recommend(过敏fixture)");
    checkEntry(t, a);
    let leak = "";
    for (const d of a.value?.candidates ?? []) {
      const r = book.get(d.id);
      if (!r) continue;
      if ((r.allergens ?? []).includes("甲壳类")) leak = `${d.id} allergens 标甲壳类`;
      if ((r.ingredients ?? []).some((i) => i.canon === "虾" || i.canon === "蟹")) leak = `${d.id} 含虾/蟹 canon`;
      if (/虾|蟹/.test(r.title ?? "")) leak = `${d.id} 标题含虾/蟹`;
    }
    t.check("过敏 fixture：候选无虾/蟹泄漏", !leak && (a.value?.candidates?.length ?? 0) > 0, leak || "候选为空");
    t.note(`easy:${v?.candidates?.map((d) => d.title).join("/")}；过敏fixture:${a.value?.candidates?.map((d) => d.title).join("/")}`);

    // empty 分支（R20 与搜索 no_hit 同口径：不发空卡，hint 给退路）
    const emp = await exec(getEasy(), "recommend", { scene: "daily", people: 2, maxMinutes: 1 }, "recommend(empty)");
    checkEntry(t, emp);
    t.check("empty 分支：candidates 为空且 hint.code === 'empty'", emp.value?.candidates?.length === 0 && emp.value?.hint?.code === "empty", safeJson({ n: emp.value?.candidates?.length, code: emp.value?.hint?.code }));
    t.check("empty 分支：presentationMeta === null（不发空卡）", emp.meta === null, `实际 ${safeJson(emp.meta)}`);
  });
}

// ───────── 入口 ─────────
async function main() {
  initTmp();
  try {
    await runAll();
  } finally {
    cleanupTmp();
  }
  const total = caseResults.length;
  const failed = caseResults.filter((r) => !r.ok);
  console.log(`\n${total - failed.length}/${total} 通过${failed.length ? `（失败用例：${failed.map((f) => f.id).join(", ")}）` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  cleanupTmp();
  console.error(`FATAL 契约测试无法启动：${e?.stack ?? e}`);
  process.exitCode = 1;
});
