// 11.2 3D 계층 뷰: 끌어서 회전. 큐브 색 = 판정, 겹친 큐브 수 = 이벤트 피크 필요 대수(최대 5), 단일 장애점은 빨간 테두리.
import { useRef, useState } from 'react';
import type { Analysis } from '../../engine/analyze';
import { LAYER_NAMES, type Layer, type Verdict } from '../../engine/model';
import { worstVerdict } from './edit';
import { project3d, TIER_Z, worldPositions } from './projection';
import { usePick } from './store';

const COLOR: Record<Verdict | 'none', string> = { ok: '#1f9d55', conditional: '#d98a00', fail: '#d13b3b', unknown: '#7a7f8a', none: '#9aa3ae' };
const W = 120, H = 34, D = 60; // 큐브 가로·높이·깊이

export function View3D({ analysis, onSelect }: { analysis?: Analysis; onSelect: () => void }) {
  const { project, select } = usePick('project', 'select');
  const [rot, setRot] = useState({ yaw: -32, pitch: 24 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const pos = worldPositions(project);
  const P = (x: number, y: number, z: number) => project3d(x, y, z, rot.yaw, rot.pitch, 0.9);
  const poly = (pts: [number, number, number][]) => pts.map((q) => `${q[0]},${q[1]}`).join(' ');

  // 레이어 깊이마다 바닥판 하나
  const tiers = [...new Set(project.nodes.map((n) => TIER_Z[n.layer]))].sort((a, b) => b - a);
  const slabs = tiers.map((z) => {
    const y = -z * 0.32 + H;
    const layers = (Object.keys(TIER_Z) as Layer[]).filter((l) => TIER_Z[l] === z && project.nodes.some((n) => n.layer === l));
    return { z, pts: [P(-620, y, z - 45), P(620, y, z - 45), P(620, y, z + 45), P(-620, y, z + 45)], label: P(-600, y, z + 45), name: layers.map((l) => LAYER_NAMES[l]).join(' · ') };
  });

  const cubes = project.nodes.map((n) => {
    const [x, y, z] = pos[n.id];
    const v: Verdict | 'none' = worstVerdict(analysis?.judgements.find((j) => j.nodeId === n.id)) ?? 'none';
    const count = Math.min(5, Math.max(1, analysis?.nodes[n.id]?.instances?.event.value ?? 1));
    return { n, x, y, z, v, count, depth: P(x, y, z)[2], spof: !!analysis?.spof.includes(n.id) };
  }).sort((a, b) => b.depth - a.depth);

  const center = (id: string) => { const [x, y, z] = pos[id]; return P(x, y, z); };

  return (
    <svg
      className="view3d" viewBox="0 0 1040 680" role="img" aria-label="3D 계층 뷰"
      onPointerDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; (e.target as Element).setPointerCapture?.(e.pointerId); }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x, dy = e.clientY - drag.current.y;
        drag.current = { x: e.clientX, y: e.clientY };
        setRot((r) => ({ yaw: r.yaw + dx * 0.4, pitch: Math.max(-80, Math.min(80, r.pitch + dy * 0.4)) }));
      }}
      onPointerUp={() => { drag.current = null; }}
    >
      {slabs.map((s) => (
        <g key={s.z}>
          <polygon points={poly(s.pts)} className="slab" />
          <text x={s.label[0]} y={s.label[1] + 14} className="slab-label">{s.name}</text>
        </g>
      ))}
      {project.edges.map((e) => {
        const a = center(e.from), b = center(e.to);
        return <line key={`${e.from}->${e.to}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={e.sync ? 'edge3d' : 'edge3d async'} />;
      })}
      {cubes.map(({ n, x, y, z, v, count, spof }) => (
        <g key={n.id} className="cube" onClick={() => { select({ kind: 'node', id: n.id }); onSelect(); }}>
          {Array.from({ length: count }, (_, k) => {
            const ox = x - W / 2 + k * 10, oy = y - k * 8;
            const top = [P(ox, oy, z - D / 2), P(ox + W, oy, z - D / 2), P(ox + W, oy, z + D / 2), P(ox, oy, z + D / 2)];
            const front = [P(ox, oy, z - D / 2), P(ox + W, oy, z - D / 2), P(ox + W, oy + H, z - D / 2), P(ox, oy + H, z - D / 2)];
            const side = [P(ox + W, oy, z - D / 2), P(ox + W, oy, z + D / 2), P(ox + W, oy + H, z + D / 2), P(ox + W, oy + H, z - D / 2)];
            return (
              <g key={k}>
                <polygon points={poly(side)} fill={COLOR[v]} opacity={0.55} stroke={spof ? COLOR.fail : '#0003'} />
                <polygon points={poly(front)} fill={COLOR[v]} opacity={0.75} stroke={spof ? COLOR.fail : '#0003'} />
                <polygon points={poly(top)} fill={COLOR[v]} opacity={0.95} stroke={spof ? COLOR.fail : '#0003'} />
              </g>
            );
          })}
          <text x={P(x, y - 8 * count, z)[0]} y={P(x, y - 8 * count, z)[1] - 6} className="cube-label">{n.name}{count > 1 ? ` ×${count}` : ''}</text>
        </g>
      ))}
      <text x={12} y={668} className="slab-label">끌어서 회전 · 색 = 판정 · 겹친 수 = 이벤트 피크 필요 대수(최대 5) · 빨간 테두리 = 단일 장애점</text>
    </svg>
  );
}
