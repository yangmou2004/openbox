/**
 * Electron 的最小替身。只用于在纯 Node 里把 out/main/index.js 跑起来，
 * 这样多数据库那套逻辑（清单、重命名、改文件名、切换）能真跑一遍，
 * 而不必开 GUI。
 */
"use strict";

const handlers = new Map();

/** 测试可以改这几个钩子，用来喂给主进程「用户选了哪个文件」 */
const hooks = {
  saveDialog: async () => ({ canceled: true, filePath: undefined }),
  openDialog: async () => ({ canceled: true, filePaths: [] }),
  revealed: []
};

class BrowserWindow {
  constructor() {
    this.webContents = { setWindowOpenHandler() {} };
  }
  on() {}
  loadFile() {}
  loadURL() {}
  show() {}
  isMinimized() {
    return false;
  }
  restore() {}
  focus() {}
  static getAllWindows() {
    return [];
  }
}

module.exports = {
  app: {
    requestSingleInstanceLock: () => true,
    on() {},
    whenReady: () => Promise.resolve(),
    quit() {},
    getPath: () => process.env.OPENBOX_DATA_DIR || require("os").tmpdir()
  },
  BrowserWindow,
  ipcMain: {
    handle(channel, fn) {
      handlers.set(channel, fn);
    }
  },
  dialog: {
    showSaveDialog: (...a) => hooks.saveDialog(...a),
    showOpenDialog: (...a) => hooks.openDialog(...a)
  },
  shell: {
    openExternal() {},
    showItemInFolder(p) {
      hooks.revealed.push(p);
    }
  },
  net: { fetch: async () => new Response("") },
  protocol: {
    registerSchemesAsPrivileged() {},
    handle() {}
  },
  contextBridge: { exposeInMainWorld() {} },
  ipcRenderer: { invoke: async () => undefined },

  // 测试用
  __handlers: handlers,
  __hooks: hooks
};
