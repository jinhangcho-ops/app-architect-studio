import type { Analysis } from '../../engine/analyze';
import type { Traffic } from '../../engine/traffic';
import type { Metric } from '../../engine/model';
import { catalog } from './data';
import { Section } from './fields';
import { fmt, fmtMetric, howMetric } from './format';
import { useStore } from './store';

const Line = ({ label, m }: { label: string; m?: Metric }) =>
  m ? <tr title={howMetric(m)}><td>{label}</td><td>{fmtMetric(m)}</td></tr> : null;

export function ResultsPanel({ analysis: a }: { analysis?: Analysis }) {
  const { project } = useStore();
  if (!a) return <p className="muted">입력을 고치면 결과가 나옵니다.</p>;
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const t = a.traffic;

  return (
    <div className="panel">
      <Section title="규모">
        {!t && <p className="muted">서버 트래픽 계산 없음 (로컬 exe이거나 규모·페르소나가 없음)</p>}
        {t && <table className="metrics"><tbody>
          <Line label="DAU" m={t.dau} />
          <Line label="창 안 접속" m={t.inWindowShare} />
          <Line label="피크 1시간 비중" m={t.peakShare} />
          <Line label="피크 RPS" m={t.peakRps} />
          <Line label="이벤트 피크 RPS" m={t.peakRpsEvent} />
          <Line label="이벤트 쓰기/초" m={t.peakWriteRpsEvent} />
          <Line label="이벤트 동시 접속" m={t.concurrentPeakEvent} />
          <Line label="저장(여유분 포함)" m={t.storageGbWithOverhead} />
          <Line label="하루 송신" m={t.egressGbPerDay} />
        </tbody></table>}
      </Section>

      {t && t.personas.length > 0 && <Section title="페르소나별 하루 트래픽">
        <PersonaTable t={t} />
        <p className="muted">페르소나마다 자기 패턴·비율로 무작위 하루를 계산해 더합니다. 1인당 = 합계 ÷ 인원(그날 안 들어온 사람 포함).</p>
        {Object.keys(t.tables).length > 0 && <table className="metrics"><tbody>
          {Object.entries(t.tables).map(([k, x]) => (
            <tr key={k} title={`${howMetric(x.rowsPerDay)}

${howMetric(x.peakRowsPerSec)}`}>
              <td>{k}</td><td>{fmtMetric(x.rowsPerDay)} · 피크 {fmtMetric(x.peakRowsPerSec)}</td>
            </tr>
          ))}
        </tbody></table>}
      </Section>}

      <Section title="확장 한계">
        {a.bottleneck
          ? <p title={howMetric(a.bottleneck.limitUsers)}>첫 병목: <b>{name(a.bottleneck.nodeId)}</b> — 활성 사용자 약 {fmt(a.bottleneck.limitUsers.value)}명에서 안 됨</p>
          : <p className="muted">한계를 계산할 노드가 없습니다.</p>}
        {a.growth && <ul>{a.growth.milestones.map((ms) => (
          <li key={ms.nodeId}>{name(ms.nodeId)}: {ms.month === undefined ? '성장해도 닿지 않음' : `${ms.month}개월째 한계, ${ms.startMonth}개월째 착수`}</li>
        ))}</ul>}
      </Section>

      <Section title="경로 (화면에서 동기 호출)">
        {a.paths.map((pa) => (
          <div key={pa.nodes.join('>')} className="path">
            <div>{pa.nodes.map(name).join(' → ')}</div>
            <div className="muted" title={`${howMetric(pa.p99)}\n\n${howMetric(pa.availability)}`}>
              p99 {fmtMetric(pa.p99)} · 가용성 {fmtMetric(pa.availability)} · 월 중단 {fmtMetric(pa.downtime)}
            </div>
          </div>
        ))}
        {a.spof.length > 0 && <p className="warn">단일 장애점: {a.spof.map(name).join(', ')}</p>}
      </Section>

      <Section title="월 비용">
        {!a.cost && <p className="muted">가격 상품을 고른 노드·저장·송신이 없습니다.</p>}
        {a.cost && <>
          <p title={howMetric(a.cost.total)}>합계 {fmtMetric(a.cost.total)}</p>
          <table className="metrics"><tbody>
            {Object.entries(a.cost.parts).map(([k, m]) => <Line key={k} label={project.nodes.some((n) => n.id === k) ? name(k) : k} m={m} />)}
          </tbody></table>
          {a.cost.missing.length > 0 && <p className="warn">가격표에 없음: {a.cost.missing.join(', ')}</p>}
          {a.cost.stale.length > 0 && <p className="warn">오래된 가격: {a.cost.stale.join(', ')}</p>}
        </>}
      </Section>

      <Section title="구조 규칙">
        {!a.rules.length && <p className="muted">걸린 규칙이 없습니다.</p>}
        {a.rules.map((r) => (
          <div key={r.ruleId + r.target} className="judge v-fail">
            <b>❌ {r.target}</b>
            <div>{r.why}</div>
            <div className="muted">→ {r.instead}</div>
          </div>
        ))}
      </Section>

      <Section title="확인 필요 조문">
        {!a.regulation.length && <p className="muted">개인정보 노드가 없거나 걸린 조문이 없습니다.</p>}
        {a.regulation.map((h) => (
          <div key={h.nodeId + h.article + h.law} className="law" title={`출처: ${h.source}
기준일: ${h.asOf}`}>
            ⚖️ {name(h.nodeId)} · <b>{h.law} {h.article} 확인 필요</b> <span className="muted">— {h.reason}</span>
            {!h.verified && <span className="tag">조문 번호 미확인</span>}
          </div>
        ))}
        {a.regulation.length > 0 && <p className="muted">법률 검토를 대신하지 않습니다. 조문 내용은 원문에서 확인하세요.</p>}
      </Section>

      <Section title="판정 요약">
        {a.judgements.flatMap((j) => j.items.filter((i) => i.verdict !== 'ok').map((i) => (
          <div key={j.nodeId + i.itemId}>{name(j.nodeId)} · {catalog.byId.get(i.itemId)?.name}: {i.reasons[0]}</div>
        )))}
      </Section>
    </div>
  );
}

/** 페르소나별 1인당·합계, 마지막 줄은 전체 합 */
function PersonaTable({ t }: { t: Traffic }) {
  const rows = (x: Traffic['personas'][number]) => Object.values(x.rows).reduce((s, v) => s + v, 0);
  const total = t.personas.reduce((s, x) => ({ people: s.people + x.people, requests: s.requests + x.requests, rows: s.rows + rows(x), mb: s.mb + x.responseKb / 1000 }),
    { people: 0, requests: 0, rows: 0, mb: 0 });
  const hasRows = total.rows > 0;
  return (
    <div className="plans"><table>
      <thead><tr>
        <th>페르소나</th><th>비율</th><th>인원</th><th>1인당 요청</th><th>요청 합계</th>
        {hasRows && <><th>1인당 쓰기 행</th><th>쓰기 행 합계</th></>}
        <th>1인당 응답</th>
      </tr></thead>
      <tbody>
        {t.personas.map((x) => (
          <tr key={x.name}>
            <td>{x.name}</td><td>{Math.round(x.share * 100)}%</td><td>{fmt(x.people)}</td>
            <td>{fmt(x.requests / x.people)}</td><td>{fmt(x.requests)}</td>
            {hasRows && <><td>{fmt(rows(x) / x.people)}</td><td>{fmt(rows(x))}</td></>}
            <td>{fmt(x.responseKb / x.people)} KB</td>
          </tr>
        ))}
        <tr className="metric-row">
          <td>합계</td><td>100%</td><td>{fmt(total.people)}</td>
          <td>{fmt(total.requests / total.people)}</td><td>{fmt(total.requests)}</td>
          {hasRows && <><td>{fmt(total.rows / total.people)}</td><td>{fmt(total.rows)}</td></>}
          <td>{fmt((total.mb * 1000) / total.people)} KB</td>
        </tr>
      </tbody>
    </table></div>
  );
}
