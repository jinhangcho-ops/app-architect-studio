// 국가별 표준시(UTC 기준 시간, 서머타임 미반영). 여러 시간대를 쓰는 나라는 인구가 가장 많은 시간대로 두고,
// 다른 지역이면 페르소나의 utc_offset으로 덮어쓴다.
export const STANDARD_OFFSET: Record<string, number> = {
  KR: 9, JP: 9, CN: 8, TW: 8, HK: 8, SG: 8, MY: 8, PH: 8, VN: 7, TH: 7,
  ID: 7, // 서부(WIB)
  IN: 5.5, AE: 4, GB: 0, FR: 1, DE: 1, ES: 1, IT: 1, NL: 1,
  US: -5, // 동부(ET)
  CA: -5, // 동부(ET)
  MX: -6, // 중부
  BR: -3, // 브라질리아
  AU: 10, // 동부(AEST)
  NZ: 12,
};

export function utcOffset(country: string, override?: number): number {
  if (override !== undefined) return override;
  const o = STANDARD_OFFSET[country];
  if (o === undefined) throw new Error(`표준시를 모르는 국가 ${country}: utc_offset을 직접 넣어 주세요`);
  return o;
}
