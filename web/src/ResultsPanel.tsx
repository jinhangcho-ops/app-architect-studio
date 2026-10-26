import type { Analysis } from '../../engine/analyze';
import { regionLines } from '../../engine/failure';
import { PATHS_CUT_TEXT } from '../../engine/latency';
import { GAP_EFFECT, specAdvice, specGaps } from '../../engine/interfaces';
import type { Traffic } from '../../engine/traffic';
import type { Metric } from '../../engine/model';
import { catalog } from './data';
import { updateTable } from './edit';
import { Section } from './fields';
import { fmt, fmtMetric, howMetric } from './format';
import { costTimeline, milestoneText } from './reportData';
import { featureTables, unusedTables } from '../../engine/tables';
import { schemaWarnings } from '../../engine/ddl';
import { useState } from 'react';
import { nodeStorageProfile, selectedFeatures, storageProfileOf, type Project } from '../../engine/schema';
import { loadSqlJs, runSqliteLab, type LabResult } from './sqliteLab';
import { usePick } from './store';

/** 기능 → 읽고 쓰는 테이블. 결과 패널과 보고서가 같이 쓴다 */
export function FeatureTablesTable({ project, className }: { project: Project; className?: string }) {
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const label = (node: string, table: string) => project.nodes.find((n) => n.id === node)?.tables.find((t) => t.name === table)?.label;
  const feats = featureTables(project), unused = unusedTables(project), warns = schemaWarnings(project, catalog.byId);
  const cell = (ts: { node: string; table: string }[]) => ts.map((t) => `${name(t.node)}.${t.table}${label(t.node, t.table) ? ` (${label(t.node, t.table)})` : ''}`).join(', ') || '—';
  return <>
    {feats.length > 0 ? <div className="plans"><table className={className}>
      <thead><tr><th>기능</th><th>어디서</th><th>쓰는 테이블</th><th>읽는 테이블</th></tr></thead>
      <tbody>{feats.map((f) => (
        <tr key={f.via + f.name}>
          <td>{f.name}</td>
          <td>{f.via === '행동' ? '사용자 행동' : f.via.split(' → ').map(name).join(' → ')}</td>
          <td>{cell(f.tables.filter((t) => t.op === 'write'))}</td>
          <td>{cell(f.tables.filter((t) => t.op === 'read'))}</td>
        </tr>
      ))}</tbody>
    </table></div> : <p className="muted">아직 테이블에 연결한 기능이 없어요. 행동에서 쓰는 테이블을, 연결선의 인터페이스에서 읽고 쓰는 테이블을 고르세요.</p>}
    {unused.length > 0 && <p className="warn">어떤 기능에도 연결되지 않은 테이블: {cell(unused.map((k) => { const d = k.indexOf('.'); return { node: k.slice(0, d), table: k.slice(d + 1) }; }))}</p>}
    {/* 스키마 경고(기본값·코드 타입, 인덱스 이름 겹침 …) — 전체 결과와 설계서 6절에 같이 나온다 */}
    {warns.length > 0 && <ul className="warn">{warns.map((w, i) => <li key={i}>⚠️ {name(w.node)}{w.table ? `.${w.table}` : ''}: {w.text}</li>)}</ul>}
  </>;
}

const Line = ({ label, m }: { label: string; m?: Metric }) =>
  m ? <tr title={howMetric(m)}><td>{label}</td><td>{fmtMetric(m)}</td></tr> : null;

export function ResultsPanel({ analysis: a }: { analysis?: Analysis }) {
  const { project } = usePick('project');
  if (!a) return <p className="muted">입력을 고치면 결과가 나옵니다.</p>;
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const t = a.traffic;

  return (
    <div className="panel">
      {a.localMemory && <Section title="로컬 실행 메모리">
        <table className="metrics"><tbody>
          <Line label="예상 점유" m={a.localMemory.mb} />
          <Line label="기기 메모리 중" m={a.localMemory.share} />
        </tbody></table>
        {a.localMemory.share && a.localMemory.share.value > 0.5 && <p className="warn">기기 메모리의 절반 넘게 씁니다. 큰 라이브러리를 지연 로드로 돌리거나 캐시를 줄여 보세요 (기준 50%는 예시값).</p>}
      </Section>}

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
        {t && t.assumptions.length > 0 && <ul className="warn">{t.assumptions.map((s) => <li key={s}>⚠️ {s}</li>)}</ul>}
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

      {a.tables.length > 0 && <Section title="테이블 크기">
        <div className="plans"><table>
          <thead><tr><th>테이블</th><th>하루 새 행</th><th>행</th><th>인덱스/행</th><th>저장</th><th>파티션</th><th>SQLite 실험</th></tr></thead>
          <tbody>{a.tables.map((x) => (
            <tr key={x.key}>
              <td>{x.key}</td>
              <td title={howMetric(x.newRowsPerDay)}>{fmt(x.newRowsPerDay.value)}</td>
              <td title={howMetric(x.rowBytes)}>{fmt(x.rowBytes.value)} B</td>
              <td title={howMetric(x.indexBytesPerRow)}>{fmt(x.indexBytesPerRow.value)} B</td>
              <td title={howMetric(x.storedGb)}>{fmt(x.storedGb.value)} GB</td>
              <td title={x.partitions ? howMetric(x.partitions.gb) : ''}>{x.partitions ? `${x.partitions.count} × ${fmt(x.partitions.gb.value)} GB` : '—'}</td>
              <td><TableLab nodeId={x.nodeId} table={x.table} /></td>
            </tr>
          ))}</tbody>
        </table></div>
        {a.storage?.tablesGb && <p title={`${howMetric(a.storage.tablesGb)}

${howMetric(a.storage.personaGb)}`}>
          저장량: 테이블 합계 {fmtMetric(a.storage.tablesGb)} · 페르소나 추정(쓰기 × 건당 KB) {fmtMetric(a.storage.personaGb)}
          {' '}({a.storage.personaGb.value > 0 ? `${fmt((a.storage.tablesGb.value / a.storage.personaGb.value) * 100)}%` : '—'}). 비용은 테이블 합계로 계산합니다.
        </p>}
        {a.tables.some((x) => x.assumptions.length) && <ul className="muted">
          {a.tables.flatMap((x) => x.assumptions.map((s) => <li key={x.key + s}>{x.key} — {s}</li>))}
        </ul>}
        {a.growth && a.growth.tables.length > 0 && <ul>{a.growth.tables.map((ms) => (
          <li key={ms.nodeId}>{ms.nodeId}: {ms.month === undefined ? '성장해도 서버 메모리에 닿지 않음' : `${ms.month}개월째 서버 메모리를 넘음, ${ms.startMonth}개월째 파티션 착수`}</li>
        ))}</ul>}
      </Section>}

      {project.nodes.some((n) => n.tables.length) && <Section title="기능별 테이블" desc="행동과 인터페이스에 연결한 테이블이에요. 파일 › 스키마(DDL)·데이터 사전 내보내기로 CREATE TABLE과 데이터 사전을 받아요.">
        <FeatureTablesTable project={project} />
      </Section>}

      <Section title="확장 한계">
        {a.bottleneck
          ? <p title={howMetric(a.bottleneck.limitUsers)}>첫 병목: <b>{name(a.bottleneck.nodeId)}</b> — {a.bottleneck.limitUsers.value === 0 ? '지금 구조에서 이미 안 됨' : `활성 사용자 약 ${fmt(a.bottleneck.limitUsers.value)}명에서 안 됨`}</p>
          : <p className="muted">한계를 계산할 노드가 없습니다.</p>}
        {a.growth && a.growth.monthlyCost.length > 0 && <p className="muted">
          월 비용: {costTimeline(a.growth!.monthlyCost)}
          {a.cost && a.cost.missing.length > 0 && ' (계산하지 못한 항목이 있어 실제보다 작음)'}
        </p>}
        {a.growth && <ul>{a.growth.milestones.map((ms) => (
          <li key={ms.nodeId}>{name(ms.nodeId)}: {milestoneText(ms)}</li>
        ))}</ul>}
      </Section>

      <Section title="경로 (화면에서 동기 호출)">
        {a.pathsCut && <p className="warn">{PATHS_CUT_TEXT}</p>}
        {a.paths.map((pa) => (
          <div key={pa.nodes.join('>')} className="path">
            <div>{pa.nodes.map(name).join(' → ')}</div>
            <div className="muted" title={`${howMetric(pa.p99)}\n\n${howMetric(pa.availability)}`}>
              p99 {fmtMetric(pa.p99)} · 가용성 {fmtMetric(pa.availability)} · 월 중단 {fmtMetric(pa.downtime)}
            </div>
          </div>
        ))}
        {a.spof.length > 0 && <p className="warn">단일 장애점: {a.spof.map(name).join(', ')}</p>}
        {a.failure && regionLines(a.failure, name).map((l) => <p key={l} className="muted">{l}</p>)}
      </Section>

      <Section title="월 비용">
        {!a.cost && <p className="muted">가격 상품을 고른 노드·저장·송신이 없습니다.</p>}
        {a.cost && <>
          <p title={howMetric(a.cost.total)}>합계 {fmtMetric(a.cost.total)}</p>
          <table className="metrics"><tbody>
            {Object.entries(a.cost.parts).map(([k, m]) => <Line key={k} label={project.nodes.some((n) => n.id === k) ? name(k) : k} m={m} />)}
          </tbody></table>
          {a.cost.missing.length > 0 && <>
            <p className="warn">계산하지 못한 항목이 있어 합계가 실제보다 작습니다:</p>
            <ul className="warn">{a.cost.missing.map((x) => <li key={x}>{x}</li>)}</ul>
          </>}
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

      {project.edges.some((e) => e.interfaces.length) && <Section title="인터페이스 명세 점검" desc="보내는 쪽과 받는 쪽이 같은 계약으로 짜도록, 비어 있는 것과 기술에 맞는 공유 방법이에요.">
        {project.edges.flatMap((e) => e.interfaces.map((i) => ({ e, i, gaps: specGaps(i) }))).map(({ e, i, gaps }) => (
          <div key={`${e.from}>${e.to}>${i.name}`} className={`judge ${gaps.length ? 'v-conditional' : 'v-ok'}`}>
            <b>{gaps.length ? '⚠️' : '✅'} {name(e.from)} → {name(e.to)} · {i.name}</b>
            {gaps.length > 0 && <div>{gaps.join(' · ')}</div>}
          </div>
        ))}
        {project.edges.some((e) => e.interfaces.some((i) => specGaps(i).length)) && <p className="warn">{GAP_EFFECT}</p>}
        {specAdvice(project).map((x) => (
          <div key={x.nodeId + x.title} className="judge">
            <b>💡 {name(x.nodeId)} — {x.title}</b>
            <div>{x.text}</div>
            {x.file && <div className="muted">파일 › 인터페이스 명세 내보내기 → {x.file}</div>}
          </div>
        ))}
      </Section>}

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
        {t.personas.map((x, i) => (
          <tr key={i}>
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

/** 테이블 하나를 브라우저 SQLite에 만들어 1만 행을 넣고 잰다. 주 항목이 SQLite 계열이면 실측값을 테이블에 넣을 수 있다 */
export function TableLab({ nodeId, table }: { nodeId: string; table: string }) {
  const { project, edit } = usePick('project', 'edit');
  const [state, setState] = useState<{ running?: boolean; result?: LabResult; error?: string }>({});
  const node = project.nodes.find((n) => n.id === nodeId)!;
  const t = node.tables.find((x) => x.name === table)!;
  const sp = nodeStorageProfile(node, catalog.byId);
  const isSqlite = !!sp && sp === storageProfileOf(catalog.byId.get('sqlite'), catalog.byId);
  const run = async () => {
    setState({ running: true });
    try {
      const SQL = await loadSqlJs();
      const withoutRowid = !!sp && selectedFeatures(sp, node, t).some((f) => f.id === 'without_rowid');
      setState({ result: runSqliteLab(SQL, t, { withoutRowid }) });
    } catch (e) {
      setState({ error: (e as Error).message });
    }
  };
  const apply = (r: LabResult) => edit((p) => updateTable(p, nodeId, table, { measured: { ...t.measured, row_bytes: r.rowBytes, index_bytes: r.indexBytes } }));
  const r = state.result;
  return (
    <span className="lab">
      <button onClick={run} disabled={state.running}>{state.running ? '실험 중…' : '실험'}</button>
      {r && <span title={r.ddl.join(';\n')}>
        {' '}행 {fmt(r.rowBytes)} B · 인덱스 {fmt(r.indexBytes)} B · {fmt(r.insertsPerSec)}행/초(참고)
        {isSqlite
          ? <button onClick={() => apply(r)}>실측 적용</button>
          : <span className="muted"> — SQLite 기준이라 이 노드 계산에는 넣지 않음</span>}
      </span>}
      {state.error && <span className="warn"> {state.error}</span>}
    </span>
  );
}
