// 블록 안으로 들어가 보기 (백엔드·게이트웨이·워커): 주 항목·보조 항목을 부품 블록으로, 부품마다 판정과
// 지금 부하에서 통과하는 대안을 옆에 둔다. 대안의 "교체"로 바꾸고, 보조 항목은 더하거나 뺀다. 왼쪽은 들어오는 블록, 오른쪽은 나가는 블록.
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { Analysis } from '../../engine/analyze';
import { judgeItem } from '../../engine/judge';
import { LAYER_NAMES, VERDICT_NAMES, type Verdict } from '../../engine/model';
import type { CatalogItem, Project } from '../../engine/schema';
import { catalog } from './data';
import { applyAlternative, updateNode } from './edit';
import { useStore } from './store';

/** 안쪽 다이어그램을 맞출 때 글자가 읽히는 크기 아래로는 줄이지 않는다 (좁은 화면에서는 끌어서 본다) */
export const READABLE = { minZoom: 0.6 };

/** 부품 다이어그램을 여는 블록 */
export const PART_LAYERS = ['backend', 'gateway', 'batch'] as const;

export type Part = {
  itemId: string;
  role: '주' | '보조';
  verdict?: Verdict;
  reasons: string[];
  alternatives: { id: string; verdict: Verdict; better: string[]; note?: string }[];
};

/** 노드의 부품(주 항목 + 보조 항목)과, 부품마다 이 노드 부하에서 안 됨이 아닌 대안 (같은 역할·이 레이어에 붙는 것만) */
export function partsOf(p: Project, a: Analysis | undefined, byId: Map<string, CatalogItem>, nodeId: string): Part[] {
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const used = new Set([n.primary, ...n.extras]);
  const s = a?.scenarios[nodeId];
  const j = a?.judgements.find((x) => x.nodeId === nodeId);
  return [n.primary, ...n.extras].filter((x): x is string => !!x).map((id) => {
    const item = byId.get(id)!;
    const role = id === n.primary ? '주' : '보조';
    const mine = j?.items.find((x) => x.itemId === id);
    return {
      itemId: id, role, verdict: mine?.verdict, reasons: mine?.reasons ?? [],
      alternatives: s ? item.alternatives.flatMap((alt) => {
        const it = byId.get(alt.id);
        if (!it || used.has(alt.id) || it.role !== role || !it.attaches_to.includes(n.layer)) return [];
        const verdict = judgeItem(it, n, s).verdict;
        return verdict === 'fail' ? [] : [{ id: alt.id, verdict, better: alt.better_for, note: alt.note }];
      }) : [],
    };
  });
}

type PartData = { part: Part; onRemove?: () => void };
type AltData = { id: string; verdict: Verdict; better: string[]; note?: string; onSwap: () => void };
type PeerData = { name: string; layer: string; onEnter?: () => void };

function PartBlock({ data }: NodeProps<Node<PartData>>) {
  const { part, onRemove } = data;
  const item = catalog.byId.get(part.itemId)!;
  return (
    <div className={`pblock v-${part.verdict ?? 'none'} ${part.role === '주' ? 'main' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="pblock-head">
        <span className="tag">{part.role} 항목 · {item.kind}</span>
        <span>{part.verdict ? VERDICT_NAMES[part.verdict] : ''}</span>
        {onRemove && <button className="nodrag" aria-label="보조 항목 빼기" onClick={onRemove}>×</button>}
      </div>
      <b>{item.name}</b>
      {item.summary && <div className="muted pblock-sum">{item.summary}</div>}
      {part.reasons.slice(0, 2).map((r) => <div key={r} className="pblock-why">{r}</div>)}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function AltBlock({ data }: NodeProps<Node<AltData>>) {
  return (
    <div className={`altblock v-${data.verdict}`}>
      <Handle type="target" position={Position.Left} />
      <div>{VERDICT_NAMES[data.verdict]} <b>{catalog.byId.get(data.id)?.name ?? data.id}</b></div>
      {data.better.length > 0 && <div className="muted">{data.better.join('·')}에 더 좋음{data.note ? ` (${data.note})` : ''}</div>}
      <button className="nodrag" onClick={data.onSwap}>교체</button>
    </div>
  );
}

function PeerBlock({ data }: NodeProps<Node<PeerData>>) {
  return (
    <div className="peerblock" onDoubleClick={data.onEnter} title={data.onEnter ? '두 번 누르면 이 블록 안으로' : undefined}>
      <Handle type="target" position={Position.Left} />
      <div className="muted">{data.layer}</div>
      <b>{data.name}</b>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { part: PartBlock, alt: AltBlock, peer: PeerBlock };

export function InsideBar({ title, layer, children }: { title: string; layer: string; children?: React.ReactNode }) {
  const { setFocus } = useStore();
  return (
    <div className="inside-bar">
      <button onClick={() => setFocus(undefined)}>← 전체</button>
      <span className="muted">전체 › {layer} ›</span> <b>{title}</b>
      <span className="spacer" />
      {children}
    </div>
  );
}

export function PartsInside({ nodeId, analysis, canEnter }: { nodeId: string; analysis?: Analysis; canEnter: (layer: string) => boolean }) {
  const { project: p, edit, select, setFocus } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const parts = partsOf(p, analysis, catalog.byId, nodeId);
  const extrasToAdd = catalog.items.filter((i) => i.role === '보조' && i.attaches_to.includes(n.layer) && !n.extras.includes(i.id));
  const primaries = catalog.items.filter((i) => i.role === '주' && i.attaches_to.includes(n.layer));

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  let y = 0;
  for (const part of parts) {
    const id = `p:${part.itemId}`;
    nodes.push({
      id, type: 'part', position: { x: 300, y }, data: {
        part, onRemove: part.role === '보조' ? () => edit((x) => updateNode(x, nodeId, { extras: n.extras.filter((e) => e !== part.itemId) })) : undefined,
      } satisfies PartData,
    });
    part.alternatives.forEach((alt, k) => {
      const aid = `a:${part.itemId}:${alt.id}`;
      nodes.push({ id: aid, type: 'alt', position: { x: 640, y: y + k * 92 }, data: { ...alt, onSwap: () => edit((x) => applyAlternative(x, nodeId, part.itemId, alt.id)) } satisfies AltData });
      edges.push({ id: `${id}->${aid}`, source: id, target: aid, style: { strokeDasharray: '4 4' }, label: '대안' });
    });
    if (part.role === '보조') edges.push({ id: `main->${id}`, source: `p:${n.primary}`, target: id, label: '함께 씀' });
    y += Math.max(150, part.alternatives.length * 92);
  }
  // 이웃 블록: 들어오는 것은 왼쪽, 나가는 것은 맨 오른쪽
  const main = n.primary ? `p:${n.primary}` : undefined;
  const peer = (other: string, x: number, i: number) => {
    const o = p.nodes.find((q) => q.id === other)!;
    return { id: `n:${other}:${x}`, type: 'peer', position: { x, y: i * 80 }, data: { name: o.name, layer: LAYER_NAMES[o.layer], onEnter: canEnter(o.layer) ? () => setFocus(other) : undefined } satisfies PeerData };
  };
  p.edges.filter((e) => e.to === nodeId).forEach((e, i) => {
    const pn = peer(e.from, 0, i); nodes.push(pn);
    if (main) edges.push({ id: `${pn.id}->main`, source: pn.id, target: main, markerEnd: { type: MarkerType.ArrowClosed }, style: e.sync ? undefined : { strokeDasharray: '6 4' } });
  });
  p.edges.filter((e) => e.from === nodeId).forEach((e, i) => {
    const pn = peer(e.to, 1000, i); nodes.push(pn);
    if (main) edges.push({ id: `main->${pn.id}`, source: main, target: pn.id, markerEnd: { type: MarkerType.ArrowClosed }, style: e.sync ? undefined : { strokeDasharray: '6 4' } });
  });

  return (
    <div className="inside">
      <InsideBar title={n.name} layer={LAYER_NAMES[n.layer]}>
        <select aria-label="주 항목" value={n.primary ?? ''} onChange={(e) => edit((x) => updateNode(x, nodeId, { primary: e.target.value || undefined }))}>
          <option value="">주 항목 고르기</option>
          {primaries.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
        <select aria-label="보조 항목 더하기" value="" onChange={(e) => e.target.value && edit((x) => updateNode(x, nodeId, { extras: [...n.extras, e.target.value] }))}>
          <option value="">+ 보조 항목</option>
          {extrasToAdd.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
        </select>
      </InsideBar>
      {!parts.length && <p className="muted inside-empty">항목이 없습니다. 위에서 주 항목을 고르세요.</p>}
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView fitViewOptions={READABLE} onPaneClick={() => select(null)} nodesConnectable={false}>
        <Background />
        <Controls />
      </ReactFlow>
      <p className="inside-hint muted">대안의 "교체"로 바꾸면 바깥 계산(비용·한계·판정)에 바로 반영됩니다 · 이웃 블록을 두 번 누르면 그 블록 안으로 갑니다</p>
    </div>
  );
}
