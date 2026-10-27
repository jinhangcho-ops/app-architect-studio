import { describe, expect, it } from 'vitest';
import { cmpVersion, normName, parseRequirements, versionOf } from '../requirements';

// 사용자가 붙여 준 pip freeze 결과 (2026-10-27)
const frozen = `annotated-doc==0.0.5
annotated-types==0.8.0
anyio==4.15.1
certifi==2026.10.18
fastapi==0.146.0
pydantic==2.14.1
pydantic_core==2.50.1
PyJWT==2.15.1
python-dotenv==1.2.4
starlette==1.7.0
StrEnum==0.4.15
supabase==2.33.0
typing_extensions==4.16.0
uvicorn==0.54.0`;

describe('requirements.txt 읽기', () => {
  it('pip freeze 결과: 모든 줄을 읽고 이름은 정규화', () => {
    const r = parseRequirements(frozen);
    expect(r.skipped).toEqual([]);
    expect(r.reqs).toHaveLength(14);
    expect(versionOf(r, 'fastapi')).toBe('0.146.0');
    expect(versionOf(r, 'pydantic')).toBe('2.14.1');
    expect(versionOf(r, 'starlette')).toBe('1.7.0');
    // 대소문자·_·. 는 같은 이름
    expect(versionOf(r, 'pyjwt')).toBe('2.15.1');
    expect(versionOf(r, 'Typing.Extensions')).toBe('4.16.0');
    expect(r.reqs.find((x) => x.name === 'strenum')?.line).toBe(11);
  });

  it('범위는 허용되는 가장 낮은 버전으로, 하한이 없으면 모름', () => {
    const r = parseRequirements([
      'fastapi>=0.95,<1.0',
      'pydantic~=1.10',
      'starlette==0.27.*',
      'uvicorn<0.30',
      'httpx',
      'anyio (>=3.7)',
      'h11>0.14,!=0.15',
    ].join('\n'));
    expect(r.skipped).toEqual([]);
    expect(versionOf(r, 'fastapi')).toBe('0.95');
    expect(versionOf(r, 'pydantic')).toBe('1.10');
    expect(versionOf(r, 'starlette')).toBe('0.27');
    expect(versionOf(r, 'uvicorn')).toBeUndefined();
    expect(versionOf(r, 'httpx')).toBeUndefined();
    expect(versionOf(r, 'anyio')).toBe('3.7');
    expect(versionOf(r, 'h11')).toBe('0.14');
    expect(versionOf(r, 'not-listed')).toBeUndefined();
  });

  it('extras·환경 표시·주석·줄 이음·해시 옵션', () => {
    const r = parseRequirements([
      '\uFEFF# 서버',
      'fastapi[standard,all]==0.115.0  # 웹',
      'pydantic==1.10.13 ; python_version < "3.8"',
      'pydantic==2.5.0 ; python_version >= "3.8"',
      'uvicorn==0.30.0 \\',
      '    --hash=sha256:abc',
      '',
    ].join('\n'));
    expect(r.skipped).toEqual([]);
    const fa = r.reqs.find((x) => x.name === 'fastapi')!;
    expect(fa.extras).toEqual(['standard', 'all']);
    expect(fa.min).toBe('0.115.0');
    expect(r.reqs.filter((x) => x.name === 'pydantic').map((x) => x.marker)).toEqual(['python_version < "3.8"', 'python_version >= "3.8"']);
    // 환경마다 다르면 가장 낮은 버전 (어느 환경에서도 돌아야 함)
    expect(versionOf(r, 'pydantic')).toBe('1.10.13');
    expect(versionOf(r, 'uvicorn')).toBe('0.30.0');
  });

  it('설치 옵션·경로·주소 줄과 읽지 못한 조건은 줄 번호와 함께 알림', () => {
    const r = parseRequirements([
      '-r base.txt',
      '--index-url https://example.com/simple',
      '-e .',
      './libs/mypkg',
      'git+https://github.com/x/y.git#egg=y',
      'mypkg @ https://example.com/mypkg-1.0.whl',
      'fastapi==latest',
      'pydantic>=2',
    ].join('\n'));
    expect(r.skipped.map((s) => s.split(':')[0])).toEqual(['1번째 줄', '2번째 줄', '3번째 줄', '4번째 줄', '5번째 줄', '7번째 줄']);
    expect(r.reqs.map((x) => [x.name, x.min])).toEqual([['mypkg', undefined], ['pydantic', '2']]);
  });

  it('버전 비교는 숫자로 (0.100 > 0.99, 2.0.0a1 = 2.0)', () => {
    expect(cmpVersion('0.100.0', '0.99.1')).toBe(1);
    expect(cmpVersion('2.0.0a1', '2.0')).toBe(0);
    expect(cmpVersion('1.10', '1.9.9')).toBe(1);
    expect(normName('Typing__Extensions')).toBe('typing-extensions');
  });
});

it('python_version 표시 판단 (주.부 버전만, 그 밖의 표시는 모름)', async () => {
  const { markerHolds } = await import('../requirements');
  expect(markerHolds('python_version < "3.12"', '3.12.1')).toBe(false);
  expect(markerHolds("python_version>='3.8'", '3.10')).toBe(true);
  expect(markerHolds('sys_platform == "win32"', '3.12')).toBeUndefined();
});
