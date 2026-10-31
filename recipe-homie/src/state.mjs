/**
 * 用户状态：做饭记录、想吃的、冰箱里的剩料。
 *
 * 和 profile 的分工：
 *   profile = 你是谁（长期口味、忌口、阶段目标）
 *   state   = 你最近怎样（做过什么、想吃什么、剩下什么）
 *
 * 这里的东西会过期：剩料三天后自动不算，想吃的实现后就划掉，
 * 做过的菜两周内不再推。记性要准，不能变成"永远记得你三年前爱吃这个"。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_STATE = {
  version: 1,
  cookLog: [],   // [{ date, id, title, verdict: "loved"|"ok"|"never", note, leftovers: [{ canon, name, grams, addedAt }] }]
  wants: [],     // [{ title, canon, note, addedAt, satisfiedAt }]
  notes: [],     // [{ date, text }] 用户随口说过的、值得记一句的
  updatedAt: null,
};

export function loadState(file) {
  if (!file || !existsSync(file)) return structuredClone(DEFAULT_STATE);
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { ...structuredClone(DEFAULT_STATE), ...s };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(file, state) {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 1), "utf8");
  return state;
}

const DAY = 86400000;
const daysBetween = (a, b = new Date()) => Math.floor((b - new Date(a)) / DAY);

/** 最近做过什么：{ id: 天数 } 与 { title: 天数 } */
export function recentCooks(state) {
  const byId = new Map();
  const byTitle = new Map();
  for (const c of state.cookLog ?? []) {
    if (!c?.date) continue;
    const d = daysBetween(c.date);
    if (d < 0) continue;
    if (c.id) byId.set(c.id, Math.min(byId.get(c.id) ?? 999, d));
    if (c.title) byTitle.set(c.title, Math.min(byTitle.get(c.title) ?? 999, d));
  }
  return { byId, byTitle };
}

/** 做过且评价过的菜：never 永久排除，loved 加权 */
export function verdicts(state) {
  const never = new Set();
  const loved = new Set();
  for (const c of state.cookLog ?? []) {
    if (!c) continue;
    if (c.verdict === "never") {
      if (c.id) never.add(c.id);
      if (c.title) never.add(c.title);
    }
    if (c.verdict === "loved") {
      if (c.id) loved.add(c.id);
      if (c.title) loved.add(c.title);
    }
  }
  return { never, loved };
}

/** 还没实现的"想吃" */
export function openWants(state) {
  return (state.wants ?? []).filter((w) => w && !w.satisfiedAt);
}

/** 冰箱里的剩料：过了保质期就不算 */
export function liveLeftovers(state, now = new Date()) {
  const out = new Map();
  for (const c of state.cookLog ?? []) {
    for (const l of c.leftovers ?? []) {
      if (!l?.canon || !l?.grams) continue;
      const added = l.addedAt ?? c.date;
      const days = l.days ?? (l.canon && ["蔬菜", "菌菇"].includes(l.cat) ? 2 : 4);
      if (daysBetween(added, now) > days) continue;
      out.set(l.canon, (out.get(l.canon) ?? 0) + l.grams);
    }
  }
  return out;
}

/** 一句人话：冰箱里还有什么 */
export function leftoversLine(state) {
  const live = liveLeftovers(state);
  if (!live.size) return "";
  return [...live.entries()].map(([canon, g]) => `${canon} ${Math.round(g)}g`).join("、");
}
