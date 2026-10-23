import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadLaws } from '../io';
import { checkRegulation } from '../regulation';
import { Project } from '../schema';

const laws = loadLaws(fileURLToPath(new URL('../../data/laws', import.meta.url)));

const p = Project.parse({
  name: 'p',
  nodes: [
    { id: 'member', name: '회원 DB', layer: 'db', region: 'aws:ap-northeast-1', privacy: { personal: true, unique_id: true, subjects: ['KR'] } },
    { id: 'pay', name: '결제 연동', layer: 'external', region: 'aws:ap-northeast-2', privacy: { personal: true, subjects: ['KR'], sends_external: true } },
    { id: 'log', name: '주문 로그', layer: 'db', region: 'aws:ap-northeast-2', privacy: { personal: true, subjects: ['JP'] } },
    { id: 'local', name: '기기 저장', layer: 'db', region: 'local', privacy: { personal: true, subjects: ['KR', 'JP'] } },
    { id: 'plain', name: '통계', layer: 'analytics' },
  ],
});
const hits = checkRegulation(p, laws);
const of = (id: string) => hits.filter((h) => h.nodeId === id).map((h) => `${h.law} ${h.article}`);

describe('관문: 설계서 15절 표시 예시', () => {
  it('회원 DB(한국 사용자, 도쿄 리전, 고유식별정보) → 제28조의8·제29조·제24조', () => {
    expect(of('member')).toEqual(expect.arrayContaining(['개인정보 보호법 제28조의8', '개인정보 보호법 제29조', '개인정보 보호법 제24조']));
    expect(hits.find((h) => h.nodeId === 'member' && h.article === '제28조의8')!.reason).toBe('한국 사용자 개인정보 + 일본 리전 저장');
  });

  it('결제 연동(외부로 전송) → 제17조', () => {
    expect(of('pay')).toContain('개인정보 보호법 제17조');
    expect(of('pay')).not.toContain('개인정보 보호법 제28조의8'); // 서울 리전
  });

  it('주문 로그(일본 사용자, 서울 리전) → 個人情報保護法 第28条', () => {
    expect(of('log')).toContain('個人情報保護法 第28条');
  });

  it('기기에만 저장하면 국외 이전 조문은 걸리지 않음, 개인정보가 없으면 아무것도 없음', () => {
    expect(of('local')).not.toContain('개인정보 보호법 제28조의8');
    expect(of('local')).not.toContain('個人情報保護法 第28条');
    expect(of('plain')).toEqual([]);
  });

  it('조문 내용은 없고, 원문 대조 여부와 출처·기준일이 붙음', () => {
    for (const h of hits) {
      expect(Object.keys(h).sort()).toEqual(['article', 'asOf', 'law', 'nodeId', 'reason', 'source', 'verified']);
      expect(h.source).toMatch(/^https:\/\//);
    }
  });
});
