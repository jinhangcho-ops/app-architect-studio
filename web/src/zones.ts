// 캔버스 망 구역 틀: 같은 공개 범위(인터넷 공개·내부망·사설) 노드들을 감싸는 틀. 노드를 다른 틀 안에 놓으면 그 공개 범위가 된다
import { EXPOSURES, type ProjectNode } from '../../engine/schema';
import { hasExposure } from '../../engine/security';
import type { XY } from './layout';

type Exposure = (typeof EXPOSURES)[number];
export type ZoneRect = { zone: Exposure; x: number; y: number; w: number; h: number };
/** 노드 카드 크기 (styles.css .card) */
export const CARD = { w: 200, h: 92 };
// 틀 안쪽 여백, 위쪽은 구역 이름 자리
const PAD = 24, HEAD = 20;

/** 구역마다 그 구역 노드를 감싸는 틀. skip: 끄는 중인 노드는 빼고 (자기 틀 안에 늘 들어가 보이지 않게) */
export function zoneRects(nodes: ProjectNode[], positions: Record<string, XY>, skip?: string): ZoneRect[] {
  return EXPOSURES.flatMap((zone) => {
    const ps = nodes.filter((n) => n.id !== skip && hasExposure(n) && n.security?.exposure === zone).map((n) => positions[n.id]).filter((x): x is XY => !!x);
    if (!ps.length) return [];
    const x0 = Math.min(...ps.map((q) => q.x)) - PAD, y0 = Math.min(...ps.map((q) => q.y)) - PAD - HEAD;
    const x1 = Math.max(...ps.map((q) => q.x)) + CARD.w + PAD, y1 = Math.max(...ps.map((q) => q.y)) + CARD.h + PAD;
    return [{ zone, x: x0, y: y0, w: x1 - x0, h: y1 - y0 }];
  });
}

/** 점이 들어 있는 구역. 틀이 겹치면 더 작은(안쪽) 틀 */
export function zoneAt(rects: ZoneRect[], pt: XY): Exposure | undefined {
  return rects.filter((r) => pt.x >= r.x && pt.x <= r.x + r.w && pt.y >= r.y && pt.y <= r.y + r.h)
    .sort((a, b) => a.w * a.h - b.w * b.h)[0]?.zone;
}
