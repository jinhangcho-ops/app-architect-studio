// 4절 트래픽 계산: 사용 패턴별 사용자를 하루 동안 무작위로 접속시켜(시드 고정) 요청·피크·동시 접속·용량을 센다.
// 접속 횟수 ~ 포아송(패턴의 하루 평균). 접속 시각(현지 표준시)은 window_share 확률로 창 안의 정규분포(창 반폭 = window_sigma × σ,
// 창 밖은 다시 뽑음), 나머지는 창 밖 시간에 고르게. 그 뒤 기준 나라 표준시로 바꿔 1시간 칸에 담는다.
import { enabled } from './deploy';
import type { Metric } from './model';
import type { Persona, Project } from './schema';
import { utcOffset } from './timezones';

type Pattern = {
  label: string;
  sessions_per_day: number;
  reads_per_session: number;
  writes_per_session: number;
  session_minutes: number;
  write_kb: number;
  response_kb: number;
  sync_per_session: number;
};

/** 사용 패턴 프리셋. 값은 구간을 나누기 위한 예시이며, 실측이 있으면 페르소나에서 필드별로 덮어쓴다. */
export const PATTERNS: Record<Persona['pattern'], Pattern> = {
  power: { label: '핵심 열성', sessions_per_day: 8, reads_per_session: 35, writes_per_session: 5, session_minutes: 25, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  enthusiast: { label: '열성', sessions_per_day: 5, reads_per_session: 27, writes_per_session: 3, session_minutes: 15, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  active: { label: '적극', sessions_per_day: 3, reads_per_session: 23, writes_per_session: 2, session_minutes: 10, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  regular: { label: '일반', sessions_per_day: 1.5, reads_per_session: 19, writes_per_session: 1, session_minutes: 6, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  occasional: { label: '가끔', sessions_per_day: 0.4, reads_per_session: 14, writes_per_session: 1, session_minutes: 5, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  rare: { label: '드물게', sessions_per_day: 0.1, reads_per_session: 9.5, writes_per_session: 0.5, session_minutes: 3, write_kb: 1, response_kb: 20, sync_per_session: 1 },
  dormant: { label: '휴면 직전', sessions_per_day: 0.02, reads_per_session: 5, writes_per_session: 0, session_minutes: 2, write_kb: 1, response_kb: 20, sync_per_session: 1 },
};

// shortcut: 패턴마다 최대 20만 명만 뽑고 실제 인원 비율로 키운다. 피크가 들쭉날쭉하면 상한을 올린다
const SIM_CAP = 200_000;

export type Traffic = {
  dau: Metric;
  dailyRequests: Metric;
  dailyWrites: Metric;
  avgRps: Metric;
  peakShare: Metric;
  peakRps: Metric;
  peakRpsEvent: Metric;
  peakWriteRps: Metric;
  peakWriteRpsEvent: Metric;
  burstRps?: Metric;
  concurrentPeak: Metric;
  concurrentPeakEvent: Metric;
  storageGb: Metric;
  storageGbWithOverhead: Metric;
  egressGbPerDay: Metric;
  bandwidthMbpsEvent: Metric;
  /** 접속 중 현지 시간대 창 안에 들어온 비율 (window_share 근처) */
  inWindowShare: Metric;
  /** 기준 나라 표준시 0~23시별 RPS (평소) */
  hourlyRps: number[];
  /** 페르소나별 하루 합계 (무작위 하루). 1인당 값 = 합계 / people */
  personas: PersonaTraffic[];
  /** 행동이 쓰는 테이블('노드.테이블')별 하루 행 수와 피크 1시간의 초당 행 */
  tables: Record<string, { rowsPerDay: Metric; peakRowsPerSec: Metric }>;
};

export type PersonaTraffic = {
  name: string;
  share: number;
  /** 활성 사용자 × 비율 */
  people: number;
  dau: number;
  sessions: number;
  requests: number;
  writes: number;
  responseKb: number;
  /** 테이블('노드.테이블')별 하루 쓰기 행 */
  rows: Record<string, number>;
};

/** 접속 1회당 테이블별 쓰기 행: Σ 행동 빈도(페르소나 값 우선) × 행동 1회의 행 수 */
export function rowsPerSession(p: Project, ps: Persona): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of p.actions) {
    const rate = ps.action_rates[a.name] ?? a.per_session;
    for (const w of a.writes) out.set(`${w.node}.${w.table}`, (out.get(`${w.node}.${w.table}`) ?? 0) + rate * w.rows);
  }
  return out;
}

/** mulberry32: 작고 빠른 시드 고정 난수 */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gaussian = (r: () => number) => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
/** Knuth 방식. 하루 평균 접속이 수십 회 이하인 패턴에서만 쓰므로 충분히 빠르다 */
const poisson = (r: () => number, lambda: number) => {
  const limit = Math.exp(-lambda);
  let k = 0;
  for (let p = r(); p > limit; p *= r()) k++;
  return k;
};

export const patternOf = (ps: Persona): Pattern => {
  const base = PATTERNS[ps.pattern];
  const pick = <K extends keyof Pattern>(k: K) => (ps[k as keyof Persona] as Pattern[K] | undefined) ?? base[k];
  return {
    label: base.label,
    sessions_per_day: pick('sessions_per_day'),
    reads_per_session: pick('reads_per_session'),
    writes_per_session: pick('writes_per_session'),
    session_minutes: pick('session_minutes'),
    write_kb: pick('write_kb'),
    response_kb: pick('response_kb'),
    sync_per_session: pick('sync_per_session'),
  };
};

const m = (value: number, unit: string, formula: string, inputs: Record<string, number>): Metric => ({ value, unit, formula, inputs });

/** 서버 트래픽이 없는 구동 방식(로컬 exe)이거나 규모·페르소나가 없으면 undefined. */
export function traffic(p: Project): Traffic | undefined {
  if (!enabled(p.deploy, 'traffic') || !p.scale || !p.personas.length) return undefined;
  const { users, seed, event_multiplier: ev, retention_days: days, overhead_k: k, burst } = p.scale;
  const hybrid = p.deploy.mode === 'hybrid';
  const reportOffset = utcOffset(p.scale.report_country, p.scale.report_utc_offset);
  const r = rng(seed);

  const hourReq = Array<number>(24).fill(0);
  const hourWrite = Array<number>(24).fill(0);
  const hourUserSec = Array<number>(24).fill(0);
  let dau = 0, sessions = 0, inWindow = 0, writeKb = 0, respKb = 0;
  const personas: PersonaTraffic[] = [];
  const tableHour = new Map<string, number[]>();

  for (const ps of p.personas) {
    const pt = patternOf(ps);
    const n = Math.round(users * ps.share);
    const sim = Math.min(n, SIM_CAP);
    if (!sim) continue;
    const scale = n / sim;
    const [a, b] = ps.window;
    const span = (b - a + 24) % 24 || 24;
    const mu = a + span / 2, sigma = span / (2 * ps.window_sigma);
    const shift = reportOffset - utcOffset(ps.country, ps.utc_offset); // 현지 시각 + shift = 기준 나라 시각
    const share = ps.window_share ?? p.scale.window_share;
    // 행동이 있으면 쓰기 요청 = 행동 횟수(행동 1회 = 쓰기 요청 1건). 패턴의 writes_per_session은 쓰지 않는다
    const actionWrites = p.actions.reduce((s, a) => s + (ps.action_rates[a.name] ?? a.per_session), 0);
    const writes = p.actions.length ? actionWrites : pt.writes_per_session;
    const reqPer = hybrid ? pt.sync_per_session : pt.reads_per_session + writes;
    const writePer = hybrid ? pt.sync_per_session : writes;
    const rowsPer = [...rowsPerSession(p, ps)];
    for (const [k] of rowsPer) if (!tableHour.has(k)) tableHour.set(k, Array<number>(24).fill(0));
    const me: PersonaTraffic = { name: ps.name, share: ps.share, people: n, dau: 0, sessions: 0, requests: 0, writes: 0, responseKb: 0, rows: {} };

    for (let i = 0; i < sim; i++) {
      const kk = poisson(r, pt.sessions_per_day);
      if (kk) { dau += scale; me.dau += scale; }
      for (let j = 0; j < kk; j++) {
        let local: number;
        if (span === 24 || r() < share) {
          let off: number;
          do off = sigma * gaussian(r); while (Math.abs(off) > span / 2);
          local = mu + off;
          inWindow += scale;
        } else {
          // shortcut: 창 밖(밤)은 고르게 뽑는다. 새벽 4~5시 최저점까지 반영하려면 창 밖에도 곡선을 둔다
          local = b + r() * (24 - span);
        }
        // shortcut: 접속의 요청을 시작 시각의 1시간 칸에 몰아 담는다. 분 단위 피크가 필요해지면 접속 시간에 걸쳐 나눈다
        const h = Math.floor((((local + shift) % 24) + 24) % 24);
        hourReq[h] += reqPer * scale;
        hourWrite[h] += writePer * scale;
        hourUserSec[h] += pt.session_minutes * 60 * scale;
        sessions += scale;
        writeKb += writePer * pt.write_kb * scale;
        respKb += reqPer * pt.response_kb * scale;
        me.sessions += scale;
        for (const [k, rows] of rowsPer) tableHour.get(k)![h] += rows * scale;
      }
    }
    me.requests = me.sessions * reqPer;
    me.writes = me.sessions * writePer;
    me.responseKb = me.requests * pt.response_kb;
    me.rows = Object.fromEntries(rowsPer.map(([k, rows]) => [k, me.sessions * rows]));
    personas.push(me);
  }

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const req = sum(hourReq), writes = sum(hourWrite);
  const peakReqHour = Math.max(...hourReq);
  const peakRps = peakReqHour / 3600;
  const peakWriteRps = Math.max(...hourWrite) / 3600;
  const concurrent = Math.max(...hourUserSec) / 3600;
  const storage = (writeKb * days) / 1e6;
  const egress = respKb / 1e6;
  const avgRespKb = req ? respKb / req : 0;

  return {
    dau: m(dau, '명', '하루 1회 이상 접속한 사용자 (무작위 하루)', { 활성사용자: users, 시드: seed }),
    dailyRequests: m(req, '건/일', 'Σ 접속 × 접속당 요청 (무작위 하루)', { 접속: sessions }),
    dailyWrites: m(writes, '건/일', 'Σ 접속 × 접속당 쓰기 (무작위 하루)', { 접속: sessions }),
    avgRps: m(req / 86400, 'RPS', '하루 요청 / 86,400', { 하루요청: req }),
    peakShare: m(req ? peakReqHour / req : 0, '비율', '1시간 칸 중 가장 많은 칸의 비중', { 하루요청: req }),
    peakRps: m(peakRps, 'RPS', '피크 1시간 요청 / 3,600', { 피크1시간요청: peakReqHour }),
    peakRpsEvent: m(peakRps * ev, 'RPS', '피크 RPS × 이벤트 배수', { 피크RPS: peakRps, 이벤트배수: ev }),
    peakWriteRps: m(peakWriteRps, '건/초', '피크 1시간 쓰기 / 3,600', { 하루쓰기: writes }),
    peakWriteRpsEvent: m(peakWriteRps * ev, '건/초', '피크 쓰기 × 이벤트 배수', { 피크쓰기: peakWriteRps, 이벤트배수: ev }),
    ...(burst && {
      burstRps: m((dau * burst.share * burst.requests) / burst.window_s, 'RPS', 'DAU × 몰리는 비율 × 그 사이 요청 / 시간',
        { DAU: dau, 비율: burst.share, 요청: burst.requests, 초: burst.window_s }),
    }),
    concurrentPeak: m(concurrent, '명', '피크 1시간 체류(사용자·초) / 3,600', { 하루접속: sessions }),
    concurrentPeakEvent: m(concurrent * ev, '명', '피크 동시 접속 × 이벤트 배수', { 동시접속: concurrent, 이벤트배수: ev }),
    storageGb: m(storage, 'GB', 'Σ 하루 쓰기 × 건당 크기 × 보관 일수', { 하루쓰기KB: writeKb, 보관일수: days }),
    storageGbWithOverhead: m(storage * k, 'GB', '저장량 × 인덱스·복제 여유분', { 저장량: storage, 여유분: k }),
    egressGbPerDay: m(egress, 'GB/일', 'Σ 하루 요청 × 응답 크기', { 하루응답KB: respKb }),
    bandwidthMbpsEvent: m((peakRps * ev * avgRespKb * 8) / 1000, 'Mbps', '이벤트 피크 RPS × 평균 응답 크기',
      { 피크RPS: peakRps * ev, 평균응답KB: avgRespKb }),
    inWindowShare: m(sessions ? inWindow / sessions : 0, '비율', '현지 시간대 창 안에 들어온 접속 비율', { 접속: sessions }),
    hourlyRps: hourReq.map((x) => x / 3600),
    personas,
    tables: Object.fromEntries([...tableHour].map(([k, hours]) => {
      const day = sum(hours), peak = Math.max(...hours) / 3600;
      return [k, {
        rowsPerDay: m(day, '행/일', 'Σ 페르소나 접속 × 접속당 행동 빈도 × 행동 1회 행 수 (무작위 하루)', { 페르소나: personas.length }),
        peakRowsPerSec: m(peak, '행/초', '피크 1시간 행 / 3,600', { 피크1시간행: peak * 3600 }),
      }];
    })),
  };
}
