// 분석의 유일한 입구. 정해진 순서로 계산하고, 판정은 모든 계산값을 변수로 받아 맨 마지막에 한다.
// deploy → traffic → load → calibrate/capacity → latency·availability·cost → limits → growth → judge
import { monthlyDowntimeHours, nodeAvailability, pathAvailability, singlePointsOfFailure, standingInstances } from './availability';
import { checkSecurity, type SecurityHit } from './security';
import { calibrate } from './calibrate';
import { instancesNeeded } from './capacity';
import { monthlyCost, type CostResult } from './cost';
import { costLines } from './meters';
import { enabled, localMemoryMb } from './deploy';
import { adoption, monthReaching, type AdoptionMonth } from './adoption';
import { timeline, usersAt, type Milestone } from './growth';
import type { Vars } from './expr';
import { checkRules, judgeNode, mergeScenario, type NodeJudgement, type RuleHit, type Scenario } from './judge';
import { MAX_PATHS, nodeP99, pathP99, syncPaths } from './latency';
import { limitFactor } from './limits';
import { apiLoads, type ApiLoad } from './api';
import { computedScenarios, nodeLoads, type NodeLoad } from './load';
import { metric, type Metric } from './model';
import { failureScenarios, recoveryVars, type Failure } from './failure';
import { minuteShape, pipelineFlows, type PipelineFlow } from './pipeline';
import { checkRegulation, type LawHit } from './regulation';
import type { CatalogItem, LawRow, PriceRow, Project, ProjectNode, Rule } from './schema';
import { tableSizes, type TableAnalysis } from './tables';
import { dayCurve, spikeFactors, traffic, type Traffic } from './traffic';

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
  /** DB 노드: 부르는 노드들이 여는 연결 수 */
  connections?: { normal: Metric; event: Metric };
};

/** 노드 1대가 DB에 여는 연결 풀 기본값 (HikariCP maximumPoolSize, node-postgres Pool max 기본값) */
export const DEFAULT_DB_POOL = 10;
/** 연결 풀러가 DB에 여는 연결 수 기본값 (PgBouncer default_pool_size) */
export const POOLER_POOL = 20;

export type PathAnalysis = { nodes: string[]; p99?: Metric; availability: Metric; downtime: Metric };

export type Analysis = {
  traffic?: Traffic;
  nodes: Record<string, NodeAnalysis>;
  paths: PathAnalysis[];
  /** 동기 경로가 MAX_PATHS개를 넘어 앞쪽만 계산함 */
  pathsCut?: boolean;
  spof: string[];
  cost?: CostResult;
  bottleneck?: { nodeId: string; limitUsers: Metric };
  /** 한계를 계산한 노드 중 100만 배 넘게 버틴 노드가 있음 (그 노드는 limitUsers·병목에 넣지 않는다) */
  unbounded?: boolean;
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
  /** 네트워크·보안 점검 (v1.3.0): 노드·연결선 보안 값의 ❌·⚠️·ℹ️. 항목 판정(judgements)과 따로 */
  security: SecurityHit[];
  /** 15절 "법령명 제N조 확인 필요" 목록 */
  regulation: LawHit[];
  /** 데이터 파이프라인: 큐 → 소비자 적체·지연, 배치 1회 실행 */
  pipeline: PipelineFlow[];
  /** 장애 시나리오: 존 하나·리전 하나가 멈출 때, 백업에서 되살릴 때 */
  failure?: Failure;
  /** 노드별 판정 변수(계산값 + 직접 넣은 값). 화면이 후보 항목을 다시 계산 없이 판정하는 데 쓴다 */
  scenarios: Record<string, Scenario>;
};

export type Data = { catalog: Map<string, CatalogItem>; rules: Rule[]; prices: PriceRow[]; laws?: LawRow[] };

const m = metric;
/** 트래픽마다 1분 곡선 (같은 트래픽을 재사용하는 여러 번의 분석이 같은 배열을 써서 자동 확장 결과를 다시 쓴다) */
const minuteOf = new WeakMap<Traffic, number[]>();

/** 대당 처리량(사양·실측으로 보정)과 최대 대수. 화면의 세부 구성도 같은 값을 쓴다 */
export function perInstance(node: ProjectNode, catalog: Map<string, CatalogItem>) {
  const th = node.primary ? catalog.get(node.primary)?.thresholds : undefined;
  const cal = th?.rps && calibrate(th.rps, node.spec, node.measured.rps);
  // 처리 시간·workers가 있으면 p99(nodeP99, c = 대수 × workers, μ = 1000/처리 시간)와 같은 한계로 자른다
  const perf = cal && node.perf && (node.perf.workers * 1000) / node.perf.service_ms;
  // 실측값이 잘리면 값은 실측이 아니라 처리 시간에서 나오므로 basis '실측'을 뺀다. 보정값이 이미 inputs에 있으면(실측·업계 값) 다시 넣지 않는다
  const rps = cal && perf !== undefined && perf < cal.value
    ? { ...cal, ...(cal.basis === '실측' && { basis: undefined }), value: perf, formula: `min(${cal.formula}, workers × 1000 / 처리 시간)`,
      inputs: { ...cal.inputs, ...(!Object.values(cal.inputs).includes(cal.value) && { 보정값: cal.value }), workers: node.perf!.workers, 처리ms: node.perf!.service_ms } }
    : cal;
  const max = th?.max_instances && calibrate(th.max_instances, node.spec, node.measured.max_instances);
  return { rps, max: max?.value ?? Infinity };
}

/** 주 서버 1대 DB(single_primary)의 모양: 부하 중 쓰기 몫, 읽기 복제본이 있는지. 대수만큼 늘어나는 노드면 undefined */
export type PrimaryShape = { writeShare: number; replicas: boolean };
export function primaryShape(n: ProjectNode, catalog: Map<string, CatalogItem>, load?: NodeLoad): PrimaryShape | undefined {
  if (!n.primary || catalog.get(n.primary)?.scaling !== 'single_primary') return undefined;
  return { writeShare: load && load.rps.normal > 0 ? load.writeRps.normal / load.rps.normal : 0, replicas: n.extras.includes('read_replica') };
}

/** 부하 rps를 받는 데 필요한 대수(목표 사용률, 최소·최대 대수 적용), 사용률, 그 대수에서의 p99. 결과 카드·비용·"사용자 증가 시 p99" 그래프가 같이 쓴다.
 *  주 서버 1대 DB는 쓰기를 주 서버 1대가 모두 받는다: 대수를 늘려도 쓰기 한계는 그대로이고, 읽기 복제본이 있을 때만 읽기를 복제본 대수로 나눈다.
 *  사용률은 가장 바쁜 서버 기준 (주 서버와 복제본 중 큰 쪽), p99는 주 서버의 대기열 */
export function sizeAt(n: ProjectNode, perRps: number, maxInstances: number, rps: number, u: number, db?: PrimaryShape) {
  // 늘 떠 있는 대수: 최소 대수와 이중화(2대 이상) 중 큰 쪽, 최대 대수 이하 (비용·가용성·연결 수·장애가 같은 대수를 쓰게)
  const floor = Math.max(n.min_instances, n.replicas > 1 ? Math.min(maxInstances, n.replicas) : 0);
  if (!db) {
    const N = instancesNeeded(rps, perRps, u, floor, maxInstances);
    return { N, util: N ? rps / (N * perRps) : 0, p99: n.perf && nodeP99(rps, n.perf.service_ms, N * n.perf.workers, n.perf.service_p99_ms) };
  }
  const reads = rps * (1 - db.writeShare), onPrimary = db.replicas ? rps - reads : rps;
  // 늘 떠 있는 대수(최소 대수·이중화)만큼 복제본이 떠 있으므로 읽기도 나눠 받는다 (비용이 세는 대수와 용량이 세는 대수를 같게)
  const replicas = db.replicas && reads > 0 ? Math.min(Math.max(0, maxInstances - 1), Math.max(Math.ceil(reads / (perRps * u)), floor - 1)) : 0;
  const util = Math.max(onPrimary / perRps, replicas ? reads / (replicas * perRps) : 0);
  return { N: Math.max(floor, 1 + replicas), util, p99: n.perf && nodeP99(onPrimary, n.perf.service_ms, n.perf.workers, n.perf.service_p99_ms) };
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
  // 대당 처리량(사양·실측 보정)은 노드마다 한 번만: 성장 타임라인이 달마다 다시 쓴다
  const perOf = new Map(p.nodes.map((n) => [n.id, perInstance(n, d.catalog)]));
  for (const n of p.nodes) {
    const load = loads?.get(n.id);
    const per = perOf.get(n.id)!;
    const db = primaryShape(n, d.catalog, load);
    const standing = standingInstances(n, per.max);
    const a = nodeAvailability(n.availability ?? p.default_availability, standing);
    const na: NodeAnalysis = {
      load,
      perInstanceRps: per.rps,
      availability: m(a, '비율', '1 − (1 − 1대 가용성)^늘 떠 있는 대수 (max(이중화, 최소 대수), 최대 대수 이하)', { 가용성1대: n.availability ?? p.default_availability, 대수: standing }),
    };
    if (load && per.rps && enabled(p.deploy, 'scale')) {
      const at = (s: 'normal' | 'event') => {
        // 비용(hourlyOf)과 같은 최소 대수를 쓴다. 0대까지 줄어드는 노드는 부하가 0일 때 0대
        const { N, util, p99 } = sizeAt(n, per.rps!.value, per.max, load.rps[s], u, db);
        return db ? {
          N: m(N, '대', db.replicas ? '주 서버 1대(쓰기) + 읽기 복제본 ceil(읽기 / (대당 처리량 × 목표 사용률)), 최소·이중화 대수 이상' : '주 서버 1대 (쓰기·읽기 모두, 대수를 늘려도 처리량이 늘지 않음), 최소·이중화 대수만큼 대기 서버',
            { 부하: load.rps[s], 쓰기: load.writeRps[s], 대당: per.rps!.value, 목표사용률: u, 최소: n.min_instances, 이중화: n.replicas }),
          util: m(util, '비율', db.replicas ? 'max(쓰기 / 대당 처리량, 읽기 / (복제본 수 × 대당 처리량))' : '부하 / 주 서버 1대 처리량', { 부하: load.rps[s], 쓰기: load.writeRps[s], 대수: N }),
          p99,
        } : {
          N: m(N, '대', 'ceil(부하 / (대당 처리량 × 목표 사용률)), 최소·이중화 대수 이상, 최대 대수 이하', { 부하: load.rps[s], 대당: per.rps!.value, 목표사용률: u, 최소: n.min_instances, 이중화: n.replicas }),
          util: m(util, '비율', '부하 / (대수 × 대당 처리량)', { 부하: load.rps[s], 대수: N }),
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

  // 데이터 파이프라인: 큐 적체·지연, 배치 1회 실행. 배수 f에서는 대수를 계산하는 노드만 그 부하로 다시 센다
  const eventFactor = t && t.peakRps.value > 0 ? t.peakRpsEvent.value / t.peakRps.value : 1;
  const instAt = (f: number) => (id: string, s: 'normal' | 'event') => {
    if (f === 1) return nodes[id].instances?.[s].value;
    const c = p.nodes.find((x) => x.id === id)!, cl = loads?.get(id), per = perOf.get(id)!;
    return cl && per.rps && enabled(p.deploy, 'scale') ? sizeAt(c, per.rps.value, per.max, cl.rps[s] * f, u, primaryShape(c, d.catalog, cl)).N : undefined;
  };
  // 큐 소비자·배치 1회 양은 1분 단위 트래픽 곡선(페르소나·하루 피크·일시적 급증의 기대 곡선)으로 돈다
  const queued = p.nodes.some((n) => n.layer === 'queue' || n.batch);
  let minute = t && queued ? minuteOf.get(t) : undefined;
  if (t && !minute && queued) {
    // 하루 양은 급증 없는 곡선으로 트래픽 계산과 맞추고, 급증은 그 위에 더한다 (급증만큼 하루 도착이 는다)
    const sc = p.scale!, curve = dayCurve({ ...p, scale: { ...sc, spikes: undefined } }, 1)?.total;
    const spike = sc.spikes && spikeFactors(sc.spikes, sc.seed);
    if (curve && shape) minuteOf.set(t, (minute = minuteShape(curve, shape).map((x, i) => x * (spike ? spike[i] : 1))));
  }
  const flowCache = new Map<number, PipelineFlow[]>();
  const flowsAt = (f: number) => {
    if (!flowCache.has(f)) flowCache.set(f, loads && shape ? pipelineFlows(p, loads, shape, eventFactor, instAt(f), f, minute) : []);
    return flowCache.get(f)!;
  };
  const pipeline = flowsAt(1);
  /** 자동 확장 소비자의 하루 (큐를 여럿 받으면 가장 바쁜 것). 배수 f에서 다시 계산한다 */
  const autoOf = (id: string, f: number, s: 'normal' | 'event') => {
    const xs = flowsAt(f).filter((x) => x.to === id && x.auto).map((x) => x.auto![s]);
    return xs.length ? xs.reduce((a, b) => (b.max > a.max ? b : a)) : undefined;
  };
  for (const n of p.nodes) {
    const an = autoOf(n.id, 1, 'normal'), ae = autoOf(n.id, 1, 'event');
    if (!an || !ae || nodes[n.id].instances) continue;
    const how = '1분 단위 트래픽으로 자동 확장을 돌린 하루 중 가장 많은 대수';
    nodes[n.id].instances = { normal: m(an.max, '대', how, { 최소: an.min }), event: m(ae.max, '대', how, { 최소: ae.min }) };
  }
  /** 받는 노드의 파이프라인 판정 변수: 큐 지연·허용 지연, 배치 실행·실행 창 (여럿이면 가장 나쁜 것) */
  const pipeVars = (flows: PipelineFlow[], id: string, s: 'normal' | 'event'): Vars => {
    const q = flows.filter((x) => x.to === id && x.kind === 'queue' && x.lag), b = flows.filter((x) => x.to === id && x.kind === 'batch' && x.run);
    return {
      ...(q.length && { queue_lag_s: Math.max(...q.map((x) => x.lag![s].value)), max_lag_s: Math.min(...q.map((x) => x.limit)) }),
      ...(b.length && { batch_run_s: Math.max(...b.map((x) => x.run![s].value)), batch_window_s: Math.min(...b.map((x) => x.limit)) }),
    };
  };
  // 신선도가 필요한 항목(마이크로 배치·Flink)은 허용 지연을 요구 신선도로 쓴다
  const freshness = (id: string): Vars => {
    const lim = pipeline.filter((x) => x.from === id || x.to === id).map((x) => x.limit);
    return lim.length ? { required_freshness_s: Math.min(...lim) } : {};
  };

  // 경로별 p99·가용성, 단일 장애점
  // 로컬 exe처럼 서버 가용성을 따지지 않는 방식이면 경로·단일 장애점도 만들지 않는다
  const allPaths = enabled(p.deploy, 'availability') ? syncPaths(p) : [];
  const paths = allPaths.slice(0, MAX_PATHS);
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
    const per = perOf.get(n.id)!;
    // 이중화(replicas > 1)는 부하와 무관하게 늘 떠 있어야 하는 대수다. 1이면 0대까지 줄어드는 워커를 막지 않도록 하한으로 쓰지 않는다
    // 최대 대수(api_single = 1대)보다 많이 띄울 수 없으므로 그 대수로 자른다 (가용성의 standingInstances와 같은 상한)
    const floor = n.replicas > 1 ? Math.min(per.max, n.replicas) : 0;
    const db = primaryShape(n, d.catalog, load);
    const hourly = autoOf(n.id, factor, 'normal')?.hourly ?? (load && per.rps && shape
      ? shape.map((s) => sizeAt(n, per.rps!.value, per.max, load.rps.normal * factor * s, u, db).N)
      : Array<number>(24).fill(n.min_instances));
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

  // DB 연결 수: 이 DB를 부르는 노드의 대수 × 대당 연결 풀. 대수를 계산하지 않는 노드는 이중화·최소 대수(적어도 1대)로 본다.
  // 연결 풀러(PgBouncer 등)가 있으면 DB 쪽 연결은 풀러 크기(기본 20, PgBouncer default_pool_size)를 넘지 않는다.
  // connAt(배수): 사용자가 배수만큼 늘 때의 연결 수 (부르는 노드 대수가 계단식으로 늘어 사용자에 비례하지 않으므로 한계 찾기가 다시 계산해 쓴다)
  const connAt = new Map<string, (f: number, s: 'normal' | 'event') => { total: number; parts: number[]; callers: ProjectNode[] }>();
  for (const n of p.nodes) {
    if (n.layer !== 'db') continue;
    const callers = [...new Set(p.edges.filter((e) => e.to === n.id).map((e) => e.from))]
      .map((id) => p.nodes.find((x) => x.id === id)!).filter((c) => c.layer !== 'ui');
    if (!callers.length) continue;
    const pooled = n.extras.includes('connection_pooler');
    const count = (f: number, s: 'normal' | 'event') => {
      const parts = callers.map((c) => {
        const cl = loads?.get(c.id), per = perOf.get(c.id)!;
        const auto = autoOf(c.id, f, s);
        const N = auto ? auto.max : cl && per.rps && enabled(p.deploy, 'scale')
          ? sizeAt(c, per.rps.value, per.max, cl.rps[s] * f, u, primaryShape(c, d.catalog, cl)).N
          : Math.max(1, c.replicas, c.min_instances);
        return N * (c.db_pool ?? DEFAULT_DB_POOL);
      });
      const sum = parts.reduce((a, b) => a + b, 0);
      return { total: pooled ? Math.min(sum, POOLER_POOL) : sum, parts, callers };
    };
    connAt.set(n.id, count);
    const at = (s: 'normal' | 'event') => {
      const c = count(1, s);
      return m(c.total, '개', pooled ? 'min(Σ 부르는 노드 대수 × 대당 연결 풀, 연결 풀러 크기)' : 'Σ 부르는 노드 대수 × 대당 연결 풀',
        Object.fromEntries(c.callers.map((x, i) => [x.id, c.parts[i]])));
    };
    nodes[n.id].connections = { normal: at('normal'), event: at('event') };
  }

  // 장애 시나리오: 존·리전 장애, 백업에서 되살리기 (서버 가용성을 따지지 않는 방식이면 만들지 않는다)
  const dataGb = (id: string) => {
    const xs = tables.filter((x) => x.nodeId === id);
    return xs.length ? xs.reduce((s, x) => s + x.storedGb.value, 0) : undefined;
  };
  const failure = enabled(p.deploy, 'availability') ? failureScenarios(p, (n) => {
    const na = nodes[n.id];
    return {
      ...(na.instances && { N: { normal: na.instances.normal.value, event: na.instances.event.value } }),
      ...(na.utilization && { util: { normal: na.utilization.normal.value, event: na.utilization.event.value } }),
      max: perOf.get(n.id)!.max, singlePrimary: !!primaryShape(n, d.catalog), dataGb: dataGb(n.id),
    };
  }) : undefined;

  // 판정 변수에 계산값을 더한다: 사용률, 노드 p99, 이 노드를 지나는 경로 중 가장 낮은 가용성, DB 연결 수, 파이프라인, 장애 목표
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
      ...(na.connections && { db_connections: na.connections[s].value }),
      ...freshness(n.id),
      ...pipeVars(pipeline, n.id, s),
      ...recoveryVars(failure, p, n, s, dataGb(n.id)),
    });
    judged.set(n.id, mergeScenario(n, { normal: add('normal'), event: add('event') }));
  }

  // 한계 사용자와 첫 병목
  let bottleneck: Analysis['bottleneck'], unbounded = false;
  if (p.scale && t) {
    for (const n of p.nodes) {
      // 배수마다 다시 계산하는 값: 사용률(대수가 계단식·최대 대수에서 멈춤), 연결 수(사람이 직접 넣었으면 그 값 그대로)
      const conn = n.vars.event.db_connections === undefined ? connAt.get(n.id) : undefined;
      const load = loads?.get(n.id), per = perOf.get(n.id)!, db = primaryShape(n, d.catalog, load);
      const util = nodes[n.id].utilization && load && per.rps && n.vars.event.utilization === undefined
        ? (x: number) => sizeAt(n, per.rps!.value, per.max, load.rps.event * x, u, db).util : undefined;
      // 이 노드로 들어오는 파이프라인이 있으면 배수마다 적체·실행 시간을 다시 계산한다
      const piped = pipeline.some((x) => x.to === n.id && (x.lag || x.run)) && n.vars.event.queue_lag_s === undefined;
      const f = limitFactor(n, d.catalog, judged.get(n.id)!, conn || util || piped
        ? (x) => ({ ...(conn && { db_connections: conn(x, 'event').total }), ...(util && { utilization: util(x) }), ...(piped && pipeVars(flowsAt(x), n.id, 'event')) }) : undefined);
      if (f === undefined) continue;
      // 한계 없음(∞)은 화면 그래프 축·성장 타임라인을 깨므로 노드 값으로 두지 않고 표시만 한다
      if (f === Infinity) { unbounded = true; continue; }
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
    ...(allPaths.length > MAX_PATHS && { pathsCut: true }),
    spof: singlePointsOfFailure(p, paths, (n) => perOf.get(n.id)!.max),
    cost,
    bottleneck,
    ...(unbounded && { unbounded }),
    growth,
    judgements: p.nodes.map((n) => judgeNode(n, d.catalog, judged.get(n.id))),
    rules: checkRules(p, d.rules, tables.map((x) => ({ target: `${p.nodes.find((n) => n.id === x.nodeId)!.name}.${x.table}`, vars: x.vars }))),
    security: checkSecurity(p),
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
    pipeline,
    failure,
  };
}
