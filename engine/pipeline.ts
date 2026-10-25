// 데이터 파이프라인: 큐에 쌓이는 양과 지연(소비자가 따라잡는지), 정해진 주기로 도는 배치의 1회 실행 시간.
// 큐: 소비자 그룹마다 모든 메시지를 받는다(Kafka 소비자 그룹). 도착 = 큐 → 소비자 연결선으로 흐르는 양, 처리량 = 병렬 수 × (1000 / 평균 처리 ms).
//     병렬 수 = 소비자 대수 × 대당 동시 처리, 파티션 수가 있으면 그것을 넘지 못한다(파티션 하나는 소비자 하나만 읽는다).
//     하루를 시간 칸으로 돌려 적체(건)를 쌓고 빼며, 지연 = 적체 / 처리량 + 1건 처리 시간. 하루 평균 도착이 처리량 이상이면 적체가 끝없이 는다.
// 배치(batch.every_min이 있는 노드): 주기 동안 들어온 양을 한 번에 처리한다. 1회 실행 = 그 양 / 처리량, 실행 창(window_min, 없으면 주기) 안에 끝나야 한다.
//     데이터가 늦어지는 최대 시간(신선도) = 주기 + 1회 실행.
// shortcut: 1시간 칸으로 돌고, 이벤트 날은 하루 내내 평소 × 이벤트 배수로 본다. 몇 분짜리 몰림이 만드는 적체는 작게(이벤트는 크게) 나온다. 분 단위가 필요해지면 dayCurve(5분 칸)로 돈다
import { edgeFlow, type NodeLoad } from './load';
import { metric as m, type Metric } from './model';
import type { Project, ProjectNode } from './schema';

/** 허용 지연을 정하지 않았을 때 (예시값 — 서비스에 맞게 넣는다) */
export const DEFAULT_MAX_LAG_S = 300;

export type PipelineFlow = {
  /** 보내는 노드(큐 또는 배치에 데이터를 넣는 노드)와 받는 노드 */
  from: string;
  to: string;
  kind: 'queue' | 'batch';
  /** 피크 도착(건/초) */
  arrival: { normal: number; event: number };
  /** 처리량(건/초). 처리 시간(perf)을 모르면 없음 */
  capacity?: Metric;
  /** 큐: 하루 중 가장 큰 적체(건)와 지연(초, 끝없이 늘면 Infinity). 배치: 1회 실행(초)과 신선도(초) */
  backlog?: { normal: Metric; event: Metric };
  lag?: { normal: Metric; event: Metric };
  run?: { normal: Metric; event: Metric };
  /** 허용 지연(초): 큐는 지연, 배치는 실행 창 */
  limit: number;
};

/** 노드가 동시에 처리하는 수: 소비자 대수 × 대당 동시 처리 (대수를 계산하지 않는 노드는 이중화·최소 대수, 적어도 1대) */
const parallel = (n: ProjectNode, instances?: number) => (instances ?? Math.max(1, n.replicas, n.min_instances)) * (n.perf?.workers ?? 1);

/** 하루(시간 칸)의 적체·지연. lambda: 시간대별 도착(건/초), mu: 처리량(건/초). 전날 남은 적체까지 넣으려 이틀을 돈다 */
export function backlogDay(lambda: number[], mu: number, serviceS: number): { backlog: number; lag: number } {
  if (lambda.reduce((s, x) => s + x, 0) / lambda.length >= mu) return { backlog: Infinity, lag: Infinity };
  let b = 0, max = 0;
  for (let day = 0; day < 2; day++) {
    for (const l of lambda) {
      b = Math.max(0, b + (l - mu) * 3600);
      if (day) max = Math.max(max, b);
    }
  }
  return { backlog: max, lag: max / mu + serviceS };
}

/** 파이프라인 연결: 큐에서 나가는 연결선, 배치 노드로 들어오는 연결선.
 *  shape: 0~23시 부하 ÷ 피크, eventFactor: 이벤트 피크 ÷ 평소 피크, instances: 노드의 계산된 대수, factor: 사용자 배수(한계 찾기) */
export function pipelineFlows(p: Project, loads: Map<string, NodeLoad>, shape: number[], eventFactor: number,
  instances: (id: string, s: 'normal' | 'event') => number | undefined, factor = 1): PipelineFlow[] {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const out: PipelineFlow[] = [];
  for (const e of p.edges) {
    const from = byId.get(e.from)!, to = byId.get(e.to)!;
    const kind = to.batch ? 'batch' : from.layer === 'queue' ? 'queue' : undefined;
    const l = loads.get(e.from);
    if (!kind || !l) continue;
    const peak = edgeFlow(e, l, undefined, 'normal').rps * factor;
    const arrival = { normal: peak, event: peak * eventFactor };
    const limitOf = kind === 'batch' ? (to.batch!.window_min ?? to.batch!.every_min) * 60 : from.max_lag_s ?? to.max_lag_s ?? DEFAULT_MAX_LAG_S;
    const flow: PipelineFlow = { from: e.from, to: e.to, kind, arrival, limit: limitOf };
    if (to.perf) {
      const at = (s: 'normal' | 'event') => {
        const units = Math.min(parallel(to, instances(to.id, s)), kind === 'queue' && from.partitions ? from.partitions : Infinity);
        return { units, mu: (units * 1000) / to.perf!.service_ms };
      };
      const n0 = at('normal');
      flow.capacity = m(n0.mu, '건/초', kind === 'queue' && from.partitions ? 'min(소비자 대수 × 대당 동시 처리, 파티션 수) × 1000 / 평균 처리 ms' : '대수 × 대당 동시 처리 × 1000 / 평균 처리 ms',
        { 병렬: n0.units, 처리ms: to.perf.service_ms, ...(from.partitions && { 파티션: from.partitions }) });
      const day = (s: 'normal' | 'event') => shape.map((x) => arrival[s] * x);
      if (kind === 'queue') {
        const res = (s: 'normal' | 'event') => backlogDay(day(s), at(s).mu, to.perf!.service_ms / 1000);
        const rn = res('normal'), re = res('event');
        const how = '하루 시간 칸마다 적체 += (도착 − 처리량) × 3600, 0 아래로는 안 내려감 (하루 평균 도착 ≥ 처리량이면 끝없이 늚)';
        flow.backlog = { normal: m(rn.backlog, '건', how, { 처리량: at('normal').mu }), event: m(re.backlog, '건', how, { 처리량: at('event').mu }) };
        flow.lag = { normal: m(rn.lag, '초', '가장 큰 적체 / 처리량 + 1건 처리 시간', { 적체: rn.backlog }), event: m(re.lag, '초', '가장 큰 적체 / 처리량 + 1건 처리 시간', { 적체: re.backlog }) };
      } else {
        const every = to.batch!.every_min;
        const run = (s: 'normal' | 'event') => {
          const perRun = (day(s).reduce((a, x) => a + x, 0) * 3600 * every) / 1440;
          return m(perRun / at(s).mu, '초', '주기 동안 들어온 양 / 처리량', { 주기분: every, 건수: perRun, 처리량: at(s).mu });
        };
        flow.run = { normal: run('normal'), event: run('event') };
        flow.lag = {
          normal: m(every * 60 + flow.run.normal.value, '초', '주기 + 1회 실행 (데이터가 가장 늦게 반영되는 시간)', { 주기초: every * 60 }),
          event: m(every * 60 + flow.run.event.value, '초', '주기 + 1회 실행 (데이터가 가장 늦게 반영되는 시간)', { 주기초: every * 60 }),
        };
      }
    }
    out.push(flow);
  }
  return out;
}

/** 초 → 읽기 쉬운 시간 (끝없이 늘면 "끝없음") */
export const secs = (x: number) => (!Number.isFinite(x) ? '끝없음' : x < 1 ? `${Math.round(x * 1000)}ms` : x < 120 ? `${Math.round(x)}초` : x < 7200 ? `${Math.round(x / 60)}분` : `${(x / 3600).toFixed(1)}시간`);
const rate = (x: number) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));

/** 파이프라인 연결 한 줄 (CLI·화면·설계서): 평소 / 이벤트 */
export function flowLine(f: PipelineFlow, nameOf: (id: string) => string): string {
  const head = `${nameOf(f.from)} → ${nameOf(f.to)} (${f.kind === 'queue' ? '큐' : '배치'}): 피크 도착 ${rate(f.arrival.normal)} / ${rate(f.arrival.event)}건/초`;
  if (!f.capacity) return `${head} · 처리 시간(평균 처리 ms·대당 동시 처리)을 넣으면 ${f.kind === 'queue' ? '지연' : '실행 시간'}을 계산해요`;
  if (f.kind === 'queue') {
    return `${head} · 처리량 ${rate(f.capacity.value)}건/초 · 최대 지연 ${secs(f.lag!.normal.value)} / ${secs(f.lag!.event.value)} (허용 ${secs(f.limit)}) · 최대 적체 ${Number.isFinite(f.backlog!.event.value) ? Math.round(f.backlog!.event.value).toLocaleString('en-US') + '건' : '끝없음'}`;
  }
  return `${head} · 처리량 ${rate(f.capacity.value)}건/초 · 1회 실행 ${secs(f.run!.normal.value)} / ${secs(f.run!.event.value)} (실행 창 ${secs(f.limit)}) · 반영까지 최대 ${secs(f.lag!.event.value)}`;
}
