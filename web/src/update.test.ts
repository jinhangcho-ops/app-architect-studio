// @vitest-environment happy-dom
// 새 버전 확인·업데이트 (electron/update.cjs): 네트워크·창·설치 프로그램 없이 가짜로 확인한다
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { checkForUpdate, setUpdateCheck } from './desktop';

const require = createRequire(import.meta.url);
type Res = { ok: boolean; status: number; url: string; headers: { get: (k: string) => string | null }; arrayBuffer: () => Promise<ArrayBuffer> };
type Deps = Record<string, unknown>;
const u = require('../../electron/update.cjs') as {
  compareVersions: (a: string, b: string) => number;
  tagFromUrl: (url: string) => string | undefined;
  createUpdater: (deps: Deps) => {
    check: () => Promise<{ current: string; version: string; tag: string; notes?: string } | null>;
    installVersion: (v: string) => Promise<{ ok: boolean; reason?: string; args?: string[] }>;
    install: () => Promise<{ ok: boolean; reason?: string }>;
  };
  RELEASES: string;
  removeOldDownloads: (dir: string) => string[];
};

const res = (body: string | Buffer, status = 200, url = ''): Res => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return { ok: status < 400, status, url, headers: { get: () => null }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
};
const tmp = mkdtempSync(join(tmpdir(), 'aas-updtest-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** latestTag: releases/latest가 넘어가는 태그. files: 받는 주소 → 응답 */
function setup(o: { current?: string; latestTag?: string; notes?: string | null; files?: Record<string, Res>; packaged?: boolean; free?: number; busy?: string; exit?: number | null; offline?: boolean } = {}) {
  const calls: string[] = [], spawned: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
  let quit = 0;
  const latestUrl = async () => {
    calls.push(`${u.RELEASES}latest`);
    if (o.offline) throw new Error('getaddrinfo ENOTFOUND');
    return `${u.RELEASES}tag/${o.latestTag ?? 'v1.10.0'}`;
  };
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (o.offline) throw new Error('getaddrinfo ENOTFOUND');
    if (url.endsWith('/RELEASE_NOTES.md')) return o.notes === null ? res('Not Found', 404) : res(o.notes ?? '### 추가\n- 새 기능\n### 개선\n- 없음\n### 삭제\n- 없음');
    return o.files?.[url] ?? res('Not Found', 404);
  };
  const updater = u.createUpdater({
    latestUrl, fetchImpl, getVersion: () => o.current ?? '1.9.0', isPackaged: () => o.packaged ?? true, tempDir: () => tmp, installDir: () => 'C:\\Users\\me\\AppData\\Local\\Programs\\App Architect Studio',
    freeBytes: () => o.free ?? 10e9, busy: () => o.busy,
    spawn: (file: string, args: string[], opts: Record<string, unknown>) => {
      spawned.push({ file, args, opts });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      if (o.exit !== undefined && o.exit !== null) setTimeout(() => child.emit('exit', o.exit), 10);
      return child;
    },
    quit: () => { quit++; },
  });
  return { updater, calls, spawned, quits: () => quit };
}
const exe = Buffer.from('MZ 가짜 설치 파일');
const sha = createHash('sha256').update(exe).digest('hex');
const files = (version: string, sum: string) => {
  const base = `${u.RELEASES}download/v${version}/App-Architect-Studio-Setup-${version}.exe`;
  return { [base]: res(exe), [`${base}.sha256`]: res(sum) };
};

describe('새 버전 확인', () => {
  it('1.9.0 → 1.10.0을 찾고 노트를 함께 받음, 실행마다 한 번만 묻기', async () => {
    const { updater, calls } = setup();
    const info = await updater.check();
    expect(info).toMatchObject({ current: '1.9.0', version: '1.10.0', tag: 'v1.10.0' });
    expect(info!.notes).toContain('### 추가');
    await updater.check();
    expect(calls).toEqual([`${u.RELEASES}latest`, `${u.RELEASES}download/v1.10.0/RELEASE_NOTES.md`]);
  });

  it('새 버전인데 노트가 없으면(404) 노트 없이 알림', async () => {
    const info = await setup({ notes: null }).updater.check();
    expect(info).toMatchObject({ version: '1.10.0' });
    expect(info!.notes).toBeUndefined();
  });

  it('같거나 옛 버전, 이상한 태그면 알림 없음 · 노트도 받지 않음', async () => {
    for (const latestTag of ['v1.9.0', 'v1.8.9', 'nightly', 'v../x', 'v1.10.0-beta']) {
      const { updater, calls } = setup({ latestTag });
      expect(await updater.check(), latestTag).toBeNull();
      expect(calls.filter((c) => c.endsWith('RELEASE_NOTES.md')), latestTag).toEqual([]);
    }
    expect(u.compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(u.tagFromUrl(`${u.RELEASES}tag/v2.0.0`)).toBe('v2.0.0');
    expect(u.tagFromUrl(`${u.RELEASES}tag/v..%2Fx`)).toBeUndefined();
  });

  it('인터넷 오류면 조용히 넘어감, 개발 실행·버전 모름·0.0.0이면 묻지 않음', async () => {
    expect(await setup({ offline: true }).updater.check()).toBeNull();
    for (const o of [{ packaged: false }, { current: '1.1.0-local' }, { current: '0.0.0' }]) {
      const { updater, calls } = setup(o);
      expect(await updater.check()).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it('설정에서 끄면 아무 요청도 하지 않음 (켜면 물음)', async () => {
    let asked = 0;
    const api = { checkUpdate: async () => { asked++; return null; } };
    setUpdateCheck(false);
    await checkForUpdate(api);
    expect(asked).toBe(0);
    setUpdateCheck(true);
    await checkForUpdate(api);
    expect(asked).toBe(1);
  });
});

describe('지금 업데이트', () => {
  it('지문이 맞으면 정확한 명령줄로 조용히 설치하고 앱을 닫음', async () => {
    const { updater, spawned, quits } = setup({ files: files('1.10.0', `${sha}  App-Architect-Studio-Setup-1.10.0.exe`) });
    await updater.check();
    const r = await updater.install();
    expect(r).toMatchObject({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toMatch(/App-Architect-Studio-Setup-1\.10\.0\.exe$/);
    // NSIS: /S 조용히, --force-run 설치 뒤 다시 열기, /D=는 마지막에 따옴표 없이 (명령줄을 그대로 넘김)
    expect(spawned[0].args).toEqual(['/S', '--force-run', '/D=C:\\Users\\me\\AppData\\Local\\Programs\\App Architect Studio']);
    expect(spawned[0].opts).toMatchObject({ windowsVerbatimArguments: true, detached: true, argv0: `"${spawned[0].file}"` });
    expect(quits()).toBe(1);
  }, 10000);

  it('지문이 다르거나 지문 파일이 비면 실행하지 않고 받은 것을 지움', async () => {
    for (const sum of ['0'.repeat(64), '', '   ']) {
      const before = readdirSync(tmp).length;
      const { updater, spawned, quits } = setup({ files: files('1.10.0', sum) });
      await updater.check();
      expect((await updater.install()).ok).toBe(false);
      expect(spawned).toEqual([]);
      expect(quits()).toBe(0);
      expect(readdirSync(tmp).length).toBe(before);
    }
  });

  it('설치 프로그램이 2초 안에 실패 코드로 끝나면 앱을 닫지 않고 알림', async () => {
    const { updater, quits } = setup({ files: files('1.10.0', sha), exit: 1223 });
    await updater.check();
    const r = await updater.install();
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('1223') });
    expect(quits()).toBe(0);
  });

  it('지정 버전은 그 릴리스 주소로 받고, 잘못된 버전 글자는 받지 않음', async () => {
    const a = setup({ files: files('1.2.0', 'x') });
    await a.updater.installVersion('1.2.0');
    expect(a.calls.sort()).toEqual([`${u.RELEASES}download/v1.2.0/App-Architect-Studio-Setup-1.2.0.exe`, `${u.RELEASES}download/v1.2.0/App-Architect-Studio-Setup-1.2.0.exe.sha256`].sort());
    for (const bad of ['../1.2.0', '1.2.0;del', 'nightly', '']) {
      const b = setup();
      expect((await b.updater.installVersion(bad)).ok, bad).toBe(false);
      expect(b.calls, bad).toEqual([]);
    }
  });

  it('작업 중·공간 부족·개발 실행·버전 모름이면 받기 전에 거절', async () => {
    for (const o of [{ busy: '저장 중이에요' }, { free: 100 * 1024 * 1024 }, { packaged: false }, { current: 'abc' }]) {
      const { updater, calls, spawned } = setup(o);
      const r = await updater.installVersion('1.10.0');
      expect(r.ok, JSON.stringify(o)).toBe(false);
      expect(calls, JSON.stringify(o)).toEqual([]);
      expect(spawned).toEqual([]);
    }
    expect(existsSync(tmp)).toBe(true);
  });

  it('확인 없이 설치를 부르면 거절 (화면이 넘긴 값으로는 설치하지 않음)', async () => {
    const { updater, calls } = setup();
    expect((await updater.install()).ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('지난 업데이트 설치 파일 정리', () => {
  it('이 앱이 만든 aas-update-xxxxxx 폴더만 지움', () => {
    const dir = mkdtempSync(join(tmp, 'clean-'));
    const ours = mkdtempSync(join(dir, 'aas-update-'));
    for (const n of ['aas-update-keep-me', 'other']) mkdirSync(join(dir, n));
    expect(u.removeOldDownloads(dir)).toEqual([ours.slice(dir.length + 1)]);
    expect(readdirSync(dir).sort()).toEqual(['aas-update-keep-me', 'other']);
  });
});
