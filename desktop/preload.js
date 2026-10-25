/**
 * 渲染进程与主进程之间的安全桥。
 * 网页侧只能调用这里显式暴露的方法，拿不到 Node 能力，也拿不到密钥原文。
 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('bcNative', {
  isDesktop: true,
  platform: process.platform,

  cfg: {
    get: () => ipcRenderer.invoke('cfg:get'),
    set: (patch) => ipcRenderer.invoke('cfg:set', patch),
    path: () => ipcRenderer.invoke('cfg:path'),
  },

  notion: {
    verify: () => ipcRenderer.invoke('notion:verify'),
    search: (query) => ipcRenderer.invoke('notion:search', { query }),
    children: (pageId) => ipcRenderer.invoke('notion:children', { pageId }),
    import: (pageId, downloadImages) => ipcRenderer.invoke('notion:import', { pageId, downloadImages }),
    saveNew: (p) => ipcRenderer.invoke('notion:saveNew', p),
    updatePage: (p) => ipcRenderer.invoke('notion:updatePage', p),
    /** 存档：mode = new 新建 | append 追加到页面 | replace 覆盖页面 */
    archive: (p) => ipcRenderer.invoke('notion:archive', p),
    writeback: (p) => ipcRenderer.invoke('notion:writeback', p),
  },

  wechat: {
    ip: () => ipcRenderer.invoke('wechat:ip'),
    probe: () => ipcRenderer.invoke('wechat:probe'),
    push: (pkg) => ipcRenderer.invoke('wechat:push', pkg),
    drafts: (count) => ipcRenderer.invoke('wechat:drafts', { count }),
    deleteDraft: (mediaId) => ipcRenderer.invoke('wechat:deleteDraft', { mediaId }),
    dashboard: () => ipcRenderer.invoke('wechat:dashboard'),
  },

  /** 文稿库：编辑器内容持久化到 userData，关掉应用不丢 */
  docs: {
    list: () => ipcRenderer.invoke('docs:list'),
    get: (id) => ipcRenderer.invoke('docs:get', { id }),
    save: (p) => ipcRenderer.invoke('docs:save', p),
    create: (title, content) => ipcRenderer.invoke('docs:create', { title, content }),
    select: (id) => ipcRenderer.invoke('docs:select', { id }),
    remove: (id) => ipcRenderer.invoke('docs:delete', { id }),
  },

  app: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', { url }),
    saveJson: (filename, data) => ipcRenderer.invoke('app:saveJson', { filename, data }),
    openPath: (p) => ipcRenderer.invoke('app:openPath', { p }),
    limits: () => ipcRenderer.invoke('app:limits'),
    lanInfo: () => ipcRenderer.invoke('lan:info'),
    quit: () => ipcRenderer.invoke('app:quit'),
  },

  onProgress: (cb) => on('progress', cb),
  onLanChanged: (cb) => on('lan:changed', cb),
});
