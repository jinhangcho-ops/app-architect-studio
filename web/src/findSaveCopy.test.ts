import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { autosaveMinutes, DEFAULT_MINUTES, MAX_AUTO, MAX_MANUAL, readAutosaves, readManualSaves, setAutosaveMinutes, startNewSnapshot, writeAutosave, writeManualSave } from './autosave';
import { catalog, examples } from './data';
import { pasteNode, run } from './edit';
import { searchProject } from './search';

const load = (name: string) => { const ex = examples.find((e) => e.name === name)!; return parseProject(ex.data, catalog.items, ex.name); };
const p = load('global-commerce.json');

/** 브라우저 저장소 대신 쓰는 메모리 저장소 */
const memory = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } };
};

describe('찾기 (Ctrl+F)', () => {
  it('노드 이름·고른 항목·테이블·컬럼을 대소문자·띄어쓰기 없이 찾음', () => {
    expect(searchProject(p, catalog.byId, '정산 워커').map((h) => h.label)).toEqual(['멀티마켓 정산 워커 (N-05)']);
    expect(searchProject(p, catalog.byId, 'kafka').map((h) => [h.kind, h.label])).toEqual([['node', 'Kafka 이벤트 브로커 (N-04)']]);
    expect(searchProject(p, catalog.byId, 'POSTGRESQL')[0]).toMatchObject({ kind: 'node', node: 'N-06', detail: '데이터베이스 · 항목 PostgreSQL' });
    expect(searchProject(p, catalog.byId, 'ledger')).toEqual([expect.objectContaining({ kind: 'table', node: 'N-06', table: 'ledger_entries' })]);
    expect(searchProject(p, catalog.byId, 'tenant_id').map((h) => h.label)).toEqual(['정산·원장 DB (N-06).orders', '데이터 레이크하우스 (N-10).events']);
    expect(searchProject(p, catalog.byId, '   ')).toEqual([]);
  });
});

describe('저장 기록 (자동 10개·간격 지정, 직접 20개)', () => {
  const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 0, min));

  it('자동 저장: 간격(기본 10분) 안에서는 최신 시점을 덮어쓰고, 간격이 지나면 새 시점, 최대 10개', () => {
    const st = memory();
    writeAutosave(p, {}, st, at(0));
    writeAutosave({ ...p, edges: [] }, {}, st, at(9));
    expect(readAutosaves(st)).toHaveLength(1);
    expect(readAutosaves(st)[0].project.edges).toEqual([]);
    for (let i = 1; i <= 12; i++) writeAutosave(p, {}, st, at(i * 10));
    const list = readAutosaves(st);
    expect(list).toHaveLength(MAX_AUTO);
    expect(list[0].savedAt).toBe(at(120).toISOString());
  });

  it('간격은 사용자가 바꿀 수 있음 (1분이면 매 분 새 시점), 잘못된 값은 기본 10분', () => {
    const st = memory();
    expect(autosaveMinutes(st)).toBe(DEFAULT_MINUTES);
    setAutosaveMinutes(1, st);
    writeAutosave(p, {}, st, at(0));
    writeAutosave(p, {}, st, at(1));
    expect(readAutosaves(st)).toHaveLength(2);
    st.setItem('app-architect-studio.save-settings.v1', '{"minutes":0}');
    expect(autosaveMinutes(st)).toBe(DEFAULT_MINUTES);
  });

  it('다른 프로젝트를 열거나 예전 시점을 복구한 뒤에는 최신 시점을 덮어쓰지 않음', () => {
    const st = memory();
    writeAutosave(p, {}, st, at(0));
    writeAutosave({ ...p, name: '다른 프로젝트' }, {}, st, at(1));
    expect(readAutosaves(st).map((x) => x.project.name)).toEqual(['다른 프로젝트', p.name]);
    startNewSnapshot();
    writeAutosave({ ...p, name: '다른 프로젝트' }, {}, st, at(2));
    expect(readAutosaves(st)).toHaveLength(3);
  });

  it('직접 저장(Ctrl+S): 누를 때마다 새 시점, 최대 20개, 위치도 함께', () => {
    const st = memory();
    for (let i = 0; i < 25; i++) writeManualSave(p, { 'N-03': { x: i, y: 0 } }, st, at(i));
    const list = readManualSaves(st);
    expect(list).toHaveLength(MAX_MANUAL);
    expect(list[0].positions).toEqual({ 'N-03': { x: 24, y: 0 } });
    expect(readAutosaves(st)).toEqual([]);
  });

  it('처음 형식(한 칸짜리) 기록도 읽고, 깨진 기록·막힌 저장소에서도 앱은 계속됨', () => {
    const st = memory();
    st.setItem('app-architect-studio.autosave.v1', JSON.stringify({ savedAt: at(0).toISOString(), project: p }));
    expect(readAutosaves(st).map((x) => x.project.name)).toEqual([p.name]);
    st.setItem('app-architect-studio.autosave.v1', '{깨진');
    expect(readAutosaves(st)).toEqual([]);
    const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } } as Storage;
    expect(writeAutosave(p, {}, full)).toBe(false);
    expect(writeManualSave(p, {}, full)).toBe(false);
    expect(readAutosaves(undefined)).toEqual([]);
  });
});

describe('복사·붙여넣기 (Ctrl+C / Ctrl+V)', () => {
  it('새 id와 "(복사)" 이름으로 들어가고, 두 번 붙이면 id가 겹치지 않음, 테이블도 함께', () => {
    const db = p.nodes.find((n) => n.id === 'N-06')!;
    const once = pasteNode(p, db);
    const twice = pasteNode(once.project, db);
    expect([once.id, twice.id]).toEqual(['N-06-2', 'N-06-3']);
    const copy = twice.project.nodes.find((n) => n.id === 'N-06-2')!;
    expect(copy.name).toBe('정산·원장 DB (N-06) (복사)');
    expect(copy.tables.map((t) => t.name)).toEqual(['orders', 'ledger_entries']);
    expect(run(twice.project, '2026-10-24').error).toBeUndefined();
  });
});
