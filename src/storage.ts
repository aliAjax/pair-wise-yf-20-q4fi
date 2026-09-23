// 浏览器本地存储层：编排数据只存 localStorage，不发任何网络请求。
import type { CueNode } from "./gate";
import { CHANNEL_NUMBERS } from "./gate";

const STORE_KEY = "hxyfront-62008:cueing-store:v1";

export interface CueingStore {
  /** 已排编排（只有整批通过通道闸的数据才会进入这里） */
  schedule: CueNode[];
  /** 待提交批 / 被整批退回后等待改派通道的节点 */
  draft: CueNode[];
}

function sanitizeNode(raw: unknown): CueNode | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const channel = Number(value.channel);
  const atMs = Number(value.atMs);
  const durationMs = Number(value.durationMs);
  if (
    typeof value.id !== "string" ||
    typeof value.section !== "string" ||
    typeof value.model !== "string" ||
    !CHANNEL_NUMBERS.includes(channel) ||
    !Number.isFinite(atMs) ||
    atMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs <= 0
  ) {
    return null;
  }
  return {
    id: value.id,
    section: value.section,
    model: value.model,
    channel,
    atMs,
    durationMs,
  };
}

function sanitizeList(raw: unknown): CueNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(sanitizeNode).filter((node): node is CueNode => node !== null);
}

function seedStore(): CueingStore {
  // 首次打开时给一组与旧示例页对齐的演示数据，全部满足通道闸。
  return {
    schedule: [
      {
        id: "seed-intro-a",
        section: "Intro",
        model: "30mm扇形架",
        channel: 1,
        atMs: 12_500,
        durationMs: 4_200,
      },
      {
        id: "seed-intro-b",
        section: "Intro",
        model: "罗马烛光",
        channel: 1,
        atMs: 18_400,
        durationMs: 2_000,
      },
      {
        id: "seed-chorus-a",
        section: "Chorus A",
        model: "75mm礼花弹",
        channel: 3,
        atMs: 68_200,
        durationMs: 3_000,
      },
      {
        id: "seed-finale",
        section: "Finale",
        model: "冷焰火",
        channel: 8,
        atMs: 222_000,
        durationMs: 8_000,
      },
    ],
    draft: [],
  };
}

export function loadStore(): CueingStore {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (raw === null) {
      const seeded = seedStore();
      saveStore(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw) as Partial<CueingStore>;
    return {
      schedule: sanitizeList(parsed.schedule),
      draft: sanitizeList(parsed.draft),
    };
  } catch {
    return { schedule: [], draft: [] };
  }
}

export function saveStore(store: CueingStore): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    // 隐私模式或配额耗尽时静默：本次会话仍可操作。
  }
}

export function resetStore(): CueingStore {
  const seeded = seedStore();
  saveStore(seeded);
  return seeded;
}
