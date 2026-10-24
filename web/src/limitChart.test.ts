import { describe, expect, it } from 'vitest';
import { adoption } from '../../engine/adoption';
import { parseProject } from '../../engine/data';
import { dayCurve, patternOf, perSession } from '../../engine/traffic';
import { catalog, examples } from './data';
import { run } from './edit';
import { dayUtilization, p99Series } from './Overview';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'phase3.json')!;
const p = parseProject(ex.data, catalog.items, ex.name);
const a = run(p, today).analysis!;
const users = p.scale!.users;
const expectedDaily = (q: typeof p) => q.personas.reduce((s, ps) => s + Math.round(q.scale!.users * ps.share) * patternOf(ps).sessions_per_day * perSession(q, ps).reqPer, 0);

describe('하루 기대 트래픽 (5분 칸)', () => {
  const c = dayCurve(p, 5)!;
  it('하루 합 = 페르소나별 사람 × 접속 × 접속당 요청, 무작위 하루와도 거의 같음', () => {
    const daily = c.total.reduce((s, r) => s + r * 300, 0);
    expect(daily).toBeCloseTo(expectedDaily(p), -1);
    expect(Math.abs(daily - a.traffic!.dailyRequests.value) / daily).toBeLessThan(0.02);
  });
  // 페르소나 접속 창의 끝에서 분포가 잘려(무작위 하루와 같은 가정) 작은 턱이 생기므로 8%까지 둔다
  it('계산 결과가 부드러움: 이웃한 5분 칸 사이 변화가 피크의 8% 안', () => {
    const peak = Math.max(...c.total);
    const jumps = c.total.map((r, j) => Math.abs(r - c.total[(j + 1) % c.total.length]) / peak);
    expect(Math.max(...jumps)).toBeLessThan(0.08);
  });
  it('최신화 주기가 짧을수록 요청이 늘고, 모아 보내면 쓰기 요청이 줌', () => {
    const poll = { ...p, exchange: { receive: 'polling' as const, refresh_s: 30, send: 'realtime' as const, batch_s: 60 } };
    const batch = { ...p, exchange: { receive: 'polling' as const, send: 'batch' as const, batch_s: 600 } };
    expect(expectedDaily(poll)).toBeGreaterThan(expectedDaily(p) * 1.2);
    const ps = p.personas[0];
    expect(perSession(batch, ps).writePer).toBeLessThan(perSession(p, ps).writePer);
    expect(run(poll, today).analysis!.traffic!.peakRps.value).toBeGreaterThan(a.traffic!.peakRps.value);
  });
});

describe('하루 서버 사용률', () => {
  it('곡선의 피크는 엔진의 평소 피크 사용률 근처 (5분 평균이라 1시간 평균보다 조금 높을 수 있음)', () => {
    const lines = dayUtilization(p, a, catalog.byId, dayCurve(p, 5)!.total);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const peak = Math.max(...l.pts.map(([, v]) => v));
      const want = a.nodes[l.id].utilization!.normal.value;
      expect(peak / want).toBeGreaterThan(0.9);
      expect(peak / want).toBeLessThan(1.3);
    }
  });
});

describe('유입 모형', () => {
  const inflow = { market: users * 10, external: 0.01, word_of_mouth: 0.4, entry: p.personas.find((x) => x.pattern === 'occasional')!.name, up: 0.05, down: 0.03, leave: 0.1 };
  const q = { ...p, growth: { ...p.growth!, inflow } };
  const curve = adoption(q, 60)!;
  it('입소문이 써 본 사람에 비례해 커져 S자: 새 사용자가 늘다가 시장이 차면 줄어듦', () => {
    const fresh = curve.slice(1).map((m) => m.external + m.wordOfMouth);
    const peakAt = fresh.indexOf(Math.max(...fresh));
    expect(peakAt).toBeGreaterThan(0);
    expect(peakAt).toBeLessThan(fresh.length - 1);
    expect(curve[1].wordOfMouth).toBeGreaterThan(curve[1].external);
  });
  it('사람 수는 들어온 사람 − 떠난 사람과 맞음', () => {
    const last = curve.at(-1)!;
    const came = curve.reduce((s, m) => s + m.external + m.wordOfMouth, 0);
    expect(last.active).toBeCloseTo(users + came - last.left, 3);
  });
  it('성장 타임라인이 유입 곡선을 따름 (월 성장률과 다른 달)', () => {
    const g = run(q, today).analysis!.growth!;
    expect(g.adoption!.length).toBe(p.growth!.months + 1);
    const first = g.milestones[0];
    if (first.month !== undefined) expect(curve[first.month].equivalent).toBeGreaterThanOrEqual(first.limitUsers);
  });
});

describe('p99', () => {
  it('지금 사용자 수에서는 엔진의 이벤트 피크 p99와 같고, 갈수록 가파르게 오름', () => {
    for (const l of p99Series(p, a, catalog.byId, [users])) expect(l.pts[0][1]).toBeCloseTo(a.nodes[l.id].p99!.event.value, 6);
    const xs = Array.from({ length: 400 }, (_, i) => (users * 20 * (i + 1)) / 400);
    const curved = p99Series(p, a, catalog.byId, xs).some((l) => {
      const f = l.pts.filter(([, v]) => Number.isFinite(v));
      const slope = (i: number) => (f[i + 1][1] - f[i][1]) / (f[i + 1][0] - f[i][0]);
      return f.length > 10 && slope(f.length - 2) > slope(0) * 1.5;
    });
    expect(curved).toBe(true);
  });
});
