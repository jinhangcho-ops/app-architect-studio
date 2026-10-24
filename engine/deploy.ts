// 16절 구동 방식: 어떤 계산을 켤지, 모든 노드가 공통으로 받는 판정 변수, 로컬 메모리 추정.
import type { Vars } from './expr';
import type { Metric } from './model';
import type { Deploy } from './schema';

export type Calc = 'traffic' | 'scale' | 'cost' | 'latency' | 'availability' | 'localMemory';

const SERVER: Calc[] = ['traffic', 'scale', 'cost', 'latency', 'availability'];
const ENABLED: Record<Deploy['mode'], Calc[]> = {
  local_exe: ['localMemory'],
  web: SERVER,
  server: SERVER,
  mobile: [...SERVER, 'localMemory'],
  // 하이브리드: PC 쪽은 exe 기준, 동기화 서버는 웹 기준
  hybrid: [...SERVER, 'localMemory'],
};

export const enabled = (d: Deploy, c: Calc) => ENABLED[d.mode].includes(c);

/** 화면·설계서에 쓰는 이름 */
export const MODE_NAMES: Record<Deploy['mode'], string> = { web: '웹 (브라우저 + 서버)', mobile: '모바일 앱', local_exe: '로컬 데스크톱(exe)', hybrid: '하이브리드 (로컬 + 동기화)', server: '서버 전용' };
export const SCOPE_NAMES: Record<Deploy['scope'], string> = { single: '혼자', team: '팀·사내', public: '공개 서비스' };

export const deployVars = (d: Deploy): Vars => ({
  deploy_mode: d.mode,
  offline_required: d.offline_required,
  single_user: d.scope === 'single',
});

/** 지연 로딩한 라이브러리는 동시에 올라가는 것 중 가장 큰 하나만 더한다. */
export function localMemoryMb(p: { runtime_mb: number; eager_mb?: number[]; lazy_mb?: number[]; cache_mb?: number }): Metric {
  const eager = (p.eager_mb ?? []).reduce((s, x) => s + x, 0);
  const lazy = Math.max(0, ...(p.lazy_mb ?? []));
  const cache = p.cache_mb ?? 0;
  return {
    value: p.runtime_mb + eager + lazy + cache,
    unit: 'MB',
    formula: '런타임 기본 + Σ 상시 로드 + max 지연 로드 + 데이터 캐시',
    inputs: { 런타임: p.runtime_mb, 상시로드합: eager, 지연로드최대: lazy, 캐시: cache },
  };
}
