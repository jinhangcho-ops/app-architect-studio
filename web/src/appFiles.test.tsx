// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// 데스크톱 앱 흉내: 열기 창은 next 파일을 고르고, 저장은 어디에 무엇을 썼는지 남긴다
const fake = vi.hoisted(() => {
  const f = { next: '', files: {} as Record<string, string>, saved: [] as { file?: string; name: string }[] };
  (globalThis as { desktop?: unknown }).desktop = {
    isDesktop: true,
    openFile: () => Promise.resolve({ path: f.next, text: f.files[f.next] }),
    saveFile: (file: string | undefined, text: string) => { f.saved.push({ file, name: JSON.parse(text).name }); return Promise.resolve(null); },
    writeSnapshot: () => Promise.resolve(true), listSnapshots: () => Promise.resolve([]),
    checkUpdate: () => Promise.resolve(null), installUpdate: () => Promise.resolve({ ok: false }),
  };
  return f;
});
const { App } = await import('./App');
const { exportProject, useStore } = await import('./store');
const { readAutosaves } = await import('./autosave');
const { parseProject } = await import('../../engine/data');
const { catalog, examples } = await import('./data');

const mount = async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<App />));
  return { el, done: () => act(async () => root.unmount()) };
};
const key = (k: string) => act(async () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: `Key${k.toUpperCase()}`, ctrlKey: true }));
  await new Promise((r) => setTimeout(r, 20));
});
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

it('A를 열고 B를 연 뒤 되돌리면 Ctrl+S가 B 파일에 A를 쓰지 않고 이름을 다시 물음, 같은 이름 다른 프로젝트는 자동 저장 시점을 덮지 않음', async () => {
  localStorage.clear();
  const base = useStore.getState().project;
  fake.files['A.json'] = JSON.stringify(exportProject({ ...base, name: '같은 이름', nodes: base.nodes.slice(0, 2), edges: [] }, {}));
  fake.files['B.json'] = JSON.stringify(exportProject({ ...base, name: '같은 이름' }, {}));
  const { done } = await mount();
  fake.next = 'A.json'; await key('o'); await wait(900);
  fake.next = 'B.json'; await key('o'); await wait(900);
  // 자동 저장: A 시점과 B 시점이 따로 남음
  expect(readAutosaves().map((s) => s.project.nodes.length)).toEqual([base.nodes.length, 2]);
  await key('s');
  expect(fake.saved.at(-1)).toEqual({ file: 'B.json', name: '같은 이름' });
  await key('z');
  expect(useStore.getState().project.nodes).toHaveLength(2);
  await key('s');
  expect(fake.saved.at(-1)?.file).toBeUndefined();
  await done();
});

it('없는 카탈로그 항목·없는 노드 연결선이 있어도 부품 구성은 그려지고, 패널이 터져도 앱은 남음', async () => {
  const ex = examples.find((e) => e.name === 'actions.json')!;
  const base = parseProject(ex.data, catalog.items, ex.name);
  const api = base.nodes.find((n) => n.layer === 'backend')!;
  // importProject를 거치지 않고 깨진 프로젝트를 그대로 넣는다
  useStore.getState().load({ ...base, nodes: base.nodes.map((n) => (n.id === api.id ? { ...n, extras: [...n.extras, 'no_such_extra'] } : n)), edges: [...base.edges, { ...base.edges[0], from: api.id, to: 'ghost' }, { ...base.edges[0], from: 'ghost', to: api.id }] });
  const { el, done } = await mount();
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  await act(async () => useStore.getState().setFocus(api.id, 'parts'));
  expect(el.textContent).toContain('no_such_extra');
  expect(el.textContent).not.toContain('이 화면을 그리지 못했습니다');
  await act(async () => { useStore.getState().setFocus(undefined); useStore.getState().select({ kind: 'edge', from: 'ghost', to: api.id }); });
  await act(async () => ([...el.querySelectorAll('button')].find((b) => b.textContent === '선택한 것') as HTMLButtonElement).click());
  spy.mockRestore();
  expect(el.querySelector('.app')).not.toBeNull();
  expect(el.textContent).toContain('이 화면을 그리지 못했습니다');
  await done();
});

it('감사 12: 세부 구성 중 Ctrl+C는 그 노드를 복사, 와이어프레임 탭에서는 복사하지 않음', async () => {
  const ex = examples.find((e) => e.name === 'phase3.json')!;
  useStore.getState().load(parseProject(ex.data, catalog.items, ex.name));
  useStore.setState({ clipboard: undefined });
  const { done } = await mount();
  const id = useStore.getState().project.nodes[1].id;
  await act(async () => useStore.getState().setFocus(id, 'wireframe'));
  await key('c');
  expect(useStore.getState().clipboard).toBeUndefined();
  await act(async () => useStore.getState().setFocus(id, 'servers'));
  await key('c');
  expect(useStore.getState().clipboard?.id).toBe(id);
  await done();
});

it('감사 12: 다른 파일을 연 뒤 되돌리면 설정 비교 기준도 앞 파일로', async () => {
  const ex = (n: string) => { const e = examples.find((x) => x.name === n)!; return parseProject(e.data, catalog.items, e.name); };
  const a = ex('phase2.json'), b = ex('global-commerce.json');
  useStore.getState().load(a);
  useStore.getState().load(b);
  expect(useStore.getState().baseline).toBe(b);
  useStore.getState().undo();
  expect(useStore.getState().baseline).toBe(a);
  useStore.getState().redo();
  expect(useStore.getState().baseline).toBe(b);
});

it('감사 12: 앞 알림의 타이머가 뒤에 뜬 긴 알림을 일찍 지우지 않음, JSON 오류는 한국어 앞말', async () => {
  fake.files['bad.json'] = '{ bad';
  const { el, done } = await mount();
  await key('s');
  await wait(2000);
  fake.next = 'bad.json'; await key('o'); await wait(100);
  expect(el.textContent).toContain('JSON 파일을 읽지 못했습니다');
  await wait(1000);
  expect(el.textContent).toContain('JSON 파일을 읽지 못했습니다');
  await done();
});

it('리뷰 13: 처음 프로젝트에서 파일을 연 뒤 되돌리면 비교 기준도 처음 프로젝트로', () => {
  const ex = examples.find((e) => e.name === 'phase1.json')!;
  // 앱을 켰을 때처럼 load를 거치지 않은 프로젝트
  const first = { ...useStore.getState().project, name: '처음' };
  useStore.setState({ project: first, baseline: first, past: [], future: [] });
  const a = parseProject(ex.data, catalog.items, ex.name);
  useStore.getState().load(a);
  useStore.getState().undo();
  expect(useStore.getState().project).toBe(first);
  expect(useStore.getState().baseline).toBe(first);
});

it('리뷰 13: 세부 구성 중 Ctrl+V는 캔버스로 나와 붙인 노드를 고름', async () => {
  const ex = examples.find((e) => e.name === 'phase3.json')!;
  useStore.getState().load(parseProject(ex.data, catalog.items, ex.name));
  const { done } = await mount();
  const id = useStore.getState().project.nodes[1].id;
  await act(async () => useStore.getState().setFocus(id, 'servers'));
  await key('c');
  const before = useStore.getState().project.nodes.length;
  await key('v');
  const s = useStore.getState();
  expect(s.project.nodes.length).toBe(before + 1);
  expect(s.focus).toBeUndefined();
  expect(s.selected).toEqual({ kind: 'node', id: s.project.nodes.at(-1)!.id });
  await done();
});

it('감사 13: 복구 안내가 떠 있어도 이번 작업은 새 시점으로 자동 저장, 남아 있던 시점은 그대로', async () => {
  localStorage.clear();
  const { writeAutosave } = await import('./autosave');
  const base = useStore.getState().project;
  writeAutosave({ ...base, name: '한 시간 고친 작업' }, {});
  const { el, done } = await mount();
  expect(el.textContent).toContain('한 시간 고친 작업');
  await act(async () => useStore.getState().edit((p) => ({ ...p, name: '새 작업' })));
  await wait(1500);
  expect(readAutosaves().map((s) => s.project.name)).toEqual(['새 작업', '한 시간 고친 작업']);
  await done();
});
