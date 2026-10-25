// 9절 필요 대수: N = ceil(부하 / (대당 처리량 × 목표 사용률)), 최소·최대 대수로 자른다.
export function instancesNeeded(rps: number, perInstance: number, utilization: number, min = 1, max = Infinity): number {
  return Math.min(max, Math.max(min, Math.ceil(rps / (perInstance * utilization))));
}
