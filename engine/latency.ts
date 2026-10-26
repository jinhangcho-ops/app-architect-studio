// 12절 지연시간: 노드를 M/M/c 대기열로 보고 p99를 추정, 동기 경로를 따라 더한다(보수적 상한).
import type { Metric } from './model';
import { entryNodes, type Project } from './schema';

/** 얼랑 C(대기할 확률). 얼랑 B 점화식으로 계산해 c가 커도 넘치지 않는다. a = λ/μ */
export function erlangC(c: number, a: number): number {
  if (a >= c) return 1;
  // 점화식은 c번 돌아 c가 수십만이면 편집마다 몇 초가 걸린다. c가 크면 Halfin–Whitt 근사(오차 수 %)로 바로 구한다
  if (c > 1000) {
    const beta = (c - a) / Math.sqrt(a);
    return 1 / (1 + (beta * normalCdf(beta)) / Math.exp(-0.5 * beta * beta) * Math.sqrt(2 * Math.PI));
  }
  let b = 1;
  for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b);
  return (c * b) / (c - a * (1 - b));
}

/** 표준정규 누적분포 (Abramowitz–Stegun 7.1.26, 오차 1e-7) */
function normalCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const erf = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** 대기열이 끝없이 길어지면(ρ ≥ 1) value = Infinity. */
export function nodeP99(lambda: number, serviceMs: number, c: number, serviceP99Ms?: number): Metric {
  const mu = 1000 / serviceMs; // 초당 처리 수
  const a = lambda / mu;
  const rho = a / c;
  const s99 = serviceP99Ms ?? serviceMs * Math.log(100); // 실측이 없으면 지수분포 가정
  const inputs = { λ: lambda, S_ms: serviceMs, c, ρ: rho };
  if (!lambda) return { value: s99, unit: 'ms', formula: '부하 0: 대기 없이 처리 시간만', inputs: { ...inputs, S99_ms: s99 } };
  if (rho >= 1) return { value: Infinity, unit: 'ms', formula: 'ρ ≥ 1: 대기열이 끝없이 길어짐', inputs };
  const C = erlangC(c, a);
  const wait = (Math.max(0, Math.log(C / 0.01)) / (c * mu - lambda)) * 1000;
  return { value: wait + s99, unit: 'ms', formula: 'max(0, ln(C/0.01))/(cμ−λ) + S₉₉', inputs: { ...inputs, C, 대기_ms: wait, S99_ms: s99 } };
}

// shortcut: 경로가 이보다 많으면(깊은 사슬에서 갈래마다 두 배) 앞쪽 경로만 본다. 가장 나쁜 경로를 놓칠 수 있어 화면에 알린다. 그런 설계가 흔해지면 노드별 최악값을 동적 계획으로 구한다
export const MAX_PATHS = 500;
export const PATHS_CUT_TEXT = `동기 경로가 ${MAX_PATHS}개를 넘어 앞쪽 ${MAX_PATHS}개만 계산했어요 (가장 느린 경로·단일 장애점을 놓칠 수 있음)`;

/** 화면 노드에서 출발해 동기 연결선만 따라간 경로들. 비동기 연결에서 경로가 끊긴다. MAX_PATHS + 1개에서 멈춘다(넘었는지 알 수 있게). */
export function syncPaths(p: Project): string[][] {
  const out: string[][] = [];
  const walk = (path: string[]) => {
    if (out.length > MAX_PATHS) return;
    const next = p.edges.filter((e) => e.from === path.at(-1) && e.sync && !path.includes(e.to));
    if (!next.length) out.push(path);
    for (const e of next) walk([...path, e.to]);
  };
  for (const n of entryNodes(p)) walk([n.id]);
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
