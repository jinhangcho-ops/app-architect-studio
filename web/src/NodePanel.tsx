import { Select } from './Select';
import { useState } from 'react';
import type { Analysis } from '../../engine/analyze';
import { judgeItem } from '../../engine/judge';
import { LAYERS, LAYER_NAMES, VERDICT_NAMES, type Layer } from '../../engine/model';
import { REGIONS, TABLE_LAYERS } from '../../engine/schema';
import { catalog, prices } from './data';
import { parseHtml, type ApiCall } from './htmlImport';
import { addEdge, applyAlternative, removeEdge, removeNode, setVar, updateEdge, updateNode } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { fmtMetric, howMetric } from './format';
import { useStore } from './store';
import { StorageSection, TablesSection } from './TablesPanel';
import { NodeSummary } from './NodeSummary';

const itemName = (id: string) => catalog.byId.get(id)?.name ?? id;

/** 입력 칸의 글자를 판정 변수 값으로: 숫자·참거짓·그 밖의 글자 */
const parseValue = (s: string) => (s === 'true' ? true : s === 'false' ? false : s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s);

export function NodePanel({ id, analysis }: { id: string; analysis?: Analysis }) {
  const { project, edit, select, setFocus } = useStore();
  const [goal, setGoal] = useState('');
  const [newVar, setNewVar] = useState('');
  const [apiCalls, setApiCalls] = useState<ApiCall[]>([]);
  const n = project.nodes.find((x) => x.id === id);
  if (!n) return <p className="muted">노드가 없습니다.</p>;

  const upd = (patch: Parameters<typeof updateNode>[2]) => edit((p) => updateNode(p, id, patch));
  const j = analysis?.judgements.find((x) => x.nodeId === id);
  const na = analysis?.nodes[id];
  const scenario = analysis?.scenarios[id];
  const fits = catalog.items.filter((i) => i.attaches_to.includes(n.layer));
  const goals = [...new Set(fits.flatMap((i) => Object.keys(i.goals)))].sort();
  // 판단 불가 이유에서 빠진 변수 이름을 뽑아 바로 입력할 수 있게 한다
  const missing = [...new Set(j?.items.flatMap((i) => i.verdict === 'unknown' ? i.reasons[0].split(': ')[1]?.split(', ') ?? [] : []) ?? [])]
    .filter((k) => !k.startsWith('th.'));

  const changeLayer = (layer: Layer) => upd({
    layer,
    primary: n.primary && catalog.byId.get(n.primary)?.attaches_to.includes(layer) ? n.primary : undefined,
    extras: n.extras.filter((x) => catalog.byId.get(x)?.attaches_to.includes(layer)),
  });

  return (
    <div className="panel">
      <NodeSummary project={project} analysis={analysis} id={id} />
      <Section title="기본">
        <TextField label="이름" value={n.name} onChange={(v) => upd({ name: v })} />
        <Row label="레이어">
          <Select value={n.layer} onChange={(e) => changeLayer(e.target.value as Layer)}>
            {LAYERS.map((l) => <option key={l} value={l}>{LAYER_NAMES[l]}</option>)}
          </Select>
        </Row>
        <Row label="설명"><textarea value={n.description ?? ''} onChange={(e) => upd({ description: e.target.value || undefined })} /></Row>
      </Section>

      <Section title="선택 항목">
        <Row label="주 항목">
          <Select value={n.primary ?? ''} onChange={(e) => upd({ primary: e.target.value || undefined })}>
            <option value="">(없음)</option>
            {fits.filter((i) => i.role === '주').map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </Select>
        </Row>
        <div className="checks">
          {fits.filter((i) => i.role === '보조').map((i) => (
            <label key={i.id} title={i.summary}>
              <input type="checkbox" checked={n.extras.includes(i.id)}
                onChange={(e) => upd({ extras: e.target.checked ? [...n.extras, i.id] : n.extras.filter((x) => x !== i.id) })} />
              {i.name}
            </label>
          ))}
        </div>
      </Section>

      <Section title="★ 판정 근거">
        {!j?.items.length && <p className="muted">항목을 고르면 판정합니다.</p>}
        {j?.items.map((it) => (
          <div key={it.itemId} className={`judge v-${it.verdict}`}>
            <div><b>{VERDICT_NAMES[it.verdict]}</b> {itemName(it.itemId)}</div>
            <div className="summary">{catalog.byId.get(it.itemId)?.summary}</div>
            <ul>{it.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            {it.alternatives.map((a) => (
              <div key={a.id} className="alt">
                → {VERDICT_NAMES[a.verdict]} {itemName(a.id)}{a.note ? ` (${a.note})` : ''}
                <button onClick={() => edit((p) => applyAlternative(p, id, it.itemId, a.id))}>적용</button>
              </div>
            ))}
          </div>
        ))}
      </Section>

      <Section title="📊 계산 결과">
        <table className="metrics"><tbody>
          {([
            ['피크 RPS (평소)', na?.load && { value: na.load.rps.normal, unit: 'RPS', formula: '연결선을 따라 내려온 부하', inputs: {} }],
            ['피크 RPS (이벤트)', na?.load && { value: na.load.rps.event, unit: 'RPS', formula: '연결선을 따라 내려온 부하', inputs: {} }],
            ['대당 처리량', na?.perInstanceRps],
            ['필요 대수 (이벤트)', na?.instances?.event],
            ['사용률 (이벤트)', na?.utilization?.event],
            ['p99 (이벤트)', na?.p99?.event],
            ['가용성', na?.availability],
            ['한계 사용자', na?.limitUsers],
          ] as const).map(([label, m]) => (
            <tr key={label} title={howMetric(m || undefined)}><td>{label}</td><td>{fmtMetric(m || undefined)}</td></tr>
          ))}
        </tbody></table>
      </Section>

      {(TABLE_LAYERS as readonly string[]).includes(n.layer) && <>
        <StorageSection node={n} />
        <TablesSection node={n} />
      </>}

      <Section title="목표로 찾기">
        <Select value={goal} onChange={(e) => setGoal(e.target.value)}>
          <option value="">목표 고르기</option>
          {goals.map((g) => <option key={g} value={g}>{g}</option>)}
        </Select>
        {goal && fits.filter((i) => i.goals[goal] === '좋음').map((i) => {
          const v = scenario && judgeItem(i, n, scenario).verdict;
          const has = n.primary === i.id || n.extras.includes(i.id);
          return (
            <div key={i.id} className="alt" title={i.summary}>
              {v && VERDICT_NAMES[v]} {i.name} <span className="muted">({i.role})</span>
              {!has && <button onClick={() => upd(i.role === '주' ? { primary: i.id } : { extras: [...n.extras, i.id] })}>적용</button>}
            </div>
          );
        })}
      </Section>

      <Section title="사양·운영">
        <NumField label="vCPU" value={n.spec?.vcpu} onChange={(v) => upd({ spec: { ...n.spec, vcpu: v } })} />
        <NumField label="메모리(GB)" value={n.spec?.memGb} onChange={(v) => upd({ spec: { ...n.spec, memGb: v } })} />
        <NumField label="이중화 대수" value={n.replicas} step={1} onChange={(v) => upd({ replicas: v ?? 1 })} />
        <NumField label="최소 대수" value={n.min_instances} step={1} onChange={(v) => upd({ min_instances: v ?? 1 })} />
        <NumField label="1대 가용성" value={n.availability} step={0.0001} hint="비우면 프로젝트 기본값" onChange={(v) => upd({ availability: v })} />
        <NumField label="평균 처리(ms)" value={n.perf?.service_ms} onChange={(v) => upd({ perf: v ? { workers: n.perf?.workers ?? 8, ...n.perf, service_ms: v } : undefined })} />
        <NumField label="대당 동시 처리" value={n.perf?.workers} step={1} onChange={(v) => n.perf && upd({ perf: { ...n.perf, workers: v ?? 1 } })} />
        {(() => {
          const b = n.primary ? catalog.byId.get(n.primary)?.billing : undefined;
          const MODEL = { provisioned: '대수 × 시간', usage: '사용량', plan: '월 정액' } as const;
          return <>
            <Row label="과금 방식"><span>{b ? `${MODEL[b.model]} (${Object.values(b.products).join(', ')})` : '과금 없음 (자원이 아님)'}</span></Row>
            {b?.products.tb_scanned && <NumField label="월 스캔량(TB)" value={n.usage.scanned_tb_month} onChange={(v) => upd({ usage: { ...n.usage, scanned_tb_month: v } })} />}
          </>;
        })()}
        <Row label="상품 직접 지정">
          <Select value={n.price ?? ''} onChange={(e) => upd({ price: e.target.value || undefined })}>
            <option value="">(항목의 과금 방식 사용)</option>
            {prices.filter((r) => r.unit === 'hour' || r.unit === 'month').map((r) => <option key={r.id} value={r.id}>{r.id}</option>)}
          </Select>
        </Row>
      </Section>

      {n.layer === 'ui' && (
        <Section title="HTML 화면">
          <input type="file" accept=".html,.htm" onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            const r = parseHtml(await f.text());
            upd({ html: { file: f.name, regions: r.regions } });
            setApiCalls(r.apiCalls);
          }} />
          {n.html && <>
            <p className="muted">{n.html.file} — 영역 {n.html.regions.length}개</p>
            <ul className="regions">{n.html.regions.map((r, i) => (
              <li key={i}><b>{r.role}</b> <code>{r.selector}</code>{r.controls.length > 0 && <div className="muted">{r.controls.join(' · ')}</div>}</li>
            ))}</ul>
          </>}
          {apiCalls.length > 0 && <>
            <p>찾은 API 호출 — 연결할 노드를 고르면 연결선을 만듭니다</p>
            {apiCalls.map((c) => (
              <div key={c.method + c.path} className="alt">
                <code>{c.method} {c.path}</code>
                <Select value="" onChange={(e) => e.target.value && edit((p) => addEdge(p, id, e.target.value))}>
                  <option value="">연결할 노드</option>
                  {project.nodes.filter((x) => x.layer === 'gateway' || x.layer === 'backend').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </Select>
              </div>
            ))}
          </>}
        </Section>
      )}

      <Section title="데이터 위치·개인정보">
        <Row label="저장 위치">
          <Select value={n.region ?? ''} onChange={(e) => upd({ region: (e.target.value || undefined) as typeof n.region })}>
            <option value="">(미정)</option>
            <option value="local">사용자 기기</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Row>
        {(() => {
          const pv = n.privacy ?? { personal: false, sensitive: false, unique_id: false, subjects: [], sends_external: false };
          const setPv = (patch: Partial<typeof pv>) => upd({ privacy: { ...pv, ...patch } });
          const subj = (c: string, on: boolean) => setPv({ subjects: on ? [...pv.subjects, c] : pv.subjects.filter((x) => x !== c) });
          return (
            <div className="checks">
              <label><input type="checkbox" checked={pv.personal} onChange={(e) => setPv({ personal: e.target.checked })} />개인정보 포함</label>
              <label><input type="checkbox" checked={pv.sensitive} onChange={(e) => setPv({ sensitive: e.target.checked })} />민감정보 포함</label>
              <label><input type="checkbox" checked={pv.unique_id} onChange={(e) => setPv({ unique_id: e.target.checked })} />고유식별정보 포함</label>
              <label><input type="checkbox" checked={pv.sends_external} onChange={(e) => setPv({ sends_external: e.target.checked })} />외부(제3자)로 전송</label>
              <label><input type="checkbox" checked={pv.subjects.includes('KR')} onChange={(e) => subj('KR', e.target.checked)} />한국 사용자 데이터</label>
              <label><input type="checkbox" checked={pv.subjects.includes('JP')} onChange={(e) => subj('JP', e.target.checked)} />일본 사용자 데이터</label>
            </div>
          );
        })()}
        {analysis?.regulation.filter((h) => h.nodeId === id).map((h) => (
          <div key={h.article + h.law} className="law" title={`출처: ${h.source}
기준일: ${h.asOf}`}>
            ⚖️ <b>{h.law} {h.article} 확인 필요</b> <span className="muted">— {h.reason}</span>
            {!h.verified && <span className="tag">조문 번호 미확인</span>}
          </div>
        ))}
      </Section>

      <Section title="직접 넣는 값">
        {[...new Set([...Object.keys(n.vars.normal), ...missing])].map((k) => (
          <Row key={k} label={k} hint="평소와 이벤트에 같은 값으로 들어갑니다. 비우면 지웁니다">
            <input value={n.vars.normal[k] === undefined ? '' : String(n.vars.normal[k])}
              placeholder="값 없음"
              onChange={(e) => edit((p) => setVar(p, id, k, e.target.value === '' ? undefined : parseValue(e.target.value)))} />
          </Row>
        ))}
        <div className="inline">
          <input placeholder="변수 이름" value={newVar} onChange={(e) => setNewVar(e.target.value)} />
          <button onClick={() => { if (newVar) edit((p) => setVar(p, id, newVar, 0)); setNewVar(''); }}>추가</button>
        </div>
      </Section>

      <button onClick={() => setFocus(id)}>세부 구성 열기</button>
      <button className="danger" onClick={() => { edit((p) => removeNode(p, id)); select(null); }}>노드 삭제</button>
    </div>
  );
}

export function EdgePanel({ from, to }: { from: string; to: string }) {
  const { project, edit, select } = useStore();
  const e = project.edges.find((x) => x.from === from && x.to === to);
  if (!e) return <p className="muted">연결선이 없습니다.</p>;
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const upd = (patch: Parameters<typeof updateEdge>[3]) => edit((p) => updateEdge(p, from, to, patch));
  return (
    <div className="panel">
      <Section title={`${name(from)} → ${name(to)}`}>
        <Row label="동기 호출"><input type="checkbox" checked={e.sync} onChange={(x) => upd({ sync: x.target.checked })} /></Row>
        <NumField label="호출 비율" value={e.callRatio} hint="요청 1건당 이 연결로 몇 번 부르는지" onChange={(v) => upd({ callRatio: v ?? 1 })} />
        <Row label="흐르는 요청">
          <Select value={e.carries} onChange={(x) => upd({ carries: x.target.value as typeof e.carries })}>
            <option value="all">전체</option><option value="read">읽기만</option><option value="write">쓰기만</option>
          </Select>
        </Row>
        <NumField label="왕복 지연(ms)" value={e.rtt_ms} onChange={(v) => upd({ rtt_ms: v ?? 0 })} />
      </Section>
      <button className="danger" onClick={() => { edit((p) => removeEdge(p, from, to)); select(null); }}>연결선 삭제</button>
    </div>
  );
}
