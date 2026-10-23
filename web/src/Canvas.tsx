import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import type { Analysis } from '../../engine/analyze';
import { LAYER_NAMES, VERDICT_NAMES, type Verdict } from '../../engine/model';
import type { ProjectNode } from '../../engine/schema';
import { catalog } from './data';
import { addEdge, removeEdge, removeNode, worstVerdict } from './edit';
import { fmt } from './format';
import { canEnter } from './NodeInside';
import { useStore } from './store';

type CardData = { node: ProjectNode; verdict?: Verdict; detail?: string; spof: boolean };

function Card({ data, selected }: NodeProps<Node<CardData>>) {
  const { node, verdict, detail, spof } = data;
  const item = node.primary ? catalog.byId.get(node.primary)?.name : undefined;
  return (
    <div className={`card v-${verdict ?? 'none'} ${selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="card-head">
        <span className="layer">{LAYER_NAMES[node.layer]}</span>
        {verdict && <span className="badge">{VERDICT_NAMES[verdict]}</span>}
      </div>
      <div className="card-name">{node.name}</div>
      <div className="card-item">{item ?? '항목 없음'}{node.extras.length ? ` +${node.extras.length}` : ''}</div>
      {detail && <div className="card-detail">{detail}</div>}
      {spof && <div className="card-spof">단일 장애점</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { card: Card };

export function Canvas({ analysis, onSelect }: { analysis?: Analysis; onSelect: () => void }) {
  const { project, positions, selected, edit, move, select, setFocus } = useStore();

  const nodes: Node<CardData>[] = project.nodes.map((n) => {
    const na = analysis?.nodes[n.id];
    const parts = [
      na?.load && `피크 ${fmt(na.load.rps.normal)} / ${fmt(na.load.rps.event)} RPS`,
      na?.instances && `${na.instances.event.value}대`,
      na?.p99 && `p99 ${fmt(na.p99.event.value)}ms`,
    ].filter(Boolean);
    return {
      id: n.id,
      type: 'card',
      position: positions[n.id] ?? { x: 0, y: 0 },
      selected: selected?.kind === 'node' && selected.id === n.id,
      data: {
        node: n,
        verdict: worstVerdict(analysis?.judgements.find((j) => j.nodeId === n.id)),
        detail: parts.join(' · '),
        spof: !!analysis?.spof.includes(n.id),
      },
    };
  });

  const edges: Edge[] = project.edges.map((e) => ({
    id: `${e.from}->${e.to}`,
    source: e.from,
    target: e.to,
    animated: !e.sync,
    style: e.sync ? undefined : { strokeDasharray: '6 4' },
    label: [e.sync ? '' : '비동기', e.callRatio !== 1 ? `×${e.callRatio}` : '', e.carries !== 'all' ? e.carries : ''].filter(Boolean).join(' ') || undefined,
    markerEnd: { type: MarkerType.ArrowClosed },
    selected: selected?.kind === 'edge' && selected.from === e.from && selected.to === e.to,
  }));

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      fitView
      onNodesChange={(changes) => {
        for (const c of changes) if (c.type === 'position' && c.position) move(c.id, c.position);
      }}
      onNodesDelete={(ns) => edit((p) => ns.reduce((acc, n) => removeNode(acc, n.id), p))}
      onEdgesDelete={(es) => edit((p) => es.reduce((acc, e) => removeEdge(acc, e.source, e.target), p))}
      onConnect={(c) => c.source && c.target && edit((p) => addEdge(p, c.source, c.target))}
      onNodeClick={(_, n) => { select({ kind: 'node', id: n.id }); onSelect(); }}
      // 테이블을 두는 블록(DB·캐시·분석)은 두 번 누르면 안쪽 다이어그램으로 들어간다
      onNodeDoubleClick={(_, n) => { if (canEnter(project.nodes.find((x) => x.id === n.id)?.layer)) setFocus(n.id); }}
      onEdgeClick={(_, e) => { select({ kind: 'edge', from: e.source, to: e.target }); onSelect(); }}
      onPaneClick={() => select(null)}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
