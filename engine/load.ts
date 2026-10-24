// 노드별 부하: 화면 노드에서 시작해 연결선을 위상 정렬 순서로 따라가며 λ × callRatio를 더해 내려간다.
import { callSplit } from './api';
import { deployVars } from './deploy';
import type { Scenario } from './judge';
import { entryNodes, type Project, type ProjectEdge } from './schema';
import type { Traffic } from './traffic';

type Pair = { normal: number; event: number };
export type NodeLoad = { rps: Pair; writeRps: Pair };

export function nodeLoads(p: Project, t: Traffic): Map<string, NodeLoad> {
  const loads = new Map<string, NodeLoad>(p.nodes.map((n) => [n.id, {
    rps: { normal: 0, event: 0 },
    writeRps: { normal: 0, event: 0 },
  }]));

  const entries = entryNodes(p);
  for (const n of entries) {
    const share = n.entry_share ?? 1 / entries.length;
    const l = loads.get(n.id)!;
    l.rps = { normal: t.peakRps.value * share, event: t.peakRpsEvent.value * share };
    l.writeRps = { normal: t.peakWriteRps.value * share, event: t.peakWriteRpsEvent.value * share };
  }

  for (const id of topoOrder(p)) {
    const from = loads.get(id)!;
    const split = callSplit(p, p.nodes.find((n) => n.id === id)!);
    for (const e of p.edges.filter((x) => x.from === id)) {
      const to = loads.get(e.to)!;
      for (const s of ['normal', 'event'] as const) {
        const f = edgeFlow(e, from, split, s);
        to.rps[s] += f.rps;
        to.writeRps[s] += f.write;
      }
    }
  }
  return loads;
}

/** 연결선 하나로 흐르는 요청과 그중 쓰기. 화면 와이어프레임에 API 호출이 있으면(split) 호출 비율대로, 없으면 carries × callRatio */
export function edgeFlow(e: ProjectEdge, from: NodeLoad, split: ReturnType<typeof callSplit>, s: 'normal' | 'event'): { rps: number; write: number } {
  const w = from.writeRps[s];
  if (split) {
    const f = split.get(e.to) ?? { read: 0, write: 0 };
    return { rps: (from.rps[s] - w) * f.read + w * f.write, write: w * f.write };
  }
  const r = e.carries === 'all' ? from.rps[s] : e.carries === 'write' ? w : from.rps[s] - w;
  return { rps: r * e.callRatio, write: e.carries === 'read' ? 0 : w * e.callRatio };
}

/** Kahn 위상 정렬. 순환 연결이 있으면 부하가 끝없이 불어나므로 오류로 멈춘다. */
function topoOrder(p: Project): string[] {
  const indeg = new Map(p.nodes.map((n) => [n.id, 0]));
  for (const e of p.edges) indeg.set(e.to, indeg.get(e.to)! + 1);
  const queue = p.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const e of p.edges.filter((x) => x.from === id)) {
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  if (order.length !== p.nodes.length) {
    const stuck = p.nodes.filter((n) => !order.includes(n.id)).map((n) => n.name);
    throw new Error(`순환 연결이 있어 부하를 계산할 수 없음: ${stuck.join(', ')}`);
  }
  return order;
}

/** 계산한 부하(nodeLoads)와 구동 방식을 노드의 판정 변수로 바꾼다. 트래픽이 없으면 구동 방식 변수만 준다. */
export function computedScenarios(p: Project, loads: Map<string, NodeLoad> | undefined): Map<string, Scenario> {
  const common = deployVars(p.deploy);
  return new Map(p.nodes.map((n) => {
    const l = loads?.get(n.id);
    const at = (s: 'normal' | 'event') => ({
      ...common,
      writer_nodes: new Set(p.edges.filter((e) => e.to === n.id && e.carries !== 'read').map((e) => e.from)).size,
      ...(l && { peak_rps: l.rps[s], peak_write_rps: l.writeRps[s] }),
    });
    return [n.id, { normal: at('normal'), event: at('event') }];
  }));
}
