// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// desktop.ts가 불러올 때 읽으므로 import보다 먼저 데스크톱 앱 흉내를 둔다. 명세 파일 저장만 실패(EPERM)
vi.hoisted(() => {
  (globalThis as { desktop?: unknown }).desktop = new Proxy({}, {
    get: (_, k) => (k === 'saveTexts' ? () => Promise.reject(new Error('EPERM: operation not permitted')) : () => Promise.resolve(null)),
  });
});
const { App } = await import('./App');
const { parseProject } = await import('../../engine/data');
const { catalog, examples } = await import('./data');
const { useStore } = await import('./store');

it('데스크톱에서 명세 파일 저장이 실패하면 알림을 띄움', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // 인터페이스 명세가 있는 예시
  const ex = examples.find((e) => e.name === 'global-commerce.json')!;
  useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name) });
  const el = document.createElement('div'); document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(<App />));
  const item = () => [...el.querySelectorAll('button[role="menuitem"]')].find((b) => b.textContent === '인터페이스 명세 내보내기') as HTMLButtonElement | undefined;
  // 파일 메뉴를 차례로 열어 그 항목을 찾는다
  for (const b of el.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (item()) break;
    await act(async () => (b as HTMLButtonElement).click());
  }
  await act(async () => item()!.click());
  expect(el.querySelector('[role="status"]')?.textContent).toContain('저장하지 못했습니다: EPERM');
  await act(async () => root.unmount());
});
