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
