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
      const miss = readMiss(p, e);
      for (const s of ['normal', 'event'] as const) {
        const f = edgeFlow(e, from, split, s, miss);
        to.rps[s] += f.rps;
        to.writeRps[s] += f.write;
      }
    }
  }
  return loads;
}

/** 캐시 적중률을 정하지 않았을 때 쓰는 값 (예시값 — 실측 적중률로 바꾼다) */
export const DEFAULT_HIT_RATIO = 0.8;

/** 이 연결선의 읽기 중 실제로 도착하는 몫. 보내는 노드가 캐시도 부르면(캐시 먼저 보고 없을 때만 DB: cache-aside) DB로 가는 읽기는 (1 − 적중률)만 */
export function readMiss(p: Project, e: ProjectEdge): number {
  const layer = (id: string) => p.nodes.find((n) => n.id === id)?.layer;
  if (layer(e.to) !== 'db') return 1;
  const cache = p.edges.find((x) => x.from === e.from && x.sync && layer(x.to) === 'cache');
  return cache ? 1 - (p.nodes.find((n) => n.id === cache.to)!.hit_ratio ?? DEFAULT_HIT_RATIO) : 1;
}

/** 연결선 하나로 흐르는 요청과 그중 쓰기. 화면 와이어프레임에 API 호출이 있으면(split) 호출 비율대로, 없으면 carries × callRatio.
 *  miss: 읽기 중 도착하는 몫 (readMiss, 캐시가 앞에 있으면 1보다 작다). 쓰기는 그대로 간다 */
export function edgeFlow(e: ProjectEdge, from: NodeLoad, split: ReturnType<typeof callSplit>, s: 'normal' | 'event', miss = 1): { rps: number; write: number } {
  const w = from.writeRps[s], r = from.rps[s] - w;
  if (split) {
    const f = split.get(e.to) ?? { read: 0, write: 0 };
    return { rps: r * f.read * miss + w * f.write, write: w * f.write };
  }
  const reads = e.carries === 'write' ? 0 : r * miss, writes = e.carries === 'read' ? 0 : w;
  return { rps: (reads + writes) * e.callRatio, write: writes * e.callRatio };
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
      ...(l && {
        peak_rps: l.rps[s], peak_write_rps: l.writeRps[s],
        // 읽기 비율 (캐시가 맞는지 보는 값)
        ...(l.rps[s] > 0 && { read_ratio: 1 - l.writeRps[s] / l.rps[s] }),
        // 주 서버가 받는 부하: 읽기 복제본이 있으면 쓰기만, 없으면 전부 (single_primary DB의 판정에 쓴다)
        primary_rps: n.extras.includes('read_replica') ? l.writeRps[s] : l.rps[s],
      }),
    });
    return [n.id, { normal: at('normal'), event: at('event') }];
  }));
}
