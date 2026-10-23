import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { snapshotFromFile } from './autosave';
import { catalog, examples } from './data';
import { stamp, stampTime } from './desktop';
import { exportProject } from './store';

const require = createRequire(import.meta.url);
const files = require('../../electron/files.cjs') as {
  allow: (f: string) => string;
  writeSnapshot: (f: string, kind: string, name: string, text: string, max: number) => boolean;
  listSnapshots: (f: string, kind: string) => { name: string; text: string }[];
};

const dir = mkdtempSync(join(tmpdir(), 'aas-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const project = join(dir, '설계.aas.json');
writeFileSync(project, '{}');

describe('데스크톱 앱 폴더 저장 (electron/files.cjs)', () => {
  it('열기·저장 창에서 고른 파일이 아니면 쓰지 않음', () => {
    expect(() => files.writeSnapshot(join(dir, '다른.json'), 'manual', '2026-10-24_03-00-00', '{}', 20)).toThrow('고른 파일이 아닙니다');
  });

  it('.saves에 시점 파일을 쓰고, max개를 넘으면 가장 오래된 것부터 지움, 목록은 최신이 앞', () => {
    files.allow(project);
    for (let i = 0; i < 23; i++) files.writeSnapshot(project, 'manual', `2026-10-24_03-00-${String(i).padStart(2, '0')}`, `{"i":${i}}`, 20);
    expect(readdirSync(join(dir, '.saves'))).toHaveLength(20);
    const list = files.listSnapshots(project, 'manual');
    expect(list.map((x) => x.name).slice(0, 2)).toEqual(['2026-10-24_03-00-22', '2026-10-24_03-00-21']);
    expect(list.at(-1)!.name).toBe('2026-10-24_03-00-03');
    expect(files.listSnapshots(project, 'auto')).toEqual([]);
  });

  it('같은 이름이면 덮어씀 (자동 저장이 간격 안에서 같은 시점을 고칠 때)', () => {
    files.writeSnapshot(project, 'auto', '2026-10-24_04-00-00', 'a', 10);
    files.writeSnapshot(project, 'auto', '2026-10-24_04-00-00', 'b', 10);
    expect(files.listSnapshots(project, 'auto')).toEqual([{ name: '2026-10-24_04-00-00', text: 'b' }]);
  });

  it('경로가 섞인 이름이나 모르는 종류는 거부', () => {
    expect(() => files.writeSnapshot(project, 'manual', '../../evil', '{}', 20)).toThrow('시점 이름 형식');
    expect(() => files.writeSnapshot(project, 'secret', '2026-10-24_03-00-00', '{}', 20)).toThrow('알 수 없는 저장 종류');
  });
});

describe('시점 파일 이름과 내용', () => {
  it('이름은 현지 시각, 이름 → 시각이 되돌아옴', () => {
    const d = new Date(2026, 9, 24, 3, 5, 9);
    expect(stamp(d)).toBe('2026-10-24_03-05-09');
    expect(stampTime(stamp(d)).getTime()).toBe(d.getTime());
  });

  it('폴더 시점 파일(내보내기 JSON)을 프로젝트와 노드 위치로 되살림, 깨진 파일은 건너뜀', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    const s = snapshotFromFile('2026-10-24_03-05-09', JSON.stringify(exportProject(p, { api: { x: 1, y: 2 } })))!;
    expect(s.project).toEqual(p);
    expect(s.positions).toEqual({ api: { x: 1, y: 2 } });
    expect(snapshotFromFile('2026-10-24_03-05-09', '{깨진')).toBeUndefined();
  });
});
