import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateNode } from './edit';
import { exportProject, importProject, useStore } from './store';

const s = () => useStore.getState();
const nameOf = (id: string) => s().project.nodes.find((n) => n.id === id)!.name;
const rename = (name: string) => s().edit((p) => updateNode(p, 'api', { name }));

describe('되돌리기·다시 하기 (Ctrl+Z / Ctrl+Y)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useStore.setState({ past: [], future: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('편집을 되돌리고 다시 하기, 새 편집을 하면 다시 하기 기록은 지워짐', () => {
    const before = nameOf('api');
    rename('A');
    vi.advanceTimersByTime(1000);
    rename('B');
    s().undo();
    expect(nameOf('api')).toBe('A');
    s().undo();
    expect(nameOf('api')).toBe(before);
    s().redo();
    expect(nameOf('api')).toBe('A');
    vi.advanceTimersByTime(1000);
    rename('C');
    expect(s().future).toEqual([]);
  });

  it('0.5초 안에 이어진 편집(한 글자씩 입력)은 한 번에 되돌림', () => {
    const before = nameOf('api');
    vi.advanceTimersByTime(1000);
    for (const v of ['주', '주문', '주문 A']) { rename(v); vi.advanceTimersByTime(100); }
    s().undo();
    expect(nameOf('api')).toBe(before);
  });

  it('아무것도 바꾸지 않는 편집은 기록하지 않고, 기록이 없으면 되돌리기는 그대로', () => {
    s().edit((p) => p);
    expect(s().past).toEqual([]);
    const p = s().project;
    s().undo();
    expect(s().project).toBe(p);
  });

  it('다른 프로젝트를 불러온 것도 되돌릴 수 있음', () => {
    const p = s().project;
    s().load({ ...p, name: '다른 프로젝트' });
    expect(s().undo()).toBe(true);
    expect(s().project.name).toBe(p.name);
    // 다시 하기도 불러오기를 넘으면 알림, 보통 편집은 아님
    expect(s().redo()).toBe(true);
    rename('편집');
    expect(s().undo()).toBe(false);
  });
});

describe('파일 불러오기에서 화면으로 고칠 수 없는 것을 걸러 냄', () => {
  it('없는 노드에 닿은 연결선, 페르소나의 없는 행동 비율은 빼고 알림', () => {
    const p = exportProject(s().project, {});
    const data = { ...p, edges: [...p.edges, { from: 'api', to: 'ghost' }, { from: 'ghost', to: 'ghost2' }], personas: p.personas.map((ps, i) => (i ? ps : { ...ps, action_rates: { ...ps.action_rates, 없는행동: 1 } })) };
    const r = importProject(JSON.parse(JSON.stringify(data)), 'x.json');
    expect(r.project.edges).toHaveLength(p.edges.length);
    expect(r.project.personas[0].action_rates).not.toHaveProperty('없는행동');
    expect(r.dropped).toContain('연결선 2개');
    expect(r.dropped).toContain('행동 비율 1개');
    expect(importProject(JSON.parse(JSON.stringify(p)), 'x.json').dropped).toBeUndefined();
  });
});
