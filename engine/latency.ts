// 12절 지연시간: 노드를 M/M/c 대기열로 보고 p99를 추정, 동기 경로를 따라 더한다(보수적 상한).
import type { Metric } from './model';
import type { Project } from './schema';

/** 얼랑 C(대기할 확률). 얼랑 B 점화식으로 계산해 c가 커도 넘치지 않는다. a = λ/μ */
export function erlangC(c: number, a: number): number {
  if (a >= c) return 1;
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return (c * b) / (c - a * (1 - b));
}

/** 대기열이 끝없이 길어지면(ρ ≥ 1) value = Infinity. */
export function nodeP99(lambda: number, serviceMs: number, c: number, serviceP99Ms?: number): Metric {
  const mu = 1000 / serviceMs; // 초당 처리 수
  const a = lambda / mu;
  const rho = a / c;
  const s99 = serviceP99Ms ?? serviceMs * Math.log(100); // 실측이 없으면 지수분포 가정
  const inputs = { λ: lambda, S_ms: serviceMs, c, ρ: rho };
  if (rho >= 1) return { value: Infinity, unit: 'ms', formula: 'ρ ≥ 1: 대기열이 끝없이 길어짐', inputs };
  const C = erlangC(c, a);
  const wait = (Math.max(0, Math.log(C / 0.01)) / (c * mu - lambda)) * 1000;
  return { value: wait + s99, unit: 'ms', formula: 'max(0, ln(C/0.01))/(cμ−λ) + S₉₉', inputs: { ...inputs, C, 대기_ms: wait, S99_ms: s99 } };
}

/** 화면 노드에서 출발해 동기 연결선만 따라간 경로들. 비동기 연결에서 경로가 끊긴다. */
export function syncPaths(p: Project): string[][] {
  const out: string[][] = [];
  const walk = (path: string[]) => {
    const next = p.edges.filter((e) => e.from === path.at(-1) && e.sync && !path.includes(e.to));
    if (!next.length) out.push(path);
    for (const e of next) walk([...path, e.to]);
  };
  for (const n of p.nodes.filter((x) => x.layer === 'ui')) walk([n.id]);
  return out;
}

/** 경로 p99 ≈ Σ 노드 p99 + Σ 구간 RTT. p99를 모르는 노드는 0으로 두고 inputs에 남긴다. */
export function pathP99(p: Project, path: string[], nodeP99s: Map<string, Metric>): Metric {
  let total = 0, rtt = 0;
  const inputs: Record<string, number> = {};
  for (const id of path) {
    const v = nodeP99s.get(id)?.value;
    if (v !== undefined) { total += v; inputs[id] = v; }
  }
  for (let i = 1; i < path.length; i++) rtt += p.edges.find((e) => e.from === path[i - 1] && e.to === path[i])!.rtt_ms;
  return { value: total + rtt, unit: 'ms', formula: 'Σ 노드 p99 + Σ 구간 RTT (보수적 상한)', inputs: { ...inputs, RTT_ms: rtt } };
}
