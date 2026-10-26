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
