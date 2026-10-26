import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const u = require('../../electron/update.cjs') as {
  compareVersions: (a: string, b: string) => number;
  checkUpdate: (current: string, fetchImpl: (url: string, init?: unknown) => Promise<{ ok: boolean; json: () => Promise<unknown> }>) => Promise<{ current: string; version: string; url: string } | null>;
  RELEASES: string;
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
