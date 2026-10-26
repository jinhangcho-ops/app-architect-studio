// 연결선의 인터페이스 명세: 보내는 노드가 받는 노드에 부르는 REST·gRPC 호출과 큐 메시지. 호출 수는 부하 계산에, 크기는 리전 간 전송량에 쓰인다
import type { Analysis } from '../../engine/analyze';
import { interfaceRates, requestBytes, responseBytes } from '../../engine/interfaces';
import { readMiss } from '../../engine/load';
import { FIELD_TYPES, HTTP_METHODS, IDENT, type Interface, type ProjectEdge, type SpecField } from '../../engine/schema';
import { updateEdge } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { fmt } from './format';
import { Select } from './Select';
import { usePick } from './store';

const KIND_NAMES = { rest: 'REST (HTTP)', grpc: 'gRPC', message: '메시지 (큐·이벤트)' } as const;
const PATH_LABEL = { rest: '경로', grpc: '메서드 이름', message: '토픽' } as const;
const PATH_HINT = { rest: '/로 시작. 경로 변수는 {order_id}처럼', grpc: '영문 식별자 (예: CreateOrder)', message: '큐의 토픽·채널 이름 (예: orders.created)' } as const;
const FIELD_NAMES: Record<(typeof FIELD_TYPES)[number], string> = {
  string: '문자열', integer: '정수', number: '실수', boolean: '참·거짓', datetime: '날짜·시각', uuid: 'UUID', object: '객체', array: '배열',
};

export function InterfacesSection({ e, analysis }: { e: ProjectEdge; analysis?: Analysis }) {
  const { project, edit } = usePick('project', 'edit');
  const toLayer = project.nodes.find((n) => n.id === e.to)?.layer;
  const set = (interfaces: Interface[]) => edit((p) => updateEdge(p, e.from, e.to, { interfaces }));
  const upd = (k: number, patch: Partial<Interface>) => set(e.interfaces.map((x, j) => (j === k ? { ...x, ...patch } : x)));
  const add = () => {
    let n = e.interfaces.length + 1;
    while (e.interfaces.some((x) => x.name === `인터페이스 ${n}`)) n++;
    const base = { name: `인터페이스 ${n}`, per_request: 1, on: 'all' as const, request: [], response: [] };
    set([...e.interfaces, toLayer === 'queue' ? { ...base, kind: 'message', path: 'topic.name' } : { ...base, kind: 'rest', method: 'GET', path: '/path' }]);
  };
  // 이 연결로 가는 인터페이스별 초당 호출 (평소 / 이벤트)
  const from = analysis?.nodes[e.from]?.load;
  const rates = from && e.interfaces.length ? { normal: interfaceRates(e, from, 'normal', readMiss(project, e)), event: interfaceRates(e, from, 'event', readMiss(project, e)) } : undefined;

  return (
    <Section title={`인터페이스 명세 (${e.interfaces.length})`} desc="이 연결로 주고받는 호출·메시지예요. 적으면 호출 수로 부하를, 크기로 리전 간 전송량을 계산하고, 파일 › 인터페이스 명세 내보내기로 OpenAPI·AsyncAPI·proto 파일을 만들어요.">
      {e.interfaces.map((x, k) => (
        <details key={k} className="table-editor">
          <summary>
            <b>{x.name}</b> <span className="muted">{x.kind === 'rest' ? `${x.method ?? 'GET'} ${x.path}` : `${KIND_NAMES[x.kind]} ${x.path}`}
              {rates && ` · ${fmt(rates.normal[k].rps)} / ${fmt(rates.event[k].rps)} RPS`} · 요청 {fmt(requestBytes(x))}B{x.kind !== 'message' && ` / 응답 ${fmt(responseBytes(x))}B`}</span>
          </summary>
          <TextField label="이름" value={x.name} onChange={(v) => upd(k, { name: v })} />
          <Row label="방식">
            <Select value={x.kind} onChange={(ev) => {
              const kind = ev.target.value as Interface['kind'];
              upd(k, { kind, method: kind === 'rest' ? x.method ?? 'GET' : undefined, ...(kind === 'message' && { response: [] }) });
            }}>
              {Object.entries(KIND_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </Row>
          {x.kind === 'rest' && <Row label="메서드">
            <Select value={x.method ?? 'GET'} onChange={(ev) => upd(k, { method: ev.target.value as Interface['method'] })}>
              {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
          </Row>}
          <Row label={PATH_LABEL[x.kind]} hint={PATH_HINT[x.kind]}><input value={x.path} onChange={(ev) => upd(k, { path: ev.target.value })} /></Row>
          <Row label="부르는 요청" hint="보내는 노드가 받는 요청 중 어떤 것에서 부르나요">
            <Select value={x.on} onChange={(ev) => upd(k, { on: ev.target.value as Interface['on'] })}>
              <option value="all">모든 요청</option><option value="read">읽기 요청만</option><option value="write">쓰기 요청만</option>
            </Select>
          </Row>
          <NumField label="요청 1건당 횟수" value={x.per_request} step={0.1} hint="그 요청 1건마다 이 인터페이스를 몇 번 부르는지. 받는 노드의 부하 = 요청 × 이 값" onChange={(v) => upd(k, { per_request: v === undefined || v < 0 ? 1 : v })} />
          <Row label="받는 쪽에서" hint="받는 노드에 읽기로 보나 쓰기로 보나. 자동: REST는 GET만 읽기, 메시지는 쓰기, gRPC는 읽기">
            <Select value={x.op ?? ''} onChange={(ev) => upd(k, { op: (ev.target.value || undefined) as Interface['op'] })}>
              <option value="">자동</option><option value="read">읽기</option><option value="write">쓰기</option>
            </Select>
          </Row>
          <TextField label="설명" value={x.description} onChange={(v) => upd(k, { description: v || undefined })} />
          <Fields title="요청 필드" fields={x.request} onChange={(request) => upd(k, { request })} />
          {x.kind !== 'message' && <Fields title="응답 필드" fields={x.response} onChange={(response) => upd(k, { response })} />}
          <NumField label="요청 크기(B, 실측)" value={x.request_bytes} hint="비우면 필드 형식별 예시 크기로 어림해요" onChange={(v) => upd(k, { request_bytes: v === undefined || v < 0 ? undefined : v })} />
          {x.kind !== 'message' && <NumField label="응답 크기(B, 실측)" value={x.response_bytes} hint="비우면 필드 형식별 예시 크기로 어림해요" onChange={(v) => upd(k, { response_bytes: v === undefined || v < 0 ? undefined : v })} />}
          <button className="danger" onClick={() => set(e.interfaces.filter((_, j) => j !== k))}>이 인터페이스 삭제</button>
        </details>
      ))}
      <button onClick={add}>+ 인터페이스</button>
    </Section>
  );
}

function Fields({ title, fields, onChange }: { title: string; fields: SpecField[]; onChange: (f: SpecField[]) => void }) {
  const upd = (k: number, patch: Partial<SpecField>) => onChange(fields.map((f, j) => (j === k ? { ...f, ...patch } : f)));
  return (
    <div>
      <p className="muted">{title} — 이름은 영문 식별자 (코드 생성 도구가 그대로 써요)</p>
      {fields.length > 0 && <div className="plans"><table className="grid">
        <thead><tr><th>이름</th><th>형식</th><th>필수</th><th>평균 B</th><th>설명</th><th /></tr></thead>
        <tbody>
          {fields.map((f, k) => (
            <tr key={k}>
              <td><input value={f.name} aria-invalid={!IDENT.test(f.name)} title={IDENT.test(f.name) ? '' : '영문·숫자·_ 만 (숫자로 시작하지 않음)'} onChange={(ev) => upd(k, { name: ev.target.value })} /></td>
              <td><Select value={f.type} onChange={(ev) => upd(k, { type: ev.target.value as SpecField['type'] })}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{FIELD_NAMES[t]}</option>)}
              </Select></td>
              <td><input type="checkbox" checked={f.required} onChange={(ev) => upd(k, { required: ev.target.checked })} /></td>
              <td><input type="number" value={f.avg_bytes ?? ''} placeholder="예시" onChange={(ev) => upd(k, { avg_bytes: ev.target.value === '' || Number(ev.target.value) <= 0 ? undefined : Number(ev.target.value) })} /></td>
              <td><input value={f.description ?? ''} onChange={(ev) => upd(k, { description: ev.target.value || undefined })} /></td>
              <td><button aria-label="필드 빼기" onClick={() => onChange(fields.filter((_, j) => j !== k))}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table></div>}
      <button onClick={() => {
        let n = fields.length + 1;
        while (fields.some((f) => f.name === `field${n}`)) n++;
        onChange([...fields, { name: `field${n}`, type: 'string', required: true }]);
      }}>+ 필드</button>
    </div>
  );
}
