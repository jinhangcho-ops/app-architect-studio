import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { clearAutosave, readAutosave, writeAutosave } from './autosave';
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

describe('임시 저장', () => {
  it('저장한 프로젝트와 노드 위치를 그대로 되살리고, 지우면 없음', () => {
    const st = memory();
    expect(writeAutosave(p, { 'N-03': { x: 10, y: 20 } }, st)).toBe(true);
    const back = readAutosave(st)!;
    expect(back.project).toEqual(p);
    expect(back.positions).toEqual({ 'N-03': { x: 10, y: 20 } });
    clearAutosave(st);
    expect(readAutosave(st)).toBeUndefined();
  });

  it('깨진 저장, 저장소가 막힌 경우에도 앱은 계속됨', () => {
    const st = memory();
    st.setItem('app-architect-studio.autosave.v1', '{깨진');
    expect(readAutosave(st)).toBeUndefined();
    const full = { ...memory(), setItem: () => { throw new Error('QuotaExceededError'); } } as Storage;
    expect(writeAutosave(p, {}, full)).toBe(false);
    expect(readAutosave(undefined)).toBeUndefined();
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
