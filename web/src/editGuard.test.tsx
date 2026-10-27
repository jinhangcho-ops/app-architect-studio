// @vitest-environment happy-dom
// 화면 편집이 저장 파일을 못 여는 상태를 만들지 않는지, 숫자 칸을 한 글자씩 칠 수 있는지
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import type { Project } from '../../engine/schema';
import { catalog, examples } from './data';
import { removeColumn, updateAction, updatePersona } from './edit';
import { NumField } from './fields';
import { InterfacesSection } from './InterfacesPanel';
import { NodePanel } from './NodePanel';
import { exportProject, importProject, useStore } from './store';
import { TableEditor } from './TablesPanel';

const s = () => useStore.getState();
const load = () => { const ex = examples.find((e) => e.name === 'global-commerce.json')!; return parseProject(ex.data, catalog.items, ex.name); };
const reopen = () => importProject(JSON.parse(JSON.stringify(exportProject(s().project, s().positions))), 'x.json');
beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

/** React가 알아차리게 값을 넣고 input 이벤트를 보낸다 (사람이 친 것처럼) */
const setValue = (inp: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inp, v);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
};
/** 칸을 비우고 글자를 하나씩 뒤에 붙여 친다 (칸이 되돌아가면 그 값 뒤에 붙는다) */
async function typeChars(inp: HTMLInputElement, text: string) {
  await act(async () => { inp.focus(); setValue(inp, ''); });
  for (const ch of text) await act(async () => setValue(inp, inp.value + ch));
  await act(async () => { inp.blur(); });
}
async function mount(ui: React.ReactNode) {
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(ui));
  return el;
}

/** 첫 연결선에 REST 인터페이스 하나 (에러 응답 400) */
const restIf = (p: Project): Project => ({ ...p, edges: p.edges.map((x, k) => (k ? x : { ...x, interfaces: [{ name: 'a', kind: 'rest', method: 'GET', path: '/a', per_request: 1, on: 'all', request: [{ name: 'ok', type: 'string', required: true }], response: [], errors: [{ status: 400, description: 'x' }] }] })) });

describe('편집 → 저장 → 다시 열기 (P1)', () => {
  const withIf = restIf;
  const setIf = (patch: object) => (p: Project): Project => ({ ...p, edges: p.edges.map((x, k) => (k ? x : { ...x, interfaces: [{ ...x.interfaces[0], ...patch }] })) });
  const start = (p: Project) => useStore.setState({ project: p, rejected: undefined, past: [], future: [] });

  it('페르소나 비율을 고치는 중(합 ≠ 1)도 막지 않고, 그 상태로 저장한 파일도 열림', () => {
    const p = load();
    expect(p.personas.length).toBeGreaterThan(1);
    start(p);
    s().edit((x) => updatePersona(x, 0, { share: 0.5 }));
    expect(s().project.personas[0].share).toBe(0.5);
    expect(s().rejected).toBeUndefined();
    expect(() => reopen()).not.toThrow();
    // 다른 페르소나를 맞추면 합이 1
    const rest = (1 - 0.5) / (p.personas.length - 1);
    for (let i = 1; i < p.personas.length; i++) s().edit((x) => updatePersona(x, i, { share: rest }));
    expect(() => reopen()).not.toThrow();
  });

  it('형식이 틀린 글자(필드 이름 한글, 에러 코드 공백)는 막고 이유를 알림', () => {
    const base = withIf(load());
    for (const [patch, why] of [
      [{ request: [{ name: '주문', type: 'string', required: true }] }, /영문·숫자·_/],
      [{ errors: [{ status: 400, code: 'A B', description: 'x' }] }, /에러 코드는 영문/],
    ] as const) {
      start(base);
      s().edit(setIf(patch));
      expect(s().project).toBe(base);
      expect(s().rejected).toMatch(why);
    }
  });

  it('글자 칸 비우기(경로·에러 설명)는 다시 치는 중이라 적용하고, 저장한 파일도 열림', () => {
    const base = withIf(load());
    for (const patch of [{ path: '' }, { errors: [{ status: 400, description: '' }] }, { request: [{ name: '', type: 'string', required: true }] }]) {
      start(base);
      s().edit(setIf(patch));
      expect(s().project).not.toBe(base);
      expect(s().rejected).toBeUndefined();
      expect(() => reopen()).not.toThrow();
    }
  });

  it('마지막 컬럼 삭제·인덱스 컬럼 비우기는 막고 알림, 다음 편집이 성공하면 알림을 지움', () => {
    const base = load();
    start(base);
    const db = base.nodes.find((n) => n.tables.length)!;
    const setT = (t: object) => (p: Project): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === db.id ? { ...n, tables: [{ ...n.tables[0], ...t }, ...n.tables.slice(1)] } : n)) });
    let t = db.tables[0];
    while (t.columns.length) t = removeColumn(t, 0);
    s().edit(setT(t));
    expect(s().project).toBe(base);
    expect(s().rejected).toMatch(/columns/);
    s().edit(setT({ indexes: [{ name: 'ix', columns: [], unique: false }] }));
    expect(s().project).toBe(base);
    expect(s().rejected).toMatch(/indexes/);
    s().edit((p) => ({ ...p, name: '다른 이름' }));
    expect(s().project.name).toBe('다른 이름');
    expect(s().rejected).toBeUndefined();
    expect(() => reopen()).not.toThrow();
  });

  it('컬럼이 하나뿐인 테이블은 컬럼 삭제 단추가 없음', async () => {
    const p = load();
    const db = p.nodes.find((n) => n.tables.length)!;
    const one = { ...db, tables: [{ ...db.tables[0], columns: db.tables[0].columns.slice(0, 1), indexes: [] }] };
    start({ ...p, nodes: p.nodes.map((n) => (n.id === db.id ? one : n)) });
    const el = await mount(<TableEditor node={one} t={one.tables[0]} open />);
    expect(el.querySelector('button[aria-label="컬럼 삭제"]')).toBeNull();
  });
});

describe('숫자 칸을 한 글자씩 칠 수 있음 (N1)', () => {
  it('NumField: 중간 값이 거절되어도 칸이 되돌아가지 않고 0.5가 저장됨', async () => {
    let saved: number | undefined;
    // 0이나 빈 칸은 받지 않는 칸 (store가 범위 밖 값을 거절하는 것처럼)
    function H() {
      const [v, setV] = useState<number | undefined>(2);
      return <NumField label="몫" value={v} onChange={(x) => { if (x) { setV(x); saved = x; } }} />;
    }
    const el = await mount(<H />);
    const inp = el.querySelector('input')!;
    await typeChars(inp, '0.5');
    expect(saved).toBe(0.5);
    expect(inp.value).toBe('0.5');
  });

  it('포커스가 빠지면 받아들여진 값으로 다시 맞춤', async () => {
    function H() { return <NumField label="몫" value={2} onChange={() => {}} />; }
    const el = await mount(<H />);
    const inp = el.querySelector('input')!;
    await act(async () => { inp.focus(); setValue(inp, '7'); });
    expect(inp.value).toBe('7');
    await act(async () => { inp.blur(); });
    expect(inp.value).toBe('2');
  });

  it('에러 status 칸에 404를 한 글자씩 쳐도 404로 저장됨', async () => {
    const p = restIf(load());
    const e = p.edges[0], k = 0;
    useStore.setState({ project: p, rejected: undefined });
    const edge = () => s().project.edges.find((x) => x.from === e.from && x.to === e.to)!;
    function H() { useStore((st) => st.project); return <InterfacesSection e={edge()} />; }
    const el = await mount(<H />);
    const inp = el.querySelector('input[min="400"]') as HTMLInputElement;
    await typeChars(inp, '404');
    expect(edge().interfaces[k].errors[0].status).toBe(404);
  });
});

describe('화면 노드 진입 몫 (N2)', () => {
  it('진입 몫을 넣고 비울 수 있음', async () => {
    const p = load();
    const ui = p.nodes.find((n) => n.layer === 'ui')!;
    useStore.setState({ project: p, rejected: undefined });
    function H() { useStore((st) => st.project); return <NodePanel id={ui.id} />; }
    const el = await mount(<H />);
    const row = [...el.querySelectorAll('label.row')].find((l) => l.textContent?.startsWith('진입 몫'))!;
    expect(row.getAttribute('title')).toMatch(/비우면/);
    const inp = row.querySelector('input')!;
    const share = () => s().project.nodes.find((n) => n.id === ui.id)!.entry_share;
    await typeChars(inp, '0.3');
    expect(share()).toBe(0.3);
    await typeChars(inp, '');
    expect(share()).toBeUndefined();
  });
});

describe('인터페이스 방식을 바꾸면 경로를 새 방식 모양으로 (P2)', () => {
  it('REST ↔ gRPC ↔ 메시지', async () => {
    const p = restIf(load());
    const e = p.edges[0], k = 0;
    useStore.setState({ project: p, rejected: undefined });
    const edge = () => s().project.edges.find((x) => x.from === e.from && x.to === e.to)!;
    const path = () => edge().interfaces[k].path;
    function H() { useStore((st) => st.project); return <InterfacesSection e={edge()} />; }
    const el = await mount(<H />);
    // 방식 고르기는 첫 드롭다운 (페이지 안 Select: 버튼을 눌러 목록을 열고 항목을 누른다)
    const label = { rest: 'REST (HTTP)', grpc: 'gRPC', message: '메시지 (큐·이벤트)' } as Record<string, string>;
    const pick = async (kind: string) => {
      await act(async () => (el.querySelectorAll('details')[k].querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement).click());
      await act(async () => ([...document.querySelectorAll('[role="option"]')].find((o) => o.textContent === label[kind]) as HTMLElement).click());
    };
    expect(path().startsWith('/')).toBe(true);
    await pick('grpc');
    expect(path()).toBe('Method1');
    await pick('rest');
    expect(path()).toBe('/Method1');
    await pick('message');
    expect(path()).toBe('topic.name');
    await pick('grpc');
    expect(path()).toBe('Method1');
  });
});

describe('감사 13: 숫자 칸 비우기·행동 이름·에러 응답 버튼', () => {
  it('처리 시간을 지우고 다시 쳐도 동시 처리 수·p99는 그대로', async () => {
    const p = load();
    const n = p.nodes.find((x) => x.id === 'N-05')!;
    useStore.setState({ project: { ...p, nodes: p.nodes.map((x) => (x === n ? { ...x, perf: { service_ms: 40, workers: 4, service_p99_ms: 120 } } : x)) }, rejected: undefined });
    function H() { useStore((st) => st.project); return <NodePanel id={n.id} />; }
    const el = await mount(<H />);
    const inp = [...el.querySelectorAll('label.row')].find((l) => l.textContent?.startsWith('평균 처리(ms)'))!.querySelector('input')!;
    await typeChars(inp, '60');
    expect(s().project.nodes.find((x) => x.id === n.id)!.perf).toEqual({ service_ms: 60, workers: 4, service_p99_ms: 120 });
  });
  it('"+ 에러 응답"을 두 번 눌러도 상태 코드가 겹치지 않음', async () => {
    const p = restIf(load());
    const e = p.edges[0];
    useStore.setState({ project: { ...p, edges: p.edges.map((x, i) => (i ? x : { ...x, interfaces: x.interfaces.map((f, k) => (k ? f : { ...f, errors: [] })) })) }, rejected: undefined });
    const edge = () => s().project.edges.find((x) => x.from === e.from && x.to === e.to)!;
    function H() { useStore((st) => st.project); return <InterfacesSection e={edge()} />; }
    const el = await mount(<H />);
    const btn = () => [...el.querySelectorAll('button')].find((b) => b.textContent === '+ 에러 응답') as HTMLButtonElement;
    await act(async () => btn().click());
    await act(async () => btn().click());
    expect(edge().interfaces[0].errors.map((x) => x.status)).toEqual([400, 401]);
  });
  it('행동 이름을 다른 행동 이름으로 바꾸지 않음', () => {
    const ex = examples.find((x) => x.name === 'actions.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    const [a, b] = p.actions;
    expect(updateAction(p, b.name, { name: a.name })).toBe(p);
  });
});
