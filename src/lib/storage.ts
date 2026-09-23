// 业务文件二：浏览器本地存储（数据只存 localStorage，不落任何后端）

import type { FireNode } from "./scheduler";

const STORAGE_KEY = "fireworks-choreography:nodes:v1";

/** 首次打开时的示例编排：八条通道均有占用、且各自合法 */
const SEED_NODES: FireNode[] = [
  { id: "seed-1", segment: "Intro", model: "30mm扇形架", channel: 1, igniteAt: 12_500, durationMs: 3_200 },
  { id: "seed-2", segment: "Intro", model: "罗马烛光", channel: 2, igniteAt: 13_000, durationMs: 5_000 },
  { id: "seed-3", segment: "Verse", model: "冷焰火", channel: 3, igniteAt: 31_000, durationMs: 6_000 },
  { id: "seed-4", segment: "Chorus A", model: "75mm礼花弹", channel: 4, igniteAt: 68_200, durationMs: 4_500 },
  { id: "seed-5", segment: "Chorus A", model: "75mm礼花弹", channel: 5, igniteAt: 70_000, durationMs: 4_000 },
  { id: "seed-6", segment: "Chorus A", model: "30mm扇形架", channel: 1, igniteAt: 72_000, durationMs: 3_500 },
  { id: "seed-7", segment: "Finale", model: "冷焰火", channel: 6, igniteAt: 222_000, durationMs: 8_000 },
  { id: "seed-8", segment: "Finale", model: "100mm礼花弹", channel: 7, igniteAt: 224_000, durationMs: 5_000 },
  { id: "seed-9", segment: "Finale", model: "罗马烛光", channel: 8, igniteAt: 226_000, durationMs: 4_500 },
];

function normalize(raw: unknown): FireNode[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item, index) => ({
      id: String(item.id ?? `restored-${index}`),
      segment: String(item.segment ?? "未命名段落"),
      model: String(item.model ?? "未登记型号"),
      channel: Number(item.channel),
      igniteAt: Number(item.igniteAt),
      durationMs: Number(item.durationMs),
    }))
    .filter(
      (node) =>
        Number.isInteger(node.channel) &&
        node.channel >= 1 &&
        node.channel <= 8 &&
        Number.isFinite(node.igniteAt) &&
        node.igniteAt >= 0 &&
        Number.isFinite(node.durationMs) &&
        node.durationMs >= 0,
    );
}

/** 读取已排编排；首次访问写入示例数据 */
export function loadNodes(): FireNode[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      persistNodes(SEED_NODES);
      return [...SEED_NODES];
    }
    return normalize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** 整批替换已排编排（仅在闸判定通过后调用，保证不会写入冲突数据） */
export function persistNodes(nodes: FireNode[]): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nodes));
}

/** 清空已排编排 */
export function clearNodes(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}
