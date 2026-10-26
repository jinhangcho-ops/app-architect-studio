// 설치형 데스크톱 앱에서만 있는 기능(electron/preload.cjs). 브라우저에서는 undefined라 기존 방식(브라우저 저장소·내려받기)을 쓴다
export type DesktopApi = {
  isDesktop: true;
  openFile: () => Promise<{ path: string; text: string } | null>;
  /** file이 없으면 저장 창을 띄운다. 저장한 경로(취소면 null) */
  saveFile: (file: string | undefined, text: string, suggested: string) => Promise<string | null>;
  writeSnapshot: (file: string, kind: 'manual' | 'auto', name: string, text: string, max: number) => Promise<boolean>;
  listSnapshots: (file: string, kind: 'manual' | 'auto') => Promise<{ name: string; text: string }[]>;
  /** 한 장이면 저장 창, 여러 장이면 폴더 고르기. 저장한 경로들(취소면 null) */
  savePngs: (files: { name: string; base64: string }[]) => Promise<string[] | null>;
  /** 글자 파일 여러 개(명세 등)를 고른 폴더에. 저장한 경로들(취소면 null) */
  saveTexts: (files: { name: string; text: string }[]) => Promise<string[] | null>;
  /** GitHub Releases에 지금보다 새 버전이 있으면 그 정보, 없거나 확인할 수 없으면 null */
  checkUpdate: () => Promise<{ current: string; version: string; url: string; installer?: unknown } | null>;
  /** 확인한 새 버전의 설치 파일을 받아 지문을 대조하고, 맞으면 설치 프로그램을 띄우고 앱을 닫는다 */
  installUpdate: () => Promise<{ ok: boolean; reason?: string }>;
  /** 이 저장소의 Releases 페이지를 브라우저로 연다 */
  openRelease: (url: string) => Promise<void>;
};

export const desktop = (globalThis as { desktop?: DesktopApi }).desktop;

/** 새 버전 확인 켜짐·꺼짐 (이 PC의 앱 설정, 기본 켜짐). 저장소를 못 쓰면 켜짐으로 본다 */
const UPDATE_KEY = 'app-architect-studio.update-check.v1';
export const updateCheckOn = () => { try { return globalThis.localStorage?.getItem(UPDATE_KEY) !== 'off'; } catch { return true; } };
export const setUpdateCheck = (on: boolean) => { try { globalThis.localStorage?.setItem(UPDATE_KEY, on ? 'on' : 'off'); } catch { /* 이번 실행에서만 */ } };

/** 시점 파일 이름: 현지 시각 2026-10-24_03-15-00 (이름 순서 = 시간 순서) */
export const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};
/** stamp로 만든 이름 → 시각 */
export const stampTime = (name: string) => {
  const [d, t] = name.split('_');
  return new Date(`${d}T${t.replace(/-/g, ':')}`);
};

export const baseName = (file: string) => file.split(/[\\/]/).pop() ?? file;
