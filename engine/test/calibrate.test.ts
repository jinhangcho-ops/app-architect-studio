import { describe, expect, it } from 'vitest';
import { calibrate } from '../calibrate';
import type { Threshold } from '../schema';

const api: Threshold = { value: 500, unit: 'RPS', base_spec: { vcpu: 2 }, bound_by: 'vcpu', source: '예시' };

describe('기준값 보정 (설계서 5절 예시)', () => {
  it('500 RPS(2 vCPU)에 8 vCPU를 넣으면 2,000 RPS', () => {
    expect(calibrate(api, { vcpu: 8 })).toMatchObject({ value: 2000, basis: '사양보정' });
  });

  it('상한 1,500이면 1,500', () => {
    expect(calibrate({ ...api, max: 1500 }, { vcpu: 8 })).toMatchObject({ value: 1500, basis: '사양보정' });
  });

  it('실측값이 있으면 실측값이 우선', () => {
    expect(calibrate(api, { vcpu: 8 }, 730)).toMatchObject({ value: 730, basis: '실측' });
  });

  it('사양이 없거나 묶인 자원 값이 없으면 업계 기준값', () => {
    expect(calibrate(api)).toMatchObject({ value: 500, basis: '업계' });
    expect(calibrate(api, { memGb: 32 })).toMatchObject({ value: 500, basis: '업계' });
  });

  it('값이 없는(null) 기준값은 보정하지 않음', () => {
    expect(calibrate({ value: null, unit: '개', source: '확인 필요' })).toBeUndefined();
  });
});
