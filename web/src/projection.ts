// v2 project_3d_point / ensure_3d_coordinates를 그대로 옮긴 것. 숫자는 v2 파이썬 결과로 테스트한다.
import type { Layer } from '../../engine/model';
import type { Project } from '../../engine/schema';

/** 레이어별 3D 깊이(z). v2 TIER_3D_CONFIG를 v3 레이어에 맞춘 값 */
export const TIER_Z: Record<Layer, number> = {
  ui: -250, gateway: -125, backend: 0, cache: 0, queue: 130, batch: 130, db: 260, external: 260, analytics: 380,
};

/** Y축(좌우) 회전 → X축(상하) 회전 → 카메라 거리 1350의 약한 원근 투영. 반환: [화면 x, 화면 y, 깊이] */
export function project3d(x: number, y: number, z: number, yawDeg: number, pitchDeg: number, scale = 1, cx = 520, cy = 340): [number, number, number] {
  const yaw = (yawDeg * Math.PI) / 180, pitch = (pitchDeg * Math.PI) / 180;
  const x1 = x * Math.cos(yaw) + z * Math.sin(yaw);
  const z1 = -x * Math.sin(yaw) + z * Math.cos(yaw);
  const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
  const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch);
  const persp = 1350 / Math.max(450, 1350 + z2 * 0.55);
  return [cx + x1 * scale * persp, cy + y2 * scale * persp, z2];
}

/** 같은 깊이의 노드를 가로로 235씩 벌리고, 깊이마다 반 칸 엇갈리게, 뒤쪽일수록 위로 올린다 (v2 배치) */
export function worldPositions(p: Project): Record<string, [number, number, number]> {
  const byZ = new Map<number, string[]>();
  for (const n of p.nodes) byZ.set(TIER_Z[n.layer], [...(byZ.get(TIER_Z[n.layer]) ?? []), n.id]);
  const out: Record<string, [number, number, number]> = {};
  [...byZ.entries()].sort((a, b) => a[0] - b[0]).forEach(([z, ids], tierIdx) => {
    const stagger = ((tierIdx % 2) - 0.5) * 55;
    const start = -((ids.length - 1) * 235) / 2 + stagger;
    ids.forEach((id, i) => { out[id] = [start + i * 235, -z * 0.32, z]; });
  });
  return out;
}
