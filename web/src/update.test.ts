import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const u = require('../../electron/update.cjs') as {
  compareVersions: (a: string, b: string) => number;
  checkUpdate: (current: string, fetchImpl: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) => Promise<{ current: string; version: string; url: string } | null>;
  RELEASES: string;
  installUpdate: (info: unknown, deps: { fetchImpl: (url: string) => Promise<unknown>; tempDir: string; launch: (f: string) => Promise<void>; quit: () => void }) => Promise<{ ok: boolean; reason?: string; file?: string }>;
};
const reply = (body: unknown, ok = true) => async () => ({ ok, json: async () => body });

describe('새 버전 알림 (electron/update.cjs)', () => {
  it('버전 비교: 숫자 단위로, 꼬리표(-local)는 같은 번호의 정식보다 낮음', () => {
    expect(u.compareVersions('1.1.0', '1.0.1')).toBeGreaterThan(0);
    expect(u.compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(u.compareVersions('v1.1.0', '1.1.0')).toBe(0);
    expect(u.compareVersions('1.1.0', '1.1.0-local')).toBeGreaterThan(0);
    expect(u.compareVersions('1.0.9', '1.1.0-local')).toBeLessThan(0);
    expect(u.compareVersions('이상한 값', '1.0.0')).toBe(0);
  });

  it('최신 Release가 더 새로우면 알림 정보, 같거나 낮으면 없음', async () => {
    const latest = { tag_name: 'v1.2.0', html_url: `${u.RELEASES}tag/v1.2.0` };
    expect(await u.checkUpdate('1.1.0', reply(latest))).toEqual({ current: '1.1.0', version: '1.2.0', url: `${u.RELEASES}tag/v1.2.0` });
    expect(await u.checkUpdate('1.2.0', reply(latest))).toBeNull();
    expect(await u.checkUpdate('1.3.0', reply(latest))).toBeNull();
  });

  it('이 저장소 Releases 주소가 아니거나, 응답 실패·인터넷 끊김이면 알리지 않음', async () => {
    expect(await u.checkUpdate('1.0.0', reply({ tag_name: 'v9.0.0', html_url: 'https://evil.example/download' }))).toBeNull();
    expect(await u.checkUpdate('1.0.0', reply({}, false))).toBeNull();
    expect(await u.checkUpdate('1.0.0', async () => { throw new Error('offline'); })).toBeNull();
  });
});

describe('[업데이트]: 받기 → 지문 대조 → 설치 실행', () => {
  const exe = Buffer.from('MZ 가짜 설치 파일');
  const hex = createHash('sha256').update(exe).digest('hex');
  const name = 'App-Architect-Studio-Setup-1.2.0.exe';
  const dl = `${u.RELEASES}download/v1.2.0/`;
  const latest = (digest = hex) => ({
    tag_name: 'v1.2.0', html_url: `${u.RELEASES}tag/v1.2.0`,
    assets: [{ name, browser_download_url: dl + name, digest: `sha256:${digest}` }, { name: `${name}.sha256`, browser_download_url: `${dl}${name}.sha256` }],
  });
  const files = (sum: string, body = exe) => async (url: string) => ({
    ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength), text: async () => (url.endsWith('.sha256') ? `${sum}  ${name}` : ''),
  });
  const run = async (info: unknown, fetchImpl: (url: string) => Promise<unknown>) => {
    const dir = mkdtempSync(join(tmpdir(), 'aas-upd-')), launched: string[] = [];
    let quit = 0;
    const r = await u.installUpdate(info, { fetchImpl, tempDir: dir, launch: async (f) => { launched.push(f); }, quit: () => { quit++; } });
    const saved = launched[0] ? readFileSync(launched[0]) : undefined;
    rmSync(dir, { recursive: true, force: true });
    return { r, launched, quit, saved };
  };

  it('확인할 때 설치 파일·지문 주소와 GitHub 지문을 함께 받음', async () => {
    const info = await u.checkUpdate('1.1.1', reply(latest()));
    expect(info).toMatchObject({ version: '1.2.0', installer: { name, url: dl + name, sha256Url: `${dl}${name}.sha256`, digest: hex } });
  });

  it('두 지문과 맞으면 파일을 저장해 설치 프로그램을 띄우고 앱을 닫음', async () => {
    const info = await u.checkUpdate('1.1.1', reply(latest()));
    const { r, launched, quit, saved } = await run(info, files(hex));
    expect(r.ok).toBe(true);
    expect(launched[0].endsWith(name)).toBe(true);
    expect(saved).toEqual(exe);
    expect(quit).toBe(1);
  });

  it('.sha256이나 GitHub 지문이 다르면 실행하지 않음', async () => {
    const wrong = '0'.repeat(64);
    const a = await run(await u.checkUpdate('1.1.1', reply(latest())), files(wrong));
    expect(a.r).toMatchObject({ ok: false, reason: expect.stringContaining('지문') });
    expect(a.launched).toEqual([]);
    const b = await run(await u.checkUpdate('1.1.1', reply(latest(wrong))), files(hex));
    expect(b.launched).toEqual([]);
    expect(b.quit).toBe(0);
  });

  it('설치 파일이 없거나 이 저장소 주소가 아니면 받지 않음', async () => {
    const noAssets = await u.checkUpdate('1.1.1', reply({ tag_name: 'v1.2.0', html_url: `${u.RELEASES}tag/v1.2.0`, assets: [] }));
    expect(noAssets).not.toHaveProperty('installer');
    expect((await run(noAssets, files(hex))).r.ok).toBe(false);
    const evil = { installer: { name, url: 'https://evil.example/x.exe', sha256Url: 'https://evil.example/x.sha256', digest: hex } };
    let fetched = 0;
    expect((await run(evil, async () => { fetched++; return {}; })).r.ok).toBe(false);
    expect(fetched).toBe(0);
  });
});
