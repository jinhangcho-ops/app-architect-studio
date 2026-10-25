import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { applyIndustry, updatePersona } from './edit';
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
});
