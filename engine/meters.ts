// 9절 계량: 노드의 주 항목 과금 방식에 따라 한 달 사용량을 구해 cost.ts의 LineItem으로 만든다.
//   provisioned  = 시간대별 필요 대수 × 30일 (월 정액 상품이면 최대 대수)
//   usage        = 요청 수 · 연산 시간(vCPU·초, GB·초) · 스캔량
//   plan         = 월 정액 1개
// 저장(GB·월), 인터넷 송신(GB), 리전이 다른 노드 사이 전송(GB)은 프로젝트 단위로 더한다.
import type { LineItem } from './cost';
import type { NodeLoad } from './load';
import type { CatalogItem, Project, ProjectNode } from './schema';
import type { Traffic } from './traffic';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** factor = 사용자 배수(성장 타임라인에서 미래 달의 비용을 구할 때 1보다 큼) */
export function costLines(
  p: Project, t: Traffic | undefined, loads: Map<string, NodeLoad> | undefined, catalog: Map<string, CatalogItem>,
  hourlyOf: (n: ProjectNode, factor: number) => number[], factor: number,
): { lines: LineItem[]; missing: string[] } {
  const lines: LineItem[] = [];
  const missing: string[] = [];
  const regionOf = (n: ProjectNode) => (n.region && n.region !== 'local' ? n.region : n.region === 'local' ? undefined : p.cost.region);
  // 노드의 하루 요청 = 전체 하루 요청 × (이 노드 피크 / 전체 피크). 부하가 연결선을 따라 같은 비율로 전파되기 때문
  const requestsPerMonth = (n: ProjectNode) => {
    const l = loads?.get(n.id);
    return l && t && t.peakRps.value > 0 ? t.dailyRequests.value * (l.rps.normal / t.peakRps.value) * 30 * factor : 0;
  };
  const gbPerRequest = t && t.dailyRequests.value > 0 ? t.egressGbPerDay.value / t.dailyRequests.value : 0;

  for (const n of p.nodes) {
    // 사용자 기기에서 도는 노드는 클라우드 과금이 없다
    if (n.region === 'local') continue;
    const billing = n.primary ? catalog.get(n.primary)?.billing : undefined;
    const region = regionOf(n);
    const instances = (product: string) => {
      const hourly = hourlyOf(n, factor);
      lines.push({
        key: n.id, product, region,
        quantities: { hour: sum(hourly) * 30, month: Math.max(...hourly) },
        how: { hour: '30일 × Σ 시간대 필요 대수', month: '하루 중 최대 대수' },
      });
    };
    // 노드에 상품을 직접 지정했으면 그 상품을 대수×시간으로 쓴다
    if (n.price) { instances(n.price); continue; }
    if (!billing) continue;
    if (!region) { missing.push(`${n.name}: 리전 없음 (노드 리전 또는 프로젝트 기본 리전 필요)`); continue; }
    const pr = billing.products;
    if (billing.model === 'provisioned' && pr.instance) instances(pr.instance);
    if (billing.model === 'plan' && pr.month) lines.push({ key: n.id, product: pr.month, region, quantities: { month: 1 }, how: { month: '월 정액 1개' } });
    if (billing.model !== 'usage') continue;

    const req = requestsPerMonth(n);
    if (pr.million_requests) lines.push({ key: n.id, product: pr.million_requests, region, quantities: { million_requests: req / 1e6 }, how: { million_requests: '월 요청 ÷ 100만' } });
    if (pr.vcpu_second || pr.gb_second) {
      if (!n.perf) missing.push(`${n.name}: 처리 시간(평균 처리 ms) 없음`);
      else {
        const seconds = (req * n.perf.service_ms) / 1000;
        if (pr.vcpu_second) {
          if (n.spec?.vcpu) lines.push({ key: n.id, product: pr.vcpu_second, region, quantities: { vcpu_second: seconds * n.spec.vcpu }, how: { vcpu_second: '월 요청 × 처리 시간 × vCPU' } });
          else missing.push(`${n.name}: vCPU 사양 없음`);
        }
        if (pr.gb_second) {
          if (n.spec?.memGb) lines.push({ key: n.id, product: pr.gb_second, region, quantities: { gb_second: seconds * n.spec.memGb }, how: { gb_second: '월 요청 × 처리 시간 × 메모리 GB' } });
          else missing.push(`${n.name}: 메모리(GB) 사양 없음`);
        }
      }
    }
    if (pr.tb_scanned) {
      if (n.usage.scanned_tb_month !== undefined) lines.push({ key: n.id, product: pr.tb_scanned, region, quantities: { tb_scanned: n.usage.scanned_tb_month * factor }, how: { tb_scanned: '월 스캔 TB(입력값) × 사용자 배수' } });
      else missing.push(`${n.name}: 월 스캔량(TB) 없음`);
    }
  }

  if (t && p.cost.storage) lines.push({ key: '저장', product: p.cost.storage, region: p.cost.region, quantities: { gb_month: t.storageGbWithOverhead.value * factor }, how: { gb_month: '보관 기간 저장량(여유분 포함)' } });
  if (t && p.cost.egress) lines.push({ key: '송신', product: p.cost.egress, region: p.cost.region, quantities: { gb: t.egressGbPerDay.value * 30 * factor }, how: { gb: '하루 송신 × 30' } });
  if (t && p.cost.transfer) {
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    for (const e of p.edges) {
      const a = regionOf(byId.get(e.from)!), b = regionOf(byId.get(e.to)!);
      if (!a || !b || a === b) continue;
      // 연결선이 나르는 몫: 전부, 쓰기만, 읽기만 (load.ts의 전파 규칙과 같다)
      const l = loads?.get(e.from);
      const r = l?.rps.normal ?? 0, w = l?.writeRps.normal ?? 0;
      const carried = !r ? 0 : e.carries === 'all' ? 1 : e.carries === 'write' ? w / r : (r - w) / r;
      // shortcut: 노드 사이 응답 크기를 사용자 응답 평균 크기로 본다. 구간별 크기가 필요해지면 연결선에 payload_kb를 둔다
      const gb = requestsPerMonth(byId.get(e.from)!) * carried * e.callRatio * gbPerRequest;
      lines.push({ key: '리전 간 전송', product: p.cost.transfer, region: a, quantities: { gb_interregion: gb }, how: { gb_interregion: `${e.from}→${e.to} 월 요청 × 호출 비율 × 요청당 응답 GB` } });
    }
  }
  return { lines, missing };
}
