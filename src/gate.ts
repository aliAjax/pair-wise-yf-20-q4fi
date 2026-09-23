// 点火通道占用闸：纯判定逻辑，不接触 DOM 与存储。
// 规则：
// 1. 预置 8 条点火通道（1~8）。
// 2. 同通道前后两发：前一发未熄（时间区间重叠）不得再点 —— 燃烧冲突。
// 3. 同通道前后两发即便不重叠，冷却间隔不足 1500ms 也不得点火 —— 冷启动冲突。
// 4. 保存时整批校验，任一冲突则整批拒绝，已排编排不动。

export const CHANNEL_COUNT = 8;
export const CHANNEL_NUMBERS = Array.from(
  { length: CHANNEL_COUNT },
  (_, index) => index + 1
);
export const COLD_GAP_MS = 1500;

export interface CueNode {
  id: string;
  section: string; // 节目段落
  model: string; // 烟花型号
  channel: number; // 通道号 1~8
  atMs: number; // 点火时刻（相对节目开始的毫秒数）
  durationMs: number; // 持续毫秒
}

export type ConflictKind = "burning" | "cold";

export interface GateViolation {
  kind: ConflictKind;
  /** 发起冲突的节点 id；校验“候选批”时必为批内节点 */
  nodeId: string;
  /** 与之相撞的另一节点 id（可能来自已排编排或同批） */
  againstId: string;
  channel: number;
  /** 两发点火时刻之差的绝对值（毫秒） */
  gapMs: number;
}

export interface GateResult {
  ok: boolean;
  violations: GateViolation[];
}

export function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `cue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 解析点火时刻输入。接受：
 * - "mm:ss.mmm"，如 01:08.200
 * - "ss.mmm" / "ss"
 * - 纯数字，按毫秒处理
 * 无法解析返回 null。
 */
export function parseTime(text: string): number | null {
  const raw = text.trim();
  if (raw === "") return null;

  if (/^\d+$/.test(raw)) return Number(raw);

  const match = /^(?:(\d+):)?(\d{1,2})(?:\.(\d{1,3}))?$/.exec(raw);
  if (!match) return null;

  const minutes = match[1] === undefined ? 0 : Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] === undefined ? 0 : Number(match[3].padEnd(3, "0"));
  return minutes * 60_000 + seconds * 1000 + fraction;
}

/** 毫秒格式化为 mm:ss.mmm */
export function formatTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const minutes = Math.floor(safe / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1000);
  const millis = safe % 1000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function pairViolation(
  a: CueNode,
  b: CueNode
): GateViolation | null {
  if (a.channel !== b.channel) return null;

  const earlier = a.atMs <= b.atMs ? a : b;
  const later = earlier === a ? b : a;
  const gapMs = later.atMs - earlier.atMs;

  // 同刻点（gap=0）按“前一发未熄”处理。
  if (gapMs < earlier.durationMs) {
    return {
      kind: "burning",
      nodeId: later.id,
      againstId: earlier.id,
      channel: a.channel,
      gapMs,
    };
  }
  if (gapMs - earlier.durationMs < COLD_GAP_MS) {
    return {
      kind: "cold",
      nodeId: later.id,
      againstId: earlier.id,
      channel: a.channel,
      gapMs,
    };
  }
  return null;
}

/**
 * 校验一次提交：saved 为已排编排（永不动），batch 为待登记的候选批。
 * 同通道内按点火时刻排序后逐对相邻比较即可覆盖所有冲突
 * （区间/冷却间隙被任一相邻对违反即不可排入）。
 * 返回的每条违规 nodeId 都指向批内节点。
 */
export function evaluateSubmission(
  saved: CueNode[],
  batch: CueNode[]
): GateResult {
  const byChannel = new Map<number, CueNode[]>();
  for (const node of [...saved, ...batch]) {
    const list = byChannel.get(node.channel) ?? [];
    list.push(node);
    byChannel.set(node.channel, list);
  }

  const batchIds = new Set(batch.map((node) => node.id));
  const violations: GateViolation[] = [];

  for (const list of byChannel.values()) {
    list.sort((a, b) => a.atMs - b.atMs || a.id.localeCompare(b.id));
    for (let i = 1; i < list.length; i += 1) {
      const violation = pairViolation(list[i - 1], list[i]);
      if (
        violation &&
        (batchIds.has(violation.nodeId) || batchIds.has(violation.againstId))
      ) {
        // 若“晚发”一方是已排节点（候选节点更早），把责任归到候选节点上。
        if (!batchIds.has(violation.nodeId)) {
          violations.push({
            ...violation,
            nodeId: violation.againstId,
            againstId: violation.nodeId,
          });
        } else {
          violations.push(violation);
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * 找一条可接纳该候选节点的空闲通道：
 * 与该通道上任意已排节点既不重叠、冷却间隙也不少于 1500ms。
 * 不考虑同批其它节点（改派后以整批重提结果为准）。
 */
export function suggestFreeChannel(
  candidate: Pick<CueNode, "atMs" | "durationMs">,
  saved: CueNode[],
  preferredChannel?: number
): number | null {
  const fits = (channel: number): boolean =>
    saved
      .filter((node) => node.channel === channel)
      .every((node) => pairViolation(node, { ...candidate, id: "", channel } as CueNode) === null);

  if (preferredChannel !== undefined && fits(preferredChannel)) {
    return preferredChannel;
  }
  return CHANNEL_NUMBERS.find(fits) ?? null;
}

export interface ModelSummaryRow {
  model: string;
  total: number;
  /** 每条通道上的发数，下标 0 对应通道 1 */
  perChannel: number[];
}

/** 型号清单：按型号统计总发数与各通道发数。 */
export function summarizeModels(nodes: CueNode[]): ModelSummaryRow[] {
  const rows = new Map<string, ModelSummaryRow>();
  for (const node of nodes) {
    let row = rows.get(node.model);
    if (!row) {
      row = {
        model: node.model,
        total: 0,
        perChannel: new Array(CHANNEL_COUNT).fill(0),
      };
      rows.set(node.model, row);
    }
    row.total += 1;
    row.perChannel[node.channel - 1] += 1;
  }
  return [...rows.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model));
}
