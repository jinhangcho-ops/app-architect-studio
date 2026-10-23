import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { localMemoryMb } from '../deploy';
import { loadCatalog, loadProject } from '../io';
import { computedScenarios, nodeLoads } from '../load';
import { judgeNode } from '../judge';
import { Project } from '../schema';
import { patternOf, traffic, type Traffic } from '../traffic';

const catalog = loadCatalog(fileURLToPath(new URL('../../data/catalog', import.meta.url)));
const example = loadProject(fileURLToPath(new URL('../../examples/phase2.json', import.meta.url)), catalog.items);
const t = traffic(example)!;

/** 기대값(평균): 무작위 결과가 이 근처에 있어야 한다 */
const expected = (p: Project) => {
  let sessions = 0, requests = 0, dau = 0;
  for (const ps of p.personas) {
    const pt = patternOf(ps);
    const n = p.scale!.users * ps.share;
    sessions += n * pt.sessions_per_day;
    requests += n * pt.sessions_per_day * (pt.reads_per_session + pt.writes_per_session);
    dau += n * (1 - Math.exp(-pt.sessions_per_day)); // 포아송: 하루 1회 이상 들어올 확률
  }
  return { sessions, requests, dau };
};
// 창 안 80%: 창 반폭 7.5시간 = 2.7σ(σ ≈ 2.78시간)에서 잘라낸 정규분포. 15:30 중심 ±0.5시간 칸의 질량
// = 0.8 × 0.14285 / 0.99307 ≈ 0.1151. 창 밖 20%는 밤 9시간에 고르게 퍼져 이 칸에는 들어가지 않는다
const PEAK_SHARE = 0.1151;
const withPersonas = (over: object) => ({ ...example, personas: example.personas.map((ps) => ({ ...ps, ...over })) });

describe('관문: 무작위 접속 시각 (현지 08~23시에 80%)', () => {
  it('접속의 약 80%가 08~23시 안', () => {
    expect(Math.abs(t.inWindowShare.value - 0.8)).toBeLessThan(0.005);
  });

  it('페르소나의 window_share를 바꾸면 그 비율을 따라감', () => {
    expect(traffic(withPersonas({ window_share: 1 }))!.inWindowShare.value).toBe(1);
    expect(Math.abs(traffic(withPersonas({ window_share: 0.6 }))!.inWindowShare.value - 0.6)).toBeLessThan(0.005);
  });

  it('서비스 전체 기본값(scale.window_share)을 쓰고, 페르소나 값이 있으면 그 값이 우선', () => {
    const all = (s: number) => ({ ...example, scale: { ...example.scale!, window_share: s } });
    expect(Math.abs(traffic(all(0.7))!.inWindowShare.value - 0.7)).toBeLessThan(0.005);
    const mixed = { ...all(0.7), personas: example.personas.map((ps) => ({ ...ps, window_share: 0.9 })) };
    expect(Math.abs(traffic(mixed)!.inWindowShare.value - 0.9)).toBeLessThan(0.005);
  });

  it('피크 1시간 비중은 계산값(약 11.5%)과 거의 같음', () => {
    expect(Math.abs(t.peakShare.value - PEAK_SHARE)).toBeLessThan(0.005);
    expect(t.hourlyRps.indexOf(Math.max(...t.hourlyRps))).toBe(15);
  });

  it('시드가 같으면 결과가 같고, 다르면 조금 달라짐', () => {
    expect(traffic(example)!.peakRps.value).toBe(t.peakRps.value);
    const other = traffic({ ...example, scale: { ...example.scale!, seed: 2 } })!;
    expect(other.peakRps.value).not.toBe(t.peakRps.value);
    expect(Math.abs(other.peakRps.value / t.peakRps.value - 1)).toBeLessThan(0.02);
  });

  it('자정을 넘는 창(22~7시, 가운데 2:30)은 새벽 2시대가 피크', () => {
    const night = traffic({ ...example, personas: [{ ...example.personas[0], share: 1, window: [22, 7] }] })!;
    expect(night.hourlyRps.indexOf(Math.max(...night.hourlyRps))).toBe(2);
  });
});

describe('관문: 국가별 표준시', () => {
  const peakHour = (tt: Traffic) => tt.hourlyRps.indexOf(Math.max(...tt.hourlyRps));

  it('미국(동부, UTC−5) 사용자의 현지 15:30 피크는 한국 기준 새벽 5시대', () => {
    expect(peakHour(traffic(withPersonas({ country: 'US' }))!)).toBe(5);
  });

  it('기준 나라를 미국으로 바꾸면 한국 사용자 피크가 미국 기준 1시대', () => {
    expect(peakHour(traffic({ ...example, scale: { ...example.scale!, report_country: 'US' } })!)).toBe(1);
  });

  it('한국·일본은 같은 표준시라 피크가 겹침', () => {
    expect(peakHour(traffic(withPersonas({ country: 'JP' }))!)).toBe(15);
  });

  it('utc_offset으로 다른 지역을 직접 지정 (미국 서부 −8 → 한국 기준 8시대)', () => {
    expect(peakHour(traffic(withPersonas({ country: 'US', utc_offset: -8 }))!)).toBe(8);
  });

  it('표에 없는 나라는 utc_offset 없이 쓸 수 없음', () => {
    expect(() => Project.parse({ ...example, personas: [{ ...example.personas[0], share: 1, country: 'ZZ' }] })).toThrow();
  });
});

describe('관문: 사용 패턴 7구간과 규모 계산', () => {
  const e = expected(example);

  it('하루 요청·DAU가 기대값의 2% 안', () => {
    expect(Math.abs(t.dailyRequests.value / e.requests - 1)).toBeLessThan(0.02);
    expect(Math.abs(t.dau.value / e.dau - 1)).toBeLessThan(0.02);
  });

  it('드물게·휴면 직전 사용자가 있어 DAU는 활성 사용자보다 적음', () => {
    expect(t.dau.value).toBeLessThan(example.scale!.users * 0.7);
  });

  it('피크·이벤트·평균의 관계', () => {
    expect(t.peakRps.value).toBeCloseTo(t.dailyRequests.value * t.peakShare.value / 3600, 6);
    expect(t.peakRpsEvent.value).toBeCloseTo(t.peakRps.value * 3, 6);
    expect(t.avgRps.value).toBeCloseTo(t.dailyRequests.value / 86400, 6);
    expect(t.storageGbWithOverhead.value).toBeCloseTo(t.storageGb.value * 2, 6);
  });

  it('페르소나에서 패턴 값을 필드별로 덮어씀', () => {
    expect(patternOf({ ...example.personas[3], sessions_per_day: 9 })).toMatchObject({ sessions_per_day: 9, reads_per_session: 19 });
  });

  it('모든 결과에 공식이 붙어 있음', () => {
    for (const [k, v] of Object.entries(t)) if (!Array.isArray(v)) expect(v.formula, k).not.toBe('');
  });
});

const one = (over: object) => Project.parse({
  name: 'p',
  scale: { users: 1000 },
  personas: [{ name: 'a', share: 1, pattern: 'regular', sync_per_session: 4 }],
  nodes: [{ id: 'w', name: 'w', layer: 'ui' }],
  ...over,
});

describe('구동 방식 (16절)', () => {
  it('로컬 exe면 서버 트래픽 계산이 없고, 판정 변수에는 구동 방식만 들어감', () => {
    const p = one({ deploy: { mode: 'local_exe', offline_required: true } });
    expect(traffic(p)).toBeUndefined();
    expect(computedScenarios(p, undefined).get('w')!.normal).toEqual({
      deploy_mode: 'local_exe', offline_required: true, single_user: false, writer_nodes: 0,
    });
  });

  it('하이브리드는 접속마다 동기화 요청 4건, 요청 = 쓰기', () => {
    const h = traffic(one({ deploy: { mode: 'hybrid' } }))!;
    expect(h.dailyWrites.value).toBe(h.dailyRequests.value);
    expect(Math.abs(h.dailyRequests.value / (1000 * 1.5 * 4) - 1)).toBeLessThan(0.1);
  });

  it('로컬 메모리: 런타임 + 상시 로드 합 + 지연 로드 중 최대 + 캐시', () => {
    expect(localMemoryMb({ runtime_mb: 80, eager_mb: [30, 20], lazy_mb: [150, 60], cache_mb: 50 }).value).toBe(330);
  });
});

describe('노드별 부하 전파', () => {
  // 부하 전파만 보려고 트래픽 값을 고정한다: 피크 2 RPS 중 쓰기 1
  const fixed = { peakRps: { value: 2 }, peakRpsEvent: { value: 6 }, peakWriteRps: { value: 1 }, peakWriteRpsEvent: { value: 3 } } as unknown as Traffic;
  const tiny = (edges: object[]) => Project.parse({
    name: 'p',
    nodes: [
      { id: 'w', name: 'w', layer: 'ui' }, { id: 'a', name: 'a', layer: 'backend' },
      { id: 'b', name: 'b', layer: 'backend' }, { id: 'd', name: 'd', layer: 'db' },
    ],
    edges,
  });

  it('갈라졌다 합쳐지면 호출 비율대로 더해지고, read 연결은 쓰기를 넘기지 않음', () => {
    const p = tiny([
      { from: 'w', to: 'a' }, { from: 'w', to: 'b', callRatio: 2 },
      { from: 'a', to: 'd' }, { from: 'b', to: 'd', carries: 'read' },
    ]);
    const d = nodeLoads(p, fixed).get('d')!;
    expect(d.rps).toEqual({ normal: 2 + 2, event: 6 + 6 }); // a에서 전체 2, b에서 읽기만 (2×2 − 쓰기 2) = 2
    expect(d.writeRps).toEqual({ normal: 1, event: 3 });
    expect(computedScenarios(p, fixed).get('d')!.normal.writer_nodes).toBe(1);
  });

  it('순환 연결은 오류', () => {
    expect(() => nodeLoads(tiny([{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]), fixed)).toThrow('순환 연결');
  });
});

describe('계산값이 판정으로 연결됨', () => {
  it('예시 프로젝트: SQLite는 쓰는 노드 2개(API·워커)로 안 됨, API 1대 판정에는 계산된 RPS가 쓰임', () => {
    const c = computedScenarios(example, t);
    const verdict = (id: string) => judgeNode(example.nodes.find((n) => n.id === id)!, catalog.byId, c.get(id)).items[0];
    expect(verdict('db').verdict).toBe('fail');
    expect(verdict('db').reasons[0]).toContain('쓰는 노드가 2개');
    expect(c.get('api')!.event.peak_rps).toBeCloseTo(t.peakRpsEvent.value, 6);
    expect(verdict('api').verdict).toBe(t.peakRpsEvent.value > 500 ? 'conditional' : 'ok');
  });
});

describe('페르소나별 트래픽: 각자의 패턴·비율로 계산하고 더함', () => {
  it('페르소나 합계가 전체 값과 같고, 1인당 요청은 하루 접속 × 접속당 요청 근처', () => {
    expect(t.personas.reduce((s, x) => s + x.requests, 0)).toBeCloseTo(t.dailyRequests.value, 0);
    expect(t.personas.reduce((s, x) => s + x.dau, 0)).toBeCloseTo(t.dau.value, 0);
    for (const [i, x] of t.personas.entries()) {
      const pt = patternOf(example.personas[i]);
      const perPerson = pt.sessions_per_day * (pt.reads_per_session + pt.writes_per_session);
      // 접속 수는 포아송이라 표준편차 = √기대값. 4σ 안이면 정상 (인원이 적은 페르소나일수록 넓다)
      const tol = 4 / Math.sqrt(x.people * pt.sessions_per_day);
      expect(Math.abs(x.requests / x.people / perPerson - 1)).toBeLessThan(tol);
    }
  });
});

describe('행동 → 테이블 행', () => {
  const table = (name: string) => ({ name, columns: [{ name: 'id', type: 'bigint' }] });
  const p = Project.parse({
    name: 'p',
    scale: { users: 100_000 },
    personas: [
      { name: '열성', pattern: 'power', share: 0.2, action_rates: { 주문: 0.5 } },
      { name: '일반', pattern: 'regular', share: 0.8 },
    ],
    nodes: [{ id: 'ui', name: '화면', layer: 'ui' }, { id: 'db', name: 'DB', layer: 'db', tables: [table('orders'), table('items')] }],
    actions: [{ name: '주문', per_session: 0.1, writes: [{ node: 'db', table: 'orders' }, { node: 'db', table: 'items', rows: 3 }] }],
  });
  const tr = traffic(p)!;
  const near = (v: number, want: number) => { expect(v).toBeGreaterThan(want * 0.97); expect(v).toBeLessThan(want * 1.03); };

  it('열성 2만 명 × 하루 8접속 × 주문 0.5 = 8만 주문, 일반 8만 명 × 1.5 × 0.1 = 1.2만', () => {
    near(tr.personas[0].rows['db.orders'], 20_000 * 8 * 0.5);
    near(tr.personas[1].rows['db.orders'], 80_000 * 1.5 * 0.1);
    near(tr.tables['db.items'].rowsPerDay.value, 3 * (80_000 + 12_000));
    expect(tr.tables['db.orders'].peakRowsPerSec.value).toBeGreaterThan(tr.tables['db.orders'].rowsPerDay.value / 86_400);
  });

  it('행동이 있으면 쓰기 요청 = 행동 횟수 (패턴의 접속당 쓰기는 쓰지 않음)', () => {
    near(tr.personas[0].writes, 20_000 * 8 * 0.5);
    near(tr.personas[0].requests, 20_000 * 8 * (35 + 0.5));
  });
});
