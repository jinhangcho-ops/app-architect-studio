import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const data = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
const p = loadProject(root('examples/global-commerce.json'), catalog.items);
const a = analyze(p, data, '2026-10-23');

/** 결과 안의 모든 Metric(값·단위가 있는 객체)을 찾는다 */
function metrics(x: unknown, path = ''): [string, Record<string, unknown>][] {
  if (!x || typeof x !== 'object') return [];
  const o = x as Record<string, unknown>;
  const self: [string, Record<string, unknown>][] = 'value' in o && 'unit' in o ? [[path, o]] : [];
  return [...self, ...Object.entries(o).flatMap(([k, v]) => metrics(v, `${path}.${k}`))];
}

describe('관문: 샘플 프로젝트(글로벌 커머스 N-02~N-10)', () => {
  it('샘플의 모든 숫자에 계산 출처(공식)가 있음', () => {
    const all = metrics(a);
    expect(all.length).toBeGreaterThan(30);
    for (const [path, m] of all) expect(typeof m.formula === 'string' && m.formula.length > 0, path).toBe(true);
  });

  it('고정 PASS가 없고, 모든 노드가 판정을 받음', () => {
    expect(a.judgements).toHaveLength(p.nodes.length);
    expect(a.judgements.every((j) => j.items.length > 0)).toBe(true);
  });

  it('규정 검사: 도쿄 리전 원장 DB(한국 사용자) → 제28조의8, 외부 전송 허브 → 제17조, 일본 사용자 데이터를 서울에 둔 레이크하우스 → 第28条', () => {
    const has = (node: string, art: string) => a.regulation.some((h) => h.nodeId === node && h.article === art);
    expect(has('N-06', '제28조의8')).toBe(true);
    expect(has('N-07', '제17조')).toBe(true);
    expect(has('N-10', '第28条')).toBe(true);
  });

  it('해외 사용자(미국·유럽)는 각자 표준시로 들어와 한국 기준 피크가 하나로 몰리지 않음', () => {
    const t = a.traffic!;
    const sorted = [...t.hourlyRps].sort((x, y) => y - x);
    expect(sorted[0] / sorted[3]).toBeLessThan(1.5);
  });
});
