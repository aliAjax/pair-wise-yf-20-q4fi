import { useMemo, useState } from "react";
import "./styles.css";
import {
  CHANNEL_COUNT,
  COLD_GAP_MS,
  type FireNode,
  validateBatch,
  suggestFreeChannels,
  parseTimecode,
  formatTimecode,
  formatTick,
} from "./lib/scheduler";
import { loadNodes, persistNodes, clearNodes } from "./lib/storage";

const CHANNELS = Array.from({ length: CHANNEL_COUNT }, (_, i) => i + 1);
const PX_PER_SECOND = 36;
const PAD_SECONDS = 2;
const SEGMENT_PALETTE = ["#1d4ed8", "#dc2626", "#f59e0b", "#0d9488", "#7c3aed", "#db2777", "#0891b2", "#65a30d"];

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `node-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

type Banner = { ok: boolean; conflictCount: number } | null;

function App() {
  const [committed, setCommitted] = useState<FireNode[]>(() => loadNodes());
  const [pending, setPending] = useState<FireNode[]>([]);

  const [segment, setSegment] = useState("");
  const [model, setModel] = useState("");
  const [channel, setChannel] = useState("1");
  const [igniteText, setIgniteText] = useState("");
  const [durationText, setDurationText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [banner, setBanner] = useState<Banner>(null);

  // 保存时逐通道比对：待发批次与已排编排合并判定
  const check = useMemo(() => validateBatch(committed, pending), [committed, pending]);
  const conflictByNode = useMemo(() => {
    const map = new Map<string, number>();
    check.conflicts.forEach((c) => map.set(c.nodeId, (map.get(c.nodeId) ?? 0) + 1));
    return map;
  }, [check]);

  const nodeById = useMemo(
    () => new Map([...committed, ...pending].map((n) => [n.id, n])),
    [committed, pending],
  );

  const segmentNames = useMemo(() => {
    const names: string[] = [];
    committed.forEach((n) => {
      if (!names.includes(n.segment)) names.push(n.segment);
    });
    return names;
  }, [committed]);

  const segmentColors = useMemo(() => {
    const map = new Map<string, string>();
    segmentNames.forEach((name, index) => map.set(name, SEGMENT_PALETTE[index % SEGMENT_PALETTE.length]));
    return map;
  }, [segmentNames]);

  const modelNames = useMemo(() => {
    const names: string[] = [];
    committed.forEach((n) => {
      if (!names.includes(n.model)) names.push(n.model);
    });
    return names;
  }, [committed]);

  // 时间轴：按通道分泳道，仅展示已排编排
  const lastEnd = committed.reduce((max, n) => Math.max(max, n.igniteAt + n.durationMs), 0);
  const spanMs = lastEnd + PAD_SECONDS * 2 * 1000;
  const innerWidth = Math.max(640, (spanMs / 1000) * PX_PER_SECOND);
  const ticks = useMemo(() => {
    const list: number[] = [];
    for (let t = 0; t <= spanMs; t += 5000) list.push(t);
    return list;
  }, [spanMs]);

  // 型号清单：按通道统计发数
  const modelMatrix = useMemo(() => {
    const matrix = new Map<string, number[]>();
    committed.forEach((n) => {
      const row = matrix.get(n.model) ?? new Array(CHANNEL_COUNT).fill(0);
      row[n.channel - 1] += 1;
      matrix.set(n.model, row);
    });
    return [...matrix.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh-Hans-CN"));
  }, [committed]);

  const channelCounts = useMemo(() => {
    const counts = new Array(CHANNEL_COUNT).fill(0) as number[];
    committed.forEach((n) => {
      counts[n.channel - 1] += 1;
    });
    return counts;
  }, [committed]);

  function nodeLabel(id: string): string {
    const node = nodeById.get(id);
    return node ? `${formatTimecode(node.igniteAt)} ${node.model}` : "另一发节点";
  }

  function addNode() {
    const igniteAt = parseTimecode(igniteText);
    const durationMs = Number(durationText);
    if (!segment.trim()) return setFormError("请填写节目段落");
    if (!model.trim()) return setFormError("请填写烟花型号");
    if (igniteAt === null) return setFormError("点火时刻格式应为 mm:ss.mmm，例如 01:08.200");
    if (!Number.isInteger(durationMs) || durationMs <= 0) return setFormError("持续毫秒须为正整数");

    const node: FireNode = {
      id: makeId(),
      segment: segment.trim(),
      model: model.trim(),
      channel: Number(channel),
      igniteAt,
      durationMs,
    };
    setPending((list) => [...list, node]);
    setIgniteText("");
    setDurationText("");
    setFormError(null);
    setBanner(null);
  }

  // 改派：只改通道号，点火时刻与段落保持不变
  function reassign(id: string, nextChannel: number) {
    setPending((list) => list.map((n) => (n.id === id ? { ...n, channel: nextChannel } : n)));
    setBanner(null);
  }

  function quickReassign(id: string) {
    const node = pending.find((n) => n.id === id);
    if (!node) return;
    const free = suggestFreeChannels(
      committed,
      pending.filter((n) => n.id !== id),
      node,
      node.channel,
    );
    if (free.length > 0) reassign(id, free[0]);
  }

  function removePending(id: string) {
    setPending((list) => list.filter((n) => n.id !== id));
    setBanner(null);
  }

  function clearPending() {
    setPending([]);
    setBanner(null);
  }

  function submitBatch() {
    const result = validateBatch(committed, pending);
    if (!result.ok) {
      // 两类冲突都整批拒绝：不写存储、不动已排编排
      setBanner({ ok: false, conflictCount: new Set(result.conflicts.map((c) => c.nodeId)).size });
      return;
    }
    const merged = [...committed, ...pending].sort((a, b) => a.igniteAt - b.igniteAt);
    persistNodes(merged);
    setCommitted(merged);
    setPending([]);
    setBanner({ ok: true, conflictCount: 0 });
  }

  function clearAll() {
    if (!window.confirm("确定清空本机已保存的全部编排？此操作不可恢复。")) return;
    clearNodes();
    setCommitted([]);
    setBanner(null);
  }

  return (
    <main className="app">
      <section className="hero compact">
        <p>hxyfront-62008 · 点火通道占用闸 · 预置 {CHANNEL_COUNT} 条通道</p>
        <h1>烟花燃放脚本编排</h1>
        <span>
          节点登记通道号、点火时刻与持续毫秒；保存时逐通道比对，前发未熄或冷启动不足 {(COLD_GAP_MS / 1000).toFixed(1)}{" "}
          秒即整批拒绝。数据仅保存在本浏览器。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>预置点火通道</small>
          <strong>{CHANNEL_COUNT}</strong>
        </article>
        <article>
          <small>已排点火节点</small>
          <strong>{committed.length}</strong>
        </article>
        <article>
          <small>待发批次节点</small>
          <strong>{pending.length}</strong>
        </article>
        <article>
          <small>冲突待处理节点</small>
          <strong className={conflictByNode.size > 0 ? "danger" : ""}>{conflictByNode.size}</strong>
        </article>
      </section>

      <section className="panel rules">
        <h2>占用闸规则</h2>
        <ol>
          <li>预置 {CHANNEL_COUNT} 条点火通道，每发节点登记通道号、点火时刻（mm:ss.mmm）与持续毫秒。</li>
          <li>同通道前一发未熄灭，不得再点（区间重叠，整发拒绝）。</li>
          <li>前一发熄灭后冷启动间隔不足 {(COLD_GAP_MS / 1000).toFixed(1)} 秒，同样拒绝。</li>
          <li>批次内任一节点冲突则整批拒绝，已排编排一条都不动；冲突节点可改派到空闲通道后重提，改派不改点火时刻与段落。</li>
        </ol>
      </section>

      <section className="workspace">
        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>节点登记</p>
              <h2>加入待发批次</h2>
            </div>
          </div>
          <div className="field-grid">
            <label>
              <span>节目段落</span>
              <input list="segment-options" value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="如 Chorus A" />
              <datalist id="segment-options">
                {segmentNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <label>
              <span>烟花型号</span>
              <input list="model-options" value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 75mm礼花弹" />
              <datalist id="model-options">
                {modelNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            <label>
              <span>点火通道号</span>
              <select value={channel} onChange={(e) => setChannel(e.target.value)}>
                {CHANNELS.map((ch) => (
                  <option key={ch} value={ch}>
                    CH{ch}（已排 {channelCounts[ch - 1]} 发）
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>点火时刻</span>
              <input value={igniteText} onChange={(e) => setIgniteText(e.target.value)} placeholder="00:12.500" inputMode="numeric" />
            </label>
            <label>
              <span>持续毫秒</span>
              <input
                value={durationText}
                onChange={(e) => setDurationText(e.target.value)}
                placeholder="如 3200"
                inputMode="numeric"
              />
            </label>
          </div>
          {formError && <p className="inline-error">{formError}</p>}
          <div className="form-actions">
            <button className="primary" onClick={addNode}>
              登记并加入批次
            </button>
          </div>
        </section>

        <section className="panel staging-panel">
          <div className="heading">
            <div>
              <p>待发批次（保存时整批过闸）</p>
              <h2>点火节点暂存</h2>
            </div>
            {pending.length > 0 && (
              <button onClick={clearPending} className="ghost">
                清空批次
              </button>
            )}
          </div>

          {pending.length === 0 ? (
            <p className="empty">暂无待发节点，左侧登记后在此排队；提交时一次性逐通道比对。</p>
          ) : (
            <div className="staging-list">
              {pending.map((node) => {
                const nodeConflicts = check.conflicts.filter((c) => c.nodeId === node.id);
                const firstFree = suggestFreeChannels(
                  committed,
                  pending.filter((n) => n.id !== node.id),
                  node,
                  node.channel,
                )[0];
                return (
                  <article key={node.id} className={nodeConflicts.length > 0 ? "staging-row conflict" : "staging-row"}>
                    <div className="staging-main">
                      <strong>
                        {node.segment} · {node.model}
                      </strong>
                      <span>
                        {formatTimecode(node.igniteAt)} 点火 · 持续 {node.durationMs}ms
                      </span>
                      {nodeConflicts.map((c, i) => (
                        <em key={i} className="conflict-reason">
                          {c.kind === "burning"
                            ? `CH${c.channel}：前一发未熄（与 ${nodeLabel(c.otherId)} 燃烧区间重叠）`
                            : `CH${c.channel}：冷启动不足 1.5s（${nodeLabel(c.otherId)} 熄灭后最早 ${formatTimecode(
                                c.otherEnd + COLD_GAP_MS,
                              )} 可点）`}
                        </em>
                      ))}
                    </div>
                    <div className="staging-ops">
                      <label className="reassign">
                        <span>改派通道</span>
                        <select value={node.channel} onChange={(e) => reassign(node.id, Number(e.target.value))}>
                          {CHANNELS.map((ch) => (
                            <option key={ch} value={ch}>
                              CH{ch}
                            </option>
                          ))}
                        </select>
                      </label>
                      {nodeConflicts.length > 0 && firstFree && (
                        <button className="ghost" onClick={() => quickReassign(node.id)}>
                          一键改派 CH{firstFree}
                        </button>
                      )}
                      <button className="danger-btn" onClick={() => removePending(node.id)}>
                        撤出
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {banner && banner.ok && <p className="banner ok">整批过闸通过，已写入本机编排。</p>}
          {banner && !banner.ok && (
            <p className="banner fail">
              整批拒绝：{banner.conflictCount} 个节点存在通道冲突（未熄 / 冷启动不足），已排编排未做任何改动。请改派空闲通道后重提。
            </p>
          )}

          <div className="form-actions">
            <button className="primary" onClick={submitBatch} disabled={pending.length === 0}>
              保存（逐通道比对，整批提交）
            </button>
          </div>
        </section>
      </section>

      <section className="panel timeline-panel">
        <div className="heading">
          <div>
            <p>时间轴编排</p>
            <h2>按通道分泳道</h2>
          </div>
          <div className="legend">
            {segmentNames.map((name) => (
              <span key={name} className="legend-item">
                <i style={{ background: segmentColors.get(name) }} />
                {name}
              </span>
            ))}
          </div>
        </div>

        {committed.length === 0 ? (
          <p className="empty">已排编排为空，先登记节点并整批过闸。</p>
        ) : (
          <div className="timeline">
            <div className="timeline-scroll">
              <div className="timeline-inner" style={{ width: innerWidth }}>
                <div className="ruler">
                  <div className="lane-head ruler-head">通道 / 时间</div>
                  <div className="ruler-track">
                    {ticks.map((t) => (
                      <span key={t} className="tick" style={{ left: (t / 1000 + PAD_SECONDS) * PX_PER_SECOND }}>
                        {formatTick(t)}
                      </span>
                    ))}
                  </div>
                </div>
                {CHANNELS.map((ch) => {
                  const nodes = committed
                    .filter((n) => n.channel === ch)
                    .sort((a, b) => a.igniteAt - b.igniteAt);
                  return (
                    <div key={ch} className={ch % 2 === 0 ? "lane alt" : "lane"}>
                      <div className="lane-head">
                        <strong>CH{ch}</strong>
                        <span className={nodes.length > 0 ? "lane-badge busy" : "lane-badge free"}>
                          {nodes.length > 0 ? `${nodes.length} 发` : "空闲"}
                        </span>
                      </div>
                      <div
                        className="lane-track"
                        style={{
                          backgroundImage: `repeating-linear-gradient(to right, var(--border) 0 1px, transparent 1px ${
                            PX_PER_SECOND * 5
                          }px)`,
                        }}
                      >
                        {nodes.map((n) => (
                          <div
                            key={n.id}
                            className="fire-block"
                            title={`${n.segment} · ${n.model}｜${formatTimecode(n.igniteAt)}–${formatTimecode(
                              n.igniteAt + n.durationMs,
                            )}｜CH${ch}`}
                            style={{
                              left: (n.igniteAt / 1000 + PAD_SECONDS) * PX_PER_SECOND,
                              width: Math.max(8, (n.durationMs / 1000) * PX_PER_SECOND - 2),
                              background: segmentColors.get(n.segment),
                            }}
                          >
                            <b>{n.model}</b>
                            <span>{formatTimecode(n.igniteAt)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>型号清单</p>
            <h2>分通道发数统计</h2>
          </div>
          <button className="ghost danger-btn" onClick={clearAll}>
            清空本机编排
          </button>
        </div>
        {modelMatrix.length === 0 ? (
          <p className="empty">暂无已保存的烟花型号。</p>
        ) : (
          <div className="matrix-scroll">
            <table className="matrix">
              <thead>
                <tr>
                  <th>烟花型号</th>
                  {CHANNELS.map((ch) => (
                    <th key={ch}>CH{ch}</th>
                  ))}
                  <th>合计</th>
                </tr>
              </thead>
              <tbody>
                {modelMatrix.map(([name, row]) => {
                  const total = row.reduce((sum, value) => sum + value, 0);
                  return (
                    <tr key={name}>
                      <th className="row-head">{name}</th>
                      {row.map((count, i) => (
                        <td key={i} className={count > 0 ? "hit" : ""}>
                          {count > 0 ? count : <span className="zero">·</span>}
                        </td>
                      ))}
                      <td className="total">{total}</td>
                    </tr>
                  );
                })}
                <tr className="sum-row">
                  <th className="row-head">通道发数</th>
                  {channelCounts.map((count, i) => (
                    <td key={i} className="total">
                      {count}
                    </td>
                  ))}
                  <td className="total">{committed.length}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="storage-note">所有编排数据仅保存在本浏览器 localStorage（键 fireworks-choreography:nodes:v1），不上传服务器。</p>
      </section>
    </main>
  );
}

export default App;
