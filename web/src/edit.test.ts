import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { parseSpec } from '../../engine/spec';
import { addAction, addEdge, addWrite, removeWrite, addNode, addTable, applyAlternative, importTables, removeAction, removeNode, removeTable, run, setActionRate, setVar, updateAction, updateNode, updateTable, worstVerdict } from './edit';
import { autoLayout } from './layout';

const today = '2026-10-23';
const ex = examples.find((e) => e.name === 'phase3.json')!;
const base = parseProject(ex.data, catalog.items, ex.name);
const verdictOf = (p: typeof base, id: string) => worstVerdict(run(p, today).analysis!.judgements.find((j) => j.nodeId === id));

describe('관문: 노드 항목이나 사용자 수를 바꾸면 판정이 바로 바뀜', () => {
  it('예시 프로젝트가 화면 데이터로 그대로 분석됨', () => {
    const r = run(base, today);
    expect(r.error).toBeUndefined();
    expect(r.analysis!.judgements).toHaveLength(base.nodes.length);
  });

  it('DB를 SQLite로 바꾸면 안 됨, 대안 적용으로 PostgreSQL로 돌리면 다시 됨', () => {
    const sqlite = updateNode(base, 'db', { primary: 'sqlite' });
    expect(verdictOf(sqlite, 'db')).toBe('fail');
    expect(verdictOf(applyAlternative(sqlite, 'db', 'sqlite', 'postgresql'), 'db')).not.toBe('fail');
  });

  it('활성 사용자를 첫 병목의 한계보다 늘리면 그 노드가 이벤트 피크에서 걸려 조건부가 됨', () => {
    const before = run(base, today).analysis!;
    const { nodeId, limitUsers } = before.bottleneck!;
    expect(verdictOf(base, nodeId)).toBe('ok');
    const bigger = { ...base, scale: { ...base.scale!, users: limitUsers.value * 1.5 } };
    expect(verdictOf(bigger, nodeId)).toBe('conditional');
  });

  it('입력이 틀리면 계산하지 않고 오류를 돌려줌', () => {
    const bad = { ...base, personas: [{ ...base.personas[0], share: 0.3 }] };
    expect(run(bad, today).error).toContain('페르소나 비율의 합');
  });
});

describe('편집 동작', () => {
  it('노드 추가는 겹치지 않는 id와 기본값을 채움', () => {
    const { project, id } = addNode(base, 'cache');
    expect(id).toBe('cache-1');
    expect(project.nodes.at(-1)).toMatchObject({ id: 'cache-1', layer: 'cache', replicas: 1, extras: [] });
  });

  it('같은 연결선·자기 자신 연결은 추가하지 않고, 노드를 지우면 연결선도 지움', () => {
    const e = base.edges[0];
    expect(addEdge(base, e.from, e.to)).toBe(base);
    expect(addEdge(base, 'api', 'api')).toBe(base);
    const removed = removeNode(base, 'api');
    expect(removed.edges.some((x) => x.from === 'api' || x.to === 'api')).toBe(false);
  });

  it('직접 넣는 값은 평소·이벤트에 같이 들어가고 비우면 지워짐', () => {
    const p = setVar(base, 'api', 'service_time_cv', 2);
    expect(p.nodes.find((n) => n.id === 'api')!.vars).toMatchObject({ normal: { service_time_cv: 2 }, event: { service_time_cv: 2 } });
    expect(setVar(p, 'api', 'service_time_cv', undefined).nodes.find((n) => n.id === 'api')!.vars.normal).not.toHaveProperty('service_time_cv');
  });

  it('자동 배치: 연결 순서대로 열이 나뉘고 같은 열은 겹치지 않음', () => {
    const pos = autoLayout(base);
    expect(pos.web.x).toBe(0);
    expect(pos.lb.x).toBeGreaterThan(pos.web.x);
    expect(pos.api.x).toBeGreaterThan(pos.lb.x);
    const xy = Object.values(pos).map((v) => `${v.x},${v.y}`);
    expect(new Set(xy).size).toBe(xy.length);
  });
});

describe('테이블·행동 편집', () => {
  const ax = examples.find((e) => e.name === 'actions.json')!;
  const p0 = parseProject(ax.data, catalog.items, ax.name);
  const valid = (p: typeof p0) => expect(run(p, today).error).toBeUndefined();

  it('명세서로 가져온 테이블: 같은 이름은 바꾸고 새 이름은 뒤에 붙임', () => {
    const spec = parseSpec('테이블\t컬럼\t타입\norders\tid\tbigint\nshipments\tid\tbigint');
    const { project, replaced } = importTables(p0, 'db', spec.tables);
    expect(replaced).toEqual(['orders']);
    expect(project.nodes.find((n) => n.id === 'db')!.tables.map((t) => [t.name, t.columns.length])).toEqual([['orders', 1], ['order_items', 5], ['reviews', 4], ['shipments', 1]]);
    valid(project);
  });

  it('테이블 이름을 바꾸면 행동이 따라가고, 지우면 그 쓰기와 빈 행동·페르소나 빈도가 사라짐', () => {
    const renamed = updateTable(p0, 'db', 'reviews', { name: 'review' });
    expect(renamed.actions.find((a) => a.name === '리뷰')!.writes[0].table).toBe('review');
    valid(renamed);
    const removed = removeTable(renamed, 'db', 'review');
    expect(removed.actions.map((a) => a.name)).toEqual(['주문']);
    expect(removed.personas.every((ps) => !('리뷰' in ps.action_rates))).toBe(true);
    valid(removed);
  });

  it('행동 이름을 바꾸면 페르소나별 빈도도 따라가고, 빈 칸은 기본값으로 돌아감', () => {
    const renamed = updateAction(p0, '주문', { name: '구매' });
    expect(renamed.personas[0].action_rates).toEqual({ 구매: 0.6, 리뷰: 0.1 });
    valid(renamed);
    expect(setActionRate(renamed, 0, '구매', undefined).personas[0].action_rates).toEqual({ 리뷰: 0.1 });
  });

  it('새 테이블·새 행동은 바로 분석 가능한 기본값으로 생김', () => {
    const p1 = addAction(addTable(p0, 'db'));
    expect(p1.nodes.find((n) => n.id === 'db')!.tables.at(-1)!.name).toBe('table_1');
    expect(p1.actions.at(-1)).toMatchObject({ name: '행동 1', per_session: 0.1 });
    valid(p1);
    valid(removeAction(p1, '행동 1'));
  });
});

describe('노드 삭제·주 항목 변경이 다른 입력을 깨뜨리지 않음', () => {
  const ax = examples.find((e) => e.name === 'actions.json')!;
  const p0 = parseProject(ax.data, catalog.items, ax.name);

  it('테이블이 있는 노드를 지우면 그 노드에 쓰는 행동과 빈도도 지워져 분석이 계속됨', () => {
    const p = removeNode(p0, 'db');
    expect(p.actions).toEqual([]);
    expect(p.personas.every((ps) => Object.keys(ps.action_rates).length === 0)).toBe(true);
    expect(run(p, today).error).toBeUndefined();
  });

  it('주 항목을 바꾸면 이전 시스템의 저장 기능 선택이 지워짐 (같은 항목이면 유지)', () => {
    const picked = updateNode(p0, 'db', { storage_features: ['toast_pglz', 'fill_90'] });
    expect(updateNode(picked, 'db', { primary: 'postgresql' }).nodes.find((n) => n.id === 'db')!.storage_features).toEqual(['toast_pglz', 'fill_90']);
    const moved = updateNode(picked, 'db', { primary: 'mysql' });
    expect(moved.nodes.find((n) => n.id === 'db')!.storage_features).toBeUndefined();
    expect(run(moved, today).error).toBeUndefined();
  });
});

describe('안쪽 다이어그램에서 선 긋기·지우기', () => {
  const ax = examples.find((e) => e.name === 'actions.json')!;
  const p0 = parseProject(ax.data, catalog.items, ax.name);

  it('행동 → 테이블 선을 그으면 쓰기 1행이 생기고, 같은 선은 두 번 생기지 않음', () => {
    const p = addWrite(addWrite(p0, '리뷰', 'db', 'orders'), '리뷰', 'db', 'orders');
    expect(p.actions.find((a) => a.name === '리뷰')!.writes).toEqual([{ node: 'db', table: 'reviews', rows: 1 }, { node: 'db', table: 'orders', rows: 1 }]);
    expect(run(p, today).error).toBeUndefined();
  });

  it('선을 지우면 쓰기가 빠지고, 마지막 쓰기를 지우면 행동과 페르소나 빈도도 지워짐', () => {
    const p = removeWrite(p0, '리뷰', 'db', 'reviews');
    expect(p.actions.map((a) => a.name)).toEqual(['주문']);
    expect(p.personas.every((ps) => !('리뷰' in ps.action_rates))).toBe(true);
    expect(removeWrite(p0, '주문', 'db', 'orders').actions.find((a) => a.name === '주문')!.writes.map((w) => w.table)).toEqual(['order_items']);
    expect(run(p, today).error).toBeUndefined();
  });
});
