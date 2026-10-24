# App Architect Studio

레이어별 알고리즘·도구를 캔버스에서 연결해 앱 구조를 설계하는 도구입니다. 선택한 항목이 예상 규모에서 되는지·안 되는지와 더 나은 대안을 알려 주고, 트래픽·테이블 크기·비용·한계·성장·확인할 법 조문을 계산해 설계서(PDF)로 내보냅니다.

## 설치 (Windows)

1. [Releases](https://github.com/jinhangcho-ops/app-architect-studio/releases)에서 최신 `App-Architect-Studio-Setup-<버전>.exe`를 받습니다.
2. 실행하면 설치 창이 열립니다.
   - 설치 위치를 고릅니다 (기본: `C:\Users\<이름>\AppData\Local\Programs\App Architect Studio`).
   - 마지막 화면에서 **바탕화면에 바로가기 만들기**를 켜거나 끕니다.
3. 시작 메뉴나 바탕화면 바로가기로 실행합니다. 지울 때는 Windows **설정 › 앱**에서 "App Architect Studio"를 제거합니다.

> 설치 파일은 아직 코드 서명이 없어서, 처음 실행할 때 "Windows의 PC 보호" 창이 뜰 수 있습니다. **추가 정보 › 실행**을 누르세요.

> **받은 설치 파일 확인 (권장):** Releases에는 설치 파일과 같은 이름의 `.sha256` 파일(설치 파일의 지문)이 함께 있습니다. 둘을 같은 폴더에 받은 뒤, 그 폴더에서 PowerShell을 열고 아래 한 줄을 실행하세요. 버전 숫자는 받은 파일에 맞게 바꿉니다.
>
> ```powershell
> $f = "App-Architect-Studio-Setup-1.0.0.exe"; if ((Get-FileHash $f).Hash -eq (Get-Content "$f.sha256").Split(' ')[0]) { "일치: 올린 파일 그대로입니다" } else { "다름: 설치하지 말고 다시 받으세요" }
> ```
>
> "다름"이 나오면 받는 도중 파일이 깨졌거나 누군가 바꾼 것입니다. 이 지문은 같은 Releases 페이지에서 받으므로, Releases 자체가 바뀌는 경우까지 막지는 못합니다.

> **앱 파일 변조 검사:** 앱 코드 묶음(`resources/app.asar`)의 지문(SHA-256)이 실행 파일에 들어 있어, 실행할 때마다 Electron이 대조합니다. 한 바이트라도 바뀌었거나 묶음 대신 다른 코드 폴더를 넣으면 앱이 열리지 않습니다. **설치 후 앱이 바로 꺼지면 앱 파일이 손상되거나 바뀐 것이니 최신 설치 파일로 다시 설치하세요.** 코드 서명이 없는 동안에는 실행 파일 자체를 고치는 공격까지는 막지 못합니다.

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
