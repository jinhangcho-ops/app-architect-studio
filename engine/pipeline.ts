// 데이터 파이프라인: 큐에 쌓이는 양과 지연(소비자가 따라잡는지), 정해진 주기로 도는 배치의 1회 실행 시간.
// 큐: 소비자 그룹마다 모든 메시지를 받는다(Kafka 소비자 그룹). 도착 = 큐 → 소비자 연결선으로 흐르는 양, 처리량 = 병렬 수 × (1000 / 평균 처리 ms).
//     병렬 수 = 소비자 대수 × 대당 동시 처리, 파티션 수가 있으면 그것을 넘지 못한다(파티션 하나는 소비자 하나만 읽는다).
//     하루를 시간 칸으로 돌려 적체(건)를 쌓고 빼며, 지연 = 적체 / 처리량 + 1건 처리 시간. 하루 평균 도착이 처리량 이상이면 적체가 끝없이 는다.
// 배치(batch.every_min이 있는 노드): 주기 동안 들어온 양을 한 번에 처리한다 (1회 양은 하루 중 주기 길이 창의 가장 큰 합). 1회 실행 = 그 양 / 처리량, 실행 창(window_min, 없으면 주기) 안에 끝나야 한다.
//     데이터가 늦어지는 최대 시간(신선도) = 주기 + 1회 실행.
// 자동 확장 소비자(autoscale): KEDA처럼 도는 하루를 30초 칸(KEDA 확인 주기 기본값)으로 시뮬레이션한다. 도착은 1분 단위 트래픽 곡선(페르소나·하루 피크의 기대 곡선, dayCurve).
//     확인 주기(poll_s)마다 필요 대수 = ceil(지금 도착 × 처리 초 / (대당 동시 처리 × 목표 사용률))를 최소 대수 ~ 최대 대수(없으면 파티션 수 / 대당 동시 처리)로 자른다.
//     늘릴 때: 새 소비자는 delay_s 뒤에 처리를 시작한다. 줄일 때: 최근 cooldown_s 동안 필요했던 가장 큰 대수 아래로는 줄이지 않는다.
// 고정 대수 소비자도 같은 시뮬레이션을 최소 = 최대 대수로 돌린다. 도착은 1분 곡선을 설정의 계산 단위(queue_step_min, 기본 60분) 칸마다 평균한 것.
// shortcut: 이벤트 날은 하루 내내 평소 × 이벤트 배수로 본다 (이벤트가 몇 시간만이면 적체가 크게 나온다). 이벤트 시각이 필요해지면 하루 피크처럼 이벤트 창을 둔다
import { edgeFlow, type NodeLoad } from './load';
import { metric as m, type Metric } from './model';
import type { Project, ProjectNode } from './schema';

/** 허용 지연을 정하지 않았을 때 (예시값 — 서비스에 맞게 넣는다) */
export const DEFAULT_MAX_LAG_S = 300;
/** 새 소비자가 떠서 처리를 시작하기까지 (예시값 — 컨테이너 이미지·초기화에 따라 다르니 잰 값을 넣는다) */
export const DEFAULT_SCALE_DELAY_S = 30;
/** 적체·도착을 확인하는 주기 (KEDA pollingInterval 기본값) */
export const DEFAULT_POLL_S = 30;
/** 줄이기 전 기다리는 시간 (KEDA cooldownPeriod 기본값. 1대 이상에서 줄일 때 쓰는 HPA 축소 안정화 창도 기본 300초) */
export const DEFAULT_COOLDOWN_S = 300;

/** 자동 확장 하루 결과: 가장 큰 적체·지연, 시간대별 평균 대수(비용), 하루 중 가장 적은·많은 대수 */
export type AutoscaleDay = { backlog: number; lag: number; hourly: number[]; min: number; max: number };

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
  /** 자동 확장 소비자의 하루 */
  auto?: { normal: AutoscaleDay; event: AutoscaleDay };
};

/** 노드가 동시에 처리하는 수: 소비자 대수 × 대당 동시 처리 (대수를 계산하지 않는 노드는 이중화·최소 대수, 적어도 1대) */
const parallel = (n: ProjectNode, instances?: number) => (instances ?? Math.max(1, n.replicas, n.min_instances)) * (n.perf?.workers ?? 1);

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** 1분 단위 트래픽 곡선 → 시간 모양(shape: 0~23시 부하 ÷ 피크)과 같은 단위의 1분 칸 값. 하루 도착량이 무작위 하루(shape)와 같게 맞춘다
 *  (곡선의 모양은 기대값, 하루 양은 트래픽 계산 결과 그대로) */
export function minuteShape(perMin: number[], shape: number[]): number[] {
  const total = sum(perMin);
  return total > 0 ? perMin.map((x) => (x * sum(shape) * 60) / total) : perMin.map(() => 0);
}

export type AutoscaleOpts = { serviceMs: number; workers: number; cap: number; u: number; min: number; max: number; delayS: number; pollS: number; cooldownS: number };

/** 큐 소비자의 하루 (30초 칸, 전날 남은 적체·대수까지 넣으려 이틀을 돌고 둘째 날을 본다). lam: 1분 칸 도착(건/초) */
export function autoscaleDay(lam: number[], o: AutoscaleOpts): AutoscaleDay {
  const DT = 30, perMin = 60 / DT, steps = lam.length * perMin, pollEvery = Math.max(1, Math.round(o.pollS / DT));
  const rate = (N: number) => (Math.min(N * o.workers, o.cap) * 1000) / o.serviceMs;
  const need = (l: number) => Math.min(o.max, Math.max(o.min, Math.ceil((l * o.serviceMs) / 1000 / (o.workers * o.u))));
  const hourly = Array<number>(24).fill(0);
  if (sum(lam) >= lam.length * rate(o.max)) return { backlog: Infinity, lag: Infinity, hourly: hourly.map(() => o.max), min: o.max, max: o.max };
  let b = 0, active = need(lam[lam.length - 1]), waiting = 0, waitFrom = -1, maxB = 0, lag = 0, lo = Infinity, hi = 0;
  // 뜨는 중인 소비자(뜨는 시각 순)와 최근 cooldown 동안의 필요 대수. 30초마다 도니 배열을 새로 만들지 않는다
  // recent는 필요 대수가 줄어드는 순서로만 남긴다(뒤에 더 큰 값이 오면 앞의 작은 값은 다시 최대가 될 일이 없음) → 맨 앞이 최근 최대
  const pending: { at: number; n: number }[] = [], recent: { t: number; d: number }[] = [];
  const ends: number[] = [];
  for (let day = 0; day < 2; day++) {
    for (let k = 0; k < steps; k++) {
      const t = (day * steps + k) * DT, l = lam[Math.floor(k / perMin)];
      while (pending.length && pending[0].at <= t) { const x = pending.shift()!; active += x.n; waiting -= x.n; }
      if (k % pollEvery === 0) {
        const d = need(l), target = active + waiting;
        while (recent.length && recent[0].t <= t - o.cooldownS) recent.shift();
        while (recent.length && recent[recent.length - 1].d <= d) recent.pop();
        recent.push({ t, d });
        if (d > target) { pending.push({ at: t + o.delayS, n: d - target }); waiting += d - target; }
        else {
          // 줄이기: 최근 cooldown 동안 필요했던 가장 큰 대수까지만. 아직 안 뜬 것부터 거둔다
          let cut = target - recent[0].d;
          while (cut > 0 && pending.length) {
            const x = pending[pending.length - 1], c = Math.min(cut, x.n);
            x.n -= c; cut -= c; waiting -= c;
            if (!x.n) pending.pop();
          }
          if (cut > 0) active -= cut;
        }
      }
      const mu = rate(active);
      b = Math.max(0, b + (l - mu) * DT);
      // 처리할 소비자가 0대면 처음 온 메시지는 새 소비자가 뜰 때까지 기다린다
      if (b > 0 && mu === 0 && waitFrom < 0) waitFrom = t;
      const wait = mu === 0 ? (b > 0 ? t - waitFrom + DT : 0) : b / mu;
      if (mu > 0) waitFrom = -1;
      if (day) {
        hourly[Math.floor(k / (3600 / DT))] += (active * DT) / 3600;
        if (b > maxB) maxB = b;
        if (wait > lag) lag = wait;
        if (active < lo) lo = active;
        if (active > hi) hi = active;
      }
    }
    ends.push(b);
  }
  // 이틀째 끝에 적체가 더 많으면 하루에 다 빼지 못한다 (최대 대수에 막힘)
  if (ends[1] > ends[0] + 1e-6) return { backlog: Infinity, lag: Infinity, hourly, min: lo, max: hi };
  return { backlog: maxB, lag: lag + o.serviceMs / 1000, hourly, min: lo, max: hi };
}

/** 1분 곡선(같은 트래픽이면 같은 배열)마다 자동 확장 하루 결과 */
const simCache = new WeakMap<number[], Map<string, AutoscaleDay>>();

/** 1분 칸 값을 step분 칸마다 평균해 다시 1분 칸으로 편다 (고정 대수 소비자의 계산 단위) */
function stepped(mins: number[], step: number): number[] {
  if (step <= 1) return mins;
  return mins.map((_, i) => {
    const s = Math.floor(i / step) * step;
    return sum(mins.slice(s, s + step)) / Math.min(step, mins.length - s);
  });
}

/** 평소·이벤트 값을 처음 읽을 때 한 번만 계산한다 */
function pair<T>(f: (s: 'normal' | 'event') => T): { normal: T; event: T } {
  const c: Partial<Record<'normal' | 'event', T>> = {};
  return { get normal() { return (c.normal ??= f('normal')); }, get event() { return (c.event ??= f('event')); } };
}

/** 파이프라인 연결: 큐에서 나가는 연결선, 배치 노드로 들어오는 연결선.
 *  shape: 0~23시 부하 ÷ 피크, eventFactor: 이벤트 피크 ÷ 평소 피크, instances: 노드의 계산된 대수, factor: 사용자 배수(한계 찾기),
 *  minute: 1분 칸 부하 ÷ 가장 바쁜 1시간 평균 (자동 확장 소비자용, 없으면 shape를 1분 칸으로 늘려 씀) */
export function pipelineFlows(p: Project, loads: Map<string, NodeLoad>, shape: number[], eventFactor: number,
  instances: (id: string, s: 'normal' | 'event') => number | undefined, factor = 1, minute?: number[]): PipelineFlow[] {
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
      const perf = to.perf, cap = kind === 'queue' && from.partitions ? from.partitions : Infinity;
      const a = kind === 'queue' ? to.autoscale : undefined;
      const fixedN = (s: 'normal' | 'event') => instances(to.id, s) ?? Math.max(1, to.replicas, to.min_instances);
      const step = a ? 1 : p.scale?.queue_step_min ?? 60;
      const sim = kind === 'queue' ? (() => {
        const base = { serviceMs: perf.service_ms, workers: perf.workers, cap, u: p.target_utilization };
        const opts = (s: 'normal' | 'event'): AutoscaleOpts => (a
          ? { ...base, min: to.min_instances, max: Math.min(a.max ?? Infinity, Math.ceil(cap / perf.workers)), delayS: a.delay_s ?? DEFAULT_SCALE_DELAY_S,
            pollS: a.poll_s ?? DEFAULT_POLL_S, cooldownS: a.cooldown_s ?? DEFAULT_COOLDOWN_S }
          : { ...base, min: fixedN(s), max: fixedN(s), delayS: 0, pollS: DEFAULT_POLL_S, cooldownS: 0 });
        const mins = minute ?? shape.flatMap((x) => Array<number>(60).fill(x));
        // 같은 곡선·설정·도착이면 결과가 같다: 최선 조합 찾기가 항목만 바꿔 여러 번 분석할 때 다시 돌지 않는다
        if (!simCache.has(mins)) simCache.set(mins, new Map());
        const memo = simCache.get(mins)!;
        return pair((s) => {
          const o = opts(s), k = `${Object.values(o).join()}|${arrival[s]}|${step}`;
          if (!memo.has(k)) memo.set(k, autoscaleDay(stepped(mins, step).map((x) => arrival[s] * x), o));
          return memo.get(k)!;
        });
      })() : undefined;
      if (a) flow.auto = sim;
      const at = (s: 'normal' | 'event') => {
        const units = Math.min(flow.auto ? flow.auto[s].max * perf.workers : parallel(to, instances(to.id, s)), cap);
        return { units, mu: (units * 1000) / perf.service_ms };
      };
      const capacity = () => {
        const n0 = at('normal');
        return m(n0.mu, '건/초', `${flow.auto ? '가장 많을 때 ' : ''}${Number.isFinite(cap) ? 'min(소비자 대수 × 대당 동시 처리, 파티션 수)' : '대수 × 대당 동시 처리'} × 1000 / 평균 처리 ms`,
          { 병렬: n0.units, 처리ms: perf.service_ms, ...(from.partitions && { 파티션: from.partitions }) });
      };
      // 자동 확장 소비자는 하루 시뮬레이션이 무거워 값을 읽을 때 한 번만 돈다 (비용은 평소, 한계 찾기는 이벤트만 읽는다)
      if (flow.auto) { let c: Metric | undefined; Object.defineProperty(flow, 'capacity', { enumerable: true, get: () => (c ??= capacity()) }); }
      else flow.capacity = capacity();
      if (kind === 'queue') {
        const res = (s: 'normal' | 'event') => sim![s];
        const how = flow.auto
          ? '1분 단위 도착으로 30초마다 적체 += (도착 − 처리량) × 30, 처리량은 자동 확장 대수 (확인 주기마다 정하고, 늘린 대수는 뜨는 시간 뒤에, 줄이기는 cooldown 뒤에)'
          : `${step}분 칸 평균 도착으로 30초마다 적체 += (도착 − 처리량) × 30, 0 아래로는 안 내려감 (하루 도착 ≥ 하루 처리량이면 끝없이 늚)`;
        flow.backlog = pair((s) => m(res(s).backlog, '건', how, { 처리량: at(s).mu }));
        const lagHow = flow.auto ? '적체 / 그때 처리량 (0대일 때는 새 소비자가 뜰 때까지 기다린 시간) 중 가장 큰 것 + 1건 처리 시간' : '가장 큰 적체 / 처리량 + 1건 처리 시간';
        flow.lag = pair((s) => m(res(s).lag, '초', lagHow, { 적체: res(s).backlog }));
      } else {
        const every = to.batch!.every_min;
        // 1회 양 = 1분 곡선에서 주기 길이 창(자정을 넘어 이어짐)의 가장 큰 합. 하루 이상 주기는 하루 합 × 주기 / 1440
        const mins = minute ?? shape.flatMap((x) => Array<number>(60).fill(x));
        // 분 단위가 아닌 주기는 가장 가까운 정수 분 창으로 찾고 비율만큼 늘인다
        const k = Math.max(1, Math.round(every));
        const peakWin = k >= mins.length ? (sum(mins) * every) / mins.length : (() => {
          let w = sum(mins.slice(0, k)), best = w;
          for (let i = 1; i < mins.length; i++) { w += mins[(i + k - 1) % mins.length] - mins[i - 1]; if (w > best) best = w; }
          return (best * every) / k;
        })();
        const run = (s: 'normal' | 'event') => {
          const perRun = arrival[s] * peakWin * 60;
          return m(perRun / at(s).mu, '초', '주기 길이 창에 들어온 가장 큰 양 / 처리량', { 주기분: every, 건수: perRun, 처리량: at(s).mu });
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
const range = (x: AutoscaleDay) => (x.min === x.max ? `${x.max}` : `${x.min}~${x.max}`);
const rate = (x: number) => (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1));

/** 파이프라인 연결 한 줄 (CLI·화면·설계서): 평소 / 이벤트 */
export function flowLine(f: PipelineFlow, nameOf: (id: string) => string): string {
  const head = `${nameOf(f.from)} → ${nameOf(f.to)} (${f.kind === 'queue' ? '큐' : '배치'}): 피크 도착 ${rate(f.arrival.normal)} / ${rate(f.arrival.event)}건/초`;
  if (!f.capacity) return `${head} · 처리 시간(평균 처리 ms·대당 동시 처리)을 넣으면 ${f.kind === 'queue' ? '지연' : '실행 시간'}을 계산해요`;
  if (f.kind === 'queue') {
    const auto = f.auto ? ` · 소비자 ${range(f.auto.normal)} / ${range(f.auto.event)}대 (트래픽 따라 자동 확장)` : '';
    return `${head}${auto} · 처리량 ${rate(f.capacity.value)}건/초 · 최대 지연 ${secs(f.lag!.normal.value)} / ${secs(f.lag!.event.value)} (허용 ${secs(f.limit)}) · 최대 적체 ${Number.isFinite(f.backlog!.event.value) ? Math.round(f.backlog!.event.value).toLocaleString('en-US') + '건' : '끝없음'}`;
  }
  return `${head} · 처리량 ${rate(f.capacity.value)}건/초 · 1회 실행 ${secs(f.run!.normal.value)} / ${secs(f.run!.event.value)} (실행 창 ${secs(f.limit)}) · 반영까지 최대 ${secs(f.lag!.event.value)}`;
}
