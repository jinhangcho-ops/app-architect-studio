// 노드 패널의 데이터 부분: 명세서 붙여넣기, 테이블 편집, 저장 기능 선택.
import { Select } from './Select';
import { useState } from 'react';
import { COLUMN_TYPES, nodeStorageProfile, selectedFeatures, STORAGE_FORMATS, STORAGE_NAMES, type ProjectNode } from '../../engine/schema';
import { parseSpec } from '../../engine/spec';
import { catalog } from './data';
import { addTable, importTables, patchAt, removeTable, setFeature, updateNode, updateTable } from './edit';
import { NumField, Row, Section, TextField } from './fields';
import { usePick } from './store';

type Table = ProjectNode['tables'][number];
type Column = Table['columns'][number];

const TEMPLATE = '테이블\t컬럼\t타입\t크기\t평균 길이\t저장 형식\tNULL\t키·인덱스\t설명';
const csv = (xs: string[]) => xs.join(', ');
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
/** 코드 값 "C=카드, M=현금" ↔ [{code, label}] */
export const codesText = (cs?: Column['codes']) => (cs ?? []).map((x) => (x.label ? `${x.code}=${x.label}` : x.code)).join(', ');
export const parseCodes = (s: string): Column['codes'] => {
  const cs = list(s).map((x) => { const [code, ...rest] = x.split('='); return { code: code.trim(), label: rest.join('=').trim() }; }).filter((x) => x.code);
  return cs.length ? cs : undefined;
};

export function TablesSection({ node }: { node: ProjectNode }) {
  const { edit } = usePick('edit');
  const [spec, setSpec] = useState('');
  const [report, setReport] = useState<{ ok?: string; errors: string[] }>({ errors: [] });

  const importSpec = () => {
    const r = parseSpec(spec);
    let replaced: string[] = [];
    if (r.tables.length) edit((p) => { const x = importTables(p, node.id, r.tables); replaced = x.replaced; return x.project; });
    setReport({
      ok: r.tables.length ? `테이블 ${r.tables.length}개를 가져왔습니다${replaced.length ? ` (같은 이름 ${replaced.join(', ')}은 바꿈)` : ''}` : undefined,
      errors: r.errors,
    });
    if (r.tables.length && !r.errors.length) setSpec('');
  };

  return (
    <Section title={`테이블 (${node.tables.length})`}>
      <details>
        <summary>명세서 붙여넣기</summary>
        <p className="muted">엑셀 표를 복사해 붙여 넣거나 CSV·JSON을 넣습니다. 첫 줄은 머리글입니다. 키 칸: PK, PK:2, UQ:이름, idx_이름:순서</p>
        <textarea className="spec" value={spec} placeholder={TEMPLATE} onChange={(e) => setSpec(e.target.value)} />
        <div className="inline">
          <button onClick={importSpec} disabled={!spec.trim()}>가져오기</button>
          <button onClick={() => setSpec(TEMPLATE + '\n')}>머리글 넣기</button>
        </div>
        {report.ok && <p>{report.ok}</p>}
        {report.errors.length > 0 && <ul className="warn">{report.errors.map((e) => <li key={e}>{e}</li>)}</ul>}
      </details>
      {node.tables.map((t) => <TableEditor key={t.name} node={node} t={t} />)}
      <button onClick={() => edit((p) => addTable(p, node.id))}>테이블 추가</button>
    </Section>
  );
}

export function TableEditor({ node, t, open, onRename }: { node: ProjectNode; t: Table; open?: boolean; onRename?: (name: string) => void }) {
  const { edit } = usePick('edit');
  const upd = (patch: Partial<Table>) => edit((p) => updateTable(p, node.id, t.name, patch));
  const setCol = (i: number, patch: Partial<Column>) => upd({ columns: patchAt(t.columns, i, patch) });
  const setIx = (i: number, patch: Partial<Table['indexes'][number]>) => upd({ indexes: patchAt(t.indexes, i, patch) });
  const padded = !!nodeStorageProfile(node, catalog.byId)?.fixed_width_padded;

  return (
    <details className="table-editor" open={open}>
      <summary><b>{t.name}</b>{t.label && ` ${t.label}`} <span className="muted">{t.record === 'fixed' ? '고정장 · ' : ''}컬럼 {t.columns.length} · 인덱스 {t.indexes.length}{t.partition ? ' · 파티션' : ''}</span></summary>
      <Row label="이름"><input defaultValue={t.name} onBlur={(e) => { if (e.target.value && e.target.value !== t.name) { upd({ name: e.target.value }); onRename?.(e.target.value); } }} /></Row>
      <TextField label="논리명" value={t.label} onChange={(v) => upd({ label: v || undefined })} />
      <TextField label="설명" value={t.description} onChange={(v) => upd({ description: v || undefined })} />
      <Row label="장 형식" hint={`고정장: 문자열·바이너리를 최대 길이만큼 채워 저장(CHAR(n)·BINARY(n)). 가변장: 실제 길이(VARCHAR). ${padded ? '이 시스템은 고정장이면 최대 길이로 크기를 계산해요' : '이 시스템은 고정 길이 문자열도 실제 길이로 저장해 크기는 같아요'}`}>
        <Select value={t.record} onChange={(e) => upd({ record: e.target.value as Table['record'] })}>
          <option value="variable">가변장</option><option value="fixed">고정장</option>
        </Select>
      </Row>
      <NumField label="보관 일수" value={t.retention_days} hint="비우면 프로젝트 보관 기간" onChange={(v) => upd({ retention_days: v })} />
      <NumField label="갱신 비율" value={t.update_ratio} step={0.05} hint="쓰기 중 새 행이 아니라 기존 행을 고치는 비율" onChange={(v) => upd({ update_ratio: v ?? 0 })} />
      <Row label="기본 키" hint="쉼표로 구분, 순서대로">
        <input key={t.primary_key.join()} defaultValue={csv(t.primary_key)} onBlur={(e) => upd({ primary_key: list(e.target.value) })} />
      </Row>
      <Row label="파티션">
        <span className="inline">
          <Select value={t.partition?.column ?? ''} onChange={(e) => upd({ partition: e.target.value ? { column: e.target.value, interval: t.partition?.interval ?? 'month' } : undefined })}>
            <option value="">(없음)</option>
            {t.columns.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
          </Select>
          {t.partition && <Select value={t.partition.interval} onChange={(e) => upd({ partition: { ...t.partition!, interval: e.target.value as 'day' } })}>
            <option value="day">일</option><option value="week">주</option><option value="month">월</option>
          </Select>}
        </span>
      </Row>

      <div className="plans"><table className="grid">
        <thead><tr><th>컬럼</th><th>타입</th><th>저장 형식</th><th>최대</th><th>평균</th><th>NULL</th><th /></tr></thead>
        <tbody>{t.columns.map((c, i) => (
          // 이름 칸이 입력 중 값을 들고 있어서(defaultValue) 지운 줄 뒤의 칸이 옛 값을 보이지 않게 이름까지 키에 넣는다
          <tr key={`${i}-${c.name}`}>
            <td><input defaultValue={c.name} onBlur={(e) => e.target.value && e.target.value !== c.name && setCol(i, { name: e.target.value })} /></td>
            <td><Select value={c.type} onChange={(e) => setCol(i, { type: e.target.value as Column['type'] })}>
              {COLUMN_TYPES.map((x) => <option key={x}>{x}</option>)}
            </Select></td>
            <td><Select value={c.storage ?? ''} onChange={(e) => setCol(i, { storage: (e.target.value || undefined) as Column['storage'] })}>
              <option value="">(기본)</option>
              {STORAGE_FORMATS.map((x) => <option key={x} value={x}>{STORAGE_NAMES[x]}</option>)}
            </Select></td>
            <td><input type="number" value={c.max_length ?? ''} aria-invalid={t.record === 'fixed' && (c.type === 'text' || c.type === 'bytes') && !c.max_length} onChange={(e) => setCol(i, { max_length: e.target.value ? Number(e.target.value) : undefined })} /></td>
            <td><input type="number" value={c.avg_bytes ?? ''} onChange={(e) => setCol(i, { avg_bytes: e.target.value ? Number(e.target.value) : undefined })} /></td>
            <td><input type="checkbox" checked={c.nullable} onChange={(e) => setCol(i, { nullable: e.target.checked })} /></td>
            <td><button aria-label="컬럼 삭제" onClick={() => upd({ columns: t.columns.filter((_, k) => k !== i) })}>×</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => upd({ columns: [...t.columns, { name: `col_${t.columns.length + 1}`, type: 'text', nullable: false, personal: false }] })}>컬럼 추가</button>

      <details>
        <summary>데이터 사전 (논리명·도메인·코드 값·기본값·개인정보)</summary>
        <p className="muted">코드 값은 "C=카드, M=현금"처럼 쉼표로. 넣으면 DDL에 CHECK 제약이 들어가요. 기본값의 숫자·true·CURRENT_TIMESTAMP는 그대로, 나머지는 문자열로 넣어요</p>
        <div className="plans"><table className="grid">
          <thead><tr><th>컬럼</th><th>논리명</th><th>도메인</th><th>코드 값</th><th>기본값</th><th>개인정보</th><th>설명</th></tr></thead>
          <tbody>{t.columns.map((c, i) => (
            <tr key={`${i}-${c.name}`}>
              <td>{c.name}</td>
              <td><input defaultValue={c.label ?? ''} aria-label={`${c.name} 논리명`} onBlur={(e) => setCol(i, { label: e.target.value || undefined })} /></td>
              <td><input defaultValue={c.domain ?? ''} aria-label={`${c.name} 도메인`} placeholder="금액·코드·일시…" onBlur={(e) => setCol(i, { domain: e.target.value || undefined })} /></td>
              <td><input defaultValue={codesText(c.codes)} aria-label={`${c.name} 코드 값`} onBlur={(e) => setCol(i, { codes: parseCodes(e.target.value) })} /></td>
              <td><input defaultValue={c.default_value ?? ''} aria-label={`${c.name} 기본값`} onBlur={(e) => setCol(i, { default_value: e.target.value || undefined })} /></td>
              <td><input type="checkbox" checked={c.personal} aria-label={`${c.name} 개인정보`} onChange={(e) => setCol(i, { personal: e.target.checked })} /></td>
              <td><input defaultValue={c.description ?? ''} aria-label={`${c.name} 설명`} onBlur={(e) => setCol(i, { description: e.target.value || undefined })} /></td>
            </tr>
          ))}</tbody>
        </table></div>
      </details>

      <div className="plans"><table className="grid">
        <thead><tr><th>인덱스</th><th>컬럼(쉼표)</th><th>고유</th><th /></tr></thead>
        <tbody>{t.indexes.map((x, i) => (
          <tr key={`${i}-${x.name}-${x.columns.join()}`}>
            <td><input defaultValue={x.name} onBlur={(e) => e.target.value && setIx(i, { name: e.target.value })} /></td>
            <td><input defaultValue={csv(x.columns)} onBlur={(e) => setIx(i, { columns: list(e.target.value) })} /></td>
            <td><input type="checkbox" checked={x.unique} onChange={(e) => setIx(i, { unique: e.target.checked })} /></td>
            <td><button aria-label="인덱스 삭제" onClick={() => upd({ indexes: t.indexes.filter((_, k) => k !== i) })}>×</button></td>
          </tr>
        ))}</tbody>
      </table></div>
      <button onClick={() => upd({ indexes: [...t.indexes, { name: `idx_${t.indexes.length + 1}`, columns: [t.columns[0].name], unique: false }] })}>인덱스 추가</button>
      <button className="danger" onClick={() => edit((p) => removeTable(p, node.id, t.name))}>테이블 삭제</button>
    </details>
  );
}

/** 주 항목의 저장 프로필에서 기능 고르기. 아무것도 안 고르면 권장 기능이 켜진다 */
export function StorageSection({ node }: { node: ProjectNode }) {
  const { edit } = usePick('edit');
  const sp = nodeStorageProfile(node, catalog.byId);
  if (!sp) return null;
  const on = selectedFeatures(sp, node).map((f) => f.id);
  const set = (ids: string[] | undefined) => edit((p) => updateNode(p, node.id, { storage_features: ids }));
  return (
    <Section title="저장 기능">
      {sp.note && <p className="muted">{sp.note}</p>}
      {Object.entries(sp.groups).map(([g, def]) => (
        <div key={g} className="feature-group">
          <div className="muted">{def.label}{def.one ? '' : ' (여러 개)'}</div>
          {sp.features.filter((f) => f.group === g).map((f) => (
            <label key={f.id} title={[f.note, f.source].filter(Boolean).join('\n')}>
              <input type={def.one ? 'radio' : 'checkbox'} name={`${node.id}-${g}`} checked={on.includes(f.id)}
                onChange={(e) => edit((p) => setFeature(p, node.id, f.id, e.target.checked))} />
              {f.label}{f.recommended && <span className="tag">권장</span>}
            </label>
          ))}
        </div>
      ))}
      <div className="inline">
        <span className="muted">{node.storage_features ? '직접 고름' : '권장 기능 사용 중'}</span>
        {node.storage_features && <button onClick={() => set(undefined)}>권장으로 되돌리기</button>}
      </div>
    </Section>
  );
}
