# App Architect Studio

레이어별 알고리즘·도구를 캔버스에서 연결해 앱 구조를 설계하는 도구입니다. 선택한 항목이 예상 규모에서 되는지·안 되는지와 더 나은 대안을 알려 주고, 트래픽·테이블 크기·비용·한계·성장·확인할 법 조문을 계산해 설계서(PDF)로 내보냅니다.

## 설치 (Windows)

1. [Releases](https://github.com/jinhangcho-ops/app-architect-studio/releases)에서 최신 `App-Architect-Studio-Setup-<버전>.exe`를 받습니다.
2. 실행하면 설치 창이 열립니다.
   - 설치 위치를 고릅니다 (기본: `C:\Users\<이름>\AppData\Local\Programs\App Architect Studio`).
   - 마지막 화면에서 **바탕화면에 바로가기 만들기**를 켜거나 끕니다.
3. 시작 메뉴나 바탕화면 바로가기로 실행합니다. 지울 때는 Windows **설정 › 앱**에서 "App Architect Studio"를 제거합니다.

> 설치 파일은 아직 코드 서명이 없어서, 처음 실행할 때 "Windows의 PC 보호" 창이 뜰 수 있습니다. **추가 정보 › 실행**을 누르세요.

## 단축키

| 키 | 동작 |
|---|---|
| Ctrl+S | 저장 (저장 기록에 시점을 남김, 최대 20개) |
| Ctrl+Shift+S | 파일로 내보내기 (JSON) |
| Ctrl+O | 파일 열기 |
| Ctrl+Z / Ctrl+Y | 되돌리기 / 다시 하기 |
| Ctrl+F | 노드·항목·테이블·컬럼 찾기 |
| Ctrl+C / Ctrl+V | 노드 복사 / 붙여넣기 |
| Esc | 설계서 닫기 → 블록 안에서 나오기 → 선택 해제 |

자동 저장은 고칠 때마다 최신 시점을 덮어쓰고, 간격(기본 10분, **저장 기록**에서 변경)마다 새 시점을 만듭니다(최대 10개). 강제로 닫혀도 다시 열면 복구를 제안합니다.

## 개발

Node 24가 필요합니다.

```bash
npm install
npx install-electron   # 데스크톱 실행용 Electron 런타임 받기 (한 번만)
npm run dev            # 브라우저에서 개발 화면 (http://localhost:5173)
npm test               # 테스트
npm run desktop        # 데스크톱 앱으로 실행
npm run installer      # release/ 폴더에 설치 파일 만들기
```

새 버전을 배포하려면 `package.json`의 `version`을 올리고 같은 이름의 태그(예: `v1.0.1`)를 올립니다. GitHub Actions가 테스트를 돌린 뒤 설치 파일을 Releases에 올립니다.
