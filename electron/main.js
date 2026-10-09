/**
 * electron/main.js — Electron 主进程
 *
 * 启动时内嵌启动 Node 服务(随机端口),然后打开桌面窗口加载前端。
 */
'use strict';

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const store = require('../lib/store');
const { startServer } = require('../server');

let mainWindow = null;
let serverHandle = null;

async function boot() {
  // 数据写到用户目录(asar 只读,不能写进打包归档)
  store.setConfigDir(app.getPath('userData'));
  // 可通过环境变量 XTERMINAL_PORT 固定端口,默认随机端口避免冲突
  const port = parseInt(process.env.XTERMINAL_PORT, 10) || 0;
  const { server } = await startServer(port);
  serverHandle = server;
  createWindow(server.address().port);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 780,
    minWidth: 860,
    minHeight: 520,
    backgroundColor: '#1e1f22',
    autoHideMenuBar: true,
    title: 'XBTerminal — 肖巴的远程终端',
    icon: path.join(__dirname, '..', 'public', 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      spellcheck: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // 渲染进程异常退出时自动重载,避免整窗闪退
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit' && !mainWindow.isDestroyed()) {
      mainWindow.webContents.reload();
    }
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 阻止拖拽文件等导致的默认导航(只允许停留在本应用地址,避免整窗跳到 file:// 页面)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) e.preventDefault();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(boot).catch((e) => {
  console.error('启动失败:', e);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && serverHandle) {
    createWindow(serverHandle.address().port);
  }
});

app.on('before-quit', () => {
  try { serverHandle && serverHandle.close(); } catch (e) {}
});
