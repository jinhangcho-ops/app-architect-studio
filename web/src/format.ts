import type { Metric } from '../../engine/model';

/** 큰 수는 쉼표, 작은 수는 소수 둘째 자리까지 */
export const fmt = (v: number) =>
  !Number.isFinite(v) ? '∞' : Math.abs(v) >= 100 ? Math.round(v).toLocaleString('ko-KR') : String(Math.round(v * 100) / 100);

export const fmtMetric = (m?: Metric) =>
  !m ? '—' : m.unit === '비율' ? `${(m.value * 100).toFixed(m.value > 0.99 ? 2 : 1)}%` : `${fmt(m.value)} ${m.unit}`;

/** 숫자에 마우스를 올리면 공식과 입력값이 보이게 한다 (설계서 '숫자마다 출처') */
export const howMetric = (m?: Metric) =>
  !m ? '' : `${m.formula}\n${Object.entries(m.inputs).map(([k, v]) => `${k} = ${fmt(v)}`).join('\n')}${m.basis ? `\n기준값: ${m.basis}` : ''}`;
