import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { parseSpec } from '../../engine/spec';
import { Table as TableSchema } from '../../engine/schema';
import { applyIndustry, setPersonaMix, addAction, addEdge, addWrite, removeWrite, addNode, addTable, applyAlternative, importTables, removeAction, removeColumn, removeNode, removePersona, removeTable, renameColumn, run, setActionRate, setVar, updateAction, updateNode, updatePersona, updateTable, worstVerdict } from './edit';
import { autoLayout } from './layout';

const today = '2026-10-23';
const ex = examples.find((e) => e.name === 'phase3.json')!;
const base = parseProject(ex.data, catalog.items, ex.name);
const verdictOf = (p: typeof base, id: string) => worstVerdict(run(p, today).analysis!.judgements.find((j) => j.nodeId === id));

describe('판정 순위: 됨 < 조건부 < 판단 불가 < 안 됨 (배지·대안·미해결 목록이 같은 순서)', () => {
  const item = (verdict: 'ok' | 'conditional' | 'unknown' | 'fail') => ({ itemId: verdict, verdict, reasons: [], alternatives: [] });
  it('조건부와 판단 불가가 같이 있으면 노드 배지는 판단 불가', () => {
    expect(worstVerdict({ nodeId: 'n', items: [item('conditional'), item('unknown'), item('ok')] })).toBe('unknown');
    expect(worstVerdict({ nodeId: 'n', items: [item('unknown'), item('fail')] })).toBe('fail');
  });
});

describe('업종 미리 설정', () => {
  it('하루 피크와 페르소나 비율을 한 번에 바꾸고, 결과는 그대로 분석됨', () => {
    const p = applyIndustry(base, 'live_game');
    expect(p.scale!.industry).toBe('live_game');
    expect(p.scale!.day).toBeUndefined();
    expect(p.persona_mix).toBeDefined();
    expect(Math.abs(p.personas.reduce((s, x) => s + x.share, 0) - 1)).toBeLessThan(1e-9);
    expect(p.personas.map((x) => x.share)).not.toEqual(base.personas.map((x) => x.share));
    expect(parseProject(p, catalog.items).scale!.industry).toBe('live_game');
    expect(run(p, today).error).toBeUndefined();
    // 업종을 지우면 하루 모양도 지운다 (비율은 그대로)
    const off = applyIndustry({ ...p, scale: { ...p.scale!, day: { window: [9, 18], peaks: [{ at: 12, sd: 1, weight: 1 }] } } }, undefined);
    expect([off.scale!.industry, off.scale!.day]).toEqual([undefined, undefined]);
  });

  it('비율을 손으로 바꾸면 분포 모양을 지움 (모양과 비율이 어긋나지 않게)', () => {
    const p = setPersonaMix(base, [{ mu: 0.3, sg: 0.2, w: 1 }]);
    expect(updatePersona(p, 0, { name: '새 이름' }).persona_mix).toBeDefined();
    expect(updatePersona(p, 0, { share: 0.5 }).persona_mix).toBeUndefined();
  });
});

describe('관문: 노드 항목이나 사용자 수를 바꾸면 판정이 바로 바뀜', () => {
  it('트래픽은 사용자·페르소나 쪽이 바뀔 때만 다시 계산 (이름만 바꾸면 그대로 재사용)', () => {
    const t0 = run(base, today).analysis!.traffic;
    expect(run({ ...base, name: '다른 이름' }, today).analysis!.traffic).toBe(t0);
    const more = run({ ...base, scale: { ...base.scale!, users: base.scale!.users * 2 } }, today).analysis!.traffic!;
    expect(more).not.toBe(t0);
    expect(more.peakRps.value).toBeGreaterThan(t0!.peakRps.value);
  });

  it('페르소나 이름만 바꾸면 다시 돌리지 않고 이름만 바뀐 같은 결과 (처음부터 돌린 것과 같음)', () => {
    run(base, today);
    const renamed = { ...base, personas: base.personas.map((ps, i) => (i === 1 ? { ...ps, name: '새 이름' } : ps)) };
    const fast = run(renamed, today).analysis!.traffic!;
    expect(fast.personas.map((x) => x.name)).toContain('새 이름');
    run({ ...renamed, scale: { ...renamed.scale! } }, today); // 기준값이 달라 처음부터 계산
    const full = run(renamed, today).analysis!.traffic!;
    expect(fast).toEqual(full);
  });

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

  it('활성 사용자를 첫 병목의 한계보다 늘리면 그 노드가 이벤트 피크에서 넘쳐 안 됨이 됨 (사용률 100% 초과)', () => {
    const before = run(base, today).analysis!;
    const { nodeId, limitUsers } = before.bottleneck!;
    expect(verdictOf(base, nodeId)).toBe('ok');
    const bigger = { ...base, scale: { ...base.scale!, users: limitUsers.value * 1.5 } };
    expect(verdictOf(bigger, nodeId)).toBe('fail');
    const j = run(bigger, today).analysis!.judgements.find((x) => x.nodeId === nodeId)!;
    expect(j.items.find((i) => i.itemId === bigger.nodes.find((n) => n.id === nodeId)!.primary)!.reasons[0]).toContain('이벤트 피크에서 사용률');
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

  it('테이블 이름을 바꾸거나 지우면 인터페이스의 테이블 연결도 따라감', () => {
    const e0 = p0.edges[0];
    const linked = { ...p0, edges: p0.edges.map((e, k) => (k ? e : { ...e, interfaces: [{ name: '리뷰 조회', kind: 'rest' as const, method: 'GET' as const, path: '/reviews', per_request: 1, on: 'all' as const, request: [], response: [], errors: [],
      tables: [{ node: 'db', table: 'reviews', op: 'read' as const }, { node: 'db', table: 'orders', op: 'read' as const }] }] })) };
    const renamed = updateTable(linked, 'db', 'reviews', { name: 'review' });
    expect(renamed.edges[0].interfaces[0].tables!.map((t) => t.table)).toEqual(['review', 'orders']);
    valid(renamed);
    const removed = removeTable(removeTable(renamed, 'db', 'review'), 'db', 'orders');
    expect(removed.edges[0].interfaces[0].tables).toBeUndefined();
    expect(e0.from).toBe(removed.edges[0].from);
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

describe('페르소나와 유입 모형', () => {
  const base = parseProject(examples.find((e) => e.name === 'phase3.json')!.data, catalog.items, 'x');
  const entry = base.personas[4].name;
  const withInflow = { ...base, growth: { ...base.growth!, inflow: { market: 1e7, external: 0.01, word_of_mouth: 0.3, entry, up: 0.05, down: 0.03, leave: 0.1 } } };
  it('들어오는 페르소나 이름을 바꾸면 유입 모형도 따라가 결과가 계속 나옴', () => {
    const p = updatePersona(withInflow, 4, { name: '새 이름' });
    expect(p.growth!.inflow!.entry).toBe('새 이름');
    expect(run(p, '2026-10-24').error).toBeUndefined();
  });
  it('들어오는 페르소나를 지우면 남은 첫 페르소나로', () => {
    const p = removePersona(withInflow, 4);
    expect(p.growth!.inflow!.entry).toBe(base.personas[0].name);
    expect(p.personas.some((x) => x.name === entry)).toBe(false);
  });
  it('단계 이동률 합이 1을 넘으면 검사에서 걸림', () => {
    const bad = { ...withInflow, growth: { ...withInflow.growth, inflow: { ...withInflow.growth.inflow, up: 0.7, down: 0.5 } } };
    expect(run(bad, '2026-10-24').error).toMatch(/1을 넘음/);
  });
});

describe('코드 값 입력', () => {
  it('"C=카드; M=현금" ↔ 코드 목록, 쉼표 든 라벨은 그대로, 빈 칸은 없음', async () => {
    const { codesText, parseCodes } = await import('./TablesPanel');
    expect(parseCodes('C=카드; M=현금 ; X')).toEqual([{ code: 'C', label: '카드' }, { code: 'M', label: '현금' }, { code: 'X', label: '' }]);
    expect(parseCodes('C=카드,체크; M=현금')).toEqual([{ code: 'C', label: '카드,체크' }, { code: 'M', label: '현금' }]);
    expect(codesText(parseCodes('C=카드; X'))).toBe('C=카드; X');
    expect(parseCodes(' ; ')).toBeUndefined();
  });
});

describe('컬럼 이름 바꾸기·삭제가 기본 키·인덱스·파티션을 따라감', () => {
  const t = TableSchema.parse({
    name: 'logs', columns: [{ name: 'id', type: 'bigint' }, { name: 'at', type: 'timestamp' }, { name: 'who', type: 'text' }],
    primary_key: ['id', 'at'], indexes: [{ name: 'ix_at', columns: ['at'] }, { name: 'ix_who_at', columns: ['who', 'at'] }], partition: { column: 'at', interval: 'day' },
  });

  it('이름을 바꾸면 같은 테이블의 기본 키·인덱스·파티션도 새 이름으로', () => {
    const r = renameColumn(t, 'at', 'created_at')!;
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'created_at', 'who']);
    expect(r.primary_key).toEqual(['id', 'created_at']);
    expect(r.indexes.map((i) => i.columns)).toEqual([['created_at'], ['who', 'created_at']]);
    expect(r.partition).toEqual({ column: 'created_at', interval: 'day' });
  });

  it('이미 있는 컬럼 이름으로는 바꾸지 않음', () => {
    expect(renameColumn(t, 'at', 'who')).toBeUndefined();
  });

  it('지우면 목록에서 빠지고, 빈 인덱스와 그 컬럼의 파티션은 지움', () => {
    const r = removeColumn(t, 1);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'who']);
    expect(r.primary_key).toEqual(['id']);
    expect(r.indexes).toEqual([{ name: 'ix_who_at', columns: ['who'], unique: false }]);
    expect(r.partition).toBeUndefined();
    expect(removeColumn(t, 2).partition).toEqual(t.partition);
  });
});

describe('명세서 다시 붙여 넣기', () => {
  const ax = examples.find((e) => e.name === 'actions.json')!;
  const p0 = parseProject(ax.data, catalog.items, ax.name);
  it('같은 이름 테이블을 바꿀 때 명세서에 없는 데이터 사전 메타는 옛 값을 유지', () => {
    const t0 = p0.nodes.find((n) => n.id === 'db')!.tables.find((t) => t.name === 'orders')!;
    const id = t0.columns[0].name;
    const meta = updateTable(p0, 'db', 'orders', {
      label: '주문', description: '주문 한 건', record: 'fixed',
      columns: t0.columns.map((c, i) => (i ? c : { ...c, label: '번호', domain: '코드', codes: [{ code: '1', label: '하나' }], personal: true, default_value: '1', description: '옛 설명' })),
    });
    const spec = parseSpec(`테이블\t컬럼\t타입\t설명\norders\t${id}\tbigint\t\norders\tmemo\ttext\t새 설명`);
    const t = importTables(meta, 'db', spec.tables).project.nodes.find((n) => n.id === 'db')!.tables.find((x) => x.name === 'orders')!;
    expect(t).toMatchObject({ label: '주문', description: '주문 한 건', record: 'fixed' });
    expect(t.columns[0]).toMatchObject({ name: id, label: '번호', domain: '코드', codes: [{ code: '1', label: '하나' }], personal: true, default_value: '1', description: '옛 설명' });
    expect(t.columns[1]).toMatchObject({ name: 'memo', description: '새 설명', personal: false });
    expect(t.columns[1].label).toBeUndefined();
  });
});
