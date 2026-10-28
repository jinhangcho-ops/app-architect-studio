// 장애 시나리오: 존(가용 영역) 하나가 멈출 때, 리전 하나가 멈출 때, 데이터를 백업에서 되살릴 때.
// 존: 서버 N대를 zones개 존에 고르게 나눠 두었다고 보고, 존 하나가 멈추면 ceil(N / zones)대를 잃는다 (존이 1개면 전부).
//     남은 서버의 사용률 = 지금 사용률 × N / 남은 대수. 주 서버 1대 DB는 다른 존의 대기 서버로 넘긴다.
// 리전: 그 리전의 노드는 다른 리전 복사본(dr)이 없으면 리전이 돌아올 때까지 멈춘다. 복사본이 있으면 방식에 따라 넘기는 시간(RTO)과 복제 지연만큼 잃는 데이터(RPO).
// 백업: RPO = 백업 주기(시점 복구면 로그 보관 간격), RTO = 새 서버 준비 + 데이터 크기 / 되살리는 속도.
// 캐시: 캐시 노드가 멈추면 cache-aside 읽기가 모두 DB로 간다. 적중률을 0으로 두고 부하를 다시 계산해 늘어나는 노드의 사용률 = 캐시 없을 때 부하 / (대수 × 대당 처리량) (주 서버 1대 DB는 max(쓰기, 읽기 / 복제본 수)).
//     넘긴 직후 복사본의 사용률: active는 같은 대수가 떠 있어 그대로, standby는 지금 사용률 × 대수 / 대기 대수 (대기 복사본이 대수를 늘리기 전).
// shortcut: 존·리전 장애 직후(자동 확장이 대수를 다시 채우기 전)의 사용률만 본다. active도 한쪽이 전부 받는 크기로 두 리전에 띄운다고 본다 (평소 나눠 받아 절반만 쓰는 것은 세지 않음)
import { impactOf, standingInstances } from './availability';
import type { Vars } from './expr';
import type { NodeLoad } from './load';
import { fmt, metric as m, type Metric } from './model';
import { secs } from './pipeline';
import { nodeRegion, type Project, type ProjectNode } from './schema';

// 예시값: 실제 값은 클라우드 문서·복구 훈련 기록으로 dr.rto_s, backup.restore_mb_s에 넣는다
/** 같은 리전의 대기 서버로 넘기는 시간 (RDS Multi-AZ 문서: 보통 60~120초) */
export const FAILOVER_S = 60;
/** 다른 리전으로 넘기는 시간: active = 트래픽만 돌림, standby = 대기 복사본을 키워 받음 */
export const DR_RTO_S = { active: 60, standby: 900 } as const;
/** 리전 간 비동기 복제 지연 */
export const DR_LAG_S = 5;
/** 시점 복구 로그 보관 간격 (RDS 시점 복구: 보통 최근 5분 안) */
export const PITR_RPO_S = 300;
/** 백업에서 되살리는 속도와 새 서버 준비 시간 */
export const RESTORE_MB_S = 100;
export const PROVISION_S = 600;

/** analyze가 넘기는 노드 정보: 계산된 대수·사용률, 최대 대수, 주 서버 1대 DB인지, 저장 데이터 크기, 지금 부하 */
export type NodeInfo = { N?: { normal: number; event: number }; util?: { normal: number; event: number }; max?: number; singlePrimary: boolean; dataGb?: number; rps?: { normal: number; event: number }; per?: number; readReplicas?: boolean; writeRps?: { normal: number; event: number } };

/** 장애 때 떠 있는 서버 수: 계산된 대수와 늘 떠 있는 대수 중 큰 것, 최대 대수 이하 (용량 계산과 같은 대수) */
const serversOf = (n: ProjectNode, x: NodeInfo, s: 'normal' | 'event') => Math.max(x.N?.[s] ?? 0, standingInstances(n, x.max));

export type ZoneCase = { nodeId: string; zones: number; servers: number; lost: number; down: boolean; util?: { normal: Metric; event: Metric }; rto: Metric };
export type RegionCase = {
  region: string; down: string[]; failover: string[]; stopped: string[]; delayed: string[]; rto?: Metric; rpo?: Metric;
  /** 넘긴 직후 복사본의 사용률 (사용률을 계산하는 노드만) */
  util: Record<string, { normal: Metric; event: Metric }>;
};
export type DataCase = { nodeId: string; rpo: Metric; restore?: Metric };
/** 캐시 노드 전부 멈춤: 적중률을 0으로 두고 다시 계산하면 부하가 늘어나는 노드(보통 DB) */
export type CacheCase = { cacheId: string; affected: { nodeId: string; rps: { normal: Metric; event: Metric }; util?: { normal: Metric; event: Metric } }[] };
export type Failure = { zone: ZoneCase[]; regions: RegionCase[]; data: DataCase[]; cache: CacheCase[] };

export const isServer = (n: ProjectNode) => n.layer !== 'ui' && n.layer !== 'external' && n.region !== 'local';
const isData = (n: ProjectNode) => n.layer === 'db' || n.layer === 'analytics';

/** 백업에서 되살리는 시간(초). 백업이 없거나 크기를 모르면 undefined */
const restoreS = (n: ProjectNode, gb?: number) => (n.backup && gb !== undefined ? PROVISION_S + (gb * 1024) / (n.backup.restore_mb_s ?? RESTORE_MB_S) : undefined);
/** 다른 리전 복사본으로 넘기는 시간(초). 백업 방식인데 크기를 모르면 undefined */
const drRtoS = (n: ProjectNode, gb?: number) => (!n.dr ? undefined : n.dr.rto_s ?? (n.dr.mode === 'backup' ? restoreS(n, gb) : DR_RTO_S[n.dr.mode]));
/** 장애 때 잃는 데이터 시간(초): 백업 주기·시점 복구·리전 복제 지연 중 가장 짧은 것. 아무것도 없으면 Infinity */
const rpoS = (n: ProjectNode) => Math.min(
  n.backup ? (n.backup.pitr ? PITR_RPO_S : n.backup.every_h * 3600) : Infinity,
  n.dr && n.dr.mode !== 'backup' ? n.dr.lag_s ?? DR_LAG_S : Infinity,
);

/** loadsWithout(캐시 id): 그 캐시의 적중률을 0으로 둔 부하. 부하를 계산하지 않으면 undefined (캐시 장애를 만들지 않음) */
export function failureScenarios(p: Project, info: (n: ProjectNode) => NodeInfo, loadsWithout: (cacheId: string) => Map<string, NodeLoad> | undefined): Failure {
  const servers = p.nodes.filter(isServer);
  const zone = servers.map((n): ZoneCase => {
    const x = info(n), zones = n.zones ?? 1;
    const count = (s: 'normal' | 'event') => serversOf(n, x, s);
    const N = count('normal'), lost = zones === 1 ? N : Math.ceil(N / zones), down = lost >= N;
    const after = (s: 'normal' | 'event') => {
      const all = count(s), alive = all - (zones === 1 ? all : Math.ceil(all / zones));
      return m(alive > 0 ? (x.util![s] * all) / alive : Infinity, '비율', '지금 사용률 × 대수 / 남은 대수 (자동 확장이 채우기 전)', { 사용률: x.util![s], 대수: all, 남은대수: alive });
    };
    return {
      nodeId: n.id, zones, servers: N, lost, down,
      ...(x.util && !down && { util: { normal: after('normal'), event: after('event') } }),
      rto: m(down ? Infinity : x.singlePrimary ? FAILOVER_S : 0, '초', down ? '존 하나뿐이라 존이 돌아올 때까지' : x.singlePrimary ? '대기 서버로 넘기는 시간 (예시값)' : '남은 존의 서버가 바로 받음', { 존: zones }),
    };
  });

  const regions = [...new Set(servers.map((n) => nodeRegion(n, p)).filter((r): r is NonNullable<typeof r> => !!r))].map((region): RegionCase => {
    const inR = servers.filter((n) => nodeRegion(n, p) === region);
    const failover = inR.filter((n) => n.dr && n.dr.region !== region), down = inR.filter((n) => !failover.includes(n));
    const impact = Object.entries(impactOf(p, down.map((n) => n.id)));
    const rtos = failover.map((n) => drRtoS(n, info(n).dataGb));
    const data = failover.filter(isData);
    const util = Object.fromEntries(failover.flatMap((n) => {
      const x = info(n);
      if (!x.util) return [];
      const copy = n.dr!.mode === 'active' ? undefined : n.dr!.instances ?? 1;
      const at = (s: 'normal' | 'event') => {
        const all = serversOf(n, x, s);
        return copy === undefined
          ? m(x.util![s], '비율', '복사본(active)이 같은 대수로 떠 있어 사용률 그대로', { 사용률: x.util![s] })
          : m((x.util![s] * all) / copy, '비율', '지금 사용률 × 대수 / 대기 대수 (대기 복사본이 대수를 늘리기 전)', { 사용률: x.util![s], 대수: all, 대기대수: copy });
      };
      return [[n.id, { normal: at('normal'), event: at('event') }]];
    }));
    return {
      util,
      region, down: down.map((n) => n.id), failover: failover.map((n) => n.id),
      stopped: impact.filter(([, h]) => h === 'stopped').map(([id]) => id), delayed: impact.filter(([, h]) => h === 'delayed').map(([id]) => id),
      ...(down.length ? { rto: m(Infinity, '초', '복사본 없는 노드가 리전이 돌아올 때까지 멈춤', { 멈춤: down.length }) }
        : rtos.every((x) => x !== undefined) && { rto: m(Math.max(0, ...rtos as number[]), '초', '복사본으로 넘기는 시간 중 가장 긴 것', Object.fromEntries(failover.map((n, i) => [n.id, rtos[i]!]))) }),
      ...(data.length && { rpo: m(Math.max(...data.map(rpoS)), '초', '복사본 데이터 노드가 잃는 시간 중 가장 긴 것', Object.fromEntries(data.map((n) => [n.id, rpoS(n)]))) }),
    };
  });

  const data = servers.filter(isData).map((n): DataCase => {
    const gb = info(n).dataGb, r = restoreS(n, gb);
    return {
      nodeId: n.id,
      rpo: m(rpoS(n), '초', 'min(백업 주기 또는 시점 복구 간격, 리전 복제 지연). 둘 다 없으면 되살릴 수 없음', { 백업주기시간: n.backup?.every_h ?? 0 }),
      ...(r !== undefined && { restore: m(r, '초', '새 서버 준비 + 데이터 크기 / 되살리는 속도', { 준비초: PROVISION_S, 데이터GB: gb!, 'MB/초': n.backup!.restore_mb_s ?? RESTORE_MB_S }) }),
    };
  });
  // shortcut: 대수는 그대로 둠(캐시 장애 때 복제본을 늘리지 않음), 캐시 장애 때 자동 확장이 대수를 늘리는 것까지 세게 되면 sizeAt으로
  const cache = servers.filter((c) => c.layer === 'cache').flatMap((c): CacheCase[] => {
    const without = loadsWithout(c.id);
    if (!without) return [];
    const affected = p.nodes.flatMap((n) => {
      const x = info(n), now = x.rps, w = without.get(n.id)?.rps;
      if (!now || !w || (w.normal <= now.normal && w.event <= now.event)) return [];
      const rps = (s: 'normal' | 'event') => m(w[s], 'RPS', '캐시 적중률을 0으로 두고 다시 계산한 부하', { 지금부하: now[s] });
      // 사용률은 지금 사용률의 비율이 아니라 대수로 다시 계산 (지금 부하가 0이어도, 쓰기가 많은 주 서버 1대 DB도 맞게)
      const util = x.per && x.N && x.writeRps ? (s: 'normal' | 'event') => {
        const N = x.N![s], wr = x.writeRps![s], per = x.per!;
        const split = x.singlePrimary && x.readReplicas && N > 1;
        const v = split ? Math.max(wr / per, (w[s] - wr) / ((N - 1) * per)) : w[s] / ((x.singlePrimary ? 1 : N) * per);
        return m(v, '비율', split ? 'max(쓰기 / 대당 처리량, 읽기 / (복제본 수 × 대당 처리량)), 대수 그대로' : x.singlePrimary ? '캐시 없을 때 부하 / 대당 처리량 (읽기 복제본이 없어 주 서버 1대가 모두 받음)' : '캐시 없을 때 부하 / (대수 × 대당 처리량), 대수 그대로', { 캐시없을때부하: w[s], 대수: N, 대당: per, 쓰기: wr });
      } : undefined;
      return [{ nodeId: n.id, rps: { normal: rps('normal'), event: rps('event') }, ...(util && { util: { normal: util('normal'), event: util('event') } }) }];
    });
    return affected.length ? [{ cacheId: c.id, affected }] : [];
  });
  return { zone, regions, data, cache };
}

/** 장애 목표(recovery)가 있을 때 노드의 판정 변수. 판정(judge.recoveryIssues)이 이것으로 이유를 만든다 */
export function recoveryVars(f: Failure | undefined, p: Project, n: ProjectNode, s: 'normal' | 'event', gb?: number): Vars {
  if (!f || !p.recovery || !isServer(n)) return {};
  const z = f.zone.find((x) => x.nodeId === n.id)!, d = f.data.find((x) => x.nodeId === n.id);
  const r = f.regions.find((x) => x.down.includes(n.id) || x.failover.includes(n.id));
  const stops = Object.values(impactOf(p, [n.id])).includes('stopped');
  const drRto = drRtoS(n, gb);
  // 이 노드에 닿는 캐시 장애 중 사용률이 가장 큰 것 (장면별)
  const c = f.cache.flatMap((x) => x.affected.filter((a) => a.nodeId === n.id && a.util).map((a) => ({ id: x.cacheId, util: a.util![s].value })))
    .reduce<{ id: string; util: number } | undefined>((b, a) => (!b || a.util > b.util ? a : b), undefined);
  return {
    ...(c && { cache_util: c.util, cache_name: p.nodes.find((x) => x.id === c.id)!.name }),
    survive: p.recovery.survive, zones: z.zones, zone_down: z.down, zone_rto_s: z.rto.value, node_stops: stops,
    ...(z.util && { zone_util: z.util[s].value }),
    ...(r && { region_down: r.down.includes(n.id) }),
    ...(drRto !== undefined && { region_rto_s: drRto }),
    ...(r?.util[n.id] && { region_util: r.util[n.id][s].value }),
    ...(d && { rpo_s: d.rpo.value, ...(d.restore && { restore_rto_s: d.restore.value }) }),
    ...(p.recovery.rto_min !== undefined && { target_rto_s: p.recovery.rto_min * 60 }),
    ...(p.recovery.rpo_min !== undefined && { target_rpo_s: p.recovery.rpo_min * 60 }),
  };
}

/** 장애 시나리오 줄들 (CLI·화면·설계서). 존·데이터는 노드마다, 리전은 리전마다 */
export function failureLines(f: Failure, nameOf: (id: string) => string, id?: string): string[] {
  const zone = f.zone.filter((z) => !id || z.nodeId === id).map((z) => `${nameOf(z.nodeId)} — 존 하나 장애: ${z.down
    ? (z.servers === 1 ? '서버가 1대뿐이라 멈춤' : `서버 ${z.servers}대가 모두 한 존에 있어 멈춤`)
    : `${z.servers}대 중 ${z.lost}대를 잃음${z.util ? ` · 남은 서버 사용률 ${pct(z.util.normal.value)} / ${pct(z.util.event.value)}` : ''}${z.rto.value ? ` · 넘기는 데 ${secs(z.rto.value)}` : ''}`}`);
  const data = f.data.filter((x) => !id || x.nodeId === id).map((x) => `${nameOf(x.nodeId)} — 데이터: ${Number.isFinite(x.rpo.value) ? `잃는 데이터 최대 ${secs(x.rpo.value)}` : '백업·복사본이 없어 되살릴 수 없음'}${x.restore ? ` · 백업에서 되살리기 ${secs(x.restore.value)}` : ''}`);
  const cache = f.cache.filter((c) => !id || c.cacheId === id || c.affected.some((a) => a.nodeId === id)).map((c) => `${nameOf(c.cacheId)} — 캐시 장애: ${c.affected
    .map((a) => `${nameOf(a.nodeId)} 부하 ${fmt(a.rps.normal.inputs['지금부하'])} → ${fmt(a.rps.normal.value)} RPS${a.util ? `, 사용률 ${pct(a.util.normal.value)} / ${pct(a.util.event.value)}` : ''}`).join(', ')}`);
  return [...zone, ...data, ...cache, ...regionLines(f, nameOf, id)];
}

/** 리전마다 한 줄: 멈추는 노드·화면, 넘어가는 노드와 시간, 잃는 데이터. id가 있으면 그 노드가 있는 리전만 */
export function regionLines(f: Failure, nameOf: (id: string) => string, id?: string): string[] {
  return f.regions.filter((r) => !id || r.down.includes(id) || r.failover.includes(id)).map((r) => `리전 ${r.region} 장애: ${r.down.length
    ? `${r.down.map(nameOf).join(', ')} 멈춤${r.stopped.length ? ` → ${r.stopped.map(nameOf).join(', ')} 멈춤` : ''}${r.delayed.length ? ` · ${r.delayed.map(nameOf).join(', ')} 반영 지연` : ''}`
    : '모든 노드가 다른 리전 복사본으로 넘어감'}${r.failover.length ? ` · 넘어감: ${r.failover.map((x) => `${nameOf(x)}${r.util[x] ? ` 넘긴 직후 사용률 ${pct(r.util[x].normal.value)} / ${pct(r.util[x].event.value)}` : ''}`).join(', ')}${r.rto ? ` (${secs(r.rto.value)})` : ''}` : ''}${r.rpo ? ` · 잃는 데이터 최대 ${secs(r.rpo.value)}` : ''}`);
}
const pct = (x: number) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '끝없음');
