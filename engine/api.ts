// 와이어프레임의 API 호출: 화면 노드에서 나가는 부하를 호출 비율대로 나눈다.
// GET 호출이 읽기 요청을, 나머지(POST·PUT·PATCH·DELETE)가 쓰기 요청을 접속당 횟수 비율로 나눠 갖는다.
// 연결선이 없는 대상으로 가는 호출은 빼고(구조도와 어긋나지 않게), 호출이 하나도 남지 않으면 연결선의 callRatio를 그대로 쓴다.
import type { Metric } from './model';
import type { Project, ProjectNode, WireItem } from './schema';

export type ApiCall = { node: string; screen: string; item: string; label: string; method: string; path: string; to: string; perSession: number };
export type ApiLoad = ApiCall & { rps: Metric; rpsEvent: Metric };
type Split = Map<string, { read: number; write: number }>;

/** 노드 와이어프레임의 대상이 정해진 호출 전부 */
export function apiCallsOf(n: ProjectNode): ApiCall[] {
  return (n.wireframe?.screens ?? []).flatMap((s) => s.items.filter((i): i is WireItem & { api: NonNullable<WireItem['api']> & { to: string } } => !!i.api?.to)
    .map((i) => ({ node: n.id, screen: s.name, item: i.id, label: i.label, method: i.api.method, path: i.api.path, to: i.api.to, perSession: i.api.per_session })));
}

/** 연결선이 있는 대상으로 가는 호출만 */
export const routedCalls = (p: Project, n: ProjectNode) => {
  const outs = new Set(p.edges.filter((e) => e.from === n.id).map((e) => e.to));
  return apiCallsOf(n).filter((c) => outs.has(c.to));
};

const isRead = (c: ApiCall) => c.method === 'GET';

/** 호출마다 읽기·쓰기 요청 중 가져가는 몫. 읽기(또는 쓰기) 호출이 없으면 모든 호출이 나눠 갖는다 */
function shares(calls: ApiCall[]): Map<ApiCall, { read: number; write: number }> {
  const part = (xs: ApiCall[]) => {
    const sum = xs.reduce((s, c) => s + c.perSession, 0);
    return new Map(xs.map((c) => [c, sum > 0 ? c.perSession / sum : 1 / xs.length]));
  };
  const reads = calls.filter(isRead), writes = calls.filter((c) => !isRead(c));
  const r = part(reads.length ? reads : calls), w = part(writes.length ? writes : calls);
  return new Map(calls.map((c) => [c, { read: r.get(c) ?? 0, write: w.get(c) ?? 0 }]));
}

/** 대상 노드별 몫. 호출이 없으면 undefined (연결선 callRatio를 쓴다) */
export function callSplit(p: Project, n: ProjectNode): Split | undefined {
  const calls = routedCalls(p, n);
  if (!calls.length) return undefined;
  const out: Split = new Map();
  for (const [c, s] of shares(calls)) {
    const cur = out.get(c.to) ?? { read: 0, write: 0 };
    out.set(c.to, { read: cur.read + s.read, write: cur.write + s.write });
  }
  return out;
}

const m = (value: number, formula: string, inputs: Record<string, number>): Metric => ({ value, unit: 'RPS', formula, inputs });

/** 호출별 피크 RPS: 화면 노드의 읽기(또는 쓰기) 피크 × 이 호출의 몫 */
export function apiLoads(p: Project, loads: Map<string, { rps: { normal: number; event: number }; writeRps: { normal: number; event: number } }>): ApiLoad[] {
  return p.nodes.filter((n) => n.layer === 'ui').flatMap((n) => {
    const l = loads.get(n.id);
    if (!l) return [];
    return [...shares(routedCalls(p, n))].map(([c, s]) => {
      const at = (k: 'normal' | 'event') => {
        const w = l.writeRps[k], r = l.rps[k] - w;
        return isRead(c)
          ? m(r * s.read + w * s.write, '화면 읽기 피크 × 이 호출 몫 (+ 쓰기 호출이 없을 때 쓰기 몫)', { 읽기: r, 몫: s.read })
          : m(w * s.write + r * s.read, '화면 쓰기 피크 × 이 호출 몫 (+ 읽기 호출이 없을 때 읽기 몫)', { 쓰기: w, 몫: s.write });
      };
      return { ...c, rps: at('normal'), rpsEvent: at('event') };
    });
  });
}
