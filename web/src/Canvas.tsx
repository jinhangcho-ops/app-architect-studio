import { Background, BackgroundVariant, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, useRef } from 'react';
import type { Analysis } from '../../engine/analyze';
import { LAYER_NAMES, VERDICT_NAMES, type Verdict } from '../../engine/model';
import type { ProjectNode } from '../../engine/schema';
import { catalog } from './data';
import { addEdge, removeEdge, removeNode, worstVerdict } from './edit';
import { fmt } from './format';
import { canEnter } from './NodeInside';
import { useStore } from './store';

/** 카드 색: 첫 병목(빨강) · 성장하면 한계에 닿는 노드(노랑) · 여유 충분(초록) · 계산 대상 아님(회색) */
export type Health = 'bad' | 'warn' | 'ok' | 'none';
type CardData = { node: ProjectNode; verdict?: Verdict; sub: string; meter?: number; health: Health; spof: boolean };

/** 노드마다 색과 막대(한계까지 쓴 비율). 한계 사용자가 있으면 지금 사용자 ÷ 한계, 없으면 이벤트 피크 사용률 */
export function healthOf(a: Analysis | undefined, users: number | undefined, nodeId: string): { health: Health; meter?: number; startMonth?: number } {
  const na = a?.nodes[nodeId];
  if (!na?.load) return { health: 'none' };
  const lim = na.limitUsers?.value;
  const meter = lim && users ? users / lim : na.utilization?.event.value;
  const ms = a?.growth?.milestones.find((m) => m.nodeId === nodeId);
  if (a?.bottleneck?.nodeId === nodeId) return { health: 'bad', meter, startMonth: ms?.startMonth };
  if (ms?.startMonth !== undefined) return { health: 'warn', meter, startMonth: ms.startMonth };
  return { health: 'ok', meter };
}

function Card({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, verdict, sub, meter, health, spof } = data;
  return (
    <div className={`card h-${health} ${selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="layer">{LAYER_NAMES[node.layer]}</span>
        {verdict && <span className="badge" data-tip={VERDICT_NAMES[verdict]}>{VERDICT_NAMES[verdict].split(' ')[0]}</span>}
      </div>
      <div className="card-name">{node.name}</div>
      <div className="card-sub">{sub}</div>
      {meter !== undefined && (
        <div className="meter"><div className="track"><i style={{ width: `${Math.min(100, meter * 100)}%` }} /></div>{Math.round(meter * 100)}%</div>
      )}
      {spof && <div className="card-spof">단일 장애점</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { card: Card };
const EDGE = { base: '#4c5870', bad: '#ff5a5a', read: '#2ec4a6', async: '#f5b301' };

export function Canvas({ analysis, onSelect }: { analysis?: Analysis; onSelect: () => void }) {
  const { project, positions, selected, edit, move, select, setFocus, flyTo, set } = useStore();
  const flow = useRef<ReactFlowInstance<Node<CardData>> | null>(null);
  // 찾기에서 고른 노드로 화면을 옮긴다
  useEffect(() => {
    if (!flyTo || !flow.current) return;
    flow.current.fitView({ nodes: [{ id: flyTo }], duration: 300, maxZoom: 1.2 });
    set({ flyTo: undefined });
  }, [flyTo, set]);

  const users = project.scale?.users;
  const health = new Map(project.nodes.map((n) => [n.id, healthOf(analysis, users, n.id)]));
  const nodes: Node<CardData>[] = project.nodes.map((n) => {
    const na = analysis?.nodes[n.id];
    const h = health.get(n.id)!;
    const item = n.primary ? catalog.byId.get(n.primary)?.name : undefined;
    // 카드 한 줄 설명: 화면은 사용자 수, 첫 병목은 한계, 대수가 있으면 대수·p99, 아니면 고른 항목
    const sub = n.layer === 'ui' && analysis?.traffic ? `사용자 ${fmt(analysis.traffic.dau.value)}명`
      : h.health === 'bad' && na?.limitUsers ? `한계 ${fmt(na.limitUsers.value)}명`
      : na?.instances ? [`${na.instances.event.value}대`, na.p99 && `p99 ${fmt(na.p99.event.value)}ms`].filter(Boolean).join(' · ')
      : `${item ?? '항목 없음'}${n.extras.length ? ` +${n.extras.length}` : ''}`;
    return {
      id: n.id,
      type: 'card',
      position: positions[n.id] ?? { x: 0, y: 0 },
      selected: selected?.kind === 'node' && selected.id === n.id,
      data: { node: n, verdict: worstVerdict(analysis?.judgements.find((j) => j.nodeId === n.id)), sub, meter: h.meter, health: h.health, spof: !!analysis?.spof.includes(n.id) },
    };
  });

  // 선 굵기 = 요청량 (보내는 노드 평소 피크 × 호출 비율)
  const rpsOf = (e: (typeof project.edges)[number]) => (analysis?.nodes[e.from]?.load?.rps.normal ?? 0) * e.callRatio;
  const maxRps = Math.max(1, ...project.edges.map(rpsOf));
  const edges: Edge[] = project.edges.map((e) => {
    const rps = rpsOf(e);
    const color = !e.sync ? EDGE.async : health.get(e.to)?.health === 'bad' ? EDGE.bad : e.carries === 'read' ? EDGE.read : EDGE.base;
    const label = [!e.sync ? '비동기' : rps ? `${fmt(rps)} RPS` : '', e.carries === 'write' ? 'write' : e.carries === 'read' ? '읽기' : '', e.callRatio !== 1 ? `×${e.callRatio}` : '']
      .filter(Boolean).join(' ');
    return {
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      style: { stroke: color, strokeWidth: 1.5 + (6 * rps) / maxRps, ...(e.sync ? {} : { strokeDasharray: '6 5' }) },
      label: label || undefined,
      labelStyle: { fill: e.sync ? '#8b95a5' : EDGE.async, fontSize: 11 },
      labelBgStyle: { fill: '#0d1117' },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      selected: selected?.kind === 'edge' && selected.from === e.from && selected.to === e.to,
    };
  });

  // 범례: 노란·빨간 노드마다 몇 개월째 착수인지
  const months = [...new Set([...health.values()].filter((h) => h.health !== 'ok' && h.health !== 'none' && h.startMonth !== undefined).map((h) => `${h.health}:${h.startMonth}`))]
    .map((k) => { const [hh, m] = k.split(':'); return { health: hh as Health, month: Number(m) }; })
    .sort((x, y) => y.month - x.month);

  return (
    <div className="canvas-wrap">
      <div className="legend">
        <span><i className="h-ok" />여유 충분</span>
        {months.map((m) => <span key={`${m.health}${m.month}`}><i className={`h-${m.health}`} />{m.month}개월째 착수</span>)}
        <span>선 굵기 = 요청량</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="dark"
        fitView
        onInit={(f) => { flow.current = f; }}
        onNodesChange={(changes) => {
          for (const c of changes) if (c.type === 'position' && c.position) move(c.id, c.position);
        }}
        onNodesDelete={(ns) => edit((p) => ns.reduce((acc, n) => removeNode(acc, n.id), p))}
        onEdgesDelete={(es) => edit((p) => es.reduce((acc, e) => removeEdge(acc, e.source, e.target), p))}
        onConnect={(c) => c.source && c.target && edit((p) => addEdge(p, c.source, c.target))}
        onNodeClick={(_, n) => { select({ kind: 'node', id: n.id }); onSelect(); }}
        // 안쪽 다이어그램이 있는 블록은 두 번 누르면 들어간다
        onNodeDoubleClick={(_, n) => { if (canEnter(project.nodes.find((x) => x.id === n.id)?.layer)) setFocus(n.id); }}
        onEdgeClick={(_, e) => { select({ kind: 'edge', from: e.source, to: e.target }); onSelect(); }}
        onPaneClick={() => select(null)}
      >
        <Background variant={BackgroundVariant.Lines} gap={28} color="#1a222d" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
