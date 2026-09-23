// 业务文件一：点火通道占用判定（纯逻辑，不碰 DOM 与存储）

export const CHANNEL_COUNT = 8;
/** 冷启动最小间隔：前一发熄灭后 1.5 秒 */
export const COLD_GAP_MS = 1500;

/** 点火节点：登记通道号、点火时刻与持续毫秒 */
export interface FireNode {
  id: string;
  /** 节目段落，改派通道时保持不变 */
  segment: string;
  /** 烟花型号 */
  model: string;
  /** 通道号 1 ~ 8 */
  channel: number;
  /** 点火时刻，相对节目零点的毫秒数 */
  igniteAt: number;
  /** 持续毫秒（含冷启动间隔计算时按熄点 igniteAt + durationMs） */
  durationMs: number;
}

export type ConflictKind = "burning" | "coldstart";

export interface NodeConflict {
  nodeId: string;
  channel: number;
  kind: ConflictKind;
  /** 发生冲突的相邻发节点 id（便于提示） */
  otherId: string;
  /** 该通道上相邻一发的点火时刻；若建议改时刻可据此给出最早可点时间 */
  otherStart: number;
  otherEnd: number;
}

export interface ValidateResult {
  ok: boolean;
  /** 仅列出待发批次中触发的冲突（已排编排永不被本次判定污染） */
  conflicts: NodeConflict[];
}

interface ChannelEvent {
  id: string;
  start: number;
  end: number;
  /** true 表示属于本次待发批次 */
  incoming: boolean;
}

/**
 * 批量闸：把待发节点与已排节点按通道合并排序后逐发比对。
 * 任一条待发节点冲突即整批拒绝，已排编排不会被改动。
 */
export function validateBatch(committed: FireNode[], incoming: FireNode[]): ValidateResult {
  const lanes = new Map<number, ChannelEvent[]>();

  const collect = (nodes: FireNode[], isIncoming: boolean) => {
    for (const node of nodes) {
      const lane = lanes.get(node.channel) ?? [];
      lane.push({
        id: node.id,
        start: node.igniteAt,
        end: node.igniteAt + Math.max(0, node.durationMs),
        incoming: isIncoming,
      });
      lanes.set(node.channel, lane);
    }
  };
  collect(committed, false);
  collect(incoming, true);

  const conflicts: NodeConflict[] = [];

  for (const [channel, events] of lanes) {
    events.sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < events.length; i += 1) {
      const prev = events[i - 1];
      const cur = events[i];

      // 已排两发之间的历史问题不拦截本次提交
      if (!prev.incoming && !cur.incoming) continue;

      // 冲突类型一：同通道前一发未熄不得再点（区间重叠）
      // 冲突类型二：前一发虽熄灭，但冷启动间隔不足 1.5 秒
      let kind: ConflictKind | null = null;
      if (cur.start < prev.end) {
        kind = "burning";
      } else if (cur.start < prev.end + COLD_GAP_MS) {
        kind = "coldstart";
      }
      if (!kind) continue;

      // 冲突计入本次待发的那一发；两发都在批次内则各自记一条
      const makeConflict = (event: ChannelEvent): NodeConflict => ({
        nodeId: event.id,
        channel,
        kind: kind as ConflictKind,
        otherId: event.id === cur.id ? prev.id : cur.id,
        otherStart: event.id === cur.id ? prev.start : cur.start,
        otherEnd: event.id === cur.id ? prev.end : cur.end,
      });
      if (cur.incoming) conflicts.push(makeConflict(cur));
      if (prev.incoming) conflicts.push(makeConflict(prev));
    }
  }

  return { ok: conflicts.length === 0, conflicts };
}

/**
 * 判定指定节点改派到目标通道后是否空闲。
 * 改派只改通道号，点火时刻与段落原样保留。
 */
export function channelIsFree(
  committed: FireNode[],
  incoming: FireNode[],
  targetChannel: number,
  candidate: FireNode,
): boolean {
  return validateBatch(committed, [{ ...candidate, channel: targetChannel }]).ok;
}

/** 返回候选时刻能放得下的空闲通道列表（保持点火时刻不变，仅改派通道） */
export function suggestFreeChannels(
  committed: FireNode[],
  incoming: FireNode[],
  candidate: FireNode,
  excludeChannel?: number,
): number[] {
  const free: number[] = [];
  for (let ch = 1; ch <= CHANNEL_COUNT; ch += 1) {
    if (ch === excludeChannel) continue;
    if (channelIsFree(committed, incoming, ch, candidate)) free.push(ch);
  }
  return free;
}

// ---------- 时间码工具 ----------

/** 解析 mm:ss.mmm / ss.mmm / hh:mm:ss.mmm，返回毫秒；非法返回 null */
export function parseTimecode(input: string): number | null {
  const text = input.trim().replace(/[：．。]/g, (m) => (m === "：" ? ":" : "."));
  if (!/^\d+(:\d{1,2})?(:\d{1,2})?(\.\d{1,3})?$/.test(text)) return null;

  const [clockPart, fractionPart = ""] = text.split(".");
  const parts = clockPart.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return null;

  let millis = 0;
  const units = parts.length === 3 ? [3_600_000, 60_000, 1_000] : parts.length === 2 ? [60_000, 1_000] : [1_000];
  parts.forEach((value, index) => {
    millis += value * units[index];
  });
  if (parts.some((v, i) => i > 0 && v >= 60)) return null;

  if (fractionPart) {
    millis += Number(fractionPart.padEnd(3, "0"));
  }
  return millis;
}

/** 格式化为 mm:ss.mmm */
export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const minutes = Math.floor(clamped / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1_000);
  const millis = clamped % 1_000;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/** 时间轴刻度上的短标签 mm:ss */
export function formatTick(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
