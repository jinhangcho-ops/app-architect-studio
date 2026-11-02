// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { addWire, bindApi } from './edit';
import { EdgePanel, NodePanel } from './NodePanel';
import { LAYER_NAMES } from '../../engine/model';
import { useStore } from './store';

describe('연결선 패널', () => {
  it('화면 와이어프레임 호출이 부하를 정하면 호출 비율·흐르는 요청 칸을 잠금', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    const p0 = parseProject(ex.data, catalog.items, ex.name);
    const ui = p0.nodes.find((n) => n.layer === 'ui')!.id;
    const to = p0.edges.find((e) => e.from === ui)!.to;
    // 서버 렌더는 store의 처음 값을 읽으므로 실제 DOM에 그린다
    const html = (p: typeof p0) => {
      useStore.setState({ project: p });
      const el = document.createElement('div');
      const root = createRoot(el);
      flushSync(() => root.render(<EdgePanel from={ui} to={to} />));
      const out = el.innerHTML;
      root.unmount();
      return out;
    };
    expect(html(p0)).not.toContain('disabled');
    const p1 = bindApi(addWire(p0, ui, 0, { kind: 'button', label: 'b', x: 0, y: 0, w: 10, h: 10 }), ui, 0, 'w1', { method: 'GET', path: '/x', to, per_session: 1 });
    const out = html(p1);
    expect(out).toContain('API 호출이 이 연결의 부하를 정합니다');
    expect(out.match(/disabled/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('인터페이스 명세가 있으면 그 호출 수가 부하를 정해 호출 비율·흐르는 요청 칸을 잠금', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: p });
    const el = document.createElement('div');
    const root = createRoot(el);
    flushSync(() => root.render(<EdgePanel from="N-03" to="N-09" />));
    const out = el.innerHTML;
    root.unmount();
    expect(out).toContain('인터페이스 명세 (1)');
    expect(out).toContain('인터페이스 명세의 호출 수가 이 연결의 부하를 정합니다');
    expect(out.match(/disabled/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('노드 패널 레이어', () => {
  it('테이블이 있는 노드는 db·cache·analytics 레이어만 고를 수 있음 (나머지는 비활성 + 이유)', () => {
    const ex = examples.find((e) => e.name === 'actions.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    const db = p.nodes.find((n) => n.tables.length)!;
    useStore.setState({ project: p });
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    flushSync(() => root.render(<NodePanel id={db.id} />));
    const pick = el.querySelector('button[title*="테이블"]') as HTMLButtonElement;
    expect(pick).toBeTruthy();
    flushSync(() => pick.click());
    const off = [...document.querySelectorAll('.select-list [role="option"][aria-disabled="true"]')].map((o) => o.textContent);
    expect(off).toContain(LAYER_NAMES.backend);
    expect(off).not.toContain(LAYER_NAMES.cache);
    root.unmount();
    el.remove();
  });
});

describe('노드 패널 자동 확장', () => {
  it('API 서버(backend)에는 자동 확장 칸이 있고 single_primary DB에는 없음', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: p });
    const draw = (id: string) => {
      const el = document.createElement('div');
      const root = createRoot(el);
      flushSync(() => root.render(<NodePanel id={id} />));
      const out = el.innerHTML;
      root.unmount();
      return out;
    };
    expect(draw('api')).toContain('자동 확장');
    expect(draw('db')).not.toContain('자동 확장');
  });

  it('진입 서버(게이트웨이)에는 대당 대역폭 한도 칸이 있고 DB에는 없음', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name) });
    const draw = (id: string) => {
      const el = document.createElement('div');
      const root = createRoot(el);
      flushSync(() => root.render(<NodePanel id={id} />));
      const out = el.innerHTML;
      root.unmount();
      return out;
    };
    expect(draw('lb')).toContain('대당 대역폭 한도');
    expect(draw('db')).not.toContain('대당 대역폭 한도');
  });
});

describe('노드 패널 요청당 로그', () => {
  it('서버 노드에만 요청당 로그(KB) 칸이 있고, 값을 넣으면 observability에 저장·비우면 사라짐', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name), past: [], future: [] });
    const draw = (id: string) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      flushSync(() => root.render(<NodePanel id={id} />));
      return { el, done: () => { root.unmount(); el.remove(); } };
    };
    const ui = useStore.getState().project.nodes.find((n) => n.layer === 'ui')!;
    const u = draw(ui.id);
    expect(u.el.innerHTML).not.toContain('요청당 로그(KB)');
    u.done();
    const { el, done } = draw('api');
    expect(el.innerHTML).toContain('요청당 로그(KB)');
    const inp = [...el.querySelectorAll('label.row')].find((r) => r.querySelector('span')?.firstChild?.textContent === '요청당 로그(KB)')!.querySelector('input') as HTMLInputElement;
    const type = (v: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inp, v); flushSync(() => inp.dispatchEvent(new Event('input', { bubbles: true }))); };
    type('1.5');
    expect(useStore.getState().project.nodes.find((n) => n.id === 'api')!.observability?.log_kb_per_req).toBe(1.5);
    type('0');
    expect(useStore.getState().project.nodes.find((n) => n.id === 'api')!.observability).toBeUndefined();
    done();
  });
});

describe('노드 패널 백업 보호', () => {
  const setup = (withBackup: boolean) => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    const nodes = p.nodes.map((n) => {
      if (n.id !== 'db') return n;
      const { backup: _drop, ...rest } = n;
      return withBackup ? { ...rest, backup: { every_h: 24, pitr: false } } : rest;
    });
    useStore.setState({ project: { ...p, nodes }, past: [], future: [] });
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    flushSync(() => root.render(<NodePanel id="db" />));
    return { el, done: () => { root.unmount(); el.remove(); } };
  };
  const backupOf = () => useStore.getState().project.nodes.find((n) => n.id === 'db')!.backup!;
  const choose = (el: HTMLElement, label: string, option: string) => {
    flushSync(() => (el.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click());
    const o = [...document.querySelectorAll('.select-list [role="option"]')].find((x) => x.textContent === option) as HTMLElement;
    flushSync(() => o.click());
  };

  it('backup이 있는 노드에는 칸 5개(날짜는 했음일 때)가 보이고 값이 저장됨', () => {
    const { el, done } = setup(true);
    for (const t of ['백업 보관(일)', '백업 암호화', '변조 방지(삭제 잠금)', '복구 훈련(되살려 봄)']) expect(el.innerHTML).toContain(t);
    expect(el.querySelector('input[type="date"]')).toBeNull();
    choose(el, '변조 방지(삭제 잠금)', '켬');
    expect(backupOf().immutable).toBe(true);
    choose(el, '백업 암호화', '끔');
    expect(backupOf().encrypted).toBe(false);
    choose(el, '백업 암호화', '미정');
    expect('encrypted' in backupOf()).toBe(false);
    choose(el, '복구 훈련(되살려 봄)', '했음');
    expect(backupOf().restore_tested).toBe(true);
    const d = el.querySelector('input[type="date"]') as HTMLInputElement;
    expect(d).toBeTruthy();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(d, '2026-10-01');
    flushSync(() => d.dispatchEvent(new Event('input', { bubbles: true })));
    expect(backupOf().restore_tested_on).toBe('2026-10-01');
    choose(el, '복구 훈련(되살려 봄)', '없음');
    expect(backupOf().restore_tested).toBe(false);
    expect('restore_tested_on' in backupOf()).toBe(false);
    done();
  });

  it('backup이 없는 노드에는 안 보임', () => {
    const { el, done } = setup(false);
    expect(el.innerHTML).not.toContain('백업 암호화');
    expect(el.innerHTML).not.toContain('변조 방지(삭제 잠금)');
    done();
  });
});

describe('연결선 패널 타임아웃·재시도', () => {
  it('동기 연결선에만 타임아웃(ms)·재시도 횟수·서킷 브레이커 칸이 있고, 800을 넣으면 timeout_ms에 저장', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: p, past: [], future: [] });
    const sync = p.edges.find((e) => e.sync)!, async = p.edges.find((e) => !e.sync)!;
    const draw = (e: typeof sync) => {
      const el = document.createElement('div');
      document.body.append(el);
      const root = createRoot(el);
      flushSync(() => root.render(<EdgePanel from={e.from} to={e.to} />));
      return { el, done: () => { root.unmount(); el.remove(); } };
    };
    const a = draw(async);
    expect(a.el.innerHTML).not.toContain('타임아웃(ms)');
    a.done();
    const { el, done } = draw(sync);
    expect(el.innerHTML).toContain('재시도 횟수');
    expect(el.innerHTML).toContain('서킷 브레이커');
    const inp = [...el.querySelectorAll('label.row')].find((r) => r.querySelector('span')?.firstChild?.textContent === '타임아웃(ms)')!.querySelector('input') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inp, '800');
    flushSync(() => inp.dispatchEvent(new Event('input', { bubbles: true })));
    expect(useStore.getState().project.edges.find((e) => e.from === sync.from && e.to === sync.to)!.timeout_ms).toBe(800);
    done();
  });
});
