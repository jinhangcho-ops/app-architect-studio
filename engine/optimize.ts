// 10절 최선 조합: 노드마다 주 항목 후보를 골라 조합하고, 꼭 지킬 조건을 만족하는 것 중 우선순위 점수가 가장 높은 안을 찾는다.
// 노드 10개 × 후보 10개면 전수 조사가 100억 가지라, 노드별 상위 후보만 남기고 빔 탐색으로 상위 K개 조합만 이어 간다.
import { analyze, type Analysis, type Data } from './analyze';
import { judgeItem } from './judge';
import type { CatalogItem, Project } from './schema';
import { traffic } from './traffic';

const GRADE: Record<string, number> = { 좋음: 2, 보통: 1, 나쁨: 0 };

/** 우선순위 목록 → 가중치: 1위 = 목표 수, 마지막 = 1. 비어 있으면 모든 목표 1 */
export function weightsFrom(priorities: string[], allGoals: string[]): Record<string, number> {
  if (!priorities.length) return Object.fromEntries(allGoals.map((g) => [g, 1]));
  return Object.fromEntries(priorities.map((g, i) => [g, priorities.length - i]));
}

/** 항목 점수 = Σ 가중치 × 등급(좋음 2·보통 1·나쁨 0). 항목에 등급이 없는 목표는 보통(1)으로 본다 */
export const itemScore = (item: CatalogItem, w: Record<string, number>) =>
  Object.entries(w).reduce((s, [g, wt]) => s + wt * (GRADE[item.goals[g]] ?? 1), 0);

export type PlanMetrics = { cost?: number; limitUsers?: number; p99?: number; availability?: number };
export type Plan = {
  /** 노드 id → 주 항목 id (바뀐 노드만이 아니라 최적화 대상 전부) */
  assignment: Record<string, string>;
  score: number;
  metrics: PlanMetrics;
  violations: string[];
  analysis: Analysis;
};
export type OptimizeResult = {
  /** 지금 설계 (비교 기준) */
  current: Plan;
  best?: Plan;
  cheapest?: Plan;
  scalable?: Plan;
  /** 평가한 모든 조합 (비용–확장 그래프용) */
  evaluated: Plan[];
  /** 답이 없을 때 어떤 조건을 얼마나 풀면 되는지 */
  relax: string[];
};

function metricsOf(a: Analysis): PlanMetrics {
  const p99s = a.paths.flatMap((x) => (x.p99 ? [x.p99.value] : []));
  const avs = a.paths.map((x) => x.availability.value);
  return {
    // 계량값이나 가격이 빠진 조합은 합계가 실제보다 작게 나오므로 비용을 '모름'으로 둔다
    cost: a.cost && !a.cost.missing.length ? a.cost.total?.value : undefined,
    limitUsers: a.bottleneck?.limitUsers.value,
    p99: p99s.length ? Math.max(...p99s) : undefined,
    availability: avs.length ? Math.min(...avs) : undefined,
  };
}

/** 조건을 어긴 이유. 값을 계산할 수 없는데 조건이 있으면 그것도 어긴 것으로 본다(모르면 통과시키지 않음). */
function violationsOf(p: Project, m: PlanMetrics, a: Analysis): string[] {
  const c = p.optimize;
  const out: string[] = [];
  const fails = a.judgements.flatMap((j) => j.items.filter((i) => i.verdict === 'fail').map(() => j.nodeId));
  if (fails.length) out.push(`안 됨 판정: ${[...new Set(fails)].join(', ')}`);
  if (c.budget_monthly !== undefined && !(m.cost !== undefined && m.cost <= c.budget_monthly)) out.push('예산');
  if (c.min_limit_users !== undefined && m.limitUsers !== undefined && m.limitUsers < c.min_limit_users) out.push('한계 사용자');
  if (c.max_p99_ms !== undefined && !(m.p99 !== undefined && m.p99 <= c.max_p99_ms)) out.push('p99');
  if (c.min_availability !== undefined && !(m.availability !== undefined && m.availability >= c.min_availability)) out.push('가용성');
  return out;
}

const withAssignment = (p: Project, as: Record<string, string>): Project =>
  ({ ...p, nodes: p.nodes.map((n) => (as[n.id] ? { ...n, primary: as[n.id] } : n)) });

export function optimize(p: Project, d: Data, today: string, opts: { beam?: number; perNode?: number } = {}): OptimizeResult {
  const beam = opts.beam ?? 30;
  const perNode = opts.perNode ?? 3;
  const t = traffic(p);
  const run = (as: Record<string, string>) => analyze(withAssignment(p, as), d, today, { traffic: t });
  const base = run({});
  const items = [...d.catalog.values()];
  const w = weightsFrom(p.optimize.priorities, [...new Set(items.flatMap((i) => Object.keys(i.goals)))]);

  // 노드별 후보: 지금 항목과 같은 종류(패턴↔패턴, 도구↔도구, 알고리즘↔알고리즘)의 주 항목 중
  // 지금 부하에서 '안 됨'이 아닌 것, 점수 상위 perNode개 + 지금 항목
  const targets = p.nodes.filter((n) => n.primary && d.catalog.has(n.primary));
  const candidates = targets.map((n) => {
    const s = base.scenarios[n.id];
    const kind = d.catalog.get(n.primary!)!.kind;
    const ok = items
      .filter((i) => i.role === '주' && i.kind === kind && i.attaches_to.includes(n.layer) && judgeItem(i, n, s).verdict !== 'fail')
      .sort((a, b) => itemScore(b, w) - itemScore(a, w))
      .slice(0, perNode)
      .map((i) => i.id);
    return { node: n.id, ids: [...new Set([n.primary!, ...ok])] };
  });

  // 빔 탐색: 항목 점수의 합으로 부분 조합을 줄여 나간다
  let partial: { as: Record<string, string>; score: number }[] = [{ as: {}, score: 0 }];
  for (const c of candidates) {
    partial = partial
      .flatMap((x) => c.ids.map((id) => ({ as: { ...x.as, [c.node]: id }, score: x.score + itemScore(d.catalog.get(id)!, w) })))
      .sort((a, b) => b.score - a.score)
      .slice(0, beam);
  }
  // 지금 설계도 늘 비교 대상에 넣는다
  const current = Object.fromEntries(targets.map((n) => [n.id, n.primary!]));
  if (!partial.some((x) => targets.every((n) => x.as[n.id] === current[n.id]))) {
    partial.push({ as: current, score: targets.reduce((s, n) => s + itemScore(d.catalog.get(n.primary!)!, w), 0) });
  }

  const evaluated: Plan[] = partial.map(({ as, score }) => {
    const analysis = run(as);
    const metrics = metricsOf(analysis);
    return { assignment: as, score, metrics, violations: violationsOf(p, metrics, analysis), analysis };
  });
  const feasible = evaluated.filter((x) => !x.violations.length);
  const pick = (cmp: (a: Plan, b: Plan) => number) => [...feasible].sort(cmp)[0];
  // 한계를 모르는 조합(기준값이 없어 판정이 끝까지 안 넘어감)은 '무한'이 아니라 알려진 한계보다 뒤로 둔다
  const lim = (x: Plan) => x.metrics.limitUsers ?? -1;
  const cost = (x: Plan) => x.metrics.cost ?? Infinity;

  return {
    current: evaluated.find((x) => targets.every((n) => x.assignment[n.id] === current[n.id]))!,
    best: pick((a, b) => b.score - a.score || cost(a) - cost(b)),
    cheapest: feasible.some((x) => x.metrics.cost !== undefined) ? pick((a, b) => cost(a) - cost(b) || b.score - a.score) : undefined,
    scalable: pick((a, b) => lim(b) - lim(a) || b.score - a.score),
    evaluated,
    relax: feasible.length ? [] : relaxations(p, evaluated),
  };
}

/** 조건 하나만 어긴 조합 중에서, 그 조건을 가장 적게 풀면 되는 양을 알려준다. */
function relaxations(p: Project, plans: Plan[]): string[] {
  const c = p.optimize;
  const only = (name: string) => plans.filter((x) => x.violations.length === 1 && x.violations[0] === name);
  const out: string[] = [];
  const best = <T>(xs: T[], f: (x: T) => number | undefined, dir: 1 | -1) =>
    xs.map(f).filter((v): v is number => v !== undefined).sort((a, b) => dir * (a - b))[0];
  const cost = best(only('예산'), (x) => x.metrics.cost, 1);
  if (c.budget_monthly !== undefined && cost !== undefined) out.push(`예산을 월 ${Math.ceil(cost - c.budget_monthly).toLocaleString('ko-KR')}만큼 늘리면 가능`);
  const lim = best(only('한계 사용자'), (x) => x.metrics.limitUsers, -1);
  if (c.min_limit_users !== undefined && lim !== undefined) out.push(`목표 한계 사용자를 ${Math.floor(lim).toLocaleString('ko-KR')}명으로 낮추면 가능`);
  const p99 = best(only('p99'), (x) => x.metrics.p99, 1);
  if (c.max_p99_ms !== undefined && p99 !== undefined && Number.isFinite(p99)) out.push(`p99 상한을 ${Math.ceil(p99)}ms로 올리면 가능`);
  const av = best(only('가용성'), (x) => x.metrics.availability, -1);
  if (c.min_availability !== undefined && av !== undefined) out.push(`가용성 하한을 ${(av * 100).toFixed(2)}%로 낮추면 가능`);
  if (!out.length) out.push('조건 하나만 풀어서 되는 조합이 없습니다. 노드 구성이나 이중화를 바꿔 보세요');
  return out;
}
