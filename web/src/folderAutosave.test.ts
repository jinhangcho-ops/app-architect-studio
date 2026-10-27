// 폴더 자동 저장(.autosave/): 같은 파일의 예전 시점을 복구한 뒤에는 최신 시점을 덮지 않고 새 시점으로 (감사 7)
import { afterEach, expect, it, vi } from 'vitest';
import { useStore } from './store';

afterEach(() => { vi.useRealTimers(); delete (globalThis as { desktop?: unknown }).desktop; vi.resetModules(); });

it('복구(startNewSnapshot) 뒤 폴더 자동 저장은 새 이름으로 쓴다', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-27T10:00:00') });
  const writes: { name: string; project: string }[] = [];
  (globalThis as { desktop?: unknown }).desktop = { writeSnapshot: async (_f: string, _k: string, name: string, text: string) => { writes.push({ name, project: JSON.parse(text).name }); return true; } };
  vi.resetModules();
  const A = await import('./autosave');
  const p = useStore.getState().project;
  A.scheduleFolderAutosave('C:/x/p.aas.json', { ...p, name: '최신 작업' }, {});
  await vi.advanceTimersByTimeAsync(5000);
  vi.setSystemTime(new Date('2026-10-27T10:03:00'));
  A.startNewSnapshot();
  A.scheduleFolderAutosave('C:/x/p.aas.json', { ...p, name: '복구한 예전 시점' }, {});
  await vi.advanceTimersByTimeAsync(5000);
  expect(writes.map((w) => w.project)).toEqual(['최신 작업', '복구한 예전 시점']);
  expect(writes[0].name).not.toBe(writes[1].name);
});

it('감사 14: 창을 닫을 때(flushAutosave) 기다리던 자동 저장을 바로 씀', async () => {
  const writes: string[] = [];
  (globalThis as { desktop?: unknown }).desktop = { writeSnapshot: async (_f: string, _k: string, _n: string, text: string) => { writes.push(JSON.parse(text).name); return true; } };
  vi.resetModules();
  const A = await import('./autosave');
  const data = new Map<string, string>();
  const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as unknown as Storage;
  const p = useStore.getState().project;
  A.scheduleAutosave({ ...p, name: '닫기 직전' }, {}, undefined, store);
  A.scheduleFolderAutosave('C:/x/p.aas.json', { ...p, name: '닫기 직전' }, {});
  A.flushAutosave();
  expect(A.readAutosaves(store).map((x) => x.project.name)).toEqual(['닫기 직전']);
  expect(writes).toEqual(['닫기 직전']);
});

it('감사 14: 브라우저 저장소가 꽉 차면 직접 저장보다 자동 저장을 먼저 줄임', async () => {
  vi.resetModules();
  const A = await import('./autosave');
  // 크기 한도가 있는 저장소
  const data = new Map<string, string>();
  const size = () => [...data.values()].reduce((s, v) => s + v.length, 0);
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { const old = data.get(k)?.length ?? 0; if (size() - old + v.length > LIMIT) throw new Error('full'); data.set(k, v); },
  } as unknown as Storage;
  const p = { ...useStore.getState().project, nodes: [], edges: [] };
  let LIMIT = Infinity;
  A.writeAutosave(p, {}, store);
  const one = size();
  data.clear();
  LIMIT = one * 11.5; // 자동 저장 10개 + 직접 저장 1개까지만 들어감
  for (let i = 0; i < 10; i++) { A.startNewSnapshot(); A.writeAutosave({ ...p, name: `자동${i}` }, {}, store); }
  for (let i = 0; i < 3; i++) expect(A.writeManualSave({ ...p, name: `직접${i}` }, {}, store)).toBe(0);
  expect(A.readManualSaves(store)).toHaveLength(3);
  expect(A.readAutosaves(store).length).toBeLessThan(10);
});
