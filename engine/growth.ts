// 14절 성장 타임라인: 월 성장률로 한계 도달 월과 교체 착수 월을 낸다.
export const usersAt = (users: number, monthlyRate: number, month: number) => users * (1 + monthlyRate) ** month;

/** 이미 한계를 넘었으면 0, 성장하지 않으면(g ≤ 0) undefined(도달하지 않음). */
export function monthsToLimit(users: number, limitUsers: number, monthlyRate: number): number | undefined {
  if (limitUsers <= users) return 0;
  if (monthlyRate <= 0) return undefined;
  return Math.ceil(Math.log(limitUsers / users) / Math.log(1 + monthlyRate));
}

export type Milestone = { nodeId: string; limitUsers: number; month?: number; startMonth?: number };

export function timeline(limits: { nodeId: string; limitUsers: number }[], users: number, monthlyRate: number, leadMonths: number): Milestone[] {
  return limits
    .map(({ nodeId, limitUsers }) => {
      const month = monthsToLimit(users, limitUsers, monthlyRate);
      return { nodeId, limitUsers, month, startMonth: month === undefined ? undefined : Math.max(0, month - leadMonths) };
    })
    .sort((a, b) => (a.month ?? Infinity) - (b.month ?? Infinity));
}
