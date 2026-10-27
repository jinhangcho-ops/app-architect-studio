import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, migrate, readProject } from '../data';
import { nodeLoads } from '../load';
import { CatalogItem, Project, Table, checkCatalog, checkProject, checkTable, fitsType } from '../schema';

const item = {
  id: 'x', name: 'X', area: '서비스', role: '주', kind: '도구', attaches_to: ['db'], goals: {}, sources: ['s'],
};

describe('카탈로그·프로젝트 검증', () => {
  it('해석할 수 없는 조건식은 읽을 때 거부', () => {
    expect(CatalogItem.safeParse({ ...item, fails_when: [{ if: 'a >', why: 'w' }] }).success).toBe(false);
  });

  it('사양 보정을 하려면 base_spec에 해당 자원이 있어야 함', () => {
    const th = { value: 1, unit: 'u', bound_by: 'vcpu', base_spec: { memGb: 4 }, source: 's' };
    expect(CatalogItem.safeParse({ ...item, thresholds: { t: th } }).success).toBe(false);
  });

  it('없는 대안·없는 항목·맞지 않는 레이어를 찾아냄', () => {
    const it1 = CatalogItem.parse({ ...item, alternatives: [{ id: 'nope', better_for: [] }] });
    expect(checkCatalog([it1])).toEqual(['x: 없는 대안 nope']);
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'ui', primary: 'x', extras: ['y'] }] });
    expect(checkProject(p, [it1])).toEqual(['a: x는 ui 노드에 붙일 수 없음', 'a: 없는 카탈로그 항목 y']);
  });
});

describe('테이블·연결 검증 (감사 2)', () => {
  const tbl = (name: string, extra: object = {}) => ({ name, columns: [{ name: 'k', type: 'int' }], ...extra });
  const proj = (extra: object) => Project.parse({ name: 'p', nodes: [
    { id: 'a', name: 'A', layer: 'backend' }, { id: 'db', name: 'DB', layer: 'db', tables: [tbl('s'), tbl('t', { indexes: [{ name: 's', columns: ['k'] }] })] },
  ], ...extra });

  it('기본값·코드 값이 타입과 안 맞거나 NOT NULL인데 null이어도 막는 오류는 아님 (경고는 schemaWarnings)', () => {
    const t = Table.parse({ name: 't', columns: [
      { name: 'n', type: 'int', default_value: 'abc', codes: [{ code: 'A' }] }, { name: 'f', type: 'bool', default_value: 'Y' }, { name: 'x', type: 'text', default_value: 'null' },
    ] });
    expect(checkTable(t)).toEqual([]);
  });

  it('fitsType: .5, 1e-3, +1, 시간대 +09·+0900·Z도 맞음', () => {
    expect(['.5', '1e-3', '+1', '-2.', '1.5E+2'].every((v) => fitsType('numeric', v))).toBe(true);
    expect(['e3', '.', '1e', '1.2.3'].some((v) => fitsType('float', v))).toBe(false);
    expect(fitsType('int', '+1')).toBe(true);
    expect(['2024-01-01T09:00+09', '2024-01-01 09:00:00+0900', '2024-01-01T00:00:00.5Z', '2024-01-01T09:00:00-05:30'].every((v) => fitsType('timestamp', v))).toBe(true);
  });

  it('fitsType: 날짜 바로 뒤 시간대, 없는 달·날은 안 맞음 (SQLite julianday가 NULL을 돌려줌)', () => {
    expect(['2024-01-01Z', '2024-01-01+09', '2024-01-01-05', '2024-13-01', '2024-02-30T00:00'].some((v) => fitsType('timestamp', v))).toBe(false);
    expect(['2024-13-01', '2024-02-30', '2023-02-29'].some((v) => fitsType('date', v))).toBe(false);
    expect(['2024-02-29', '2024-12-31'].every((v) => fitsType('date', v))).toBe(true);
  });

  it('fitsType: 시 00–23, 분·초 00–59 밖은 안 맞음 (감사 4 H6)', () => {
    expect(['2024-01-01T24:00', '2024-01-01 23:60', '2024-01-01T23:59:60', '2024-01-01T99:00:00Z'].some((v) => fitsType('timestamp', v))).toBe(false);
    expect(['2024-01-01T00:00', '2024-01-01 23:59:59.999', '2024-01-01T19:30:00+09:00'].every((v) => fitsType('timestamp', v))).toBe(true);
  });

  it('노드 id 중복은 맨 먼저 오류 (감사 4 H7)', () => {
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'backend' }, { id: 'a', name: 'B', layer: 'backend' }], edges: [{ from: 'a', to: 'a' }] });
    expect(checkProject(p, [])[0]).toBe('노드 id 중복 a');
  });

  it('화면 노드 진입 몫 합이 1을 넘으면 오류, 비운 몫은 1 / 화면 수 (감사 4 K9)', () => {
    const ui = (id: string, entry_share?: number) => ({ id, name: id, layer: 'ui', ...(entry_share !== undefined && { entry_share }) });
    const err = (nodes: object[]) => checkProject(Project.parse({ name: 'p', nodes }), []);
    expect(err([ui('a', 0.7), ui('b', 0.7)])).toEqual(['화면 노드 진입 몫(entry_share) 합이 1을 넘음 (1.4)']);
    // 비운 칸은 남은 몫을 나눠 가지므로 오류가 아님 (리뷰 4 L4)
    expect(err([ui('a', 0.9), ui('b')])).toEqual([]);
    expect(err([ui('a', 1), ui('b')])).toEqual([]);
    expect(err([ui('a', 0.3), ui('b', 0.7)])).toEqual([]);
    expect(err([ui('a'), ui('b'), ui('c')])).toEqual([]);
  });

  it('비운 화면의 몫 = (1 − 정한 몫 합) / 비운 화면 수 (리뷰 4 L4)', () => {
    const t = { peakRps: { value: 100 }, peakRpsEvent: { value: 200 }, peakWriteRps: { value: 10 }, peakWriteRpsEvent: { value: 20 } } as never;
    const ui = (id: string, entry_share?: number) => ({ id, name: id, layer: 'ui', ...(entry_share !== undefined && { entry_share }) });
    const rps = (nodes: object[]) => [...nodeLoads(Project.parse({ name: 'p', nodes }), t).values()].map((l) => +l.rps.normal.toFixed(9));
    expect(rps([ui('a', 0.3), ui('b')])).toEqual([30, 70]);
    expect(rps([ui('a', 0.4), ui('b'), ui('c')])).toEqual([40, 30, 30]);
    expect(rps([ui('a', 1), ui('b')])).toEqual([100, 0]);
    expect(rps([ui('a'), ui('b')])).toEqual([50, 50]);
  });

  it('노드 안 테이블·인덱스 이름 겹침은 오류 아님(경고), 테이블 이름 중복은 오류', () => {
    const p = Project.parse({ name: 'p', nodes: [{ id: 'db', name: 'DB', layer: 'db', tables: [
      tbl('a', { indexes: [{ name: 'ix', columns: ['k'] }] }), tbl('b', { indexes: [{ name: 'ix', columns: ['k'] }, { name: 'a', columns: ['k'] }] }),
    ] }] });
    expect(checkProject(p, [])).toEqual([]);
    expect(checkProject({ ...p, nodes: [{ ...p.nodes[0], tables: [...p.nodes[0].tables, p.nodes[0].tables[0]] }] }, [])).toEqual(['db: 테이블 이름 중복 a']);
  });

  it('파일·전문의 인증·에러, 영문·숫자·_ 구분자는 막는 오류 아님', () => {
    const file = { name: 'f', kind: 'file', path: 'F1', request: [{ name: 'a', type: 'string' }] };
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'backend' }, { id: 'b', name: 'B', layer: 'backend' }], edges: [{ from: 'a', to: 'b', interfaces: [
      { ...file, auth: 'bearer', errors: [{ status: 500, description: 'x' }] },
      { ...file, name: 'g', record: { format: 'delimited', delimiter: 'a' } },
    ] }] });
    expect(checkProject(p, [])).toEqual([]);
  });

  it('인터페이스의 같은 테이블 연결, 행동의 같은 테이블 쓰기 두 번은 오류 아님', () => {
    const p = proj({
      actions: [{ name: '쓰기', per_session: 1, writes: [{ node: 'db', table: 's' }, { node: 'db', table: 's' }] }],
      edges: [{ from: 'a', to: 'db', interfaces: [{ name: '조회', kind: 'rest', method: 'GET', path: '/s',
        tables: [{ node: 'db', table: 's', op: 'read' }, { node: 'db', table: 's', op: 'read' }, { node: 'db', table: 's', op: 'write' }] }] }],
    });
    expect(checkProject(p, [])).toEqual([]);
  });

  it('형식 버전 3: 버전 1·2 파일(또는 버전 없음)은 그대로 열림', () => {
    expect(FORMAT_VERSION).toBe(3);
    expect(migrate({ name: 'p', format_version: 1 })).toEqual({ name: 'p' });
    expect(migrate({ name: 'p', format_version: 2 })).toEqual({ name: 'p' });
    expect(migrate({ name: 'p' })).toEqual({ name: 'p' });
  });
});

describe('앱 열기: 선택 숫자 칸의 범위 오류는 그 칸을 빼고 엶 (감사 5 M1)', () => {
  const raw = (scale: object, persona: object = {}) => ({
    name: 'p', nodes: [], scale: { users: 100, ...scale }, personas: [{ name: 'a', share: 1, pattern: 'regular', ...persona }],
  });

  it('비율 80·배수 0.5·정수 아님은 빼고(기본값이 있으면 기본값) 열고, 뺀 칸을 notes에 적음', () => {
    const notes: string[] = [];
    const p = readProject(raw({ window_share: 80, event_multiplier: 0.5 }, { window_share: 1.5 }), [], '파일', notes);
    expect(p.scale!.window_share).toBe(0.8);
    expect(p.scale!.event_multiplier).toBe(1);
    expect(p.personas[0].window_share).toBeUndefined();
    expect(notes).toHaveLength(3);
    expect(notes.join('\n')).toMatch(/scale\.window_share.*80/);
  });

  it('화면에서 비운 인터페이스·행동 이름(필수)은 "이름 없음"으로 채워 엶', () => {
    const notes: string[] = [];
    const p = readProject({
      ...raw({}), nodes: [{ id: 'a', name: 'A', layer: 'backend' }, { id: 'b', name: 'B', layer: 'backend' }],
      edges: [{ from: 'a', to: 'b', interfaces: [{ name: '', kind: 'rest', method: 'GET', path: '/x' }] }],
      actions: [{ name: '', per_session: 1, writes: [{ node: 'b', table: 't' }] }],
    }, [], '파일', notes);
    expect([p.edges[0].interfaces[0].name, p.actions[0].name]).toEqual(['이름 없음', '이름 없음']);
    expect(notes).toHaveLength(2);
  });

  it('다른 종류 오류가 섞이면 지금처럼 던짐 (필수 숫자 칸은 리뷰 5 N3부터 경계값으로 맞춰 엶)', () => {
    expect(readProject(raw({ users: -5 }), [], '파일', []).scale!.users).toBe(1);
    expect(() => readProject({ ...raw({ window_share: 80 }), name: 1 }, [], '파일', [])).toThrow(/검증 실패/);
    expect(() => readProject(raw({ window_share: 80 }), [])).not.toThrow();
  });
});
