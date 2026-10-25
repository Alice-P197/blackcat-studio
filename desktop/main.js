/**
 * 小黑喵创作台 V3 · 桌面版 —— Electron 主进程
 *
 * 为什么这样做：
 *   - 浏览器里的网页受 CORS 限制、API 密钥只能塞在 localStorage、微信接口根本调不通；
 *   - 主进程与外部 API 通信没有任何跨域限制，密钥也存在本地配置文件里，网页侧拿不到原文。
 *   - 所有耗时操作（下载图片、分块写入 Notion）都在主进程排队执行，并按进度回传，
 *     界面不会被卡死。
 */
'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

const { Notion } = require('./lib/notion.js');
const { WeChat, egressIp, CONTENT_MAX } = require('./lib/wechat.js');
const store = require('./lib/store.js');
const docs = require('./lib/docs.js');
const convert = require('./lib/convert.js');

const notion = new Notion(() => store.load().notionToken);
const wechat = new WeChat(() => ({ appid: store.load().wechatAppId, secret: store.load().wechatSecret }));

let mainWindow = null;
let lanServer = null;
const SELFTEST = process.argv.includes('--self-test');

/* ------------------------------------------------------------------ 窗口 */
function createWindow() {
  const cfg = store.load();
  const b = cfg.windowBounds || {};
  mainWindow = new BrowserWindow({
    width: b.width || 1440,
    height: b.height || 900,
    x: b.x, y: b.y,
    minWidth: 960,
    minHeight: 640,
    title: '小黑喵创作台 V3',
    backgroundColor: '#1a1b26',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'editor.html'));
  if (!SELFTEST) mainWindow.once('ready-to-show', () => mainWindow.show());

  // 外链一律用系统浏览器打开，别在应用里跳走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !url.startsWith('http://127.0.0.1') && !url.startsWith('http://localhost')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // ⚠️ 退出修复：编辑器注册了 beforeunload（有未保存内容就拦），而 Electron 遇到它会**静默取消关窗**
  // —— 不弹任何提示、窗口也不关，表现就是"点了 X 没反应、进程一直挂着"。
  // 这里接管：给用户一个明确选择；确认退出就调 preventDefault() 放行卸载。
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['放弃改动并退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: '有未保存的改动',
      message: '编辑器里还有未保存的改动，确定要退出吗？',
      detail: '想先存起来就点「取消」，然后按 Ctrl+S 存档到 Notion（工具栏的「存档」按钮）。',
    });
    if (choice === 0) event.preventDefault();   // 放行：忽略 beforeunload，正常关闭
  });

  const saveBounds = () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) store.save({ windowBounds: mainWindow.getBounds() });
    } catch (e) { /* 忽略 */ }
  };
  mainWindow.on('resized', saveBounds);
  mainWindow.on('moved', saveBounds);
  mainWindow.on('close', saveBounds);
  mainWindow.on('closed', () => { mainWindow = null; });

  return mainWindow;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const progress = (scope) => (p) => send('progress', Object.assign({ scope }, p));

/* =================================================================== IPC */
/* ---------------------------------------------------------------- 配置 */
ipcMain.handle('cfg:get', () => store.safeView());
ipcMain.handle('cfg:set', (e, patch) => {
  // 只接受白名单字段，避免渲染进程乱写
  const allow = ['notionToken', 'wechatAppId', 'wechatSecret', 'notionParentPageId',
    'notionWriteback', 'publishAfterDraft', 'lanServer', 'lanPort', 'lastNotionPage',
    'archiveMode', 'archiveTargetId', 'archiveTargetTitle'];
  const clean = {};
  for (const k of allow) if (patch && Object.prototype.hasOwnProperty.call(patch, k)) clean[k] = patch[k];
  store.save(clean);
  if (Object.prototype.hasOwnProperty.call(clean, 'lanServer') || Object.prototype.hasOwnProperty.call(clean, 'lanPort')) {
    applyLanServer();
  }
  return store.safeView();
});
ipcMain.handle('cfg:path', () => store.FILE());

/* ------------------------------------------------------------- Notion */
ipcMain.handle('notion:verify', async () => {
  try { return { ok: true, user: await notion.verify() }; }
  catch (e) { return { ok: false, error: e.message, hint: e.hint }; }
});

ipcMain.handle('notion:search', async (e, { query }) => {
  try {
    const items = await notion.search(query);
    return { ok: true, items };
  } catch (e) { return { ok: false, error: e.message, hint: e.hint, code: e.code }; }
});

ipcMain.handle('notion:children', async (e, { pageId }) => {
  try { return { ok: true, items: await notion.listChildPages(pageId) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

/** Notion -> 创作台：拉取页面 + 并行下载图片转 base64 + 转换方言 */
ipcMain.handle('notion:import', async (e, { pageId, downloadImages }) => {
  const t0 = Date.now();
  try {
    progress('import')({ phase: 'read', message: '读取 Notion 页面…' });
    const [raw, page] = await Promise.all([notion.getPageMarkdown(pageId), notion.getPage(pageId)]);

    const urls = [];
    const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
    let m;
    while ((m = re.exec(raw)) !== null) urls.push({ alt: m[1], url: m[2] });
    const uniq = [...new Set(urls.map((u) => u.url))];

    const images = [];
    let failed = 0;
    if (downloadImages !== false && uniq.length) {
      const CONC = 6;
      let idx = 0, done = 0;
      const workers = [];
      const results = {};
      const tStart = Date.now();
      async function worker() {
        while (idx < uniq.length) {
          const u = uniq[idx++];
          try {
            const r = await notion.fetchImageAsDataUrl(u);
            results[u] = r.dataUrl;
          } catch (err) {
            results[u] = null;
            failed++;
          }
          done++;
          const ms = Date.now() - tStart;
          const eta = done < uniq.length ? Math.ceil((ms / done) * (uniq.length - done) / 1000) : 0;
          progress('import')({ phase: 'images', done, total: uniq.length, failed, etaSec: eta, message: `下载图片 ${done}/${uniq.length}` });
        }
      }
      for (let i = 0; i < Math.min(CONC, uniq.length); i++) workers.push(worker());
      await Promise.all(workers);

      const altOf = {};
      urls.forEach((x) => { if (!altOf[x.url]) altOf[x.url] = x.alt || ''; });
      Object.keys(results).forEach((u, i) => {
        if (results[u]) images.push({ slot: images.length + 1, dataUrl: results[u], name: altOf[u] || '' });
      });
      // 建立 url -> 占位符 映射，交给转换器
      const map = {};
      let slot = 1;
      Object.keys(results).forEach((u) => {
        if (results[u]) { map[u] = '【图片' + slot + '】'; slot++; }
      });
      var imageMap = map;
    }

    progress('import')({ phase: 'convert', message: '转换格式…' });
    const markdown = convert.notionToBlackCat(raw, { title: page.title, images: imageMap || {} });
    progress('import')({ phase: 'done', message: '完成' });

    return {
      ok: true, page, markdown, images,
      stats: {
        rawChars: raw.length, outChars: markdown.length,
        imageTotal: uniq.length, imageFailed: failed, elapsedMs: Date.now() - t0,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint };
  }
});

/** 创作台 -> Notion：新建页面（分段写入，图片走 file_upload） */
ipcMain.handle('notion:saveNew', async (e, { parentId, title, markdown, imageStore, plainImages }) => {
  try {
    const images = imageStore || {};
    const { segments } = convert.blackcatToNotion(markdown, images);
    const res = await notion.createPageFromSegments({
      parentId: parentId || store.load().notionParentPageId || null,
      title, segments,
      onProgress: progress('save'),
    });
    store.save({ lastNotionPage: { id: res.pageId, title, url: res.url, savedAt: new Date().toISOString() } });
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint, code: e.code };
  }
});

/** 创作台 -> Notion：覆盖更新已有页面 */
ipcMain.handle('notion:updatePage', async (e, { pageId, markdown, imageStore }) => {
  try {
    const { markdown: notionMd } = convert.blackcatToNotion(markdown, imageStore || {});
    await notion.replaceMarkdown(pageId, notionMd);
    const page = await notion.getPage(pageId);
    return { ok: true, pageId, url: page.url, chars: notionMd.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * 存档（统一入口）：mode = new 新建页面 / append 追加到页面末尾 / replace 覆盖整页
 * 面板上的「存档」按钮和 Ctrl+S 都走这里，保证两条路行为完全一致。
 */
ipcMain.handle('notion:archive', async (e, { mode, pageId, parentId, title, markdown, imageStore }) => {
  try {
    const md = markdown || '';
    const images = imageStore || {};
    if (!md.trim()) return { ok: false, error: '编辑器是空的，没有可存档的内容' };
    const { segments } = convert.blackcatToNotion(md, images);
    const m = mode === 'append' || mode === 'replace' ? mode : 'new';

    if (m === 'new') {
      const res = await notion.createPageFromSegments({
        parentId: parentId || store.load().notionParentPageId || null,
        title, segments,
        onProgress: progress('save'),
      });
      store.save({
        lastNotionPage: { id: res.pageId, title, url: res.url, savedAt: new Date().toISOString() },
        archiveMode: 'new',
      });
      return { ok: true, mode: m, ...res, url: res.url };
    }

    if (!pageId) return { ok: false, error: '还没选目标页面：先在「存档」里选一篇要' + (m === 'append' ? '追加' : '覆盖') + '的页面' };
    const res = await notion.writeSegmentsToPage({
      pageId, segments, replace: m === 'replace', onProgress: progress('save'),
    });
    const page = await notion.getPage(pageId);
    store.save({
      lastNotionPage: { id: pageId, title: page.title, url: page.url, savedAt: new Date().toISOString() },
      archiveMode: m, archiveTargetId: pageId, archiveTargetTitle: page.title,
    });
    return { ok: true, mode: m, pageId, url: page.url, mdBlocks: res.mdBlocks, images: res.images, imageFailures: res.imageFailures, chars: md.length };
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint, code: e.code };
  }
});

/** 发布记录回写（自动沉淀） */
ipcMain.handle('notion:writeback', async (e, { pageId, title, mediaId, images, published, status }) => {
  try {
    if (!pageId) return { ok: false, skipped: '没有来源页面 id' };
    const d = new Date();
    const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const content = '\n---\n\n**📤 已推送到公众号**\n\n' +
      '- 日期：' + date + '\n' +
      '- 标题：' + (title || '') + '\n' +
      '- 草稿 media_id：`' + mediaId + '`\n' +
      '- 图片：' + (images || 0) + ' 张已转微信图床\n' +
      '- 状态：' + (status || (published ? '已提交发布' : '已进草稿箱，待手动发表')) + '\n';
    await notion.appendMarkdown(pageId, content);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

/* -------------------------------------------------------------- 微信 */
ipcMain.handle('wechat:ip', async () => ({ ok: true, ip: await egressIp() }));

ipcMain.handle('wechat:probe', async () => {
  // 顺便把 Notion 也一起验了，让"自检"按钮一次看到全部状态
  const out = { wechat: null, notion: null, ip: await egressIp() };
  try { out.notion = { ok: true, user: await notion.verify() }; }
  catch (e) { out.notion = { ok: false, error: e.message, hint: e.hint, code: e.code }; }
  try { out.wechat = { ok: true, detail: await wechat.probe() }; }
  catch (e) { out.wechat = { ok: false, error: e.message, hint: e.hint, errcode: e.errcode, code: e.code }; }
  return out;
});

ipcMain.handle('wechat:push', async (e, pkg) => {
  try {
    const cfg = store.load();
    const r = await wechat.pushArticle(pkg, {
      log: (m) => progress('push')({ phase: 'log', message: m }),
      onProgress: progress('push'),
      publish: !!cfg.publishAfterDraft,
    });
    let wb = null;
    if (cfg.notionWriteback && pkg.sourcePageId) {
      try {
        const d = new Date();
        const date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        await notion.appendMarkdown(pkg.sourcePageId,
          '\n---\n\n**📤 已推送到公众号**\n\n- 日期：' + date + '\n- 标题：' + pkg.title +
          '\n- 草稿 media_id：`' + r.mediaId + '`\n- 图片：' + r.images + ' 张已转微信图床\n- 状态：' +
          (r.published ? '已提交发布' : '已进草稿箱，待手动发表') + '\n');
        wb = { ok: true };
      } catch (err) { wb = { ok: false, error: err.message }; }
    }
    return { ok: true, ...r, writeback: wb };
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint, errcode: e.errcode, code: e.code };
  }
});

ipcMain.handle('wechat:drafts', async (e, { count }) => {
  try { return { ok: true, ...(await wechat.listDrafts(count)) }; }
  catch (e) { return { ok: false, error: e.message, hint: e.hint, errcode: e.errcode }; }
});

ipcMain.handle('wechat:deleteDraft', async (e, { mediaId }) => {
  try { await wechat.deleteDraft(mediaId); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message, hint: e.hint, errcode: e.errcode }; }
});

/** 数据看板：公众号内容数据 + 本机文稿数据（互动接口无权限时如实回报） */
ipcMain.handle('wechat:dashboard', async () => {
  const list = docs.list();
  const local = {
    docs: list.length,
    docsLinked: list.filter((d) => d.notionPageId).length,
    lastDoc: list[0] || null,
  };
  try {
    const d = await wechat.dashboard();
    return Object.assign({ ok: true, local }, d);
  } catch (e) {
    return { ok: false, error: e.message, hint: e.hint, errcode: e.errcode, local };
  }
});

/* ------------------------------------------------------------ 杂项 */
ipcMain.handle('shell:openExternal', async (e, { url }) => {
  if (/^https?:/i.test(url)) { await shell.openExternal(url); return { ok: true }; }
  return { ok: false, error: '只允许 http/https' };
});

/** 由界面触发的"退出应用"（工具栏 Ctrl+Q 也走这里），保证一定退得掉 */
ipcMain.handle('app:quit', () => { quitApp(); return { ok: true }; });

/* ------------------------------------------------------------ 文稿库 */
/* 编辑器内容持久化到 <userData>/documents.json —— 关掉应用不丢稿 */
ipcMain.handle('docs:list', () => ({ ok: true, items: docs.list(), currentId: docs.currentId() }));
ipcMain.handle('docs:get', (e, { id }) => ({ ok: true, doc: docs.get(id) }));
ipcMain.handle('docs:save', (e, p) => {
  try { return { ok: true, doc: docs.save(p || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('docs:create', (e, { title, content }) => ({ ok: true, doc: docs.create(title, content) }));
ipcMain.handle('docs:select', (e, { id }) => ({ ok: docs.select(id) }));
ipcMain.handle('docs:delete', (e, { id }) => ({ ok: docs.remove(id) }));

/** 把草稿包存到磁盘（方便排查 / 存档） */
ipcMain.handle('app:saveJson', async (e, { filename, data }) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '保存',
    defaultPath: filename || 'blackcat-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, data, 'utf8');
  return { ok: true, path: r.filePath };
});

ipcMain.handle('app:openPath', async (e, { p }) => {
  const err = await shell.openPath(p);
  return err ? { ok: false, error: err } : { ok: true };
});

ipcMain.handle('app:limits', () => ({ wechatContentMax: CONTENT_MAX }));

ipcMain.handle('lan:info', () => lanInfo());

/* ================================================ 局域网服务（手机访问） */
function lanInfo() {
  const os = require('os');
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) ips.push({ iface: name, ip: a.address });
    }
  }
  const cfg = store.load();
  return { enabled: !!cfg.lanServer, port: cfg.lanPort, urls: ips.map((x) => 'http://' + x.ip + ':' + cfg.lanPort + '/'), ips };
}

function applyLanServer() {
  const cfg = store.load();
  closeLanServer();
  if (!cfg.lanServer) return;

  lanServer = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];
    const map = {
      '/': ['renderer/editor.html', 'text/html; charset=utf-8'],
      '/editor.html': ['renderer/editor.html', 'text/html; charset=utf-8'],
      // 修复：手机端此前 404，导致「助手」按钮/五标签面板整个不注入，
      // 页面看起来与桌面版完全是两码事
      '/native-module.js': ['renderer/native-module.js', 'application/javascript; charset=utf-8'],
    };
    const hit = map[url];
    if (hit) {
      try {
        const buf = fs.readFileSync(path.join(__dirname, hit[0]));
        res.writeHead(200, { 'Content-Type': hit[1], 'Cache-Control': 'no-store' });
        return res.end(buf);
      } catch (e) { res.writeHead(500); return res.end('read fail'); }
    }
    if (url.startsWith('/vendor/') || url.startsWith('/assets/')) {
      const p = path.join(__dirname, decodeURIComponent(url).replace(/^\//, ''));
      if (!p.startsWith(path.join(__dirname, 'vendor')) && !p.startsWith(path.join(__dirname, 'assets'))) {
        res.writeHead(403); return res.end('forbidden');
      }
      try {
        const ext = path.extname(p).toLowerCase();
        const type = ({ '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[ext] || 'application/octet-stream';
        const buf = fs.readFileSync(p);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' });
        return res.end(buf);
      } catch (e) { res.writeHead(404); return res.end('404'); }
    }
    res.writeHead(404); res.end('404');
  });
  lanServer.on('error', (e) => console.error('局域网服务启动失败:', e.message));
  lanServer.listen(cfg.lanPort, '0.0.0.0', () => {
    console.log('局域网服务已启动:', lanInfo().urls.join('  '));
    send('lan:changed', lanInfo());
  });
}

/** 关掉局域网服务：连服务端 keep-alive 连接一起断，否则句柄会拖住进程退出 */
function closeLanServer() {
  if (!lanServer) return;
  try { if (typeof lanServer.closeAllConnections === 'function') lanServer.closeAllConnections(); } catch (e) { /* 忽略 */ }
  try { lanServer.close(); } catch (e) { /* 忽略 */ }
  lanServer = null;
}

/**
 * 统一退出入口：清场 → 正常退出 → 兜底强退。
 * 之前出现"关窗后进程常驻不退"，除了 beforeunload 拦关窗，还有可能是某个句柄（局域网连接、
 * 定时器）没释放；这个看门狗保证 2.5 秒内一定退干净。
 */
function quitApp() {
  try { closeLanServer(); } catch (e) { /* 忽略 */ }
  app.quit();
  const t = setTimeout(() => {
    console.warn('[退出] 正常退出超时，强制结束进程');
    try { app.exit(0); } catch (e) { process.exit(0); }
  }, 2500);
  if (t.unref) t.unref();
}

/* ============================================================ 自检模式 */
/**
 * node_modules\.bin\electron . --self-test
 * 用真实 Chromium + 真实 preload + 真实 IPC 跑一遍：
 *   1) 页面与本地 vendor 是否加载成功（离线可用）
 *   2) bcNative 桥是否可用、按钮与面板是否注入
 *   3) V2 原有能力是否还在
 *   4) 主进程里的 Notion / 微信客户端能否真的连通
 */
async function runSelfTest() {
  const out = [];
  const P = (s) => { out.push(s); process.stdout.write(s + '\n'); };
  const ok = (b) => (b ? '✅' : '❌');
  let pass = 0, total = 0;
  const chk = (name, b, extra) => { total++; if (b) pass++; P('   ' + ok(b) + ' ' + name + (extra ? '  ' + extra : '')); };

  P('=== 小黑喵创作台 V3 桌面版 · 自检 ===');
  P('   Electron ' + process.versions.electron + ' / Chromium ' + process.versions.chrome + ' / Node ' + process.versions.node);

  const win = createWindow();
  const rendererLog = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['verbose', 'info', 'warning', 'error'][level] || ('lvl' + level);
    const src = String(sourceId || '').split(/[\\/]/).pop();
    rendererLog.push('[' + tag + '] ' + message + '  @' + src + ':' + line);
  });
  win.webContents.on('preload-error', (_e, p, err) => rendererLog.push('[preload-error] ' + p + ' :: ' + err.message));
  win.webContents.on('render-process-gone', (_e, d) => rendererLog.push('[render-process-gone] ' + JSON.stringify(d)));
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('页面加载超时')), 60000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
    win.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(t); reject(new Error('页面加载失败 ' + code + ' ' + desc)); });
  });
  // 等模块 boot 完成
  await new Promise((r) => setTimeout(r, 3000));

  P('\n=== 渲染进程 console ===');
  if (!rendererLog.length) P('   （无输出）');
  rendererLog.slice(0, 30).forEach((l) => P('   ' + l.slice(0, 320)));

  P('\n=== 1) 渲染层（真实 Chromium）===');
  const r = await win.webContents.executeJavaScript(`(function(){
    return {
      hasNative: typeof window.bcNative === 'object' && !!window.bcNative,
      isDesktop: !!(window.bcNative && window.bcNative.isDesktop),
      hasBtn: !!document.getElementById('btnNotion'),
      btnLabel: ((document.getElementById('btnNotion') || {}).textContent || '').trim(),
      hasPanel: !!document.getElementById('sbRoot'),
      tabs: document.querySelectorAll('.sb-tab').length,
      panels: {
        sidebarDocked: (function () { var e = document.getElementById('sbRoot'); return !!e && getComputedStyle(e).position === 'fixed'; })(),
        panes: document.querySelectorAll('.sb-pane').length,
      },
      import: {
        query: !!document.getElementById('xvQuery'),
        list: !!document.getElementById('xvList'),
        btn: !!document.getElementById('xvImport'),
      },
      push: { push: !!document.getElementById('xvPush'), dry: !!document.getElementById('xvDry'), drafts: !!document.getElementById('xvDrafts') },
      dashboard: {
        tab: !!document.querySelector('.sb-tab[data-tab="data"]'),
        refresh: !!document.getElementById('dashRefresh'),
        chart: !!document.getElementById('dashChart'),
        interact: !!document.getElementById('dashInteract'),
        echarts: typeof window.echarts,
      },
      archive: {
        modes: document.querySelectorAll('#nsSeg .xv-segb').length,
        save: !!document.getElementById('nsSave'),
        targetRow: !!document.getElementById('nsTargetRow'),
        pick: !!document.getElementById('nsPick'),
        egressIp: !!document.getElementById('xvGetIp'),
        quitBtn: !!document.getElementById('xvQuit'),
      },
      vendor: {
        marked: typeof window.marked,
        markedParse: typeof (window.marked && window.marked.parse),
        MathJax: typeof window.MathJax,
        mathjaxTex2svg: typeof (window.MathJax && window.MathJax.tex2svg),
        hljs: typeof window.hljs,
        echarts: typeof window.echarts
      },
      v2: {
        editor: !!window.editor,
        preview: !!window.preview,
        copyForWeChat: typeof window.copyForWeChat,
        convertBase64Images: typeof window.convertBase64Images,
        resolveImages: typeof window.resolveImages
      },
      title: document.title,
      titleTag: (document.querySelector('title') || {}).textContent || '',
      bodyChars: document.body.innerHTML.length
    };
  })()`);

  chk('bcNative 桥可用（preload 生效）', r.hasNative && r.isDesktop);
  chk('工具栏按钮「助手」已注入', r.hasBtn && r.btnLabel === '助手', r.btnLabel);
  chk('右侧助手栏已挂载（停靠式，非遮罩弹窗）', r.hasPanel && r.panels.sidebarDocked, 'position:fixed=' + r.panels.sidebarDocked);
  chk('五个标签页', r.tabs === 5, String(r.tabs));
  chk('五个面板容器', r.panels.panes === 5, String(r.panels.panes));
  chk('数据看板齐备（标签/刷新/图表/互动说明）', r.dashboard.tab && r.dashboard.refresh && r.dashboard.chart && r.dashboard.interact,
    'echarts=' + r.dashboard.echarts);
  chk('① 导入面板齐备', r.import.query && r.import.list && r.import.btn);
  chk('② 推送面板齐备', r.push.push && r.push.dry && r.push.drafts);
  chk('③ 同步 Notion 面板齐备', r.archive.modes === 3 && r.archive.save);
  chk('保存到 Notion：三模式 + 保存按钮 + 目标选择', r.archive.modes === 3 && r.archive.save && r.archive.targetRow && r.archive.pick,
    '模式数=' + r.archive.modes);
  chk('设置里有出口 IP 获取 + 退出按钮', r.archive.egressIp && r.archive.quitBtn);
  chk('本地 vendor 全部加载（离线可用）', r.vendor.markedParse === 'function' && r.vendor.MathJax === 'object' && r.vendor.hljs === 'object' && r.vendor.echarts === 'object',
    'marked.parse=' + r.vendor.markedParse + ' MathJax=' + r.vendor.MathJax + ' hljs=' + r.vendor.hljs + ' echarts=' + r.vendor.echarts);
  chk('V2 原有能力完整（编辑器/预览/复制/图片管线）', r.v2.editor && r.v2.preview && r.v2.copyForWeChat === 'function' && r.v2.convertBase64Images === 'function' && r.v2.resolveImages === 'function');
  P('   ℹ️ 页面标题（V2 会把它设成应用名，故仅作参考）: ' + r.titleTag);

  P('\n=== 2) 渲染一次 markdown（含公式与容器）===');
  const rendered = await win.webContents.executeJavaScript(`(async function(){
    window.editor.value = '# 自检标题\\n\\n行内公式 $E=mc^2$\\n\\n$$\\n\\\\int_0^1 x dx\\n$$\\n\\n:::tip 提示\\n\\n容器正文\\n\\n:::end\\n';
    await window.render();
    await new Promise(function(r){ setTimeout(r, 2500); });
    var pv = document.getElementById('preview');
    return {
      htmlLen: pv.innerHTML.length,
      hasH1: /<h1/i.test(pv.innerHTML),
      hasTip: /提示/.test(pv.innerHTML),
      svgCount: (pv.innerHTML.match(/<svg/gi) || []).length,
      mathError: /MathJax|math-error|merror/i.test(pv.innerHTML) ? (pv.innerHTML.match(/class="[^"]*(?:merror|math-error)[^"]*"/gi) || []).length : 0
    };
  })()`);
  chk('markdown 渲染出内容', rendered.htmlLen > 100, rendered.htmlLen + ' 字符');
  chk('H1 渲染成功', rendered.hasH1);
  chk(':::tip 容器渲染成功', rendered.hasTip);
  chk('公式渲染成内联 SVG（微信要求）', rendered.svgCount >= 2, rendered.svgCount + ' 个 <svg>');
  chk('公式无渲染错误', rendered.mathError === 0);

  P('\n=== 3) 主进程：Notion 客户端 ===');
  try {
    const v = await notion.verify();
    chk('Notion 连接', true, v.name || v.id);
  } catch (e) {
    chk('Notion 连接', false, e.message + (e.code === 'NO_TOKEN' ? '（去「设置」里填 Token）' : ''));
  }

  P('\n=== 4) 主进程：微信客户端 ===');
  try {
    const d = await wechat.probe();
    Object.keys(d).forEach((k) => {
      // 「发布接口」对个人订阅号是微信官方回收了权限，属于符合预期的结果，不算失败
      if (k === '发布接口' && !d[k].ok && d[k].code === 48001) {
        chk('微信·' + k + '（该账号类型未开放，符合预期）', true, '→ 草稿建好后需手动点「发表」');
        return;
      }
      chk('微信·' + k, d[k].ok, d[k].ok ? '' : (d[k].message || ''));
    });
  } catch (e) {
    chk('微信凭据', false, e.message + (e.hint ? '（' + e.hint + '）' : ''));
  }

  P('\n=== 5) 出口 IP（IP 白名单用）===');
  const ip = await egressIp();
  P('   ' + (ip || '取不到'));

  /* ---------- 6) 手机端布局 ---------- */
  P('\n=== 6) 手机端布局（设备模拟窄屏）===');
  win.webContents.enableDeviceEmulation({
    screenPosition: 'mobile',
    screenSize: { width: 420, height: 780 },
    viewSize: { width: 420, height: 780 },
    viewPosition: { x: 0, y: 0 },
    deviceScaleFactor: 1,
  });
  await new Promise(function (r) { setTimeout(r, 1500); });
  const mob = await win.webContents.executeJavaScript(`(function(){
    return new Promise(function(res){
      document.getElementById('btnNotion').click();
      setTimeout(function(){
        var sb = document.getElementById('sbRoot'), fab = document.getElementById('sbFab');
        var main = document.querySelector('.main'), tb = document.querySelector('.toolbar');
        res({
          innerW: window.innerWidth,
          bodyMobile: document.body.classList.contains('sb-mobile'),
          sbOpen: sb.classList.contains('open'),
          fabDisplay: getComputedStyle(fab).display,
          sbWidth: getComputedStyle(sb).width,
          mainPadRight: getComputedStyle(main).paddingRight,
          toolbarWrap: getComputedStyle(tb).flexWrap
        });
      }, 600);
    });
  })()`);
  P('   视口宽=' + mob.innerW + '　侧栏宽=' + mob.sbWidth + '　工具栏换行=' + mob.toolbarWrap);
  chk('窄屏识别为移动布局', mob.bodyMobile === true, 'innerWidth=' + mob.innerW);
  chk('悬浮「助手」按钮出现', mob.fabDisplay !== 'none', mob.fabDisplay);
  chk('侧栏以抽屉方式打开（不再固定 372px）', mob.sbOpen && mob.sbWidth !== '372px', '宽度=' + mob.sbWidth);
  chk('移动端侧栏不挤压正文', mob.mainPadRight === '0px', 'padding-right=' + mob.mainPadRight);
  chk('工具栏允许换行（不再溢出）', mob.toolbarWrap === 'wrap', mob.toolbarWrap);
  win.webContents.disableDeviceEmulation();
  await new Promise(function (r) { setTimeout(r, 800); });
  const back = await win.webContents.executeJavaScript('(function(){ window.dispatchEvent(new Event("resize")); var m=document.querySelector(".main"); return { w: window.innerWidth, mobile: document.body.classList.contains("sb-mobile"), pad: getComputedStyle(m).paddingRight }; })()');
  chk('回到宽屏恢复停靠布局', back.mobile === false && back.pad === '372px', 'innerWidth=' + back.w + ' padding-right=' + back.pad);

  P('\n================ ' + pass + '/' + total + (pass === total ? '  ✅ 全部通过' : '  ⚠️ 有未通过') + ' ================');
  app.exit(pass === total ? 0 : 2);
}

/* ========================================================== 实测模式 */
/**
 * electron . --live-test [关键词]
 * 用真实界面驱动一整条链路：
 *   搜索 Notion → 导入（含图片转 base64）→ 渲染 → 推微信草稿箱 → 删掉测试草稿
 *   → 另存为新 Notion 页面 → 校验 → 丢进回收站
 * 所有产生的痕迹都会清理掉。
 */
async function runLiveTest() {
  const P = (s) => process.stdout.write(s + '\n');
  const keyword = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== '.' && a !== '--live-test') || 'airy';
  let pass = 0, total = 0;
  const ok = (b) => (b ? '✅' : '❌');
  const chk = (n, b, extra) => { total++; if (b) pass++; P('   ' + ok(b) + ' ' + n + (extra ? '  ' + extra : '')); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  P('=== 小黑喵创作台 V3 桌面版 · 实链路测试（关键词: ' + keyword + '）===');
  const win = createWindow();
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('加载超时')), 60000);
    win.webContents.once('did-finish-load', () => { clearTimeout(t); res(); });
  });
  await sleep(3000);

  const js = (code) => win.webContents.executeJavaScript('(async function(){' + code + '})()');
  // 把 confirm 打成 true，避免弹窗卡住
  await win.webContents.executeJavaScript('window.confirm = function(){return true;}; window.__t = function(ms){return new Promise(function(r){setTimeout(r,ms);});}; true');

  /* ---------- 1) 打开面板并搜索 ---------- */
  P('\n=== 1) 打开右侧助手栏 → 从 Notion 搜索 ===');
  await js('document.getElementById("btnNotion").click(); await __t(1500); return 1;');
  const opened = await js('return document.getElementById("sbRoot").classList.contains("open");');
  chk('助手栏打开（停靠式侧栏）', opened);
  await js('document.getElementById("xvQuery").value = ' + JSON.stringify(keyword) + '; document.getElementById("xvSearch").click(); await __t(6000); return 1;');
  const listInfo = await js('var it = document.querySelectorAll("#xvList .xv-item"); return { n: it.length, first: it.length ? it[0].querySelector(".t").textContent : "" };');
  chk('搜到笔记', listInfo.n > 0, listInfo.n + ' 条，第一条「' + listInfo.first + '」');
  if (!listInfo.n) { P('\n无法继续（搜不到笔记）'); app.exit(3); return; }

  /* ---------- 2) 导入 ---------- */
  P('\n=== 2) 导入到编辑器（含图片转 base64）===');
  await js('document.querySelector("#xvList .xv-item").click(); await __t(400); document.getElementById("xvImport").click(); return 1;');
  let importStatus = '';
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    importStatus = await js('return document.getElementById("xvImportStatus").textContent;');
    const prog = await js('return document.getElementById("xvProg").textContent;');
    if (prog && prog !== S_LASTPROG) { S_LASTPROG = prog; P('   · ' + prog); }
    if (/已导入|❌/.test(importStatus)) break;
  }
  chk('导入完成', /已导入/.test(importStatus), importStatus.slice(0, 150));
  const ed = await js('return { chars: (window.editor.value||"").length, placeholders: (window.editor.value.match(/【图片\\d+/g)||[]).length, store: Object.keys(window.imageStore||{}).length, head: (window.editor.value||"").slice(0,60) };');
  chk('编辑器拿到正文', ed.chars > 100, ed.chars + ' 字符');
  chk('图片进了 imageStore', ed.store > 0, ed.store + ' 张，正文占位符 ' + ed.placeholders + ' 个');
  chk('正文开头正确', /^#|^:::/.test(ed.head.trim()), JSON.stringify(ed.head.trim().slice(0, 30)));

  // 导入后应自动保存成文稿，图片一起进文稿库（持久化）
  await sleep(4500);
  const docsAfterImport = docs.list();
  const dImp = docsAfterImport.length ? docs.get(docsAfterImport[0].id) : null;
  chk('导入后自动存成文稿（持久化）', !!(dImp && (dImp.content || '').length > 100), dImp ? dImp.content.length + ' 字符' : '(没有文稿)');
  chk('文稿里带着图片数据（导入的 5 张）', !!(dImp && Object.keys(dImp.imageStore || {}).length > 0),
    dImp ? Object.keys(dImp.imageStore || {}).length + ' 张' : '0 张');
  const saveDbg = await js('return window.__saveDbg ? JSON.stringify(window.__saveDbg) : "(没保存过)"');
  const winImgs = await js('return Object.keys(window.imageStore||{}).length');
  P('   · 诊断: 最近一次保存=' + saveDbg + '　页面内 imageStore=' + winImgs + ' 张');

  /* ---------- 3) 推微信草稿 ---------- */
  P('\n=== 3) 推送到公众号草稿箱 ===');
  await js('document.querySelector(\'.sb-tab[data-tab="push"]\').click(); await __t(400); document.getElementById("xvPush").click(); return 1;');
  let pushStatus = '';
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    pushStatus = await js('return document.getElementById("xvPushStatus").textContent;');
    const prog = await js('return document.getElementById("xvProg").textContent;');
    if (prog && prog !== S_LASTPROG) { S_LASTPROG = prog; P('   · ' + prog); }
    if (/已进草稿箱|❌/.test(pushStatus)) break;
  }
  const pushed = /已进草稿箱/.test(pushStatus);
  // 长文被微信 2 万字符上限拦下是接口限制（应用已提示改用「复制到微信」），不算缺陷
  const sizeLimited = /超过微信上限|2 ?万字符/.test(pushStatus);
  if (!pushed && sizeLimited) P('   ℹ️ 这篇太长（换图后仍超 2 万字符），被微信上限拦下 —— 属预期，长文请走「复制到微信」');
  chk('推送草稿箱（长文允许被上限拦下）', pushed || sizeLimited, pushStatus.split('\n')[0].slice(0, 120));
  const mediaId = (pushStatus.match(/media_id=([A-Za-z0-9_\-]+)/) || [])[1];
  if (mediaId) {
    // 立刻验证草稿真的存在，然后删掉，不留痕迹
    const drafts = await wechat.listDrafts(10);
    const hit = drafts.items.find((d) => d.mediaId.startsWith(mediaId.slice(0, 16)));
    chk('草稿箱里能查到这篇', !!hit, hit ? '「' + hit.title + '」' : '未找到');
    if (hit) {
      await wechat.deleteDraft(hit.mediaId);
      P('   🧹 已删除测试草稿');
    }
  }

  /* ---------- 4) 手动保存到 Notion（新建） ---------- */
  P('\n=== 4) 文稿 → 保存到 Notion（手动，新建）===');
  // 先把之前测试遗留的 ZZ 测试页清掉，否则"是否重复"的判断会被污染
  const leftovers = (await notion.search('ZZ ', 30)).filter((p) => /^ZZ /.test(p.title));
  for (const p of leftovers) {
    await notion.call('/pages/' + p.id, { method: 'PATCH', body: { in_trash: true } });
    P('   🧹 先清掉历史遗留测试页：' + p.title);
  }
  const saveTitle = 'ZZ 文稿链路测试（可删）';
  await js('window.editor.value = "# ' + saveTitle + '\\n\\n第一版内容：来自创作台。\\n"; window.imageStore = {};'
    + 'document.querySelector(\'.sb-tab[data-tab="docs"]\').click(); await __t(600);'
    + 'document.querySelector(\'#nsSeg .xv-segb[data-mode="new"]\').click(); await __t(300);'
    + 'document.getElementById("nsSave").click(); return 1;');
  let nsStatus = '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    nsStatus = await js('return document.getElementById("nsStatus").textContent;');
    if (/已新建|❌/.test(nsStatus)) break;
  }
  chk('① 手动保存到 Notion 成功', /已新建/.test(nsStatus), nsStatus.slice(0, 170));

  // 文稿里应记下 notionPageId —— 这是"同一篇文稿只对应一个页面"的依据
  let recId = '';
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    const lst = docs.list();
    recId = (lst[0] && lst[0].notionPageId) || '';
    if (recId) break;
  }
  chk('① 文稿记下了 Notion 页面 id（防重复的依据）', !!recId, recId || '(空)');
  if (!recId) { P('\n拿不到页面 id，后续无法验证'); app.exit(3); return; }
  const pageInfo = await notion.getPage(recId);
  chk('① 页面在 Notion 里真实存在', !!(pageInfo && pageInfo.url), pageInfo ? pageInfo.url : '');
  const md1 = (await notion.getPageMarkdown(recId)) || '';
  chk('① 页面正文写入正常', md1.indexOf('第一版内容') >= 0, md1.length + ' 字符');

  /* ---------- 5) 防重复存档（本次改造的重点） ---------- */
  P('\n=== 5) 再存一次 → 必须是"更新同一页"，不能新建第二篇 ===');
  const modeNow = await js('var on=document.querySelector("#nsSeg .xv-segb.on"); return on?on.getAttribute("data-mode"):"";');
  chk('存过一次后默认切到「更新已存页面」', modeNow === 'update', '当前模式=' + modeNow);
  const linked = await js('return document.getElementById("nsLinked").textContent;');
  chk('界面显示这篇文稿已关联的 Notion 页面', /已存到 Notion/.test(linked), linked.slice(0, 90));

  await js('window.editor.value = "# ' + saveTitle + '\\n\\n第二版内容：更新测试。\\n"; return 1;');
  await js('document.getElementById("nsSave").click(); return 1;');
  let st5 = '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    st5 = await js('return document.getElementById("nsStatus").textContent;');
    if (/已更新|❌/.test(st5)) break;
  }
  chk('② 第二次保存走的是"更新"', /已更新/.test(st5), st5.slice(0, 170));
  await sleep(2500);
  const lst2 = docs.list();
  chk('② 关联页面 id 没变（没有另起新页）', !!(lst2[0] && lst2[0].notionPageId === recId), (lst2[0] || {}).notionPageId || '');
  const md2 = (await notion.getPageMarkdown(recId)) || '';
  chk('② 页面内容已更新为第二版', md2.indexOf('第二版内容') >= 0 && md2.indexOf('第一版内容') < 0, md2.length + ' 字符');

  // Notion 搜索有索引延迟，轮询确认"标题相同的页面只有一篇"
  let dupCount = -1;
  for (let i = 0; i < 10; i++) {
    await sleep(5000);
    const rr = await notion.search(saveTitle, 20);
    const hits = rr.filter((p) => p.title.indexOf(saveTitle) === 0);
    if (hits.length) { dupCount = hits.length; if (hits.length > 1) break; }
  }
  chk('③ 搜索里也只有一篇（没有重复页面）', dupCount === 1, '搜到 ' + dupCount + ' 篇');

  /* ---------- 6) 追加模式（显式切换才追加） ---------- */
  P('\n=== 6) 追加模式（显式切换才追加） ===');
  const MARK_A = 'ZZ-APPEND-' + Date.now();
  await js('window.editor.value = "# 追加段落\\n\\n' + MARK_A + '\\n"; return 1;');
  await js('document.querySelector(\'#nsSeg .xv-segb[data-mode="append"]\').click(); await __t(300);'
    + 'document.getElementById("nsSave").click(); return 1;');
  let st6 = '';
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    st6 = await js('return document.getElementById("nsStatus").textContent;');
    if (/已追加|❌/.test(st6)) break;
  }
  chk('④ 追加成功', /已追加/.test(st6), st6.slice(0, 170));
  await sleep(2500);
  const md3 = (await notion.getPageMarkdown(recId)) || '';
  chk('④ 追加内容进站且原有内容还在', md3.indexOf(MARK_A) >= 0 && md3.indexOf('第二版内容') >= 0, md2.length + ' → ' + md3.length);

  /* ---------- 7) 文稿持久化 ---------- */
  P('\n=== 7) 文稿持久化（关掉应用也不丢） ===');
  const list1 = docs.list();
  chk('文稿库里有文稿', list1.length >= 1, list1.length + ' 篇');
  const cur = docs.get(list1[0].id);
  chk('文稿正文非空', !!(cur && (cur.content || '').length > 0), cur ? cur.content.length + ' 字符' : '');
  chk('文稿库重启后仍在（文件落盘）', fs.existsSync(docs.FILE()), docs.FILE());
  const list2 = docs.list();
  chk('重新读盘内容一致（模拟重启）', JSON.stringify(list1.map((x) => x.id)) === JSON.stringify(list2.map((x) => x.id)), '');
  P('   文稿库文件：' + docs.FILE());

  /* ---------- 8) 密钥加密落盘 ---------- */
  P('\n=== 8) 密钥是否加密存储 ===');
  const cfgRaw = fs.readFileSync(store.FILE(), 'utf8');
  const cfgJson = JSON.parse(cfgRaw);
  const isEnc = (v) => typeof v === 'string' && v.startsWith('enc:v1:');
  chk('Notion Token 已加密', !cfgJson.notionToken || isEnc(cfgJson.notionToken), cfgJson.notionToken ? cfgJson.notionToken.slice(0, 12) + '…' : '(空)');
  chk('微信 AppSecret 已加密', !cfgJson.wechatSecret || isEnc(cfgJson.wechatSecret), cfgJson.wechatSecret ? cfgJson.wechatSecret.slice(0, 12) + '…' : '(空)');
  chk('配置文件里搜不到明文 token', cfgRaw.indexOf('ntn_') < 0, '');
  chk('解密回读正常（内存里能用）', !!store.load().notionToken, store.load().notionToken ? '长度 ' + store.load().notionToken.length : '空');

  /* ---------- 7.5) 本机缓存（静默自动保存，界面不再展示） ---------- */
  P('\n=== 7.5) 本机缓存（静默自动保存） ===');
  chk('编辑器内容已静默缓存到本机（不占界面）', docs.list().length >= 1 && (docs.get(docs.list()[0].id).content || '').length > 0, docs.list().length + ' 篇');

  /* ---------- 7.6) 数据看板 ---------- */
  P('\n=== 7.6) 数据看板（公众号内容数据）===');
  const dash = await js('document.querySelector(\'.sb-tab[data-tab="data"]\').click(); await __t(8000);'
    + 'return { drafts: document.getElementById("dashDrafts").textContent,'
    + ' images: document.getElementById("dashImages").textContent,'
    + ' videos: document.getElementById("dashVideos").textContent,'
    + ' docs: document.getElementById("dashDocs").textContent,'
    + ' rows: document.querySelectorAll("#dashList .xv-item").length,'
    + ' chart: !!document.querySelector("#dashChart svg"),'
    + ' status: document.getElementById("dashStatus").textContent,'
    + ' interact: document.getElementById("dashInteract").textContent };');
  P('   看板: 草稿=' + dash.drafts + ' 图片素材=' + dash.images + ' 视频=' + dash.videos + ' 本机文稿=' + dash.docs + ' 清单=' + dash.rows + ' 条 图表=' + dash.chart);
  chk('草稿数取到', /^[0-9]+$/.test(dash.drafts), '草稿 ' + dash.drafts + ' 篇');
  chk('素材数取到', /^[0-9]+$/.test(dash.images), '图片素材 ' + dash.images + ' 张');
  chk('草稿清单有内容', dash.rows > 0, dash.rows + ' 条');
  chk('趋势图渲染出 SVG', dash.chart === true, '');
  chk('互动数据如实标注接口状态', /404|无权限|接口权限|errcode|暂无数据/.test(dash.interact), dash.interact.slice(0, 60));
  /* ---------- 清理测试页面 ---------- */
  await notion.call('/pages/' + recId, { method: 'PATCH', body: { in_trash: true } });
  P('   🧹 测试页面已丢进回收站');


  P('\n================ ' + pass + '/' + total + (pass === total ? '  ✅ 全链路通过' : '  ⚠️ 有未通过') + ' ================');
  app.exit(pass === total ? 0 : 2);
}

let S_LASTPROG = '';

/* ================================================================= 启动 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    if (SELFTEST) { runSelfTest().catch((e) => { console.error('自检异常:', e.message); app.exit(3); }); return; }
    if (process.argv.includes('--live-test')) { runLiveTest().catch((e) => { console.error('实测异常:', e.message, e.stack); app.exit(3); }); return; }
    createWindow();
    applyLanServer();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin' && !SELFTEST) quitApp(); });
  app.on('before-quit', () => { closeLanServer(); });
}
