import { Select } from './Select';
import { useState } from 'react';
import { DEFAULT_DB_POOL, type Analysis } from '../../engine/analyze';
import { DEFAULT_HIT_RATIO } from '../../engine/load';
import { DEFAULT_COOLDOWN_S, DEFAULT_MAX_LAG_S, DEFAULT_POLL_S, DEFAULT_SCALE_DELAY_S, flowLine } from '../../engine/pipeline';
import { failureLines } from '../../engine/failure';
import { judgeItem } from '../../engine/judge';
import { LAYERS, LAYER_NAMES, VERDICT_NAMES, type Layer } from '../../engine/model';
import { REGIONS, TABLE_LAYERS } from '../../engine/schema';
import { catalog, prices } from './data';
import { parseHtml, type ApiCall } from './htmlImport';
import { callSplit } from '../../engine/api';
import { addEdge, applyAlternative, removeEdge, removeNode, setVar, updateEdge, updateNode } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { fmtMetric, howMetric } from './format';
import { usePick } from './store';
import { StorageSection, TablesSection } from './TablesPanel';
import { NodeSummary } from './NodeSummary';
import { InterfacesSection } from './InterfacesPanel';

const itemName = (id: string) => catalog.byId.get(id)?.name ?? id;

/** 입력 칸의 글자를 판정 변수 값으로: 숫자·참거짓·그 밖의 글자 */
const parseValue = (s: string) => (s === 'true' ? true : s === 'false' ? false : s !== '' && !Number.isNaN(Number(s)) ? Number(s) : s);

export function NodePanel({ id, analysis }: { id: string; analysis?: Analysis }) {
  const { project, edit, select, setFocus } = usePick('project', 'edit', 'select', 'setFocus');
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
  // 판단 불가 항목의 빠진 변수를 바로 입력할 수 있게 한다
  const missing = [...new Set(j?.items.flatMap((i) => i.missing ?? []) ?? [])]
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
            ['DB 연결 수 (이벤트)', na?.connections?.event],
            ['한계 사용자', na?.limitUsers],
          ] as const).map(([label, m]) => (
            <tr key={label} title={howMetric(m || undefined)}><td>{label}</td><td>{fmtMetric(m || undefined)}</td></tr>
          ))}
        </tbody></table>
        {/* 이 노드가 보내거나 받는 데이터 파이프라인 (큐 지연·배치 실행) */}
        {analysis?.pipeline.filter((f) => f.from === id || f.to === id).map((f) => (
          <p key={`${f.from}>${f.to}`} className="muted pipe-line" title={howMetric(f.lag?.event ?? f.capacity)}>{flowLine(f, (x) => project.nodes.find((y) => y.id === x)?.name ?? x)}</p>
        ))}
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
        <NumField label="최소 대수" value={n.min_instances} step={1} onChange={(v) => upd({ min_instances: v === undefined || v < 0 ? 1 : Math.round(v) })} />
        <NumField label="1대 가용성" value={n.availability} step={0.0001} hint="비우면 프로젝트 기본값" onChange={(v) => upd({ availability: v })} />
        <NumField label="평균 처리(ms)" value={n.perf?.service_ms} onChange={(v) => upd({ perf: v ? { workers: n.perf?.workers ?? 8, ...n.perf, service_ms: v } : undefined })} />
        <NumField label="대당 동시 처리" value={n.perf?.workers} step={1} onChange={(v) => n.perf && upd({ perf: { ...n.perf, workers: v ?? 1 } })} />
        {n.layer === 'cache' && <NumField label="캐시 적중률" value={n.hit_ratio} step={0.05} hint={`읽기 중 캐시에서 끝나는 몫. 이 캐시를 부르는 노드가 DB로 보내는 읽기가 (1 − 적중률)로 줄어요. 비우면 ${DEFAULT_HIT_RATIO} (예시값) — 실측 적중률로 바꾸세요`} onChange={(v) => upd({ hit_ratio: v === undefined ? undefined : Math.min(1, Math.max(0, v)) })} />}
        {n.layer === 'queue' && <>
          <NumField label="파티션 수" value={n.partitions} step={1} hint="Kafka·Redpanda처럼 파티션으로 나누는 큐: 소비자 병렬 수가 이 수를 넘지 못해요. 비우면 제한 없음" onChange={(v) => upd({ partitions: v && v > 0 ? Math.round(v) : undefined })} />
          <NumField label="허용 지연(초)" value={n.max_lag_s} step={10} hint={`메시지가 들어와 처리될 때까지 허용하는 시간. 넘으면 평소엔 안 됨, 이벤트 때만이면 조건부. 비우면 ${DEFAULT_MAX_LAG_S}초 (예시값)`} onChange={(v) => upd({ max_lag_s: v && v > 0 ? v : undefined })} />
        </>}
        {project.edges.some((e) => e.to === n.id && project.nodes.find((x) => x.id === e.from)?.layer === 'queue') && <>
          <Row label="자동 확장" hint="KEDA처럼 큐 소비자 대수를 트래픽(페르소나·하루 피크의 1분 단위 곡선)에 맞춰 바꿔요. 확인 주기마다 ceil(도착 × 처리 시간 / (대당 동시 처리 × 목표 사용률)). 최소는 '최소 대수'(0이면 한가할 때 끔)">
            <input type="checkbox" checked={!!n.autoscale} onChange={(e) => upd({ autoscale: e.target.checked ? {} : undefined })} />
          </Row>
          {n.autoscale && <>
            <NumField label="최대 대수" value={n.autoscale.max} step={1} hint="비우면 파티션 수 / 대당 동시 처리 (파티션이 없으면 제한 없음)" onChange={(v) => upd({ autoscale: { ...n.autoscale, max: v && v > 0 ? Math.round(v) : undefined } })} />
            <NumField label={`새 소비자가 뜨는 시간(초)${n.autoscale.delay_s === undefined ? ` — 비우면 ${DEFAULT_SCALE_DELAY_S}초 (예시값)` : ''}`} value={n.autoscale.delay_s} step={5} hint={`늘리기로 정한 뒤 새 소비자가 처리를 시작하기까지. 이 동안은 이전 대수로 받아 적체가 생겨요. 비우면 ${DEFAULT_SCALE_DELAY_S}초 — 예시값이니 실제로 잰 값을 넣으세요`} onChange={(v) => upd({ autoscale: { ...n.autoscale, delay_s: v === undefined || v < 0 ? undefined : v } })} />
            <NumField label="확인 주기(초)" value={n.autoscale.poll_s} step={5} hint={`도착·적체를 보고 대수를 다시 정하는 주기 (KEDA pollingInterval). 비우면 ${DEFAULT_POLL_S}초 (KEDA 기본값)`} onChange={(v) => upd({ autoscale: { ...n.autoscale, poll_s: v && v > 0 ? v : undefined } })} />
            <NumField label="줄이기 전 기다림(초)" value={n.autoscale.cooldown_s} step={30} hint={`몰림이 끝나도 최근 이 시간 동안 필요했던 가장 큰 대수 아래로는 줄이지 않아요 (KEDA cooldownPeriod). 길수록 다시 몰릴 때 안전하고 비용이 늘어요. 비우면 ${DEFAULT_COOLDOWN_S}초 (KEDA 기본값)`} onChange={(v) => upd({ autoscale: { ...n.autoscale, cooldown_s: v === undefined || v < 0 ? undefined : v } })} />
          </>}
        </>}
        {(n.layer === 'batch' || n.layer === 'analytics' || n.batch) && <>
          <NumField label="배치 주기(분)" value={n.batch?.every_min} step={5} hint="정해진 주기마다 그동안 들어온 양을 한 번에 처리해요. 비우면 들어오는 대로 처리 (큐 소비자)" onChange={(v) => upd({ batch: v && v > 0 ? { ...n.batch, every_min: v } : undefined })} />
          {n.batch && <NumField label="실행 창(분)" value={n.batch.window_min} step={5} hint="1회 실행이 이 시간 안에 끝나야 해요. 비우면 주기와 같음" onChange={(v) => upd({ batch: { ...n.batch!, window_min: v && v > 0 ? v : undefined } })} />}
        </>}
        {project.edges.some((e) => e.from === n.id && project.nodes.find((x) => x.id === e.to)?.layer === 'db') && <NumField label="DB 연결 풀(대당)" value={n.db_pool} step={1} hint={`이 노드 1대가 DB에 여는 연결 수. DB 연결 수 = 대수 × 이 값. 비우면 ${DEFAULT_DB_POOL} (HikariCP·node-postgres 기본값)`} onChange={(v) => upd({ db_pool: v && v > 0 ? Math.round(v) : undefined })} />}
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

      {n.layer !== 'ui' && n.layer !== 'external' && n.region !== 'local' && (
        <Section title="장애 대비">
          <NumField label="존 수" value={n.zones} step={1} hint="서버를 나눠 둔 가용 영역 수. 1이면 존 하나가 멈출 때 이 노드도 멈춰요. 비우면 1" onChange={(v) => upd({ zones: v && v > 1 ? Math.round(v) : undefined })} />
          <Row label="다른 리전 복사본" hint="같이 받기 = 같은 대수를 그 리전에도 띄움(비용 두 배, 넘기기 1분), 대기 = 대기 대수만 띄워 두고 키워 받음(15분), 백업 = 다른 리전에 둔 백업에서 되살림(대수 비용 없음). 시간은 예시값">
            <Select value={n.dr?.mode ?? ''} onChange={(e) => upd({ dr: e.target.value ? { region: n.dr?.region ?? REGIONS.find((r) => r !== (n.region ?? project.cost.region))!, ...n.dr, mode: e.target.value as 'active' | 'standby' | 'backup' } : undefined })}>
              <option value="">(없음)</option>
              <option value="active">같이 받기 (active)</option>
              <option value="standby">대기 (standby)</option>
              <option value="backup">백업만</option>
            </Select>
          </Row>
          {n.dr && <>
            <Row label="복사본 리전">
              <Select value={n.dr.region} onChange={(e) => upd({ dr: { ...n.dr!, region: e.target.value as typeof REGIONS[number] } })}>
                {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
              </Select>
            </Row>
            <NumField label="넘기는 시간(초)" value={n.dr.rto_s} step={30} hint="복구 훈련에서 잰 값. 비우면 방식별 예시값" onChange={(v) => upd({ dr: { ...n.dr!, rto_s: v && v > 0 ? v : undefined } })} />
            {n.dr.mode === 'standby' && <NumField label="대기 대수" value={n.dr.instances} step={1} hint="대기 복사본이 평소 띄워 두는 대수. 이만큼 하루 내내 비용이 들고, 넘긴 직후에는 이 대수로 부하를 받아요. 비우면 1" onChange={(v) => upd({ dr: { ...n.dr!, instances: v && v > 0 ? Math.round(v) : undefined } })} />}
          </>}
          {(n.layer === 'db' || n.layer === 'analytics') && <>
            <NumField label="백업 주기(시간)" value={n.backup?.every_h} step={1} hint="비우면 백업 없음 — 데이터가 망가지면 되살릴 수 없어요" onChange={(v) => upd({ backup: v && v > 0 ? { pitr: false, ...n.backup, every_h: v } : undefined })} />
            {n.backup && <>
              <Row label="시점 복구" hint="로그를 계속 보관해 장애 직전으로 되살림 (잃는 데이터 5분, 예시값)">
                <input type="checkbox" checked={n.backup.pitr} onChange={(e) => upd({ backup: { ...n.backup!, pitr: e.target.checked } })} />
              </Row>
              <NumField label="되살리는 속도(MB/초)" value={n.backup.restore_mb_s} step={10} hint="복구 훈련에서 잰 값. 비우면 100 (예시값)" onChange={(v) => upd({ backup: { ...n.backup!, restore_mb_s: v && v > 0 ? v : undefined } })} />
            </>}
          </>}
          {analysis?.failure && failureLines(analysis.failure, (x) => project.nodes.find((y) => y.id === x)?.name ?? x, id).map((l) => <p key={l} className="muted pipe-line">{l}</p>)}
        </Section>
      )}

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

export function EdgePanel({ from, to, analysis }: { from: string; to: string; analysis?: Analysis }) {
  const { project, edit, select } = usePick('project', 'edit', 'select');
  const e = project.edges.find((x) => x.from === from && x.to === to);
  if (!e) return <p className="muted">연결선이 없습니다.</p>;
  const name = (id: string) => project.nodes.find((n) => n.id === id)?.name ?? id;
  const upd = (patch: Parameters<typeof updateEdge>[3]) => edit((p) => updateEdge(p, from, to, patch));
  // 화면 와이어프레임에 호출이 있으면 엔진이 호출 비율로 나누고 이 연결의 호출 비율·흐르는 요청은 쓰지 않는다
  const byCalls = !!callSplit(project, project.nodes.find((n) => n.id === from)!);
  // 인터페이스 명세가 있으면 그 호출 수로 나눈다 (와이어프레임 호출이 있으면 그쪽이 먼저)
  const bySpec = !byCalls && e.interfaces.length > 0;
  return (
    <div className="panel">
      <Section title={`${name(from)} → ${name(to)}`}>
        {byCalls && <p className="muted">와이어프레임의 API 호출이 이 연결의 부하를 정합니다. 호출 비율·흐르는 요청은 화면 블록의 세부 구성 › 와이어프레임에서 바꾸세요.</p>}
        {bySpec && <p className="muted">아래 인터페이스 명세의 호출 수가 이 연결의 부하를 정합니다.</p>}
        <Row label="동기 호출"><input type="checkbox" checked={e.sync} onChange={(x) => upd({ sync: x.target.checked })} /></Row>
        <NumField label="호출 비율" value={e.callRatio} hint="요청 1건당 이 연결로 몇 번 부르는지" disabled={byCalls || bySpec} onChange={(v) => upd({ callRatio: v ?? 1 })} />
        <Row label="흐르는 요청">
          <Select value={e.carries} disabled={byCalls || bySpec} onChange={(x) => upd({ carries: x.target.value as typeof e.carries })}>
            <option value="all">전체</option><option value="read">읽기만</option><option value="write">쓰기만</option>
          </Select>
        </Row>
        <NumField label="왕복 지연(ms)" value={e.rtt_ms} onChange={(v) => upd({ rtt_ms: v ?? 0 })} />
      </Section>
      <InterfacesSection e={e} analysis={analysis} />
      <button className="danger" onClick={() => { edit((p) => removeEdge(p, from, to)); select(null); }}>연결선 삭제</button>
    </div>
  );
}
