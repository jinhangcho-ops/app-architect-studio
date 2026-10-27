// 패널에서 반복되는 입력 칸. 빈 칸은 undefined(= 값 없음)로 돌려준다.
import { useState, type InputHTMLAttributes, type ReactNode } from 'react';

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
      <NumInput
        step={step ?? 'any'}
        value={value ?? ''}
        disabled={disabled}
        // 비운 칸은 떠날 때만 "값 없음"으로 보낸다. 지우고 다시 치는 중에 보내면 묶음 전체(처리 시간·배치·백업)를 지우는 칸이 함께 묶인 값을 잃는다
        onChange={(e) => { if (e.target.value !== '') onChange(Number(e.target.value)); }}
        onBlur={(e) => { if (e.target.value === '' && value !== undefined) onChange(undefined); }}
      />
    </Row>
  );
}

/** 숫자 칸. 고치는 동안은 친 글자를 그대로 보여서 중간 값(0, 4 …)이 거절·보정되어도 칸이 되돌아가지 않고, 칸을 떠나면 저장된 값으로 맞춘다 */
export function NumInput({ value, onChange, onBlur, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  const [draft, setDraft] = useState<string>();
  return (
    <input
      type="number"
      {...rest}
      value={draft ?? value ?? ''}
      onChange={(e) => { setDraft(e.target.value); onChange?.(e); }}
      onBlur={(e) => { setDraft(undefined); onBlur?.(e); }}
    />
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
