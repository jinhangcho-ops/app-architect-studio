// 화면(렌더러)에 넘길 데스크톱 기능. 지금은 데스크톱 앱인지 알리는 것만 둔다
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktop', { isDesktop: true });
