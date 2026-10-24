// 업종별 하루 접속 모양: 깨어 있는 창과 그 안의 피크들(현지 표준시). 흔한 모양을 옮긴 예시값이라 서비스에 맞게 고쳐 쓴다.
// 피크 = 그 시각(at)을 가운데로 한 정규분포(표준편차 sd시간), weight는 피크끼리의 상대 몫.

export type Peak = { at: number; sd: number; weight: number };
export type Industry = { label: string; window: [number, number]; peaks: Peak[]; why: string };

export const INDUSTRY_IDS = ['restaurant', 'live_game', 'commute', 'office', 'shopping', 'video'] as const;
export type IndustryId = (typeof INDUSTRY_IDS)[number];

export const INDUSTRIES: Record<IndustryId, Industry> = {
  restaurant: {
    label: '외식·배달', window: [10, 22],
    peaks: [{ at: 12, sd: 0.75, weight: 0.4 }, { at: 18.5, sd: 1, weight: 0.6 }],
    why: '점심(12시)과 저녁(18시 반) 두 번 몰립니다. 저녁이 조금 더 큽니다.',
  },
  live_game: {
    label: '라이브 게임', window: [11, 2],
    peaks: [{ at: 13, sd: 1.5, weight: 0.25 }, { at: 21.5, sd: 1.5, weight: 0.75 }],
    why: '점심에 짧게, 퇴근·하교 뒤 21시 반 전후에 크게 몰리고 자정을 넘겨서도 이어집니다.',
  },
  commute: {
    label: '출퇴근 (교통·뉴스)', window: [6, 23],
    peaks: [{ at: 8, sd: 0.6, weight: 0.45 }, { at: 12.5, sd: 0.7, weight: 0.15 }, { at: 18.5, sd: 0.8, weight: 0.4 }],
    why: '출근(8시)과 퇴근(18시 반)에 짧고 높게 몰리고, 점심에 작게 한 번 더 있습니다.',
  },
  office: {
    label: '업무용 (B2B·금융)', window: [9, 18],
    peaks: [{ at: 10.5, sd: 1.2, weight: 0.55 }, { at: 15, sd: 1.2, weight: 0.45 }],
    why: '근무 시간에 몰리고, 점심때 잠깐 줄어 오전·오후 두 봉우리가 됩니다.',
  },
  shopping: {
    label: '쇼핑·커머스', window: [9, 1],
    peaks: [{ at: 13, sd: 1.2, weight: 0.3 }, { at: 21.5, sd: 1.3, weight: 0.7 }],
    why: '점심 쉬는 시간에 한 번, 저녁 21시 반 전후에 크게 몰립니다.',
  },
  video: {
    label: 'OTT·동영상', window: [18, 2],
    peaks: [{ at: 22, sd: 1.5, weight: 1 }],
    why: '저녁을 먹은 뒤 22시 전후에 가장 많이 봅니다.',
  },
};
