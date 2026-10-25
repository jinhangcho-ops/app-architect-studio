// 8절 확장성: 부하가 지금의 몇 배가 되면 노드의 항목이 '안 됨'이 되는지 이분 탐색으로 찾는다.
// 부하 변수는 사용자 수에 비례하므로 한계 사용자 = 현재 사용자 × 배수다.
import type { Vars } from './expr';
import { failsWith, type Scenario } from './judge';
import { itemIds, type CatalogItem, type ProjectNode } from './schema';

// db_connections처럼 부하에 비례하지 않는 값은 at(배수)로 그 배수에서 다시 계산해 받는다
const LOAD_VARS = ['peak_rps', 'peak_write_rps', 'primary_rps'] as const;
const MAX_FACTOR = 1e6;

const scaled = (vars: Vars, f: number): Vars => {
  const out = { ...vars };
  for (const k of LOAD_VARS) if (typeof out[k] === 'number') out[k] = (out[k] as number) * f;
  return out;
};

/**
 * 이벤트 피크 기준으로 '안 됨'이 되기 직전의 배수. 부하와 무관하게 이미 안 되면 0,
 * 1,000,000배까지 버티거나 부하 변수가 없으면 undefined(한계 없음).
 */
export function limitFactor(node: ProjectNode, catalog: Map<string, CatalogItem>, s: Scenario, at?: (f: number) => Vars): number | undefined {
  const items = itemIds(node).map((id) => catalog.get(id)!);
  const tests = items.map((it) => failsWith(it, node));
  if (!items.length || !LOAD_VARS.some((k) => typeof s.event[k] === 'number')) return undefined;
  const fails = (f: number) => {
    const ev = { ...scaled(s.event, f), ...at?.(f) };
    return tests.some((t) => t(ev));
  };
  if (fails(0)) return 0;
  let hi = 1;
  while (!fails(hi)) {
    hi *= 2;
    if (hi > MAX_FACTOR) return undefined;
  }
  let lo = hi === 1 ? 0 : hi / 2; // 여기서 fails(lo)는 거짓, fails(hi)는 참
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fails(mid)) hi = mid; else lo = mid;
  }
  return lo;
}
