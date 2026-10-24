import { Background, BackgroundVariant, BaseEdge, Controls, EdgeLabelRenderer, getBezierPath, Handle, MarkerType, Position, ReactFlow, type Edge, type EdgeProps, type Node, type NodeProps, type ReactFlowInstance } from '@xyflow/react';
import { useEffect, useMemo, useRef } from 'react';
import type { Analysis } from '../../engine/analyze';
import { callSplit } from '../../engine/api';
import { edgeFlow } from '../../engine/load';
import { LAYER_NAMES, VERDICT_NAMES, type Verdict } from '../../engine/model';
import type { ProjectNode } from '../../engine/schema';
import { catalog } from './data';
import { addEdge, removeEdge, removeNode, worstVerdict } from './edit';
import { fmt } from './format';
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
      <span className="chev" aria-hidden>›</span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { card: Card };

type FlowData = { text?: string; color: string };
/** 연결선: 글자(RPS 등)는 선 위쪽에 띄워 선·화살표와 겹치지 않게 한다 */
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data, selected }: EdgeProps<Edge<FlowData>>) {
  const [path, lx, ly] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <>
    <BaseEdge id={id} path={path} style={selected ? { ...style, stroke: '#e9edf3' } : style} markerEnd={markerEnd} interactionWidth={16} />
    {data?.text && (
      <EdgeLabelRenderer>
        <div className="edge-label" style={{ transform: `translate(-50%, -100%) translate(${lx}px, ${ly - 6}px)`, color: data.color }}>{data.text}</div>
      </EdgeLabelRenderer>
    )}
  </>;
}
const edgeTypes = { flow: FlowEdge };
const EDGE = { base: '#4c5870', bad: '#ff5a5a', read: '#2ec4a6', async: '#f5b301' };

/** layout: 패널을 접거나 펼 때 바뀌는 값. 바뀌면 넓어진(좁아진) 칸에 다이어그램을 다시 맞춘다 */
export function Canvas({ analysis, onSelect, layout }: { analysis?: Analysis; onSelect: () => void; layout?: string }) {
  const { project, positions, selected, edit, move, select, setFocus, flyTo, set } = useStore();
  const flow = useRef<ReactFlowInstance<Node<CardData>> | null>(null);
  // 찾기에서 고른 노드로 화면을 옮긴다
  useEffect(() => {
    if (!flyTo || !flow.current) return;
    flow.current.fitView({ nodes: [{ id: flyTo }], duration: 300, maxZoom: 1.2 });
    set({ flyTo: undefined });
  }, [flyTo, set]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    // 칸 크기가 바뀐 다음에 맞춘다
    const id = setTimeout(() => flow.current?.fitView({ duration: 250 }), 50);
    return () => clearTimeout(id);
  }, [layout]);

  const users = project.scale?.users;
  // 노드를 끄는 동안(위치만 바뀜)에는 아래 계산을 다시 하지 않는다
  const health = useMemo(() => new Map(project.nodes.map((n) => [n.id, healthOf(analysis, users, n.id)])), [project, analysis, users]);
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

  const edges = useMemo(() => {
    // 선 굵기 = 이 연결로 흐르는 평소 피크 요청 (엔진의 부하 전파와 같은 계산). 노드마다 호출 나눔(callSplit)은 한 번만
    const splits = new Map(project.nodes.map((n) => [n.id, callSplit(project, n)]));
    const flows = project.edges.map((e) => {
      const from = analysis?.nodes[e.from]?.load;
      return from ? edgeFlow(e, from, splits.get(e.from), 'normal').rps : 0;
    });
    const maxRps = Math.max(1, ...flows);
    return project.edges.map((e, i): Edge => {
      const rps = flows[i];
      const color = !e.sync ? EDGE.async : health.get(e.to)?.health === 'bad' ? EDGE.bad : e.carries === 'read' ? EDGE.read : EDGE.base;
      const label = [!e.sync ? `비동기${rps ? ` ${fmt(rps)} RPS` : ''}` : rps ? `${fmt(rps)} RPS` : '', e.carries === 'write' ? 'write' : e.carries === 'read' ? '읽기' : '', e.callRatio !== 1 ? `×${e.callRatio}` : '']
        .filter(Boolean).join(' ');
      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        type: 'flow',
        // 굵기 = 요청량 (1.5~4.5px). 비동기(점선)는 굵기로 양을 나타내지 않는다: 굵은 점선은 읽기 어렵다
        style: { stroke: color, strokeWidth: e.sync ? 1.5 + (3 * rps) / maxRps : 1.5, ...(e.sync ? {} : { strokeDasharray: '5 4' }) },
        data: { text: label || undefined, color: e.sync ? '#93a0b3' : EDGE.async },
        // 화살촉은 선 굵기와 상관없이 같은 크기. 그림이 viewBox 20칸 중 5칸이라 28이면 실제 약 7×11px로, 최대 4.5px 선보다 크다
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 28, height: 28, markerUnits: 'userSpaceOnUse' },
        selected: selected?.kind === 'edge' && selected.from === e.from && selected.to === e.to,
      };
    });
  }, [project, analysis, selected, health]);

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
        <span className="legend-hint">카드를 누르면 세부 구성이 열려요</span>
      </div>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode="dark"
        fitView
        onInit={(f) => { flow.current = f; }}
        onNodesChange={(changes) => {
          for (const c of changes) if (c.type === 'position' && c.position) move(c.id, c.position);
        }}
        onNodesDelete={(ns) => edit((p) => ns.reduce((acc, n) => removeNode(acc, n.id), p))}
        onEdgesDelete={(es) => edit((p) => es.reduce((acc, e) => removeEdge(acc, e.source, e.target), p))}
        onConnect={(c) => c.source && c.target && edit((p) => addEdge(p, c.source, c.target))}
        // 카드를 누르면 세부 구성이 열린다 (오른쪽 패널에는 그 노드 설정)
        onNodeClick={(_, n) => { setFocus(n.id); select({ kind: 'node', id: n.id }); onSelect(); }}
        onEdgeClick={(_, e) => { select({ kind: 'edge', from: e.source, to: e.target }); onSelect(); }}
        onPaneClick={() => select(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="#253041" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
