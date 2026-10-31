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

/** 冰箱剩料（JSON 落盘后的形状，字段都可能缺） */
export type Leftover = {
  canon?: string;
  name?: string;
  grams?: number;
  cat?: string;
  days?: number;
  addedAt?: string;
};

/** 一条做饭记录 */
export type CookLogEntry = {
  date?: string;
  id?: string;
  title?: string;
  verdict?: "loved" | "ok" | "never";
  note?: string;
  leftovers?: Leftover[];
};

/** 一条「想吃」 */
export type Want = {
  title?: string;
  canon?: string;
  note?: string;
  addedAt?: string;
  satisfiedAt?: string;
};

/** 一句随口说的话 */
export type Note = { date: string; text: string };

export type UserState = {
  version: number;
  cookLog: CookLogEntry[];
  wants: Want[];
  notes: Note[];
  updatedAt: string | null;
};

export const DEFAULT_STATE: UserState = {
  version: 1,
  cookLog: [],   // [{ date, id, title, verdict: "loved"|"ok"|"never", note, leftovers: [{ canon, name, grams, addedAt }] }]
  wants: [],     // [{ title, canon, note, addedAt, satisfiedAt }]
  notes: [],     // [{ date, text }] 用户随口说过的、值得记一句的
  updatedAt: null,
};

export function loadState(file?: string): UserState {
  if (!file || !existsSync(file)) return structuredClone(DEFAULT_STATE);
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    return { ...structuredClone(DEFAULT_STATE), ...s };
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(file: string, state: UserState): UserState {
  state.updatedAt = new Date().toISOString();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 1), "utf8");
  return state;
}

const DAY = 86400000;
// a 可能是落盘 JSON 里的任意日期字段（可能缺），b 可能是 Date —— 保持原式的 Date 相减
const daysBetween = (a: any, b: any = new Date()) => Math.floor((+b - +new Date(a)) / DAY);

/** 最近做过什么：{ id: 天数 } 与 { title: 天数 } */
export function recentCooks(state: UserState): { byId: Map<string, number>; byTitle: Map<string, number> } {
  const byId = new Map<string, number>();
  const byTitle = new Map<string, number>();
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
export function verdicts(state: UserState): { never: Set<string>; loved: Set<string> } {
  const never = new Set<string>();
  const loved = new Set<string>();
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
export function openWants(state: UserState): Want[] {
  return (state.wants ?? []).filter((w) => w && !w.satisfiedAt);
}

/** 冰箱里的剩料：过了保质期就不算 */
export function liveLeftovers(state: UserState, now = new Date()): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of state.cookLog ?? []) {
    for (const l of c.leftovers ?? []) {
      if (!l?.canon || !l?.grams) continue;
      const added = l.addedAt ?? c.date;
      const days = l.days ?? (l.canon && ["蔬菜", "菌菇"].includes(l.cat ?? "") ? 2 : 4);
      if (daysBetween(added, now) > days) continue;
      out.set(l.canon, (out.get(l.canon) ?? 0) + l.grams);
    }
  }
  return out;
}

/** 一句人话：冰箱里还有什么 */
export function leftoversLine(state: UserState): string {
  const live = liveLeftovers(state);
  if (!live.size) return "";
  return [...live.entries()].map(([canon, g]) => `${canon} ${Math.round(g)}g`).join("、");
}
