// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { updateTable } from './edit';
import { InterfacesSection } from './InterfacesPanel';
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
