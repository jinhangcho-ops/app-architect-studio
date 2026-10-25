// 업종별 하루 접속 모양: 깨어 있는 창과 그 안의 피크들(현지 표준시). 흔한 모양을 옮긴 예시값이라 서비스에 맞게 고쳐 쓴다.
// 피크 = 그 시각(at)을 가운데로 한 정규분포(표준편차 sd시간), weight는 피크끼리의 상대 몫.
// 정규분포의 꼬리가 창 밖으로 조금 나가므로, 창 안 비율 1(100%)은 업종에 따라 0.94~0.99까지만 맞는다 (결과의 "창 안 접속"이 실제 값).

export type Peak = { at: number; sd: number; weight: number };
/** 페르소나 분포의 봉우리. 가로축은 페르소나 목록(위에서부터 활발한 순)을 0~1로 편 것: mu = 가운데, sg = 폭 */
export type MixPeak = { mu: number; sg: number; w: number };
export type Industry = { label: string; window: [number, number]; peaks: Peak[]; why: string; mix: MixPeak[]; mixWhy: string };

export const INDUSTRY_IDS = ['restaurant', 'live_game', 'commute', 'office', 'shopping', 'video'] as const;
export type IndustryId = (typeof INDUSTRY_IDS)[number];

export const INDUSTRIES: Record<IndustryId, Industry> = {
  restaurant: {
    label: '외식·배달', window: [10, 22],
    peaks: [{ at: 12, sd: 0.75, weight: 0.4 }, { at: 18.5, sd: 1, weight: 0.6 }],
    why: '점심(12시)과 저녁(18시 반) 두 번 몰립니다. 저녁이 조금 더 큽니다.',
    mix: [{ mu: 0.6, sg: 0.2, w: 1 }], mixWhy: '배고플 때만 열어서 가끔 쓰는 사람이 대부분입니다.',
  },
  live_game: {
    label: '라이브 게임', window: [11, 2],
    peaks: [{ at: 13, sd: 1.5, weight: 0.25 }, { at: 21.5, sd: 1.5, weight: 0.75 }],
    why: '점심에 짧게, 퇴근·하교 뒤 21시 반 전후에 크게 몰리고 자정을 넘겨서도 이어집니다.',
    mix: [{ mu: 0.12, sg: 0.1, w: 0.45 }, { mu: 0.55, sg: 0.2, w: 0.55 }], mixWhy: '매일 오래 하는 핵심층과 가볍게 하는 층, 두 덩어리입니다.',
  },
  commute: {
    label: '출퇴근 (교통·뉴스)', window: [6, 23],
    peaks: [{ at: 8, sd: 0.6, weight: 0.45 }, { at: 12.5, sd: 0.7, weight: 0.15 }, { at: 18.5, sd: 0.8, weight: 0.4 }],
    why: '출근(8시)과 퇴근(18시 반)에 짧고 높게 몰리고, 점심에 작게 한 번 더 있습니다.',
    mix: [{ mu: 0.35, sg: 0.17, w: 1 }], mixWhy: '평일마다 쓰는 사람이 많아 가운데보다 조금 활발한 쪽에 몰립니다.',
  },
  office: {
    label: '업무용 (B2B·금융)', window: [9, 18],
    peaks: [{ at: 10.5, sd: 1.2, weight: 0.55 }, { at: 15, sd: 1.2, weight: 0.45 }],
    why: '근무 시간에 몰리고, 점심때 잠깐 줄어 오전·오후 두 봉우리가 됩니다.',
    mix: [{ mu: 0.28, sg: 0.15, w: 1 }], mixWhy: '업무로 매일 쓰므로 활발한 쪽에 몰립니다.',
  },
  shopping: {
    label: '쇼핑·커머스', window: [9, 1],
    peaks: [{ at: 13, sd: 1.2, weight: 0.3 }, { at: 21.5, sd: 1.3, weight: 0.7 }],
    why: '점심 쉬는 시간에 한 번, 저녁 21시 반 전후에 크게 몰립니다.',
    mix: [{ mu: 0.58, sg: 0.22, w: 1 }], mixWhy: '살 것이 있을 때 들어오는 사람이 많아 덜 활발한 쪽에 몰립니다.',
  },
  video: {
    label: 'OTT·동영상', window: [18, 2],
    peaks: [{ at: 22, sd: 1.5, weight: 1 }],
    why: '저녁을 먹은 뒤 22시 전후에 가장 많이 봅니다.',
    mix: [{ mu: 0.42, sg: 0.2, w: 1 }], mixWhy: '주 몇 번 보는 사람이 가장 많습니다.',
  },
};

const erf = (x: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const phi = (z: number) => (1 + erf(z / Math.SQRT2)) / 2;

/** 분포 봉우리들 → 페르소나 n칸의 비율(%, 정수, 합 100). 0~1 밖으로 나간 꼬리는 버리고 남은 것을 나눈다 (큰 나머지 순으로 1씩 올림) */
export function mixShares(mix: MixPeak[], n: number): number[] {
  if (!n) return [];
  const mass = Array.from({ length: n }, (_, i) => mix.reduce((s, k) => s + k.w * (phi(((i + 1) / n - k.mu) / k.sg) - phi((i / n - k.mu) / k.sg)), 0));
  const total = mass.reduce((s, x) => s + x, 0);
  // 봉우리가 모두 밖에 있어 아무것도 안 걸리면 고르게
  const raw = total > 0 ? mass.map((x) => (x / total) * 100) : mass.map(() => 100 / n);
  const out = raw.map(Math.floor);
  let rest = 100 - out.reduce((s, x) => s + x, 0);
  for (const [, i] of raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])) {
    if (rest-- <= 0) break;
    out[i]++;
  }
  return out;
}

/** 하루 피크 설정의 이름 (설계서·그래프 설명). 없으면 undefined (페르소나마다 창 가운데 한 봉우리) */
export const dayLabel = (s: { industry?: IndustryId; day?: unknown }) =>
  s.day ? (s.industry ? `${INDUSTRIES[s.industry].label} 기준 직접 조정` : '직접 정함') : s.industry && INDUSTRIES[s.industry].label;
