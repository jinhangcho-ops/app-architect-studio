import { describe, expect, it } from 'vitest';
import { Project } from '../../engine/schema';
import { mergeCodeAnalysis } from './codeImport';
import { run } from './edit';

// tools/analyze_py.py --self-test의 예시 패키지를 분석했을 때와 같은 모양
const analysis = {
  source: '/tmp/pkg',
  modules: [
    { id: 'main', file: 'main.py', layer: 'backend', eager: ['redis', 'services.order_worker'], lazy: [], privacy_hints: [] },
    { id: 'services.order_worker', file: 'services/order_worker.py', layer: 'batch', eager: [], lazy: ['sqlite3'], privacy_hints: ['user_email'] },
  ],
  edges: [{ from: 'main', to: 'services.order_worker' }],
  matches: [
    { module: 'main', library: 'redis', item: 'valkey', eager: true },
    { module: 'services.order_worker', library: 'sqlite3', item: 'sqlite', eager: false },
    { module: 'main', library: 'unknownlib', item: 'no_such_item', eager: true },
  ],
};

describe('관문: 코드 분석을 불러오면 카탈로그 항목이 매칭됨', () => {
  const p = mergeCodeAnalysis(Project.parse({ name: 'p', nodes: [] }), analysis).project;

  it('순환 import(models ↔ service)는 그 연결선만 건너뛰고 세어 알림, 계산은 됨', () => {
    const r = mergeCodeAnalysis(Project.parse({ name: 'p', nodes: [] }), { ...analysis, edges: [...analysis.edges, { from: 'services.order_worker', to: 'main' }] });
    expect(r.skipped).toBe(1);
    expect(r.project.edges.some((e) => e.from === 'py:services.order_worker' && e.to === 'py:main')).toBe(false);
    expect(run(r.project, '2026-10-23').analysis).toBeDefined();
  });

  it('모듈은 노드, import는 연결선, 라이브러리는 카탈로그 항목 노드', () => {
    expect(p.nodes.map((n) => [n.id, n.layer, n.primary])).toEqual([
      ['py:main', 'backend', undefined],
      ['py:services.order_worker', 'batch', undefined],
      ['lib:valkey', 'cache', 'valkey'],
      ['lib:sqlite', 'db', 'sqlite'],
    ]);
    expect(p.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['py:main>py:services.order_worker', 'py:main>lib:valkey', 'py:services.order_worker>lib:sqlite']);
  });

  it('개인정보 후보와 상시/지연 로드는 설명에 남기고 사람이 확정', () => {
    const w = p.nodes.find((n) => n.id === 'py:services.order_worker')!;
    expect(w.description).toContain('개인정보 후보(확인 필요): user_email');
    expect(w.description).toContain('지연 로드: sqlite3');
    expect(w.privacy).toBeUndefined();
  });

  it('불러온 결과가 바로 판정됨 (SQLite에 쓰는 노드는 1개라 됨)', () => {
    const j = run(p, '2026-10-23').analysis!.judgements.find((x) => x.nodeId === 'lib:sqlite')!;
    expect(j.items[0].verdict).not.toBe('fail');
  });

  it('형식이 틀린 JSON은 거부', () => {
    expect(() => mergeCodeAnalysis(Project.parse({ name: 'p', nodes: [] }), { modules: 'x' })).toThrow('코드 분석 JSON');
  });
});

it('감사 14: 모듈 2000개·연결선 8000개도 금방 불러옴 (순환 검사가 연결선 전체를 매번 훑지 않음)', () => {
  const n = 2000;
  const modules = Array.from({ length: n }, (_, i) => ({ id: `m${i}`, file: `m${i}.py`, layer: 'backend', eager: [], lazy: [], privacy_hints: [] }));
  const edges = Array.from({ length: n * 4 }, (_, k) => ({ from: `m${k % n}`, to: `m${(k % n) + 1 + (k % 7)}` })).filter((e) => Number(e.to.slice(1)) < n);
  const t = performance.now();
  const r = mergeCodeAnalysis(Project.parse({ name: 'p', nodes: [] }), { ...analysis, modules, edges, matches: [] });
  expect(performance.now() - t).toBeLessThan(3000);
  expect(r.project.nodes.length).toBeGreaterThanOrEqual(n);
});
