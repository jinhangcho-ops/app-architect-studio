import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INDUSTRIES, mixShares, type IndustryId } from '../industry';
import { loadCatalog, loadProject } from '../io';
import type { Project } from '../schema';
import { dayCurve, traffic } from '../traffic';

const catalog = loadCatalog(fileURLToPath(new URL('../../data/catalog', import.meta.url)));
const example = loadProject(fileURLToPath(new URL('../../examples/phase2.json', import.meta.url)), catalog.items);
// 모든 페르소나를 기준 나라(KR)에 두어 곡선 시각 = 현지 시각
const kr = (industry?: IndustryId): Project => ({
  ...example,
  scale: { ...example.scale!, report_country: 'KR', industry },
  personas: example.personas.map((ps) => ({ ...ps, country: 'KR', utc_offset: undefined })),
});
/** 곡선(5분 칸)의 봉우리 시각들: 앞뒤 1시간 중 가장 높고, 1시간 전·후보다 높은 칸 (밤의 평평한 바닥은 빼고) */
const peaks = (rps: number[]) => rps.flatMap((v, j) => {
  const near = Array.from({ length: 25 }, (_, k) => rps[(j + k - 12 + rps.length) % rps.length]);
  return v === Math.max(...near) && v > near[0] && v > near[24] ? [(j * 5 + 2.5) / 60] : [];
});

describe('업종별 피크 시각', () => {
  it('외식·배달은 점심과 저녁 두 봉우리, 저녁이 더 높음', () => {
    const c = dayCurve(kr('restaurant'))!;
    const at = peaks(c.total);
    expect(at).toHaveLength(2);
    expect(Math.abs(at[0] - 12)).toBeLessThan(0.5);
    expect(Math.abs(at[1] - 18.5)).toBeLessThan(0.5);
    expect(c.total[Math.round((18.5 * 60) / 5)]).toBeGreaterThan(c.total[Math.round((12 * 60) / 5)]);
  });

  it('업종이 없으면 예전처럼 창 가운데 한 봉우리', () => {
    expect(peaks(dayCurve(kr())!.total)).toHaveLength(1);
  });

  it('창 안 비율은 업종을 정해도 window_share에 맞음 (자정을 넘는 창 포함)', () => {
    for (const id of ['restaurant', 'live_game', 'video'] as const) {
      const t = traffic(kr(id))!;
      expect(Math.abs(t.inWindowShare.value - example.scale!.window_share), id).toBeLessThan(0.01);
    }
  });

  it('창 안 비율을 고르게 퍼질 때보다 낮게 잡아도 맞음 (긴 창의 여러 피크도 창 반대편으로)', () => {
    for (const id of ['commute', 'shopping', 'live_game'] as const) {
      const p = kr(id);
      const t = traffic({ ...p, scale: { ...p.scale!, window_share: 0.5 } })!;
      expect(Math.abs(t.inWindowShare.value - 0.5), id).toBeLessThan(0.02);
    }
  });

  it('라이브 게임의 무작위 하루도 가장 붐비는 시각이 21시대', () => {
    const t = traffic(kr('live_game'))!;
    expect(t.hourlyRps.indexOf(Math.max(...t.hourlyRps))).toBe(21);
  });

  it('업종 표의 값이 말이 됨: 피크가 창 안, 몫이 양수', () => {
    for (const [id, ind] of Object.entries(INDUSTRIES)) {
      const [a, b] = ind.window;
      const span = (b - a + 24) % 24 || 24;
      for (const k of ind.peaks) {
        expect((k.at - a + 24) % 24, id).toBeLessThan(span);
        expect(k.weight * k.sd, id).toBeGreaterThan(0);
      }
    }
  });
});

describe('직접 정한 하루 모양 (scale.day)', () => {
  it('업종 표와 같은 값을 넣으면 결과도 같고, 피크를 옮기면 곡선의 봉우리도 옮겨 감', () => {
    const ind = INDUSTRIES.restaurant;
    const same = kr('restaurant');
    const custom = { ...same, scale: { ...same.scale!, day: { window: ind.window, peaks: ind.peaks } } };
    expect(dayCurve(custom)!.total).toEqual(dayCurve(same)!.total);
    const moved = { ...same, scale: { ...same.scale!, day: { window: ind.window, peaks: [{ at: 15, sd: 1, weight: 1 }] } } };
    const at = peaks(dayCurve(moved)!.total);
    expect(at).toHaveLength(1);
    expect(Math.abs(at[0] - 15)).toBeLessThan(0.5);
  });
});

describe('페르소나 분포 → 비율', () => {
  it('정수 %이고 합이 100, 봉우리 쪽 칸이 가장 큼', () => {
    for (const n of [1, 3, 7, 9]) {
      for (const ind of Object.values(INDUSTRIES)) {
        const pct = mixShares(ind.mix, n);
        expect(pct.reduce((s, x) => s + x, 0)).toBe(100);
        expect(pct.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
      }
    }
    const one = mixShares([{ mu: 0.1, sg: 0.08, w: 1 }], 7);
    expect(one.indexOf(Math.max(...one))).toBe(0);
    expect(mixShares([{ mu: 0.9, sg: 0.08, w: 1 }], 7).indexOf(Math.max(...mixShares([{ mu: 0.9, sg: 0.08, w: 1 }], 7)))).toBe(6);
  });
});
