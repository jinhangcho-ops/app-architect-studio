// 분석의 유일한 입구. 정해진 순서로 계산하고, 판정은 모든 계산값을 변수로 받아 맨 마지막에 한다.
// deploy → traffic → load → calibrate/capacity → latency·availability·cost → limits → growth → judge
import { monthlyDowntimeHours, nodeAvailability, pathAvailability, singlePointsOfFailure } from './availability';
import { calibrate } from './calibrate';
import { hourlyInstances, instancesNeeded } from './capacity';
import { monthlyCost, type CostResult } from './cost';
import { costLines } from './meters';
import { enabled, localMemoryMb } from './deploy';
import { adoption, monthReaching, type AdoptionMonth } from './adoption';
import { timeline, usersAt, type Milestone } from './growth';
import { checkRules, judgeNode, mergeScenario, type NodeJudgement, type RuleHit, type Scenario } from './judge';
import { nodeP99, pathP99, syncPaths } from './latency';
import { limitFactor } from './limits';
import { apiLoads, type ApiLoad } from './api';
import { computedScenarios, nodeLoads, type NodeLoad } from './load';
import { metric, type Metric } from './model';
import { checkRegulation, type LawHit } from './regulation';
import type { CatalogItem, LawRow, PriceRow, Project, ProjectNode, Rule } from './schema';
import { tableSizes, type TableAnalysis } from './tables';
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
  growth?: { milestones: Milestone[]; monthlyCost: (Metric | undefined)[]; /** 파티션 없는 테이블이 서버 메모리를 넘는 달 (nodeId = '노드.테이블') */ tables: Milestone[];
    /** 유입 모형이 있을 때 달마다 경로별 유입·페르소나별 사용자 */ adoption?: AdoptionMonth[] };
  /** 테이블별 크기·파티션 */
  tables: TableAnalysis[];
  /** 화면 와이어프레임의 API 호출별 피크 RPS */
  api: ApiLoad[];
  /** 16절 로컬 실행 메모리 (로컬 exe·모바일·하이브리드에서 메모리 입력이 있을 때). share = 기기 메모리 중 차지하는 비율 */
  localMemory?: { mb: Metric; share?: Metric };
  /** 저장량 비교: 페르소나 추정(쓰기 × 건당 KB)과 테이블 합계 */
  storage?: { personaGb: Metric; tablesGb?: Metric };
  judgements: NodeJudgement[];
  rules: RuleHit[];
  /** 15절 "법령명 제N조 확인 필요" 목록 */
  regulation: LawHit[];
  /** 노드별 판정 변수(계산값 + 직접 넣은 값). 화면이 후보 항목을 다시 계산 없이 판정하는 데 쓴다 */
  scenarios: Record<string, Scenario>;
};

export type Data = { catalog: Map<string, CatalogItem>; rules: Rule[]; prices: PriceRow[]; laws?: LawRow[] };

const m = metric;

/** 대당 처리량(사양·실측으로 보정)과 최대 대수. 화면의 세부 구성도 같은 값을 쓴다 */
export function perInstance(node: ProjectNode, catalog: Map<string, CatalogItem>) {
  const th = node.primary ? catalog.get(node.primary)?.thresholds : undefined;
  const rps = th?.rps && calibrate(th.rps, node.spec, node.measured.rps);
  const max = th?.max_instances && calibrate(th.max_instances, node.spec, node.measured.max_instances);
  return { rps, max: max?.value ?? Infinity };
}

/** 부하 rps를 받는 데 필요한 대수(목표 사용률, 최소·최대 대수 적용)와 그 대수에서의 p99. 결과 카드와 "사용자 증가 시 p99" 그래프가 같이 쓴다 */
export function sizeAt(n: ProjectNode, perRps: number, maxInstances: number, rps: number, u: number) {
  const N = instancesNeeded(rps, perRps, u, n.min_instances, maxInstances);
  return { N, p99: n.perf && nodeP99(rps, n.perf.service_ms, N * n.perf.workers, n.perf.service_p99_ms) };
}

/** today = 'YYYY-MM-DD' (가격 기준일 경고용). reuse.traffic: 항목만 바꿔 여러 번 분석할 때 같은 트래픽을 재사용 */
export function analyze(p: Project, d: Data, today: string, reuse?: { traffic: Traffic | undefined }): Analysis {
  const t = reuse ? reuse.traffic : traffic(p);
  const loads = t ? nodeLoads(p, t) : undefined;
  const scenarios = computedScenarios(p, loads);
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
        // 비용(hourlyOf)과 같은 최소 대수를 쓴다. 0대까지 줄어드는 노드는 부하가 0일 때 0대
        const { N, p99 } = sizeAt(n, per.rps!.value, per.max, load.rps[s], u);
        return {
          N: m(N, '대', 'ceil(부하 / (대당 처리량 × 목표 사용률)), 최소·최대 대수로 자름', { 부하: load.rps[s], 대당: per.rps!.value, 목표사용률: u }),
          util: m(N ? load.rps[s] / (N * per.rps!.value) : 0, '비율', '부하 / (대수 × 대당 처리량)', { 부하: load.rps[s], 대수: N }),
          p99,
        };
      };
      const nn = at('normal'), ne = at('event');
      na.instances = { normal: nn.N, event: ne.N };
      na.utilization = { normal: nn.util, event: ne.util };
      if (nn.p99 && ne.p99 && enabled(p.deploy, 'latency')) na.p99 = { normal: nn.p99, event: ne.p99 };
    }
    nodes[n.id] = na;
  }

  // 경로별 p99·가용성, 단일 장애점
  // 로컬 exe처럼 서버 가용성을 따지지 않는 방식이면 경로·단일 장애점도 만들지 않는다
  const paths = enabled(p.deploy, 'availability') ? syncPaths(p) : [];
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
    // 이중화(replicas > 1)는 부하와 무관하게 늘 떠 있어야 하는 대수다. 1이면 0대까지 줄어드는 워커를 막지 않도록 하한으로 쓰지 않는다
    const floor = n.replicas > 1 ? n.replicas : 0;
    const hourly = load && per.rps && shape
      ? hourlyInstances(load.rps.normal * factor, shape, per.rps.value, u, n.min_instances, per.max)
      : Array<number>(24).fill(n.min_instances);
    return hourly.map((x) => Math.max(x, floor));
  };
  const tablesAt = (factor: number) => tableSizes(p, t, d.catalog, factor);
  const tables = tablesAt(1);
  const costAt = (factor: number) => {
    const { lines, missing } = costLines(p, t, loads, d.catalog, hourlyOf, factor, factor === 1 ? tables : tablesAt(factor));
    return { result: monthlyCost(lines, d.prices, today, missing), any: lines.length + missing.length > 0 };
  };
  const first = enabled(p.deploy, 'cost') ? costAt(1) : undefined;
  const cost = first?.any ? first.result : undefined;

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
    // 테이블 크기는 사용자 수에 비례하므로, 서버 메모리에 닿는 사용자 수 = 지금 사용자 × 메모리 / 지금 크기
    const tableLimits = tables
      .filter((x) => !x.vars.partitioned && typeof x.vars.server_mem_gb === 'number' && x.storedGb.value > 0)
      .map((x) => ({ nodeId: x.key, limitUsers: (p.scale!.users * (x.vars.server_mem_gb as number)) / x.storedGb.value }));
    // 유입 모형이 있으면 그 곡선(페르소나 구성까지 반영한 환산 사용자)으로, 없으면 월 성장률로 늘린다. 한계 시점은 10년까지 찾는다
    const curve = adoption(p, Math.max(months, 120));
    const reach = curve && ((lim: number) => monthReaching(curve, lim));
    const factorAt = (mo: number) => (curve ? curve[mo].equivalent / p.scale!.users : usersAt(1, g, mo));
    growth = {
      milestones: timeline(limits, p.scale.users, g, lead_months, reach),
      monthlyCost: cost ? Array.from({ length: months + 1 }, (_, mo) => costAt(factorAt(mo)).result.total) : [],
      tables: timeline(tableLimits, p.scale.users, g, lead_months, reach),
      ...(curve && { adoption: curve.slice(0, months + 1) }),
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
    rules: checkRules(p, d.rules, tables.map((x) => ({ target: `${p.nodes.find((n) => n.id === x.nodeId)!.name}.${x.table}`, vars: x.vars }))),
    tables,
    api: loads ? apiLoads(p, loads) : [],
    ...(t && {
      storage: {
        personaGb: t.storageGbWithOverhead,
        ...(tables.length && {
          tablesGb: { value: tables.reduce((s, x) => s + x.storedGb.value, 0), unit: 'GB', formula: 'Σ 테이블 저장량', inputs: Object.fromEntries(tables.map((x) => [x.key, x.storedGb.value])) },
        }),
      },
    }),
    regulation: checkRegulation(p, d.laws ?? []),
    ...(enabled(p.deploy, 'localMemory') && p.deploy.memory && (() => {
      const mb = localMemoryMb(p.deploy.memory);
      const device = p.deploy.device_spec?.memGb;
      return {
        localMemory: {
          mb,
          ...(device && { share: { value: mb.value / (device * 1000), unit: '비율', formula: '로컬 메모리 / 기기 메모리', inputs: { 로컬MB: mb.value, 기기GB: device } } }),
        },
      };
    })()),
    scenarios: Object.fromEntries(judged),
  };
}
