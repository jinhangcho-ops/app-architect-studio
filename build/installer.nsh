; 설치 창 마지막 페이지: "앱 실행"과 함께 "바탕화면에 바로가기 만들기"를 고르게 한다 (기본으로 켜 둠).
; electron-builder의 createDesktopShortcut은 묻지 않고 만들거나 안 만들기만 해서, 끄고(false) 여기서 체크박스로 만든다.

!macro customFinishPage
  Function StartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd

  Function CreateDesktopShortcut
    CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "바탕화면에 바로가기 만들기"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcut"
  !insertmacro MUI_PAGE_FINISH
!macroend

; 자동 만들기를 껐기 때문에 기본 제거 과정이 바탕화면 바로가기를 지우지 않는다. 체크박스로 만든 것을 여기서 지운다
; 업데이트(옛 언인스톨러가 --updated로 돎)에서는 지우지 않는다: 조용한 설치(/S)는 완료 페이지를 건너뛰어 다시 만들지 않으므로
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${endIf}
!macroend
