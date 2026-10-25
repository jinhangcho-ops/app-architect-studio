// 패널에서 반복되는 입력 칸. 빈 칸은 undefined(= 값 없음)로 돌려준다.
import type { ReactNode } from 'react';

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="row" title={hint}>
      {/* 도움말은 넓은 설정 화면에서만 글로 보이고, 좁은 패널에서는 마우스를 올리면 보인다 */}
      <span>{label}{hint && <small className="help">{hint}</small>}</span>
      {children}
    </label>
  );
}

export function NumField({ label, value, onChange, step, hint, disabled }: {
  label: string; value?: number; onChange: (v: number | undefined) => void; step?: number; hint?: string; disabled?: boolean;
}) {
  return (
    <Row label={label} hint={hint}>
      <input
        type="number"
        step={step ?? 'any'}
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      />
    </Row>
  );
}

export function TextField({ label, value, onChange }: { label: string; value?: string; onChange: (v: string) => void }) {
  return (
    <Row label={label}>
      <input value={value ?? ''} onChange={(e) => onChange(e.target.value)} />
    </Row>
  );
}

export function Section({ title, children, id, desc }: { title: string; children: ReactNode; id?: string; desc?: string }) {
  return (
    <section className="section" id={id}>
      <h3>{title}</h3>
      {desc && <p className="desc">{desc}</p>}
      {children}
    </section>
  );
}
