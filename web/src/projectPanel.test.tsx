// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { ProjectPanel } from './ProjectPanel';
import { useStore } from './store';

/** 라벨 글자로 그 칸의 입력을 찾는다 */
const field = (el: Element, label: string) =>
  [...el.querySelectorAll('label.row')].find((r) => r.querySelector('span')?.firstChild?.textContent === label)?.querySelector('input') as HTMLInputElement | undefined;
/** React가 받는 입력 이벤트로 값을 넣는다 */
const type = (inp: HTMLInputElement, v: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inp, v);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('설정 화면: 문서에 있는 칸 (보관 기간·접속 횟수·접속 시간·보는 기간)', () => {
  it('칸이 보이고 바꾸면 프로젝트에 들어감', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: { ...p, growth: p.growth ?? { monthly_rate: 0.1, months: 24, lead_months: 3 } }, past: [], future: [] });
    const el = document.createElement('div');
    const root = createRoot(el);
    const render = () => flushSync(() => root.render(<ProjectPanel />));
    render();
    type(field(el, '보관 기간(일)')!, '90'); render();
    expect(useStore.getState().project.scale!.retention_days).toBe(90);
    type(field(el, '보는 기간(월)')!, '36'); render();
    expect(useStore.getState().project.growth!.months).toBe(36);
    flushSync(() => ([...el.querySelectorAll('button')].find((b) => b.textContent === '편집') as HTMLButtonElement).click());
    const name = useStore.getState().project.personas[0].name;
    type(field(el, `${name} 접속 횟수(하루)`)!, '2'); render();
    type(field(el, `${name} 접속 시간(분)`)!, '7'); render();
    expect(useStore.getState().project.personas[0]).toMatchObject({ sessions_per_day: 2, session_minutes: 7 });
    root.unmount();
  });
});

describe('설정 화면: 인증·인가 절', () => {
  it('절이 보이고 방식을 고르면 p.auth.method가 저장되고 미정으로 되돌리면 auth가 사라짐', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: { ...p, auth: undefined }, past: [], future: [] });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    flushSync(() => root.render(<ProjectPanel />));
    expect(el.querySelector('#s-auth')).toBeTruthy();
    const choose = (label: string, option: string) => {
      flushSync(() => (el.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click());
      flushSync(() => ([...document.querySelectorAll('.select-list [role="option"]')].find((o) => o.textContent === option) as HTMLElement).click());
    };
    choose('방식', 'JWT(자체 발급)');
    expect(useStore.getState().project.auth?.method).toBe('jwt');
    choose('방식', '미정');
    expect(useStore.getState().project.auth).toBeUndefined();
    root.unmount();
    el.remove();
  });
});

describe('설정 화면: 비용 기준 (존 간 전송·로그)', () => {
  it('존 간 전송 상품을 고르면 cost.transfer_zone, 로그 상품을 고르면 cost.logs에 저장됨', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: p, past: [], future: [] });
    const el = document.createElement('div');
    document.body.appendChild(el);
    const root = createRoot(el);
    flushSync(() => root.render(<ProjectPanel />));
    const choose = (label: string, option: string) => {
      const row = [...el.querySelectorAll('label.row')].find((r) => r.querySelector('span')?.firstChild?.textContent === label)!;
      flushSync(() => (row.querySelector('button') as HTMLButtonElement).click());
      flushSync(() => ([...document.querySelectorAll('.select-list [role="option"]')].find((o) => o.textContent === option) as HTMLElement).click());
    };
    choose('존 간 전송 (GB)', 'transfer-interzone');
    expect(useStore.getState().project.cost.transfer_zone).toBe('transfer-interzone');
    choose('로그 저장 (GB·월)', 'logs-storage');
    expect(useStore.getState().project.cost.logs).toBe('logs-storage');
    root.unmount();
    el.remove();
  });
});
