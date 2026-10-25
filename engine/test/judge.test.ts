import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRules, judgeNode } from '../judge';
import { loadCatalog, loadProject } from '../io';
import { Project } from '../schema';

const catalog = loadCatalog(fileURLToPath(new URL('../../data/catalog', import.meta.url)));

/** 노드 하나짜리 프로젝트로 판정한다. normal/event는 설계서 4절 규모(평소/프로모션)를 넣는다. */
const judge = (node: Record<string, unknown>) => {
  const n = Project.parse({ name: 't', nodes: [{ id: 'n', name: 'n', ...node }] }).nodes[0];
  return judgeNode(n, catalog.byId).items[0];
};
const scale = (normal: object, event: object) => ({ vars: { normal, event } });

describe('관문: SQLite 판정 (설계서 5절)', () => {
  it('쓰는 노드 2개면 안 됨, 대안은 PostgreSQL만 통과', () => {
    const j = judge({ layer: 'db', primary: 'sqlite', ...scale(
      { peak_rps: 200, primary_rps: 200, peak_write_rps: 19, writer_nodes: 2, db_connections: 60 },
      { peak_rps: 600, primary_rps: 600, peak_write_rps: 58, writer_nodes: 2, db_connections: 60 },
    ) });
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('쓰는 노드가 2개');
    expect(j.alternatives.map((a) => [a.id, a.verdict])).toEqual([['postgresql', 'ok']]);
  });

  it('쓰는 노드 1개면 평소 19건/초는 통과, 프로모션 58건/초는 기준 50 초과로 조건부', () => {
    const j = judge({ layer: 'db', primary: 'sqlite', ...scale(
      { peak_rps: 200, primary_rps: 200, peak_write_rps: 19, writer_nodes: 1, db_connections: 10 },
      { peak_rps: 600, primary_rps: 600, peak_write_rps: 58, writer_nodes: 1, db_connections: 10 },
    ) });
    expect(j.verdict).toBe('conditional');
    expect(j.reasons[0]).toBe('이벤트 피크에서: 피크 쓰기 58건/초가 기준 50건/초를 넘습니다');
    // 조건부의 대안: WAL(기준 200)은 통과하므로 더 가벼운 절충안으로 제시된다
    expect(j.alternatives.map((a) => a.id)).toEqual(['postgresql', 'sqlite_wal']);
  });
});

describe('관문: 로드밸런서 판정', () => {
  it('처리 시간 편차가 크면 Round-Robin은 안 됨, Least-Connections 추천', () => {
    const j = judge({ layer: 'gateway', primary: 'round_robin', ...scale({ service_time_cv: 1.8 }, { service_time_cv: 1.8 }) });
    expect(j.verdict).toBe('fail');
    expect(j.alternatives).toEqual([{ id: 'least_connections', verdict: 'ok', note: undefined }]);
  });

  it('편차가 작으면 Round-Robin도 됨', () => {
    expect(judge({ layer: 'gateway', primary: 'round_robin', ...scale({ service_time_cv: 0.3 }, { service_time_cv: 0.3 }) }).verdict).toBe('ok');
  });
});

describe('사양 보정이 판정에 반영됨', () => {
  const vars = scale({ peak_rps: 300 }, { peak_rps: 900 });
  it('API 1대 기본(500 RPS)은 프로모션 900 RPS에서 조건부', () => {
    expect(judge({ layer: 'backend', primary: 'api_single', ...vars }).verdict).toBe('conditional');
  });
  it('8 vCPU면 2,000 RPS로 보정돼 통과', () => {
    expect(judge({ layer: 'backend', primary: 'api_single', spec: { vcpu: 8 }, ...vars }).verdict).toBe('ok');
  });
});

describe('값이 없으면 판단 불가', () => {
  it('Supabase 연결 한도가 아직 null이면 판단 불가', () => {
    const j = judge({ layer: 'db', primary: 'supabase', ...scale(
      { offline_required: false, db_connections: 60 },
      { offline_required: false, db_connections: 60 },
    ) });
    expect(j.verdict).toBe('unknown');
    expect(j.reasons[0]).toContain('th.connections');
  });

  it('오프라인이 필요하면 다른 값이 없어도 안 됨, 대안 SQLite', () => {
    const j = judge({ layer: 'db', primary: 'supabase', ...scale(
      { offline_required: true, peak_write_rps: 1, writer_nodes: 1, db_connections: 1 },
      { offline_required: true, peak_write_rps: 1, writer_nodes: 1, db_connections: 1 },
    ) });
    expect(j.verdict).toBe('fail');
    expect(j.alternatives[0].id).toBe('sqlite');
  });
});

describe('구조 규칙 (v2 규칙 이전)', () => {
  it('예시 프로젝트: 화면→DB 직결만 걸리고, 게이트웨이가 있으니 프로젝트 규칙은 통과', () => {
    const p = loadProject(fileURLToPath(new URL('../../examples/phase1.json', import.meta.url)), catalog.items);
    expect(checkRules(p, catalog.rules).map((h) => [h.ruleId, h.target])).toEqual([['ui_to_db', '웹 화면 → 주문 DB']]);
  });

  it('DB가 게이트웨이를 부르면 역방향 호출, 게이트웨이가 없으면 프로젝트 규칙', () => {
    const p = Project.parse({
      name: 'p',
      nodes: [
        { id: 'w', name: '화면', layer: 'ui' },
        { id: 'b', name: 'API', layer: 'backend' },
        { id: 'd', name: 'DB', layer: 'db' },
        { id: 'g', name: 'LB', layer: 'gateway' },
      ],
      edges: [{ from: 'd', to: 'g' }],
    });
    expect(checkRules(p, catalog.rules).map((h) => h.ruleId)).toEqual(['reverse_call']);
    const noGw = { ...p, nodes: p.nodes.filter((n) => n.layer !== 'gateway'), edges: [] };
    expect(checkRules(noGw, catalog.rules).map((h) => h.ruleId)).toEqual(['no_gateway']);
  });
});
