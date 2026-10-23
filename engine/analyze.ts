// 분석의 유일한 입구. 정해진 순서로 계산하고, 판정은 모든 계산값을 변수로 받아 맨 마지막에 한다.
// deploy → traffic → load → calibrate/capacity → latency·availability·cost → limits → growth → judge
import { monthlyDowntimeHours, nodeAvailability, pathAvailability, singlePointsOfFailure } from './availability';
import { calibrate } from './calibrate';
import { hourlyInstances, instancesNeeded } from './capacity';
import { monthlyCost, type CostResult } from './cost';
import { enabled } from './deploy';
import { timeline, usersAt, type Milestone } from './growth';
import { checkRules, judgeNode, mergeScenario, type NodeJudgement, type RuleHit, type Scenario } from './judge';
import { nodeP99, pathP99, syncPaths } from './latency';
import { limitFactor } from './limits';
import { computedScenarios, nodeLoads, type NodeLoad } from './load';
import type { Metric } from './model';
import { checkRegulation, type LawHit } from './regulation';
import type { CatalogItem, LawRow, PriceRow, Project, ProjectNode, Rule } from './schema';
import { traffic, type Traffic } from './traffic';

export type NodeAnalysis = {
  load?: NodeLoad;
  /** 대당 처리량(주 항목의 rps 기준값을 사양·실측으로 보정) */
  perInstanceRps?: Metric;
  instances?: { normal: Metric; event: Metric };
  utilization?: { normal: Metric; event: Metric };
  p99?: { normal: Metric; event: Metric };
  availability: Metric;
  /** 이벤트 피크 기준 '안 됨'이 되는 사용자 수 */
  limitUsers?: Metric;
};

export type PathAnalysis = { nodes: string[]; p99?: Metric; availability: Metric; downtime: Metric };

export type Analysis = {
  traffic?: Traffic;
  nodes: Record<string, NodeAnalysis>;
  paths: PathAnalysis[];
  spof: string[];
  cost?: CostResult;
  bottleneck?: { nodeId: string; limitUsers: Metric };
  growth?: { milestones: Milestone[]; monthlyCost: (Metric | undefined)[] };
  judgements: NodeJudgement[];
  rules: RuleHit[];
  /** 15절 "법령명 제N조 확인 필요" 목록 */
  regulation: LawHit[];
  /** 노드별 판정 변수(계산값 + 직접 넣은 값). 화면이 후보 항목을 다시 계산 없이 판정하는 데 쓴다 */
  scenarios: Record<string, Scenario>;
};

export type Data = { catalog: Map<string, CatalogItem>; rules: Rule[]; prices: PriceRow[]; laws?: LawRow[] };

const m = (value: number, unit: string, formula: string, inputs: Record<string, number>): Metric => ({ value, unit, formula, inputs });

function perInstance(node: ProjectNode, catalog: Map<string, CatalogItem>) {
  const th = node.primary ? catalog.get(node.primary)?.thresholds : undefined;
  const rps = th?.rps && calibrate(th.rps, node.spec, node.measured.rps);
  const max = th?.max_instances && calibrate(th.max_instances, node.spec, node.measured.max_instances);
  return { rps, max: max?.value ?? Infinity };
}

/** today = 'YYYY-MM-DD' (가격 기준일 경고용). reuse.traffic: 항목만 바꿔 여러 번 분석할 때 같은 트래픽을 재사용 */
export function analyze(p: Project, d: Data, today: string, reuse?: { traffic: Traffic | undefined }): Analysis {
  const t = reuse ? reuse.traffic : traffic(p);
  const loads = t ? nodeLoads(p, t) : undefined;
  const scenarios = computedScenarios(p, t);
  const u = p.target_utilization;
  const shape = t && t.peakRps.value > 0 ? t.hourlyRps.map((x) => x / t.peakRps.value) : undefined;

  // 노드별 대수·사용률·p99·가용성
  const nodes: Record<string, NodeAnalysis> = {};
  for (const n of p.nodes) {
    const load = loads?.get(n.id);
    const per = perInstance(n, d.catalog);
    const a = nodeAvailability(n.availability ?? p.default_availability, n.replicas);
    const na: NodeAnalysis = {
      load,
      perInstanceRps: per.rps,
      availability: m(a, '비율', '1 − (1 − 1대 가용성)^이중화 대수', { 가용성1대: n.availability ?? p.default_availability, 대수: n.replicas }),
    };
    if (load && per.rps && enabled(p.deploy, 'scale')) {
      const at = (s: 'normal' | 'event') => {
        const N = instancesNeeded(load.rps[s], per.rps!.value, u, n.min_instances || 1, per.max);
        return {
          N: m(N, '대', 'ceil(부하 / (대당 처리량 × 목표 사용률)), 최소·최대 대수로 자름', { 부하: load.rps[s], 대당: per.rps!.value, 목표사용률: u }),
          util: m(load.rps[s] / (N * per.rps!.value), '비율', '부하 / (대수 × 대당 처리량)', { 부하: load.rps[s], 대수: N }),
          N_value: N,
        };
      };
      const nn = at('normal'), ne = at('event');
      na.instances = { normal: nn.N, event: ne.N };
      na.utilization = { normal: nn.util, event: ne.util };
      if (n.perf && enabled(p.deploy, 'latency')) {
        const p99 = (s: 'normal' | 'event', N: number) => nodeP99(load.rps[s], n.perf!.service_ms, N * n.perf!.workers, n.perf!.service_p99_ms);
        na.p99 = { normal: p99('normal', nn.N_value), event: p99('event', ne.N_value) };
      }
    }
    nodes[n.id] = na;
  }

  // 경로별 p99·가용성, 단일 장애점
  const paths = syncPaths(p);
  const p99Normal = new Map(Object.entries(nodes).flatMap(([id, x]) => (x.p99 ? [[id, x.p99.normal] as const] : [])));
  const pathResults: PathAnalysis[] = paths.map((path) => {
    // 화면 노드는 사용자 기기라 서버 가용성 계산에서 뺀다
    const av = pathAvailability(path.filter((id) => p.nodes.find((n) => n.id === id)!.layer !== 'ui').map((id) => nodes[id].availability.value));
    return {
      nodes: path,
      p99: p99Normal.size ? pathP99(p, path, p99Normal) : undefined,
      availability: av,
      downtime: monthlyDowntimeHours(av.value),
    };
  });

  // 비용: 시간대별 대수 × 가격표
  const hourlyOf = (n: ProjectNode, factor: number) => {
    const load = loads?.get(n.id);
    const per = perInstance(n, d.catalog);
    if (load && per.rps && shape) return hourlyInstances(load.rps.normal * factor, shape, per.rps.value, u, n.min_instances, per.max);
    return Array<number>(24).fill(n.min_instances);
  };
  const costAt = (factor: number) => monthlyCost({
    nodes: p.nodes.map((n) => ({ id: n.id, price: n.price, hourly: hourlyOf(n, factor) })),
    storageGb: t && t.storageGbWithOverhead.value * factor,
    storageProduct: p.cost.storage,
    egressGbPerMonth: t && t.egressGbPerDay.value * 30 * factor,
    egressProduct: p.cost.egress,
  }, d.prices, today);
  const cost = enabled(p.deploy, 'cost') && (p.cost.storage || p.cost.egress || p.nodes.some((n) => n.price)) ? costAt(1) : undefined;

  // 판정 변수에 계산값을 더한다: 사용률, 노드 p99, 이 노드를 지나는 경로 중 가장 낮은 가용성
  const judged = new Map<string, Scenario>();
  for (const n of p.nodes) {
    const base = scenarios.get(n.id)!;
    const na = nodes[n.id];
    const pathAv = Math.min(...pathResults.filter((x) => x.nodes.includes(n.id)).map((x) => x.availability.value));
    const add = (s: 'normal' | 'event') => ({
      ...base[s],
      ...(na.utilization && { utilization: na.utilization[s].value }),
      ...(na.p99 && { node_p99_ms: na.p99[s].value }),
      ...(Number.isFinite(pathAv) && { path_availability: pathAv }),
    });
    judged.set(n.id, mergeScenario(n, { normal: add('normal'), event: add('event') }));
  }

  // 한계 사용자와 첫 병목
  let bottleneck: Analysis['bottleneck'];
  if (p.scale && t) {
    for (const n of p.nodes) {
      const f = limitFactor(n, d.catalog, judged.get(n.id)!);
      if (f === undefined) continue;
      const lim = m(p.scale.users * f, '명', '현재 활성 사용자 × 이벤트 피크에서 안 됨이 되기 직전 배수', { 활성사용자: p.scale.users, 배수: f });
      nodes[n.id].limitUsers = lim;
      if (!bottleneck || lim.value < bottleneck.limitUsers.value) bottleneck = { nodeId: n.id, limitUsers: lim };
    }
  }

  // 성장 타임라인과 월별 비용
  let growth: Analysis['growth'];
  if (p.growth && p.scale) {
    const { monthly_rate: g, months, lead_months } = p.growth;
    const limits = Object.entries(nodes).flatMap(([nodeId, x]) => (x.limitUsers ? [{ nodeId, limitUsers: x.limitUsers.value }] : []));
    growth = {
      milestones: timeline(limits, p.scale.users, g, lead_months),
      monthlyCost: cost ? Array.from({ length: months + 1 }, (_, mo) => costAt(usersAt(1, g, mo)).total) : [],
    };
  }

  return {
    traffic: t,
    nodes,
    paths: pathResults,
    spof: singlePointsOfFailure(p, paths),
    cost,
    bottleneck,
    growth,
    judgements: p.nodes.map((n) => judgeNode(n, d.catalog, judged.get(n.id))),
    rules: checkRules(p, d.rules),
    regulation: checkRegulation(p, d.laws ?? []),
    scenarios: Object.fromEntries(judged),
  };
}
