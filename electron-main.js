'use strict';

const { app: desktopApp, BrowserWindow, dialog } = require('electron');
const { once } = require('node:events');
const path = require('node:path');

desktopApp.setPath('userData', path.join(desktopApp.getPath('appData'), 'school-timetabling'));
desktopApp.setAppUserModelId('com.schooltimetabling.desktop');

const dataDirectory = desktopApp.isPackaged
  ? path.join(desktopApp.getPath('userData'), 'data')
  : path.join(__dirname, 'data');
process.env.TIMETABLE_DATA_DIR = dataDirectory;

const { app: webApp } = require('./server');

let server;

async function openDesktopApp() {
  server = webApp.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  const mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const origin = new URL(url).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    return new URL(targetUrl).origin === origin ? { action: 'allow' } : { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (new URL(targetUrl).origin !== origin) event.preventDefault();
  });
  await mainWindow.loadURL(url);
}

desktopApp.whenReady().then(openDesktopApp).catch(error => {
  console.error('Could not start School Timetabling:', error);
  dialog.showErrorBox('School Timetabling could not start', error.message);
  desktopApp.quit();
});

desktopApp.on('window-all-closed', () => {
  if (process.platform !== 'darwin') desktopApp.quit();
});

desktopApp.on('before-quit', () => {
  if (server) server.close();
});
