// 선택한 노드 요약 (오른쪽 "선택한 것" 맨 위): 한계까지 쓴 비율 고리, 받는 부하, 성장 기간 월 비용, 한계 시점
import type { Analysis } from '../../engine/analyze';
import { LAYER_NAMES } from '../../engine/model';
import type { Project } from '../../engine/schema';
import { healthOf } from './Canvas';
import { fmt, fmtMetric, howMetric } from './format';

const RING = { bad: '#ff5a5a', warn: '#f5b301', ok: '#2ec4a6', none: '#5f6a7a' } as const;

export function NodeSummary({ project: p, analysis: a, id }: { project: Project; analysis?: Analysis; id: string }) {
  const n = p.nodes.find((x) => x.id === id)!;
  const na = a?.nodes[id];
  const h = healthOf(a, p.scale?.users, id);
  const pct = h.meter !== undefined ? Math.min(1, h.meter) : undefined;
  const C = 2 * Math.PI * 42;
  const ms = a?.growth?.milestones.find((m) => m.nodeId === id);
  const storageGb = a?.tables.filter((t) => t.nodeId === id).reduce((s, t) => s + t.storedGb.value, 0);
  const name = (nid: string) => p.nodes.find((x) => x.id === nid)?.name ?? nid;
  const cost = a?.growth?.monthlyCost;

  return (
    <>
      <div className="summary">
        <svg width="92" height="92" viewBox="0 0 100 100" role="img" aria-label={pct === undefined ? '한계 계산 없음' : `한계까지 ${Math.round(pct * 100)}%`}>
          <circle cx="50" cy="50" r="42" stroke="var(--line)" strokeWidth="9" fill="none" />
          {pct !== undefined && <circle cx="50" cy="50" r="42" stroke={RING[h.health]} strokeWidth="9" fill="none" strokeLinecap="round"
            strokeDasharray={`${Math.max(0.5, pct * C)} ${C}`} transform="rotate(-90 50 50)" />}
          <text x="50" y="57" textAnchor="middle" fontSize="20" fontWeight="700" style={{ fill: 'var(--ink)' }}>{pct === undefined ? '—' : `${Math.round(pct * 100)}%`}</text>
        </svg>
        <div>
          <small>{LAYER_NAMES[n.layer]}</small>
          <b>{n.name}</b>
          {h.health === 'bad' && <span className="alert">첫 병목{ms?.startMonth !== undefined ? ` · ${ms.startMonth}개월째 착수` : ''}</span>}
          {h.health === 'warn' && <span className="alert warn">{ms?.startMonth}개월째 착수</span>}
          {h.health === 'ok' && <span className="okay">여유 충분</span>}
        </div>
      </div>

      {na?.load && (
        <section className="block">
          <h4>이 노드가 받는 부하</h4>
          <div className="grid2">
            <div><span>피크 / 이벤트</span><b>{fmt(na.load.rps.normal)} / {fmt(na.load.rps.event)} RPS</b></div>
            <div><span>쓰기</span><b>{fmt(na.load.writeRps.normal)} 건/초</b></div>
            {storageGb ? <div><span>저장</span><b>{fmt(storageGb)} GB</b></div> : null}
            {a?.traffic && <div data-tip={howMetric(a.traffic.concurrentPeakEvent)}><span>이벤트 동시 접속</span><b>{fmtMetric(a.traffic.concurrentPeakEvent)}</b></div>}
            {na.limitUsers && <div data-tip={howMetric(na.limitUsers)}><span>한계 사용자</span><b className={h.health === 'bad' ? 'bad' : ''}>약 {fmt(na.limitUsers.value)}명</b></div>}
          </div>
        </section>
      )}

      {cost && cost.length > 0 && (
        <section className="block">
          <h4>월 비용 ({cost[0]?.unit ?? ''}){a?.cost?.missing.length ? <small className="warn"> · 계산 못 한 항목 있음</small> : null}</h4>
          <div className="grid2">
            {[0, 6, 12, 24].filter((mo) => mo < cost.length).map((mo) => <div key={mo}><span>{mo}개월째</span><b>{cost[mo] ? fmt(cost[mo]!.value) : '—'}</b></div>)}
          </div>
        </section>
      )}

      {a?.growth && a.growth.milestones.length > 0 && (
        <section className="block milestone">
          <h4>한계 시점</h4>
          {a.growth.milestones.map((m) => (
            <div key={m.nodeId} className={m.nodeId === id ? 'mine' : ''}>
              <span>{name(m.nodeId)}</span>
              <b>{m.month === undefined ? '성장해도 닿지 않음' : `${m.month}개월째 한계 · ${m.startMonth}개월째 착수`}</b>
            </div>
          ))}
          <div className="hint">최선 조합 탭에서 이 노드를 바꿨을 때의 한계 시점을 비교할 수 있어요.</div>
        </section>
      )}
    </>
  );
}
