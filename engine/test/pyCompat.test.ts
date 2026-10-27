import { describe, expect, it } from 'vitest';
import { pyProfile } from '../pyCompat';

describe('버전 규칙표', () => {
  it('목록도 Python 버전도 없으면 최신 방식, 경고 없음', () => {
    expect(pyProfile({})).toMatchObject({ pydantic: 2, validateByName: false, annotated: true, builtinGenerics: true, run: 'standard', warnings: [] });
    expect(pyProfile({ requirements: '  \n' }).warnings).toEqual([]);
  });

  it('pydantic이 없으면 fastapi 버전으로 짐작 (0.100 전은 1)', () => {
    expect(pyProfile({ requirements: 'fastapi==0.99.1' }).pydantic).toBe(1);
    expect(pyProfile({ requirements: 'fastapi==0.100.0' }).pydantic).toBe(2);
  });

  it('함께 쓸 수 없는 조합은 경고', () => {
    const w = (requirements: string, python?: string) => pyProfile({ requirements, python }).warnings.join(' / ');
    expect(w('fastapi==0.95.0\npydantic==2.5.0')).toContain('pydantic 2를 쓰지 못합니다');
    expect(w('fastapi==0.126.0\npydantic==1.10.13')).toContain('pydantic 1을 쓰지 못합니다');
    expect(w('fastapi==0.135.2\npydantic==2.8.0')).toContain('pydantic 2.9 이상이 필요합니다');
    expect(w('fastapi==0.129.0\npydantic==2.9.0', '3.9')).toContain('Python 3.10 이상이 필요합니다');
    expect(w('fastapi==0.125.0\npydantic==2.9.0', '3.8')).toContain('Python 3.9 이상이 필요합니다');
    expect(w('fastapi==0.120.0\npydantic==2.9.0', '3.12')).toBe('');
    expect(w('pydantic==2.9.0')).toContain('fastapi가 없습니다');
    expect(w('fastapi\npydantic==2.9.0')).toContain('하한 버전이 없어');
    expect(w('-r base.txt\nfastapi==0.120.0')).toContain('1번째 줄');
  });
});

describe('상한만 적은 줄 (리뷰)', () => {
  it('pydantic<2·fastapi<0.100이면 pydantic 1, fastapi<0.95면 Annotated 대신 = Path(...)', () => {
    expect(pyProfile({ requirements: 'fastapi==0.110.0\npydantic<2' }).pydantic).toBe(1);
    expect(pyProfile({ requirements: 'fastapi>=0.100\npydantic<2.0' }).pydantic).toBe(1);
    expect(pyProfile({ requirements: 'fastapi<0.100' }).pydantic).toBe(1);
    expect(pyProfile({ requirements: 'fastapi<0.95' })).toMatchObject({ pydantic: 1, annotated: false });
    expect(pyProfile({ requirements: 'fastapi<=0.99.1' }).pydantic).toBe(1);
    // 상한이 경계보다 위면 그대로 최신 쪽
    expect(pyProfile({ requirements: 'fastapi<1\npydantic<3' })).toMatchObject({ pydantic: 2, annotated: true });
    // 환경 표시별 줄 중 하나라도 상한이 없으면 모름 → 최신 쪽
    expect(pyProfile({ requirements: 'pydantic<2 ; python_version<"3.8"\npydantic>=2 ; python_version>="3.8"' }).pydantic).toBe(2);
  });
});
