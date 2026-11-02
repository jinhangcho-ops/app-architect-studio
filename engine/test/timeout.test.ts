import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { Project } from '../schema';
import { checkSecurity, type SecurityCtx } from '../security';

// 타임아웃·재시도 예산 (형식 11): 동기 연결선의 timeout_ms·retries·breaker 점검과 외부 서비스 has_timeout 자동 채움
const proj = (edges: object[]) => Project.parse({
  name: 'p',
  nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, name: id.toUpperCase(), layer: 'backend' })),
  // 암호화를 정해 둬 미정 줄이 안 나게 (미정 시험은 따로)
  edges: edges.map((e) => ({ security: { tls: 'tls' }, ...e })),
});
const ctx = (p99: Record<string, number> = {}, util: Record<string, number> = {}): SecurityCtx => ({
  nodeEventRps: () => undefined, concurrentEvent: 0,
  downstreamP99Ms: (id, s) => (s === 'event' ? p99[id] : undefined),
  nodeUtil: (id, s) => (s === 'event' ? util[id] : undefined),
});
const net = (p: Project, c?: SecurityCtx) => checkSecurity(p, c).filter((h) => h.ruleId.startsWith('net_'))
  .map((h) => [h.level, h.ruleId, h.edge!.join('>'), h.target, h.why, h.instead]);

describe('타임아웃·재시도 점검 (동기 연결선)', () => {
  it('net_timeout_short: 타임아웃이 받는 쪽부터의 이벤트 p99보다 짧으면 ⚠️, 1.5배 미만이면 ℹ️ net_timeout_tight', () => {
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 100 }]), ctx({ b: 150 }))).toEqual([[
      'conditional', 'net_timeout_short', 'a>b', 'A → B', '타임아웃 100ms가 받는 쪽과 그 뒤 동기 호출의 p99 150ms보다 짧아 정상 요청도 끊깁니다',
      'p99의 1.5~2배로 두고, 더 줄이려면 받는 노드를 빠르게 하세요',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 200 }]), ctx({ b: 150 }))).toEqual([[
      'info', 'net_timeout_tight', 'a>b', 'A → B', '타임아웃 200ms가 p99 150ms에 가까워 느린 1%가 끊깁니다', 'p99의 1.5~2배로',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 150 }]), ctx({ b: 150 })).map((h) => h[1])).toEqual(['net_timeout_tight']);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 225 }]), ctx({ b: 150 }))).toEqual([]);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 300 }]), ctx({ b: 150 }))).toEqual([]);
    // p99가 없으면(perf 없음) 대조하지 않음
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 100 }]), ctx())).toEqual([]);
  });

  it('net_retry_no_timeout: 재시도가 있는데 타임아웃이 없으면 ⚠️', () => {
    expect(net(proj([{ from: 'a', to: 'b', retries: 2 }]))).toEqual([[
      'conditional', 'net_retry_no_timeout', 'a>b', 'A → B', '타임아웃 없이 재시도하면 느린 요청이 끝날 때까지 기다렸다 또 보내 스레드·연결이 쌓입니다', '타임아웃을 먼저 정하세요',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', retries: 2, timeout_ms: 500 }]))).toEqual([]);
    expect(net(proj([{ from: 'a', to: 'b', retries: 0 }]))).toEqual([]);
  });

  it('net_retry_storm: 모두 재시도하면 받는 노드 사용률이 100%를 넘으면 ⚠️', () => {
    expect(net(proj([{ from: 'a', to: 'b', retries: 2, timeout_ms: 500 }]), ctx({}, { b: 0.4 }))).toEqual([[
      'conditional', 'net_retry_storm', 'a>b', 'A → B', '받는 노드가 느려져 모두 재시도하면 부하가 3배가 되어 사용률 120% — 재시도가 장애를 키웁니다',
      '재시도는 1회로 줄이고 지수 백오프·지터로, 서킷 브레이커로 끊으세요',
    ]]);
    // 1회면 안내가 다르고, 브레이커가 켬이면 ℹ️
    expect(net(proj([{ from: 'a', to: 'b', retries: 1, timeout_ms: 500, breaker: true }]), ctx({}, { b: 0.6 }))).toEqual([[
      'info', 'net_retry_storm', 'a>b', 'A → B', '받는 노드가 느려져 모두 재시도하면 부하가 2배가 되어 사용률 120% — 재시도가 장애를 키웁니다 (브레이커가 끊어 주지만 끊기 전까지는 같음)',
      '지수 백오프·지터를 두고 서킷 브레이커로 끊으세요',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', retries: 2, timeout_ms: 500 }]), ctx({}, { b: 0.3 }))).toEqual([]);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 500 }]), ctx({}, { b: 0.9 }))).toEqual([]);
  });

  it('net_no_breaker: 재시도가 있는데 브레이커를 끔이면 ℹ️ (비면 묻지 않음)', () => {
    expect(net(proj([{ from: 'a', to: 'b', retries: 1, timeout_ms: 500, breaker: false }]))).toEqual([[
      'info', 'net_no_breaker', 'a>b', 'A → B', '재시도만 있고 서킷 브레이커가 없어 받는 쪽이 죽어 있어도 계속 두드립니다', '연속 실패 N회면 잠시 끊는 브레이커를 두세요',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', retries: 1, timeout_ms: 500, breaker: true }]))).toEqual([]);
    expect(net(proj([{ from: 'a', to: 'b', retries: 1, timeout_ms: 500 }]))).toEqual([]);
  });

  it('net_timeout_chain: 안쪽 타임아웃의 최댓값이 바깥보다 길면 바깥 연결선에 ⚠️', () => {
    const inner = [{ from: 'b', to: 'c', timeout_ms: 800 }, { from: 'b', to: 'd', timeout_ms: 300 }, { from: 'b', to: 'd', sync: false, timeout_ms: 5000 }];
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 500 }, ...inner]))).toEqual([[
      'conditional', 'net_timeout_chain', 'a>b', 'A → B', 'A → B 타임아웃 500ms보다 안쪽 B → C 타임아웃 800ms(재시도 포함 최대 800ms)가 같거나 길어, 바깥이 먼저 포기한 뒤에도 안쪽은 계속 돕니다',
      '안쪽 타임아웃을 바깥보다 짧게(바깥 ≥ Σ 안쪽 + 처리 시간)',
    ]]);
    expect(net(proj([{ from: 'a', to: 'b', timeout_ms: 1000 }, ...inner]))).toEqual([]);
  });

  it('net_timeout_chain: 안쪽은 재시도까지 곱하고, 같아도 ⚠️', () => {
    const chain = (e: object[]) => net(proj(e)).filter((h) => h[1] === 'net_timeout_chain').map((h) => h[4]);
    expect(chain([{ from: 'a', to: 'b', timeout_ms: 1000 }, { from: 'b', to: 'c', timeout_ms: 600, retries: 2 }])).toEqual([
      'A → B 타임아웃 1000ms보다 안쪽 B → C 타임아웃 600ms(재시도 포함 최대 1800ms)가 같거나 길어, 바깥이 먼저 포기한 뒤에도 안쪽은 계속 돕니다',
    ]);
    expect(chain([{ from: 'a', to: 'b', timeout_ms: 1000 }, { from: 'b', to: 'c', timeout_ms: 1000 }])).toHaveLength(1);
    expect(chain([{ from: 'a', to: 'b', timeout_ms: 1000 }, { from: 'b', to: 'c', timeout_ms: 999 }])).toEqual([]);
  });

  it('미정: 동기 연결선에 타임아웃이 비면 기존 연결선 미정 줄에 "타임아웃"이 붙음 (재시도·브레이커는 세지 않음)', () => {
    const unset = (e: object) => checkSecurity(Project.parse({ name: 'p', nodes: proj([]).nodes, edges: [{ from: 'a', to: 'b', ...e }] }))
      .filter((h) => h.ruleId === 'sec_edge_unset').map((h) => h.why);
    expect(unset({})).toEqual(['보안 값 미정: 암호화·지나는 망·타임아웃']);
    expect(unset({ timeout_ms: 500 })).toEqual(['보안 값 미정: 암호화·지나는 망']);
    expect(unset({ sync: false })).toEqual(['보안 값 미정: 암호화·지나는 망']);
  });

  it('비동기 연결선은 값이 무엇이든 점검하지 않음', () => {
    const p = proj([{ from: 'a', to: 'b', sync: false, timeout_ms: 100, retries: 3, breaker: false }, { from: 'b', to: 'c', sync: false, timeout_ms: 900 }]);
    expect(net(p, ctx({ b: 500 }, { b: 0.9 }))).toEqual([]);
  });
});

describe('analyze: ctx 채우기와 외부 서비스 has_timeout 자동', () => {
  const root = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
  const catalog = loadCatalog(root('data/catalog'));
  const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
  // 장부 앱: FastAPI(B-01, perf 있음) → Google Vision(X-01, external·sync_external_call). 예시의 X-01 vars를 지운다
  const ledger = loadProject(root('examples/ledger-fastapi.json'), catalog.items);
  const bare: Project = { ...ledger, nodes: ledger.nodes.map((n) => (n.id === 'X-01' ? { ...n, vars: { normal: {}, event: {} } } : n)) };
  const toX = (p: Project, e: object): Project => ({ ...p, edges: p.edges.map((x) => (x.to === 'X-01' ? { ...x, ...e } : x)) });
  const run = (p: Project) => analyze(p, d, '2026-10-28');

  it('들어오는 동기 연결선 중 하나라도 타임아웃이 비면 false', () => {
    const two: Project = { ...toX(bare, { timeout_ms: 2000 }), edges: [...toX(bare, { timeout_ms: 2000 }).edges, { ...bare.edges.find((x) => x.to === 'X-01')!, from: 'J-01', timeout_ms: undefined }] };
    expect(run(two).scenarios['X-01'].event.has_timeout).toBe(false);
  });

  it('들어오는 동기 연결선에 타임아웃이 모두 있으면 true, 모두 비면 false(동기 외부 호출이 걸림)', () => {
    const on = run(toX(bare, { timeout_ms: 2000 }));
    expect(on.scenarios['X-01'].event.has_timeout).toBe(true);
    expect(on.scenarios['X-01'].normal.has_timeout).toBe(true);
    const off = run(bare);
    expect(off.scenarios['X-01'].event.has_timeout).toBe(false);
    const x = off.judgements.find((j) => j.nodeId === 'X-01')!.items.find((i) => i.itemId === 'sync_external_call')!;
    expect(x.reasons.join(' ')).toContain('타임아웃이 없어');
  });

  it('동기 연결선이 없으면 넣지 않고, 노드 vars가 있으면 그 값', () => {
    expect(run(toX(bare, { sync: false })).scenarios['X-01'].event.has_timeout).toBeUndefined();
    expect(run(ledger).scenarios['X-01'].event.has_timeout).toBe(true);
    const pinned: Project = { ...bare, nodes: bare.nodes.map((n) => (n.id === 'X-01' ? { ...n, vars: { normal: { has_timeout: false }, event: { has_timeout: false } } } : n)) };
    expect(run(toX(pinned, { timeout_ms: 2000 })).scenarios['X-01'].event.has_timeout).toBe(false);
  });

  it('점검 ctx에 노드 p99·사용률을 넘김 (perf가 있는 B-01)', () => {
    const toB = (e: object): Project => ({ ...ledger, edges: ledger.edges.map((x) => (x.from === 'U-01' && x.to === 'B-01' ? { ...x, ...e } : x)) });
    const rules = (p: Project) => run(p).security.filter((h) => h.ruleId.startsWith('net_')).map((h) => `${h.ruleId}:${h.edge!.join('>')}`);
    expect(rules(toB({ timeout_ms: 1 }))).toEqual(['net_timeout_short:U-01>B-01']);
    expect(rules(toB({ timeout_ms: 100000 }))).toEqual([]);
    expect(rules(toB({ timeout_ms: 100000, retries: 100000 }))).toEqual(['net_retry_storm:U-01>B-01']);
  });

  it('net_timeout_short는 받는 쪽 뒤 동기 호출까지 더한 p99와 비교 (global-commerce N-08 → N-03: N-03 + N-09 ≈ 124ms)', () => {
    const gc = loadProject(root('examples/global-commerce.json'), catalog.items);
    const at = (t: number) => run({ ...gc, edges: gc.edges.map((x) => (x.from === 'N-08' && x.to === 'N-03' ? { ...x, timeout_ms: t } : x)) })
      .security.filter((h) => h.ruleId.startsWith('net_') && h.edge!.join('>') === 'N-08>N-03').map((h) => `${h.level}:${h.ruleId}`);
    expect(at(110)).toEqual(['conditional:net_timeout_short']);
    expect(at(160)).toEqual(['info:net_timeout_tight']);
    expect(at(200)).toEqual([]);
  });
});
