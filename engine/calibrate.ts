// 5절 기준값 보정: 실측값 → 사양 보정값 → 업계 기준값 순으로 쓴다.
import type { Metric } from './model';
import type { Spec, Threshold } from './schema';

/** 값이 없는(null) 기준값은 보정할 수 없으므로 undefined를 돌려준다. */
export function calibrate(th: Threshold, spec?: Spec, measured?: number): Metric | undefined {
  if (measured !== undefined) {
    return { value: measured, unit: th.unit, formula: '실측값', inputs: { measured }, basis: '실측' };
  }
  if (th.value === null) return undefined;

  const r = th.bound_by;
  const user = r && spec?.[r];
  const base = r && th.base_spec?.[r];
  if (r && user && base) {
    const scaled = th.value * (user / base);
    const value = th.max !== undefined ? Math.min(th.max, scaled) : scaled;
    return {
      value,
      unit: th.unit,
      formula: `min(상한, 기준값 × ${r} 사양 / 기준 ${r})`,
      inputs: { 기준값: th.value, 사양: user, 기준사양: base, ...(th.max !== undefined && { 상한: th.max }) },
      basis: '사양보정',
    };
  }
  return { value: th.value, unit: th.unit, formula: '업계 기준값', inputs: { 기준값: th.value }, basis: '업계' };
}
