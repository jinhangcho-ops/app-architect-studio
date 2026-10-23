import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { selectedFeatures, storageProfileOf } from '../../engine/schema';
import { catalog, examples } from './data';
import { addScreen, addWire, dropItem, dropRemove, run, setFeature, updateWire } from './edit';
import { serverLayout } from './ServersInside';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'global-commerce.json')!;
const p0 = parseProject(ex.data, catalog.items, ex.name);
const node = (p: typeof p0, id: string) => p.nodes.find((n) => n.id === id)!;

describe('세부 구성 끌어 놓기', () => {
  it('보조 항목을 놓으면 추가, 왼편으로 끌어 내면 빠짐, 주 항목을 놓으면 교체', () => {
    const n = node(p0, 'N-03');
    const extra = catalog.items.find((i) => i.role === '보조' && i.attaches_to.includes(n.layer) && !n.extras.includes(i.id))!;
    const p1 = dropItem(p0, 'N-03', extra.id);
    expect(node(p1, 'N-03').extras).toContain(extra.id);
    expect(dropItem(p1, 'N-03', extra.id)).toBe(p1);
    expect(node(dropRemove(p1, 'N-03', { kind: 'remove', what: 'extra', id: extra.id }), 'N-03').extras).toEqual(n.extras);
    const other = catalog.items.find((i) => i.role === '주' && i.attaches_to.includes(n.layer) && i.id !== n.primary)!;
    expect(node(dropItem(p0, 'N-03', other.id), 'N-03').primary).toBe(other.id);
    // 이 레이어에 안 붙는 항목은 무시
    const wrong = catalog.items.find((i) => !i.attaches_to.includes(n.layer))!;
    expect(dropItem(p0, 'N-03', wrong.id)).toBe(p0);
  });

  it('저장 기능: 권장에서 시작해 켜고 끄며, 하나만 고르는 묶음은 바꿔 끼움', () => {
    const db = p0.nodes.find((n) => n.primary && storageProfileOf(catalog.byId.get(n.primary), catalog.byId))!;
    const sp = storageProfileOf(catalog.byId.get(db.primary!), catalog.byId)!;
    const rec = selectedFeatures(sp, db).map((f) => f.id);
    const off = sp.features.find((f) => !rec.includes(f.id) && !sp.groups[f.group].one);
    if (off) {
      const on = node(setFeature(p0, db.id, off.id, true), db.id).storage_features!;
      expect(on).toEqual([...rec, off.id]);
      expect(node(setFeature(setFeature(p0, db.id, off.id, true), db.id, off.id, false), db.id).storage_features).toEqual(rec);
    }
    const [g] = Object.entries(sp.groups).find(([gg, def]) => def.one && sp.features.filter((f) => f.group === gg).length > 1) ?? [];
    if (g) {
      const [a, b] = sp.features.filter((f) => f.group === g);
      const ids = node(setFeature(setFeature(p0, db.id, a.id, true), db.id, b.id, true), db.id).storage_features!;
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(a.id);
    }
    expect(run(setFeature(p0, db.id, sp.features[0].id, true), today).error).toBeUndefined();
  });

  it('와이어프레임: 화면을 더하고 상자를 놓고 옮기고 지우며, 저장 형식 검사를 통과', () => {
    const ui = p0.nodes.find((n) => n.layer === 'ui')!.id;
    let p = addWire(p0, ui, 0, { kind: 'header', label: '상단', x: 0, y: 0, w: 1280, h: 64 });
    p = addWire(p, ui, 0, { kind: 'button', label: '주문', x: 40, y: 100, w: 120, h: 40 });
    p = addScreen(p, ui);
    p = updateWire(p, ui, 0, 'w2', { x: 200 });
    const ss = node(p, ui).wireframe!.screens;
    expect(ss.map((s) => s.name)).toEqual(['화면 1', '화면 2']);
    expect(ss[0].items.map((i) => [i.id, i.x])).toEqual([['w1', 0], ['w2', 200]]);
    const gone = dropRemove(p, ui, { kind: 'remove', what: 'wire', screen: 0, id: 'w1' });
    expect(node(gone, ui).wireframe!.screens[0].items.map((i) => i.id)).toEqual(['w2']);
    expect(node(parseProject(gone, catalog.items, 'x'), ui).wireframe).toEqual(node(gone, ui).wireframe);
  });

  it('로컬 exe는 서버 대수 대신 기기 1대의 메모리 점유', () => {
    const p = { ...p0, deploy: { ...p0.deploy, mode: 'local_exe' as const, device_spec: { memGb: 8 }, memory: { runtime_mb: 400, eager_mb: [], lazy_mb: [] } } };
    const s = serverLayout(p, run(p, today).analysis, catalog.byId, 'N-03');
    expect(s.local).toBe(true);
    expect(s.count).toBe(1);
    expect(s.memoryMb).toBe(400);
    expect(s.util).toBeCloseTo(400 / 8000);
  });
});
