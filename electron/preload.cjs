// 화면(렌더러)에 넘길 데스크톱 기능: 파일 열기·저장과 프로젝트 폴더의 저장 시점. 실제 파일 처리는 main 쪽(files.cjs)이 한다
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (file, text, suggested) => ipcRenderer.invoke('file:save', file, text, suggested),
  writeSnapshot: (file, kind, name, text, max) => ipcRenderer.invoke('snap:write', file, kind, name, text, max),
  listSnapshots: (file, kind) => ipcRenderer.invoke('snap:list', file, kind),
  savePngs: (files) => ipcRenderer.invoke('png:save', files),
  saveTexts: (files) => ipcRenderer.invoke('text:save', files),
});
