import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FORMAT_VERSION, migrate, parseProject } from '../../engine/data';
import { saveToFolder, snapshotFromFile } from './autosave';
import { catalog, examples } from './data';
import { stamp, stampTime, type DesktopApi } from './desktop';
import { exportProject, importProject } from './store';

const require = createRequire(import.meta.url);
const files = require('../../electron/files.cjs') as {
  allow: (f: string) => string;
  writeSnapshot: (f: string, kind: string, name: string, text: string, max: number) => boolean;
  listSnapshots: (f: string, kind: string) => { name: string; text: string }[];
  writePngs: (dir: string, files: { name: string; base64: string }[]) => string[];
  pngName: (name: string) => string;
  pngNames: (files: { name: string }[]) => string[];
  writeAtomic: (target: string, data: string | Buffer) => void;
  writeTexts: (dir: string, files: { name: string; text: string }[]) => string[];
  existingTexts: (dir: string, files: { name: string; text: string }[]) => string[];
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
    expect(readdirSync(join(dir, '.saves', basename(project)))).toHaveLength(20);
    const list = files.listSnapshots(project, 'manual');
    expect(list.map((x) => x.name).slice(0, 2)).toEqual(['2026-10-24_03-00-22', '2026-10-24_03-00-21']);
    expect(list.at(-1)!.name).toBe('2026-10-24_03-00-03');
    expect(files.listSnapshots(project, 'auto')).toEqual([]);
  });

  it('같은 폴더의 다른 프로젝트는 저장 기록을 따로 씀 (감사 13)', () => {
    const a = join(dir, 'a.aas.json'), b = join(dir, 'b.aas.json');
    writeFileSync(a, '{}'); writeFileSync(b, '{}');
    files.allow(a); files.allow(b);
    for (let i = 0; i < 3; i++) files.writeSnapshot(a, 'manual', `2026-10-27_01-00-0${i}`, '{"p":"A"}', 20);
    for (let i = 0; i < 25; i++) files.writeSnapshot(b, 'manual', `2026-10-27_02-00-${String(i).padStart(2, '0')}`, '{"p":"B"}', 20);
    expect(files.listSnapshots(a, 'manual').map((x) => JSON.parse(x.text).p)).toEqual(['A', 'A', 'A']);
    expect(files.listSnapshots(b, 'manual')).toHaveLength(20);
  });

  it('예전(v1.2.0) 위치 .saves/*.json 기록도 보임 (리뷰 14)', () => {
    const d = mkdtempSync(join(tmpdir(), 'aas-old-'));
    const f = join(d, 'old.aas.json');
    writeFileSync(f, '{}'); files.allow(f);
    mkdirSync(join(d, '.saves'));
    writeFileSync(join(d, '.saves', '2026-01-01_00-00-00.json'), '{"p":"old"}');
    // 예전 공용 폴더는 다른 프로젝트 것일 수 있어 legacy 표시 (복구해도 이 파일에 덮어쓰지 않게, 감사 14)
    expect(files.listSnapshots(f, 'manual').map((x) => [x.name, (x as { legacy?: boolean }).legacy])).toEqual([['2026-01-01_00-00-00', true]]);
    files.writeSnapshot(f, 'manual', '2026-10-27_00-00-00', '{}', 20);
    expect(files.listSnapshots(f, 'manual').map((x) => [x.name, (x as { legacy?: boolean }).legacy])).toEqual([['2026-10-27_00-00-00', undefined]]);
    rmSync(d, { recursive: true, force: true });
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

describe('직접 저장 (saveToFolder)', () => {
  const p = parseProject(examples.find((e) => e.name === 'phase3.json')!.data, catalog.items);
  // 데스크톱 API 흉내: 프로젝트 파일은 저장되고 .saves 시점 쓰기만 실패
  const api = (snap: () => Promise<boolean>) => ({ saveFile: async (f: string | undefined) => f ?? 'C:/새.aas.json', writeSnapshot: snap }) as unknown as DesktopApi;
  it('시점 쓰기만 실패해도 저장한 경로는 돌려주고 시점 실패만 알림', async () => {
    expect(await saveToFolder('C:/a.aas.json', p, {}, api(() => Promise.reject(new Error('디스크'))))).toEqual({ path: 'C:/a.aas.json', snapshot: false });
    expect(await saveToFolder(undefined, p, {}, api(async () => true))).toEqual({ path: 'C:/새.aas.json', snapshot: true });
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

describe('와이어프레임 PNG 쓰기', () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex').toString('base64');
  it('경로 문자를 빼고, 같은 이름은 번호를 붙여 고른 폴더에만 씀', () => {
    expect(files.pngName('../a/b:c')).toBe('_a_b_c.png');
    expect(files.pngName('')).toBe('화면.png');
    const out = files.writePngs(dir, [{ name: '웹 화면-화면 1', base64: png }, { name: '웹 화면-화면 1', base64: png }]);
    expect(out.map((p) => basename(p))).toEqual(['웹 화면-화면 1.png', '웹 화면-화면 1 2.png']);
    expect(readdirSync(dir)).toEqual(expect.arrayContaining(['웹 화면-화면 1.png', '웹 화면-화면 1 2.png']));
  });
  it('120자 넘는 같은 이름·대소문자만 다른 이름도 끝나고 겹치지 않음 (감사 12)', () => {
    const long = '가'.repeat(150);
    const names = files.pngNames([{ name: long }, { name: long }, { name: long }, { name: 'web-Home' }, { name: 'web-home' }]);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(5);
    expect(names[4]).toBe('web-home 2.png');
  });
  it('BOM이 붙은 시점 파일도 열림 (감사 12)', () => {
    const p = join(dir, 'bom.aas.json');
    writeFileSync(p, '{}');
    files.allow(p);
    files.writeSnapshot(p, 'auto', '2026-10-27_10-00-00', '\uFEFF{"a":1}', 5);
    expect(JSON.parse(files.listSnapshots(p, 'auto')[0].text)).toEqual({ a: 1 });
  });
  it('PNG가 아닌 내용은 쓰지 않음', () => {
    expect(() => files.writePngs(dir, [{ name: 'x', base64: Buffer.from('hello').toString('base64') }])).toThrow('PNG');
  });
});

describe('원자적 저장 (electron/files.cjs writeAtomic)', () => {
  it('새 내용으로 바꾸고 임시 파일을 남기지 않음', () => {
    const f = join(dir, '원자.json');
    writeFileSync(f, '옛 내용');
    const before = statSync(f).ino;
    files.writeAtomic(f, '새 내용');
    expect(readFileSync(f, 'utf8')).toBe('새 내용');
    // 원본을 덮어쓰지 않고 새로 쓴 파일로 바꿨다 (덮어쓰면 같은 파일 번호가 남는다)
    expect(statSync(f).ino).not.toBe(before);
    expect(readdirSync(dir).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });

  it('바꾸기에 실패하면 원본은 그대로, 임시 파일은 지움', () => {
    // 대상이 비어 있지 않은 폴더라 이름 바꾸기가 실패한다
    const target = join(dir, '폴더.json');
    mkdirSync(target);
    writeFileSync(join(target, '안.txt'), '원본');
    expect(() => files.writeAtomic(target, '덮어쓰기')).toThrow();
    expect(readFileSync(join(target, '안.txt'), 'utf8')).toBe('원본');
    expect(readdirSync(dir).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });
});

describe('파일 형식 버전·마이그레이션', () => {
  const p = parseProject(examples.find((e) => e.name === 'phase3.json')!.data, catalog.items);

  it('저장 파일에 형식 버전을 넣고, 다시 열면 같은 프로젝트', () => {
    const saved = JSON.parse(JSON.stringify(exportProject(p, {})));
    expect(saved.format_version).toBe(FORMAT_VERSION);
    expect(importProject(saved, 'x').project).toEqual(p);
  });

  it('버전이 없는 옛 파일은 1로 보고 그대로 엶', () => {
    expect(importProject(JSON.parse(JSON.stringify(p)), 'x').project).toEqual(p);
  });

  it('이 앱보다 새 형식이면 열지 않음 (모르는 값이 버려져 다시 저장할 때 사라지므로)', () => {
    expect(() => importProject({ ...JSON.parse(JSON.stringify(p)), format_version: FORMAT_VERSION + 1 }, 'x')).toThrow('더 새 버전');
    expect(() => importProject({ ...JSON.parse(JSON.stringify(p)), format_version: 'a' }, 'x')).toThrow('올바르지 않습니다');
  });

  it('낮은 버전은 변환을 차례로 적용', () => {
    const steps = { 1: (d: Record<string, unknown>) => ({ ...d, b: d.a }), 2: (d: Record<string, unknown>) => ({ ...d, c: 1 }) };
    expect(migrate({ a: 5 }, 'x', 3, steps)).toEqual({ a: 5, b: 5, c: 1 });
    expect(migrate({ a: 5, format_version: 2 }, 'x', 3, steps)).toEqual({ a: 5, c: 1 });
    expect(() => migrate({}, 'x', 3, { 1: steps[1] })).toThrow('2 → 3 변환이 없습니다');
  });
});

describe('명세 파일 저장 (writeTexts)', () => {
  it('.json·.proto와 영문 이름만 받고, 경로 문자는 막음', () => {
    const [f] = files.writeTexts(dir, [{ name: 'N_09.proto', text: 'syntax = "proto3";' }]);
    expect(readFileSync(f, 'utf8')).toBe('syntax = "proto3";');
    expect(() => files.writeTexts(dir, [{ name: '../밖.json', text: '{}' }])).toThrow('이름 형식');
    expect(() => files.writeTexts(dir, [{ name: 'a.exe', text: '' }])).toThrow('이름 형식');
  });

  it('고른 폴더에 이미 있는 파일 이름을 찾음 (덮어쓰기 전에 묻게)', () => {
    const sub = join(dir, 'texts'); mkdirSync(sub);
    writeFileSync(join(sub, 'a.sql'), '');
    expect(files.existingTexts(sub, [{ name: 'a.sql', text: '' }, { name: 'b.sql', text: '' }])).toEqual(['a.sql']);
  });
});
