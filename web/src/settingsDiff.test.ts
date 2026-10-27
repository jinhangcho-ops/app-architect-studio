import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { applyIndustry, removeNode, run, updatePersona, updateTable } from './edit';
import { changedCounts, resetSettings } from './settingsDiff';

const ex = examples.find((e) => e.name === 'phase3.json')!;
const base = parseProject(ex.data, catalog.items, ex.name);

describe('설정 화면: 불러온 값에서 바뀐 항목', () => {
  it('처음엔 0개, 바꾼 칸만 세고, 되돌리면 다시 0개 (노드는 그대로)', () => {
    expect(Object.values(changedCounts(base, base)).every((n) => n === 0)).toBe(true);
    const p = updatePersona(applyIndustry({ ...base, name: '새 이름', nodes: base.nodes.slice(1) }, 'restaurant'), 0, { name: '단골' });
    const c = changedCounts(p, base);
    expect(c['s-proj']).toBe(1);
    expect(c['s-peak']).toBe(1);
    expect(c['s-pers']).toBeGreaterThan(1);
    expect(c['s-mode'] + c['s-cost'] + c['s-ex']).toBe(0);
    const back = resetSettings(p, base);
    expect(Object.values(changedCounts(back, base)).every((n) => n === 0)).toBe(true);
    expect(back.nodes).toBe(p.nodes);
  });

  it('되돌린 행동이 지금 없는 노드·테이블에 쓰면 그 줄을 빼고, 쓸 곳이 없으면 행동과 페르소나 빈도도 정리', () => {
    const ax = examples.find((e) => e.name === 'actions.json')!;
    const b = parseProject(ax.data, catalog.items, ax.name);
    const w = b.actions[0].writes[0];
    const renamed = updateTable(b, w.node, w.table, { name: `${w.table}_v2` });
    const back = resetSettings({ ...renamed, scale: { ...renamed.scale!, users: renamed.scale!.users * 2 } }, b);
    expect(run(back, '2026-10-27').error).toBeUndefined();
    expect(back.actions.flatMap((a) => a.writes).some((x) => x.node === w.node && x.table === w.table)).toBe(false);
    const gone = resetSettings(removeNode(b, w.node), b);
    expect(run(gone, '2026-10-27').error).toBeUndefined();
    const names = new Set(gone.actions.map((a) => a.name));
    expect(gone.personas.every((ps) => Object.keys(ps.action_rates).every((k) => names.has(k)))).toBe(true);
  });
});

describe('설계 메모와 설정 되돌리기 (v1.3.0)', () => {
  it('메모를 바꿔도 바뀐 설정으로 세지 않고, 불러온 값으로 되돌려도 메모는 남음', async () => {
    const { changedCounts, resetSettings } = await import('./settingsDiff');
    const { parseProject } = await import('../../engine/data');
    const { catalog, examples } = await import('./data');
    const base = parseProject(examples.find((e) => e.name === 'phase1.json')!.data, catalog.items);
    const now = { ...base, name: '바꾼 이름', notes: [{ title: '개요', body: '글' }] };
    const c = changedCounts(now, base);
    expect(c['s-notes']).toBe(0);
    expect(Object.values(c).reduce((s, x) => s + x, 0)).toBe(1);
    expect(resetSettings(now, base)).toMatchObject({ name: base.name, notes: [{ title: '개요', body: '글' }] });
  });
});
