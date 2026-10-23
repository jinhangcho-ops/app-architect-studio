// v2의 플로우차트 자동 배치: 들어오는 연결이 없는 노드에서 시작해, 가장 긴 경로 순서로 단계(열)를 매긴다.
import type { Project } from '../../engine/schema';

export type XY = { x: number; y: number };
const COL = 280, ROW = 150;

export function autoLayout(p: Project): Record<string, XY> {
  const stage = new Map(p.nodes.map((n) => [n.id, 0]));
  const indeg = new Map(p.nodes.map((n) => [n.id, 0]));
  for (const e of p.edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue = p.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of p.edges.filter((x) => x.from === id)) {
      stage.set(e.to, Math.max(stage.get(e.to)!, stage.get(id)! + 1));
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  // 순환에 걸린 노드는 위 반복에서 단계가 덜 정해질 수 있지만, 그대로 둬도 겹치지 않게 행으로 나눈다
  const rowOf = new Map<number, number>();
  const out: Record<string, XY> = {};
  for (const n of p.nodes) {
    const s = stage.get(n.id)!;
    const r = rowOf.get(s) ?? 0;
    rowOf.set(s, r + 1);
    out[n.id] = { x: s * COL, y: r * ROW };
  }
  return out;
}
