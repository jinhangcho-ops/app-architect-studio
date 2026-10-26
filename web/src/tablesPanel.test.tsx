// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { updateTable } from './edit';
import { InterfacesSection } from './InterfacesPanel';
import { ActionsSection } from './ProjectPanel';
import { TableEditor } from './TablesPanel';
import { useStore } from './store';

const load = () => { const ex = examples.find((e) => e.name === 'global-commerce.json')!; return parseProject(ex.data, catalog.items, ex.name); };
const blur = (el: Element) => el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));

/** 첫 테이블 편집기를 store 값으로 다시 그린다 */
function mountTable() {
  const p = load();
  const nodeId = p.nodes.find((n) => n.tables.length)!.id;
  useStore.setState({ project: p, past: [], future: [] });
  const el = document.createElement('div');
  const root = createRoot(el);
  const node = () => useStore.getState().project.nodes.find((x) => x.id === nodeId)!;
  const render = () => flushSync(() => root.render(<TableEditor node={node()} t={node().tables[0]} open />));
  render();
  return { el, root, render, node, col: () => node().tables[0].columns[0] };
}

describe('닫힌 테이블 편집기 (감사 11)', () => {
  it('닫혀 있으면 머리만 그리고, 열면 칸을 그림', () => {
    const p = load();
    const node = p.nodes.find((n) => n.tables.length)!;
    useStore.setState({ project: p, past: [], future: [] });
    const el = document.createElement('div');
    flushSync(() => createRoot(el).render(<TableEditor node={node} t={node.tables[0]} />));
    expect(el.querySelectorAll('input').length).toBe(0);
    expect(el.querySelector('summary')!.textContent).toContain(node.tables[0].name);
    const d = el.querySelector('details')!;
    d.open = true;
    flushSync(() => d.dispatchEvent(new Event('toggle')));
    expect(el.querySelectorAll('input').length).toBeGreaterThan(0);
  });
});

describe('데이터 사전 칸', () => {
  it('되돌리기 뒤에 칸이 지금 값을 보이고, 칸을 지나가도 옛 값을 다시 저장하지 않음', () => {
    const { el, root, render, col } = mountTable();
    const name = col().name;
    const inp = () => el.querySelector(`input[aria-label="${name} 논리명"]`) as HTMLInputElement;
    const before = col().label;
    inp().value = 'XYZ'; blur(inp()); render();
    expect(col().label).toBe('XYZ');
    useStore.getState().undo(); render();
    expect(inp().value).toBe(before ?? '');
    blur(inp()); render();
    expect(col().label).toBe(before);
    expect(useStore.getState().future.length).toBe(1);
    root.unmount();
  });

  it('값이 그대로면 저장하지 않고, 쉼표 든 코드 라벨도 쪼개지 않음', () => {
    const { el, root, render, node, col } = mountTable();
    const t = node().tables[0];
    useStore.getState().edit((p) => updateTable(p, node().id, t.name, { columns: t.columns.map((c, i) => (i ? c : { ...c, codes: [{ code: 'C', label: '카드,체크' }] })) }));
    useStore.setState({ past: [], future: [] });
    render();
    const p0 = useStore.getState().project;
    // 이름·기본 키·인덱스·데이터 사전 글자 칸 모두
    for (const x of el.querySelectorAll('input:not([type])')) blur(x);
    render();
    expect(useStore.getState().project).toBe(p0);
    expect(useStore.getState().past.length).toBe(0);
    expect(col().codes).toEqual([{ code: 'C', label: '카드,체크' }]);
    root.unmount();
  });
});

describe('테이블 편집기 칸', () => {
  it('띄어쓰기만 다른 값을 저장한 뒤 칸이 지금 값으로 돌아가, 지나가기만 하면 다시 저장하지 않음', () => {
    const { el, root, render, node, col } = mountTable();
    const pk = () => el.querySelector('input[aria-label="기본 키"]') as HTMLInputElement;
    const v0 = pk().value;
    pk().value = `${v0} `; blur(pk()); render();
    expect(pk().value).toBe(v0);
    const lab = () => el.querySelector(`input[aria-label="${col().name} 논리명"]`) as HTMLInputElement;
    lab().value = 'XYZ'; blur(lab()); render();
    useStore.getState().undo(); render();
    expect(useStore.getState().future.length).toBe(1);
    blur(pk()); render();
    expect(useStore.getState().future.length).toBe(1);
    expect(node().tables[0].primary_key.join(', ')).toBe(v0);
    root.unmount();
  });

  it('코드 값은 ;로 나누고 쉼표 든 라벨은 그대로', () => {
    const { el, root, render, col } = mountTable();
    const inp = el.querySelector(`input[aria-label="${col().name} 코드 값"]`) as HTMLInputElement;
    inp.value = 'C=카드,체크; M=현금'; blur(inp); render();
    expect(col().codes).toEqual([{ code: 'C', label: '카드,체크' }, { code: 'M', label: '현금' }]);
    root.unmount();
  });

  it('인덱스·컬럼 이름을 저장해도 같은 줄의 다른 칸이 새로 그려지지 않음(포커스 유지)', () => {
    const { el, root, render, node } = mountTable();
    const ixRow = () => [...el.querySelectorAll('tr')].find((r) => r.querySelector('button[aria-label="인덱스 삭제"]'))!;
    const ixCols = ixRow().querySelectorAll('input')[1];
    const ixName = ixRow().querySelector('input')!;
    ixName.value = 'idx_renamed'; blur(ixName); render();
    expect(node().tables[0].indexes[0].name).toBe('idx_renamed');
    expect(el.contains(ixCols)).toBe(true);
    const colRow = () => [...el.querySelectorAll('tr')].find((r) => r.querySelector('button[aria-label="컬럼 삭제"]'))!;
    const avg = colRow().querySelectorAll('input[type="number"]')[1];
    const colName = colRow().querySelector('input')!;
    colName.value = 'renamed_col'; blur(colName); render();
    expect(node().tables[0].columns[0].name).toBe('renamed_col');
    expect(el.contains(avg)).toBe(true);
    root.unmount();
  });

  it('컬럼을 지우면 아래 줄 이름 칸이 옮겨 온 컬럼 이름을 보임', () => {
    const { el, root, render, node } = mountTable();
    const second = node().tables[0].columns[1].name;
    flushSync(() => (el.querySelector('button[aria-label="컬럼 삭제"]') as HTMLButtonElement).click()); render();
    const colRow = [...el.querySelectorAll('tr')].find((r) => r.querySelector('button[aria-label="컬럼 삭제"]'))!;
    expect(colRow.querySelector('input')!.value).toBe(second);
    root.unmount();
  });

  it('인덱스 추가의 기본 이름은 같은 노드의 다른 테이블과 겹치지 않음', () => {
    const { el, root, render, node } = mountTable();
    const n = node(); const [t0, t1] = n.tables;
    // 다른 테이블에 옛 기본 이름과 새 기본 이름을 미리 둔다
    useStore.getState().edit((p) => updateTable(p, n.id, t1.name, { indexes: [{ name: 'idx_1', columns: [t1.columns[0].name], unique: false }, { name: `idx_${t0.name}_1`, columns: [t1.columns[0].name], unique: false }] }));
    useStore.getState().edit((p) => updateTable(p, n.id, t0.name, { indexes: [] }));
    render();
    const add = () => [...el.querySelectorAll('button')].find((b) => b.textContent === '인덱스 추가')!;
    flushSync(() => add().click()); render();
    flushSync(() => add().click()); render();
    const names = node().tables.flatMap((t) => t.indexes.map((x) => x.name));
    expect(new Set(names).size).toBe(names.length);
    expect(node().tables[0].indexes.map((x) => x.name)).toEqual([`idx_${t0.name}_2`, `idx_${t0.name}_3`]);
    root.unmount();
  });
});

describe('행동 테이블 추가', () => {
  it('아직 안 쓰는 첫 테이블을 넣고, 남은 게 없으면 버튼이 사라짐', () => {
    useStore.setState({ project: load(), past: [], future: [] });
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = () => flushSync(() => root.render(<ActionsSection />));
    render();
    const btns = () => [...el.querySelectorAll('button')].filter((b) => b.textContent === '테이블 추가');
    // 첫 행동은 이미 세 테이블을 다 써서 버튼이 없고, 둘째 행동에만 있다
    expect(btns().length).toBe(1);
    flushSync(() => btns()[0].click()); render();
    flushSync(() => btns()[0].click()); render();
    const w = useStore.getState().project.actions[1].writes.map((x) => `${x.node}.${x.table}`);
    expect(w).toEqual(['N-10.events', 'N-06.orders', 'N-06.ledger_entries']);
    expect(btns().length).toBe(0);
    root.unmount();
  });
});

describe('인터페이스 방식 바꾸기', () => {
  it('파일·전문으로 바꾸면 인증·에러·REST 경로를 지우고, 다시 REST로 바꾸면 바이트 길이를 지움', () => {
    const p = load();
    const e = p.edges.find((x) => x.interfaces.length)!;
    const i0 = { ...e.interfaces[0], kind: 'rest' as const, method: 'GET' as const, path: '/path', auth: 'bearer' as const, errors: [{ status: 404, description: '없음' }], request: [{ name: 'a', type: 'string' as const, required: true, length: 10 }] };
    useStore.setState({ project: { ...p, edges: p.edges.map((x) => (x === e ? { ...x, interfaces: [i0] } : x)) }, past: [], future: [] });
    const el = document.createElement('div'); document.body.appendChild(el);
    const root = createRoot(el);
    const iface = () => useStore.getState().project.edges.find((x) => x.from === e.from && x.to === e.to)!.interfaces[0];
    const render = () => flushSync(() => root.render(<InterfacesSection e={useStore.getState().project.edges.find((x) => x.from === e.from && x.to === e.to)!} />));
    const pickKind = (from: string, to: string) => {
      const b = [...el.querySelectorAll('button.select')].find((x) => x.textContent?.startsWith(from)) as HTMLButtonElement;
      flushSync(() => b.click());
      flushSync(() => ([...document.querySelectorAll('[role="option"]')].find((x) => x.textContent === to) as HTMLElement).click());
      render();
    };
    render();
    pickKind('REST (HTTP)', '파일·전문');
    expect(iface()).toMatchObject({ kind: 'file', path: 'FILE_ID', errors: [], auth: undefined, method: undefined });
    expect(iface().request[0].length).toBe(10);
    pickKind('파일·전문', 'REST (HTTP)');
    expect(iface().request[0].length).toBeUndefined();
    root.unmount(); el.remove();
  });
});

describe('인터페이스 테이블 연결', () => {
  it('+ 테이블은 아직 안 고른 테이블을 더하고, 다 고르면 버튼이 사라짐', () => {
    const p = load();
    const e = p.edges.find((x) => x.interfaces.length)!;
    const total = p.nodes.reduce((s, n) => s + n.tables.length, 0);
    useStore.setState({ project: { ...p, edges: p.edges.map((x) => (x === e ? { ...x, interfaces: [{ ...x.interfaces[0], tables: undefined }] } : x)) }, past: [], future: [] });
    const el = document.createElement('div');
    const root = createRoot(el);
    const edge = () => useStore.getState().project.edges.find((x) => x.from === e.from && x.to === e.to)!;
    const render = () => flushSync(() => root.render(<InterfacesSection e={edge()} />));
    render();
    const btn = () => [...el.querySelectorAll('button')].find((b) => b.textContent === '+ 테이블');
    for (let k = 0; k < total; k++) { btn()!.click(); render(); }
    const links = edge().interfaces[0].tables!;
    expect(new Set(links.map((x) => `${x.node}.${x.table}`)).size).toBe(total);
    expect(btn()).toBeUndefined();
    root.unmount();
  });
});

describe('이름 겹침', () => {
  it('같은 노드에 있는 테이블 이름으로 바꾸면 저장하지 않고 칸을 옛 이름으로 되돌림', () => {
    const { el, root, node } = mountTable();
    const [t0, t1] = node().tables;
    const input = [...el.querySelectorAll('input')].find((x) => x.value === t0.name)!;
    const before = useStore.getState().project;
    input.value = t1.name; blur(input);
    expect(useStore.getState().project).toBe(before);
    expect(input.value).toBe(t0.name);
    root.unmount();
  });

  it('컬럼 이름 바꾸기는 기본 키를 따라가고, 이미 있는 컬럼 이름이면 저장하지 않음', () => {
    const { el, root, render, node } = mountTable();
    const t = node().tables[0];
    const pk = t.primary_key[0], other = t.columns.find((c) => c.name !== pk)!.name;
    const cell = () => [...el.querySelectorAll('td input')].find((x) => (x as HTMLInputElement).value === pk) as HTMLInputElement;
    const before = useStore.getState().project;
    let c = cell(); c.value = other; blur(c); render();
    expect(useStore.getState().project).toBe(before);
    c = cell(); c.value = `${pk}_x`; blur(c); render();
    expect(node().tables[0].primary_key[0]).toBe(`${pk}_x`);
    root.unmount();
  });
});
