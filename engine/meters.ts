// 9절 계량: 노드의 주 항목 과금 방식에 따라 한 달 사용량을 구해 cost.ts의 LineItem으로 만든다.
//   provisioned  = 시간대별 필요 대수 × 30일 (월 정액 상품이면 최대 대수)
//   usage        = 요청 수 · 연산 시간(vCPU·초, GB·초) · 스캔량
//   plan         = 월 정액 1개
// 다른 리전 복사본(dr): active = 같은 대수를 그 리전에, standby = 대기 대수(기본 1)를 하루 내내. 월 정액이면 1개 더, 사용량 과금은 요청이 나뉠 뿐이라 늘지 않는다.
//   데이터 노드는 복사본 리전에도 같은 저장량을 둔다.
// shortcut: 복제로 리전 사이에 오가는 쓰기 전송은 세지 않는다. 쓰기가 많아 전송비가 커지면 쓰기 rps × 행 크기로 리전 간 전송 줄을 더한다
// 저장(GB·월), 인터넷 송신(GB), 리전이 다른 노드 사이 전송(GB)은 프로젝트 단위로 더한다.
import type { LineItem } from './cost';
import { callSplit } from './api';
import { edgeFlow, readMiss, type NodeLoad } from './load';
import type { TableAnalysis } from './tables';
import { nodeRegion, type CatalogItem, type Project, type ProjectNode } from './schema';
import type { Traffic } from './traffic';

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** factor = 사용자 배수(성장 타임라인에서 미래 달의 비용을 구할 때 1보다 큼) */
export function costLines(
  p: Project, t: Traffic | undefined, loads: Map<string, NodeLoad> | undefined, catalog: Map<string, CatalogItem>,
  hourlyOf: (n: ProjectNode, factor: number) => number[], factor: number, tables: TableAnalysis[] = [],
): { lines: LineItem[]; missing: string[] } {
  const lines: LineItem[] = [];
  const missing: string[] = [];
  const regionOf = (n: ProjectNode) => { const r = nodeRegion(n, p); return r === 'local' ? undefined : r; };
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
    const dr = n.dr && n.dr.mode !== 'backup' ? n.dr : undefined;
    const instances = (product: string) => {
      const hourly = hourlyOf(n, factor);
      lines.push({
        key: n.id, product, region,
        quantities: { hour: sum(hourly) * 30, month: Math.max(...hourly) },
        how: { hour: '30일 × Σ 시간대 필요 대수', month: '하루 중 최대 대수' },
      });
      if (!dr) return;
      const copy = dr.mode === 'active' ? hourly : Array<number>(24).fill(dr.instances ?? 1);
      lines.push({
        key: n.id, product, region: dr.region,
        quantities: { hour: sum(copy) * 30, month: Math.max(...copy) },
        how: dr.mode === 'active'
          ? { hour: '복사본(active): 30일 × Σ 시간대 필요 대수', month: '복사본(active): 하루 중 최대 대수' }
          : { hour: '복사본(standby): 30일 × 24시간 × 대기 대수', month: '복사본(standby): 대기 대수' },
      });
    };
    // 노드에 상품을 직접 지정했으면 그 상품을 대수×시간으로 쓴다
    if (n.price) { instances(n.price); continue; }
    if (!billing) continue;
    if (!region) { missing.push(`${n.name}: 리전 없음 (노드 리전 또는 프로젝트 기본 리전 필요)`); continue; }
    const pr = billing.products;
    if (billing.model === 'provisioned' && pr.instance) instances(pr.instance);
    if (billing.model === 'plan' && pr.month) {
      lines.push({ key: n.id, product: pr.month, region, quantities: { month: 1 }, how: { month: '월 정액 1개' } });
      if (dr) lines.push({ key: n.id, product: pr.month, region: dr.region, quantities: { month: 1 }, how: { month: `복사본(${dr.mode}): 월 정액 1개` } });
    }
    if (billing.model !== 'usage') continue;

    // 트래픽(규모·페르소나)이 없으면 요청 수를 몰라 0원으로 보이므로 '모름'으로 둔다. 월 스캔량은 입력값이라 따로 계산한다
    if (!t && (pr.million_requests || pr.vcpu_second || pr.gb_second)) missing.push(`${n.name}: 트래픽(규모·페르소나)이 없어 사용량을 모름`);
    const req = requestsPerMonth(n);
    if (pr.million_requests && t) lines.push({ key: n.id, product: pr.million_requests, region, quantities: { million_requests: req / 1e6 }, how: { million_requests: '월 요청 ÷ 100만' } });
    if (t && (pr.vcpu_second || pr.gb_second)) {
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

  // 테이블이 하나라도 있으면 저장량은 테이블 합계(노드 리전별). 없으면 페르소나 추정(쓰기 × 건당 KB)
  // 디스크 저장 과금은 DB·분석 노드만 (캐시는 메모리 노드라 대수 과금에 들어 있다)
  if (p.cost.storage && tables.length) {
    for (const n of p.nodes.filter((x) => x.layer === 'db' || x.layer === 'analytics')) {
      if (n.region === 'local') continue;
      const mine = tables.filter((x) => x.nodeId === n.id);
      if (!mine.length) { missing.push(`${n.name}: 테이블이 없어 저장량을 모름 (테이블을 넣거나 테이블을 모두 비우면 페르소나 추정을 씀)`); continue; }
      if (mine.some((x) => !x.profiled)) { missing.push(`${n.name}: 주 항목에 저장 프로필이 없어 테이블 저장량을 모름`); continue; }
      const gb = mine.reduce((s, x) => s + x.storedGb.value, 0);
      if (!gb) continue;
      lines.push({ key: '저장', product: p.cost.storage, region: regionOf(n), quantities: { gb_month: gb }, how: { gb_month: `${n.id} 테이블 저장량 합계` } });
      if (n.dr && n.dr.mode !== 'backup') lines.push({ key: '저장', product: p.cost.storage, region: n.dr.region, quantities: { gb_month: gb }, how: { gb_month: `${n.id} 복사본 테이블 저장량` } });
    }
  } else if (t && p.cost.storage) lines.push({ key: '저장', product: p.cost.storage, region: p.cost.region, quantities: { gb_month: t.storageGbWithOverhead.value * factor }, how: { gb_month: '보관 기간 저장량(여유분 포함)' } });
  if (t && p.cost.egress) lines.push({ key: '송신', product: p.cost.egress, region: p.cost.region, quantities: { gb: t.egressGbPerDay.value * 30 * factor }, how: { gb: '하루 송신 × 30' } });
  if (t && p.cost.transfer) {
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    for (const e of p.edges) {
      const a = regionOf(byId.get(e.from)!), b = regionOf(byId.get(e.to)!);
      if (!a || !b || a === b) continue;
      // 연결선이 나르는 몫(호출 비율 포함): load.ts의 전파 규칙(edgeFlow)을 그대로 쓴다
      const l = loads?.get(e.from);
      const carried = l?.rps.normal ? edgeFlow(e, l, callSplit(p, byId.get(e.from)!), 'normal', readMiss(p, e)).rps / l.rps.normal : 0;
      // shortcut: 노드 사이 응답 크기를 사용자 응답 평균 크기로 본다. 구간별 크기가 필요해지면 연결선에 payload_kb를 둔다
      const gb = requestsPerMonth(byId.get(e.from)!) * carried * gbPerRequest;
      lines.push({ key: '리전 간 전송', product: p.cost.transfer, region: a, quantities: { gb_interregion: gb }, how: { gb_interregion: `${e.from}→${e.to} 월 요청 × 호출 비율 × 요청당 응답 GB` } });
    }
  }
  return { lines, missing };
}
