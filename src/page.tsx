import { useMemo, useState } from "react";
import {
  CHANNEL_COUNT,
  CHANNEL_NUMBERS,
  COLD_GAP_MS,
  createId,
  evaluateSubmission,
  formatTime,
  parseTime,
  suggestFreeChannel,
  summarizeModels,
  type CueNode,
  type ConflictKind,
  type GateViolation,
} from "./gate";
import { loadStore, resetStore, saveStore, type CueingStore } from "./storage";

type Notice =
  | { tone: "ok"; text: string }
  | { tone: "error"; text: string };

const MODEL_SUGGESTIONS = ["礼花弹", "罗马烛光", "扇形架", "冷焰火"];

function channelUsage(nodes: CueNode[]): number[] {
  const counts = new Array(CHANNEL_COUNT).fill(0);
  for (const node of nodes) counts[node.channel - 1] += 1;
  return counts;
}

function ChannelSelect({
  value,
  onChange,
  usage,
  disabled,
}: {
  value: number;
  onChange: (channel: number) => void;
  usage: number[];
  disabled?: boolean;
}) {
  return (
    <select
      className="channel-select"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(Number(event.target.value))}
    >
      {CHANNEL_NUMBERS.map((channel) => (
        <option key={channel} value={channel}>
          CH{String(channel).padStart(2, "0")}（{usage[channel - 1]} 发）
        </option>
      ))}
    </select>
  );
}

function CueingPage() {
  const [store, setStore] = useState<CueingStore>(() => loadStore());
  const [notice, setNotice] = useState<Notice | null>(null);

  // 登记表单
  const [section, setSection] = useState("Intro");
  const [model, setModel] = useState("");
  const [channel, setChannel] = useState(1);
  const [atText, setAtText] = useState("00:00.000");
  const [durationText, setDurationText] = useState("2000");

  const usage = useMemo(() => channelUsage(store.schedule), [store.schedule]);

  // 候选批（含被退回待改派的节点）对当前已排编排做实时判定
  const gate = useMemo(
    () => evaluateSubmission(store.schedule, store.draft),
    [store.schedule, store.draft]
  );

  const violationByNode = useMemo(() => {
    const map = new Map<string, GateViolation>();
    for (const violation of gate.violations) {
      if (!map.has(violation.nodeId)) map.set(violation.nodeId, violation);
    }
    return map;
  }, [gate.violations]);

  const modelRows = useMemo(() => summarizeModels(store.schedule), [store.schedule]);

  const persist = (next: CueingStore) => {
    setStore(next);
    saveStore(next);
  };

  const addToDraft = () => {
    const atMs = parseTime(atText);
    const durationMs = Number(durationText);
    const problems: string[] = [];
    if (section.trim() === "") problems.push("节目段落");
    if (model.trim() === "") problems.push("烟花型号");
    if (atMs === null) problems.push("点火时刻（格式 mm:ss.mmm 或毫秒整数）");
    if (!Number.isFinite(durationMs) || durationMs <= 0) problems.push("持续毫秒");

    if (problems.length > 0) {
      setNotice({ tone: "error", text: `请检查：${problems.join("、")}` });
      return;
    }

    const node: CueNode = {
      id: createId(),
      section: section.trim(),
      model: model.trim(),
      channel,
      atMs: atMs as number,
      durationMs,
    };
    persist({ ...store, draft: [...store.draft, node] });
    setNotice(null);
    setModel("");
  };

  const reassign = (nodeId: string, nextChannel: number) => {
    // 改派只动通道号；点火时刻、段落（及型号、时长）原样保留。
    persist({
      ...store,
      draft: store.draft.map((node) =>
        node.id === nodeId ? { ...node, channel: nextChannel } : node
      ),
    });
  };

  const removeDraftNode = (nodeId: string) => {
    persist({ ...store, draft: store.draft.filter((node) => node.id !== nodeId) });
  };

  const removeScheduleNode = (nodeId: string) => {
    persist({
      ...store,
      schedule: store.schedule.filter((node) => node.id !== nodeId),
    });
    setNotice(null);
  };

  const clearDraft = () => {
    if (store.draft.length === 0) return;
    if (window.confirm("清空待提交批？已排编排不受影响。")) {
      persist({ ...store, draft: [] });
      setNotice(null);
    }
  };

  // 保存：逐通道比对，任一冲突整批拒绝、不动已排编排；全部通过才整批落库。
  const submitBatch = () => {
    if (store.draft.length === 0) {
      setNotice({ tone: "error", text: "待提交批为空，先在上方登记节点。" });
      return;
    }

    const result = evaluateSubmission(store.schedule, store.draft);
    if (!result.ok) {
      const burning = result.violations.filter((v) => v.kind === "burning").length;
      const cold = result.violations.filter((v) => v.kind === "cold").length;
      setNotice({
        tone: "error",
        text: `整批退回：${store.draft.length} 发均未写入，已排编排保持不动。其中前发未熄冲突 ${burning} 处、冷启动间隔不足 1.5s 冲突 ${cold} 处，可在下方把冲突节点改派空闲通道后重提。`,
      });
      return;
    }

    persist({ schedule: [...store.schedule, ...store.draft], draft: [] });
    setNotice({ tone: "ok", text: `整批通过：${store.draft.length} 发已写入编排。` });
  };

  const restoreSeed = () => {
    if (window.confirm("恢复演示数据？当前本地编排将被覆盖。")) {
      persist(resetStore());
      setNotice(null);
    }
  };

  const violationText = (violation: GateViolation | undefined): string => {
    if (!violation) return "待校验";
    if (violation.kind === "burning") {
      return `通道${violation.channel}：前一发未熄（间隔 ${violation.gapMs}ms）`;
    }
    return `通道${violation.channel}：冷启动仅 ${violation.gapMs}ms 后，不足 1.5s`;
  };

  const kindLabel: Record<ConflictKind, string> = {
    burning: "前发未熄",
    cold: "冷启动不足",
  };

  const groupedRejections = useMemo(() => {
    const groups: { kind: ConflictKind; items: GateViolation[] }[] = [
      { kind: "burning", items: [] },
      { kind: "cold", items: [] },
    ];
    for (const violation of gate.violations) {
      groups.find((group) => group.kind === violation.kind)?.items.push(violation);
    }
    return groups.filter((group) => group.items.length > 0);
  }, [gate.violations]);

  // 时间轴量程
  const span = useMemo(() => {
    const all = [...store.schedule, ...store.draft];
    if (all.length === 0) return { start: 0, endMs: 30_000 };
    const maxEnd = Math.max(...all.map((node) => node.atMs + node.durationMs + COLD_GAP_MS));
    return { start: 0, endMs: Math.max(30_000, Math.ceil(maxEnd / 5_000) * 5_000) };
  }, [store.schedule, store.draft]);

  const ticks = useMemo(() => {
    const candidates = [1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000];
    const interval =
      candidates.find((candidate) => span.endMs / candidate <= 12) ?? 60_000;
    const list: number[] = [];
    for (let t = span.start; t <= span.endMs; t += interval) list.push(t);
    return { interval, list };
  }, [span]);

  const TRACK_PAD = 120;
  const pct = (ms: number) =>
    `${((ms - span.start) / (span.endMs - span.start)) * 100}%`;

  const nodeById = useMemo(() => {
    const map = new Map<string, CueNode>();
    for (const node of [...store.schedule, ...store.draft]) map.set(node.id, node);
    return map;
  }, [store.schedule, store.draft]);

  return (
    <main className="app">
      <section className="hero">
        <p>hxyfront-62008 · 点火通道占用闸 · 预置 {CHANNEL_COUNT} 条通道</p>
        <h1>烟花燃放脚本编排</h1>
        <span>
          登记通道号、点火时刻与持续毫秒；保存时逐通道比对——同通道前一发未熄不得再点，
          冷启动间隔不足 {COLD_GAP_MS}ms 整批退回。冲突节点可改派空闲通道重提，
          改派不改点火时刻与段落。数据仅保存在本浏览器。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>已排点火节点</small>
          <strong>{store.schedule.length}</strong>
        </article>
        <article>
          <small>待提交批</small>
          <strong>{store.draft.length}</strong>
        </article>
        <article>
          <small>通道冲突</small>
          <strong className={gate.violations.length > 0 ? "metric-bad" : ""}>
            {gate.violations.length}
          </strong>
        </article>
        <article>
          <small>已用通道</small>
          <strong>{usage.filter((count) => count > 0).length}/{CHANNEL_COUNT}</strong>
        </article>
      </section>

      {notice && (
        <section className={`notice notice-${notice.tone}`}>{notice.text}</section>
      )}

      <section className="panel form-panel">
        <div className="heading">
          <div>
            <p>节点登记</p>
            <h2>新增点火节点</h2>
          </div>
          <button className="ghost" onClick={restoreSeed}>
            恢复演示数据
          </button>
        </div>
        <div className="field-grid">
          <label>
            <span>节目段落</span>
            <input
              list="section-options"
              value={section}
              onChange={(e) => setSection(e.target.value)}
              placeholder="如 Chorus A"
            />
            <datalist id="section-options">
              {["Intro", "Chorus A", "Finale"].map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          <label>
            <span>烟花型号</span>
            <input
              list="model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="如 75mm礼花弹"
            />
            <datalist id="model-options">
              {MODEL_SUGGESTIONS.map((item) => (
                <option key={item} value={item} />
              ))}
            </datalist>
          </label>
          <label>
            <span>通道号（1-{CHANNEL_COUNT}）</span>
            <ChannelSelect value={channel} onChange={setChannel} usage={usage} />
          </label>
          <label>
            <span>点火时刻（mm:ss.mmm 或毫秒）</span>
            <input
              value={atText}
              onChange={(e) => setAtText(e.target.value)}
              placeholder="01:08.200"
            />
          </label>
          <label>
            <span>持续毫秒</span>
            <input
              type="number"
              min={1}
              step={100}
              value={durationText}
              onChange={(e) => setDurationText(e.target.value)}
            />
          </label>
          <div className="form-action">
            <button className="primary" onClick={addToDraft}>
              加入待提交批
            </button>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>待提交批 · 保存闸</p>
            <h2>逐通道比对后整批提交</h2>
          </div>
          <div className="button-row">
            <button onClick={clearDraft} disabled={store.draft.length === 0}>
              清空本批
            </button>
            <button
              className="primary"
              onClick={submitBatch}
              disabled={store.draft.length === 0}
            >
              保存（整批校验）
            </button>
          </div>
        </div>

        {groupedRejections.length > 0 && (
          <div className="reject-box">
            {groupedRejections.map((group) => (
              <div key={group.kind} className={`reject-line reject-${group.kind}`}>
                <b>{kindLabel[group.kind]}（{group.items.length}）</b>
                {group.items.map((violation) => {
                  const node = nodeById.get(violation.nodeId);
                  const against = nodeById.get(violation.againstId);
                  if (!node || !against) return null;
                  const free = suggestFreeChannel(node, store.schedule, node.channel);
                  return (
                    <div key={`${violation.nodeId}-${violation.againstId}`} className="reject-item">
                      <span>
                        {node.section} · {node.model} · {formatTime(node.atMs)}（CH{node.channel}）
                        {violation.kind === "burning" ? " 点火时前发未熄" : ` 冷启动仅剩 ${COLD_GAP_MS - (violation.gapMs - against.durationMs)}ms 裕量`}
                      </span>
                      {free !== null ? (
                        <button onClick={() => reassign(node.id, free)}>
                          改派 CH{String(free).padStart(2, "0")} 重提
                        </button>
                      ) : (
                        <em>八条通道均无空闲，需调整时刻</em>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}

        {store.draft.length === 0 ? (
          <p className="empty">暂无待提交节点。</p>
        ) : (
          <div className="table-wrap">
            <table className="cue-table">
              <thead>
                <tr>
                  <th>段落</th>
                  <th>型号</th>
                  <th>通道（仅此处可改）</th>
                  <th>点火时刻</th>
                  <th>持续</th>
                  <th>状态</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {store.draft.map((node) => {
                  const violation = violationByNode.get(node.id);
                  return (
                    <tr key={node.id} className={violation ? `row-${violation.kind}` : ""}>
                      <td>{node.section}</td>
                      <td>{node.model}</td>
                      <td>
                        <ChannelSelect
                          value={node.channel}
                          usage={usage}
                          onChange={(nextChannel) => reassign(node.id, nextChannel)}
                        />
                      </td>
                      <td>{formatTime(node.atMs)}</td>
                      <td>{node.durationMs}ms</td>
                      <td>
                        <span className={`status status-${violation ? violation.kind : "ok"}`}>
                          {violationText(violation)}
                        </span>
                      </td>
                      <td>
                        <button className="mini" onClick={() => removeDraftNode(node.id)}>
                          移除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>通道泳道时间轴</p>
            <h2>八条通道占用总览</h2>
          </div>
          <span className="legend">
            <i className="swatch swatch-burn" /> 前发未熄
            <i className="swatch swatch-cold" /> 冷启动不足
            <i className="swatch swatch-coolzone" /> 1.5s 冷却区
          </span>
        </div>
        <div className="timeline-scroll">
          <div
            className="timeline"
            style={{ minWidth: TRACK_PAD + 720, gridTemplateColumns: `${TRACK_PAD}px 1fr` }}
          >
            <div className="tl-corner">通道 / 时刻</div>
            <div className="tl-ruler" style={{ position: "relative" }}>
              {ticks.list.map((tick) => (
                <span key={tick} className="tl-tick" style={{ left: pct(tick) }}>
                  {formatTime(tick)}
                </span>
              ))}
            </div>

            {CHANNEL_NUMBERS.map((channelNumber) => {
              const laneSaved = store.schedule.filter((n) => n.channel === channelNumber);
              const laneDraft = store.draft.filter((n) => n.channel === channelNumber);
              return (
                <div key={channelNumber} className="lane-row">
                  <div className="lane-label">
                    <b>CH{String(channelNumber).padStart(2, "0")}</b>
                    <small>{laneSaved.length} 发</small>
                  </div>
                  <div className="lane-track">
                    {ticks.list.map((tick) => (
                      <i key={tick} className="lane-gridline" style={{ left: pct(tick) }} />
                    ))}
                    {laneSaved.map((node) => (
                      <div key={node.id} className="block-wrap" style={{ left: pct(node.atMs) }}>
                        <div
                          className="cool-zone"
                          style={{
                            left: `calc(${(node.durationMs / (span.endMs - span.start)) * 100}% )`,
                            width: `${(COLD_GAP_MS / (span.endMs - span.start)) * 100}%`,
                          }}
                          title={`冷却区至 ${formatTime(node.atMs + node.durationMs + COLD_GAP_MS)}`}
                        />
                        <div
                          className="cue-block"
                          style={{ width: `${(node.durationMs / (span.endMs - span.start)) * 100}%` }}
                          title={`${node.section} · ${node.model} · ${formatTime(node.atMs)} 起 ${node.durationMs}ms`}
                        >
                          <span>{node.model}</span>
                          <button
                            className="block-del"
                            onClick={() => removeScheduleNode(node.id)}
                            title="从已排编排删除"
                          >
                            ×
                          </button>
                        </div>
                      </div>
                    ))}
                    {laneDraft.map((node) => {
                      const violation = violationByNode.get(node.id);
                      return (
                        <div key={node.id} className="block-wrap" style={{ left: pct(node.atMs), zIndex: 3 }}>
                          <div
                            className={`cue-block cue-draft ${violation ? `cue-${violation.kind}` : ""}`}
                            style={{ width: `${(node.durationMs / (span.endMs - span.start)) * 100}%` }}
                            title={`待提交 · ${node.section} · ${node.model}`}
                          >
                            <span>{node.model}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>型号清单</p>
            <h2>各型号通道发数统计</h2>
          </div>
        </div>
        <div className="table-wrap">
          <table className="cue-table model-table">
            <thead>
              <tr>
                <th>型号</th>
                {CHANNEL_NUMBERS.map((c) => (
                  <th key={c} className="num">CH{c}</th>
                ))}
                <th className="num">合计</th>
              </tr>
            </thead>
            <tbody>
              {modelRows.length === 0 ? (
                <tr>
                  <td colSpan={CHANNEL_COUNT + 2} className="empty">暂无已排节点。</td>
                </tr>
              ) : (
                modelRows.map((row) => (
                  <tr key={row.model}>
                    <td>{row.model}</td>
                    {row.perChannel.map((count, index) => (
                      <td key={index} className={`num ${count > 0 ? "cell-used" : ""}`}>
                        {count > 0 ? count : "·"}
                      </td>
                    ))}
                    <td className="num"><b>{row.total}</b></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

export default CueingPage;
