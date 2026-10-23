// 9절 필요 대수: N = ceil(부하 / (대당 처리량 × 목표 사용률)), 최소·최대 대수로 자른다.
export function instancesNeeded(rps: number, perInstance: number, utilization: number, min = 1, max = Infinity): number {
  return Math.min(max, Math.max(min, Math.ceil(rps / (perInstance * utilization))));
}

/** 시간대별 필요 대수. shape는 0~23시 부하를 피크=1로 나눈 비율이다. */
export function hourlyInstances(peakRps: number, shape: number[], perInstance: number, utilization: number, min = 1, max = Infinity): number[] {
  return shape.map((s) => instancesNeeded(peakRps * s, perInstance, utilization, min, max));
}
