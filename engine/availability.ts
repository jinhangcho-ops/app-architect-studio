// 13절 가용성: 노드 = 1 − (1 − a)^n, 경로 = 노드 곱(장애가 서로 독립이라고 가정).
import type { Metric } from './model';
import { entryNodes, type Project, type ProjectNode } from './schema';

export const nodeAvailability = (a: number, replicas: number) => 1 - (1 - a) ** replicas;

export function pathAvailability(nodeAs: number[]): Metric {
  const value = nodeAs.reduce((s, x) => s * x, 1);
  return { value, unit: '비율', formula: 'Π 노드 가용성', inputs: { 노드수: nodeAs.length } };
}

export const monthlyDowntimeHours = (availability: number): Metric =>
  ({ value: (1 - availability) * 720, unit: '시간/월', formula: '(1 − 가용성) × 720시간', inputs: { 가용성: availability } });

/** 부하와 무관하게 늘 떠 있는 대수: max(1, 이중화, 최소 대수)를 최대 대수로 자른 것 (장애 시나리오도 같은 상한) */
export const standingInstances = (n: ProjectNode, max = Infinity) => Math.min(max, Math.max(1, n.replicas, n.min_instances));

/** 동기 경로 위에 있고 늘 떠 있는 대수가 1대인 노드. maxOf: 노드의 최대 대수 */
export function singlePointsOfFailure(p: Project, paths: string[][], maxOf?: (n: ProjectNode) => number): string[] {
  const onPath = new Set(paths.flat());
  return p.nodes.filter((n) => onPath.has(n.id) && standingInstances(n, maxOf?.(n)) === 1 && n.layer !== 'ui').map((n) => n.id);
}

/** 노드들이 멈추면 각 화면이 멈추는지(멈춘 노드 하나에라도 동기로 닿음), 반영이 늦어지는지(비동기를 거쳐서만 닿음). */
export function impactOf(p: Project, failed: string[]): Record<string, 'stopped' | 'delayed'> {
  const out: Record<string, 'stopped' | 'delayed'> = {};
  for (const ui of entryNodes(p)) {
    // 너비 우선으로 화면에서 닿는 노드마다 "동기로만 왔는지"를 기록한다
    const best = new Map<string, boolean>([[ui.id, true]]);
    const queue = [ui.id];
    while (queue.length) {
      const id = queue.shift()!;
      for (const e of p.edges.filter((x) => x.from === id)) {
        const sync = best.get(id)! && e.sync;
        if (!best.has(e.to) || (sync && !best.get(e.to))) {
          best.set(e.to, sync);
          queue.push(e.to);
        }
      }
    }
    const hit = failed.filter((id) => best.has(id));
    if (hit.length) out[ui.id] = hit.some((id) => best.get(id)) ? 'stopped' : 'delayed';
  }
  return out;
}
