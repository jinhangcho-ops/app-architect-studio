// @vitest-environment happy-dom
// FastAPI 노드 패널의 Python 버전·requirements.txt 칸 → 저장·경고·명세 점검
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { specAdvice } from '../../engine/interfaces';
import { catalog, examples } from './data';
import { NodePanel } from './NodePanel';
import { useStore } from './store';

const setValue = (el: HTMLInputElement | HTMLTextAreaElement, v: string) => {
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};
const node = () => useStore.getState().project.nodes.find((n) => n.id === 'B-01')!;

describe('FastAPI 노드: Python 버전·requirements.txt', () => {
  it('칸에 넣으면 노드에 저장되고, 버전 기준·경고가 패널과 명세 점검에 보임', () => {
    const ex = examples.find((e) => e.name === 'ledger-fastapi.json')!;
    useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name), past: [], future: [], rejected: undefined });
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = () => flushSync(() => root.render(<NodePanel id="B-01" />));
    render();
    expect(el.textContent).toContain('Python 버전·requirements.txt');

    setValue(el.querySelector('textarea[aria-label="requirements.txt"]') as HTMLTextAreaElement, 'fastapi==0.126.0\npydantic==1.10.13');
    render();
    expect(node().requirements).toBe('fastapi==0.126.0\npydantic==1.10.13');
    expect(el.textContent).toContain('버전 기준: fastapi 0.126.0, pydantic 1.10.13');
    expect(el.textContent).toContain('pydantic 1을 쓰지 못합니다');
    const adv = specAdvice(useStore.getState().project).find((x) => x.nodeId === 'B-01')!;
    expect(adv.text).toContain('버전 기준: fastapi 0.126.0, pydantic 1.10.13.');
    expect(adv.warnings!.join()).toContain('pydantic 1을 쓰지 못합니다');

    // Python 버전은 칸을 떠날 때. 형식이 틀리면 바꾸지 않고 알림
    const py = el.querySelector('input[aria-label="Python 버전"]') as HTMLInputElement;
    py.value = '3.x';
    flushSync(() => py.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(node().python).toBeUndefined();
    expect(useStore.getState().rejected).toContain('Python 버전');
    py.value = '3.11';
    flushSync(() => py.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(node().python).toBe('3.11');

    // 비우면 칸이 사라짐 (최신 방식)
    setValue(el.querySelector('textarea[aria-label="requirements.txt"]') as HTMLTextAreaElement, '');
    render();
    expect(node().requirements).toBeUndefined();
    root.unmount();
  });

  it('FastAPI가 아닌 노드에는 칸이 없음', () => {
    const ex = examples.find((e) => e.name === 'ledger-fastapi.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: { ...p, nodes: p.nodes.map((n) => (n.id === 'B-01' ? { ...n, primary: 'go_service' } : n)) }, past: [], future: [] });
    const el = document.createElement('div');
    const root = createRoot(el);
    flushSync(() => root.render(<NodePanel id="B-01" />));
    expect(el.textContent).not.toContain('requirements.txt');
    root.unmount();
  });
});
