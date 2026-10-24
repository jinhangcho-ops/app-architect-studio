// 엔진 전체가 쓰는 공통 타입. 파일에서 읽는 구조(카탈로그·프로젝트)는 schema.ts의 zod 스키마에서 타입을 뽑는다.
export type Basis = '실측' | '사양보정' | '업계';

/** 계산한 숫자는 모두 이 형태로 돌려준다: 값과 함께 어떻게 나왔는지를 남긴다. */
export type Metric = {
  value: number;
  unit: string;
  formula: string;
  inputs: Record<string, number>;
  basis?: Basis;
};

/** Metric 만들기 (basis 없이) */
export const metric = (value: number, unit: string, formula: string, inputs: Record<string, number>): Metric => ({ value, unit, formula, inputs });

export type Verdict = 'ok' | 'conditional' | 'fail' | 'unknown';

export const LAYERS = ['ui', 'gateway', 'backend', 'cache', 'queue', 'batch', 'db', 'external', 'analytics'] as const;
export type Layer = (typeof LAYERS)[number];

export const LAYER_NAMES: Record<Layer, string> = {
  ui: '화면/클라이언트',
  gateway: '게이트웨이/로드밸런서',
  backend: '백엔드 서비스',
  cache: '캐시',
  queue: '메시지큐',
  batch: '배치/워커',
  db: '데이터베이스',
  external: '외부 연동',
  analytics: '분석/DW',
};

/** v2의 6계층 깊이. 역방향 호출 판정(하위 → 상위)에 쓴다. */
export const LAYER_TIER: Record<Layer, number> = {
  ui: 1, gateway: 2, backend: 3, cache: 3, queue: 4, batch: 4, db: 5, external: 5, analytics: 6,
};

export const VERDICT_NAMES: Record<Verdict, string> = {
  ok: '✅ 됨',
  conditional: '⚠️ 조건부',
  fail: '❌ 안 됨',
  unknown: '❔ 판단 불가',
};
