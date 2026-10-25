/* ============================================================================
 * 小黑喵创作台 V3 · 桌面版 —— 渲染层原生模块
 *
 * 双模式：
 *   桌面（window.bcNative 存在）→ Notion 与微信全部走主进程 IPC，
 *                                 无 CORS、密钥不落网页、可建页可推草稿
 *   浏览器（手机通过局域网访问）→ 退化为只读导入（Notion 支持 CORS），
 *                                 写 Notion / 推草稿会明确提示需在电脑端操作
 *
 * 复用 V2 原有能力：editor / render() / showToast() / convertBase64Images() / imageStore
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__XHM_V3D__) return;
  window.__XHM_V3D__ = true;

  var N = window.bcNative || null;
  var IS_DESKTOP = !!(N && N.isDesktop);

  var S = {
    busy: false,
    tab: 'import',
    results: [],
    page: null,              // 当前导入来源 {id,title,url}
    cfg: {},
    lastProgress: '',
    /* 文稿 */
    docs: [],                // 文稿列表（元数据）
    doc: null,               // 当前文稿 {id,title,content,imageStore,notionPageId,notionUrl}
    docCurrentId: '',
    /* 保存到 Notion */
    nsMode: 'new',           // new | update | append
    nsTargetId: '',          // 更新/追加的目标页面
    nsTargetTitle: '',
    nsModeTouched: false,
    nsPickKind: 'target',
  };

  /* ------------------------------------------------------------- 工具 */
  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? e.value : ''; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t); else console.log('[V3]', m); }
  function setText(id, t) { var e = $(id); if (e) e.textContent = t || ''; }
  function ok(b) { return b ? '✅' : '❌'; }

  /* ==================================================== API 适配层 ==== */
  var API = {
    cfgGet: async function () {
      if (IS_DESKTOP) return await N.cfg.get();
      try { return JSON.parse(localStorage.getItem('xhm_v3_cfg') || '{}'); } catch (e) { return {}; }
    },
    cfgSet: async function (patch) {
      if (IS_DESKTOP) return await N.cfg.set(patch);
      var c = await API.cfgGet(); Object.assign(c, patch);
      localStorage.setItem('xhm_v3_cfg', JSON.stringify(c));
      return c;
    },
    verify: async function () {
      if (IS_DESKTOP) return await N.notion.verify();
      return await webNotion('GET', '/users/me');
    },
    search: async function (q) {
      if (IS_DESKTOP) return await N.notion.search(q);
      var r = await webNotion('POST', '/search', {
        page_size: 40, sort: { direction: 'descending', timestamp: 'last_edited_time' }, query: q || undefined,
      });
      if (!r.ok) return r;
      r.items = (r.data.results || []).filter(function (x) { return x.object === 'page' && !x.in_trash; }).map(function (p) {
        var props = p.properties || {};
        var t = props.title || props.Name || props['名称'] || props['标题'];
        var title = t && t.title && t.title.length ? t.title.map(function (x) { return x.plain_text; }).join('') : '(无标题)';
        return { id: p.id, title: title, edited: (p.last_edited_time || '').slice(0, 10), url: p.url };
      });
      return r;
    },
    importPage: async function (pageId, downloadImages) {
      if (IS_DESKTOP) return await N.notion.import(pageId, downloadImages);
      return await webImport(pageId, downloadImages);
    },
    saveNew: async function (p) {
      if (IS_DESKTOP) return await N.notion.saveNew(p);
      return { ok: false, error: '浏览器模式无法写入 Notion —— 请在电脑端的桌面版里操作（手机端只支持导入阅读）' };
    },
    updatePage: async function (p) {
      if (IS_DESKTOP) return await N.notion.updatePage(p);
      return { ok: false, error: '浏览器模式无法写入 Notion —— 请在电脑端的桌面版里操作' };
    },
    archive: async function (p) {
      if (IS_DESKTOP) return await N.notion.archive(p);
      return { ok: false, error: '浏览器模式无法写入 Notion —— 请在电脑端的桌面版里操作（手机端只支持导入阅读）' };
    },
    wechatPush: async function (pkg) {
      if (IS_DESKTOP) return await N.wechat.push(pkg);
      return { ok: false, error: '浏览器模式无法调用微信接口（微信不开放跨域）—— 请在电脑端的桌面版里推送' };
    },
    wechatProbe: async function () {
      if (IS_DESKTOP) return await N.wechat.probe();
      return { notion: await API.verify(), wechat: { ok: false, error: '浏览器模式不可用' }, ip: null };
    },
    wechatDrafts: async function (count) {
      if (IS_DESKTOP) return await N.wechat.drafts(count);
      return { ok: false, error: '浏览器模式不可用' };
    },
    wechatDeleteDraft: async function (id) {
      if (IS_DESKTOP) return await N.wechat.deleteDraft(id);
      return { ok: false, error: '浏览器模式不可用' };
    },
    wechatDashboard: async function () {
      if (IS_DESKTOP) return await N.wechat.dashboard();
      return { ok: false, error: '数据看板请在电脑端桌面版使用（浏览器模式没有主进程）' };
    },
    wechatIp: async function () {
      if (IS_DESKTOP) return await N.wechat.ip();
      return { ok: false, error: '浏览器模式不可用' };
    },
    lanInfo: async function () { return IS_DESKTOP ? await N.app.lanInfo() : { enabled: false, urls: [] }; },
    openExternal: async function (url) { if (IS_DESKTOP) return await N.app.openExternal(url); window.open(url, '_blank'); },
    quit: async function () { if (IS_DESKTOP && N.app.quit) return await N.app.quit(); return { ok: false }; },
  };

  /* -------- 浏览器模式：Notion 直连（CORS 允许）+ 本地转 base64 ------- */
  function webToken() { try { return JSON.parse(localStorage.getItem('xhm_v3_cfg') || '{}').notionToken || ''; } catch (e) { return ''; } }
  async function webNotion(method, path, body) {
    var tk = webToken();
    if (!tk) return { ok: false, error: '还没填 Notion Token（在设置里填）', code: 'NO_TOKEN' };
    try {
      var r = await fetch('https://api.notion.com/v1' + path, {
        method: method,
        headers: { Authorization: 'Bearer ' + tk, 'Notion-Version': '2026-03-11', 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      var d = await r.json().catch(function () { return null; });
      if (!r.ok) return { ok: false, error: (d && (d.message || d.code)) || ('HTTP ' + r.status), status: r.status };
      return { ok: true, data: d };
    } catch (e) { return { ok: false, error: '网络错误: ' + e.message }; }
  }
  async function webImport(pageId, downloadImages) {
    var r = await webNotion('GET', '/pages/' + pageId + '/markdown');
    if (!r.ok) return r;
    var raw = r.data.markdown || '';
    var pg = await webNotion('GET', '/pages/' + pageId);
    var title = '(无标题)';
    if (pg.ok) {
      var props = pg.data.properties || {};
      var t = props.title || props.Name;
      if (t && t.title && t.title.length) title = t.title.map(function (x) { return x.plain_text; }).join('');
    }
    var urls = [];
    var re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, m;
    while ((m = re.exec(raw)) !== null) urls.push({ alt: m[1], url: m[2] });
    var uniq = []; urls.forEach(function (u) { if (uniq.indexOf(u.url) === -1) uniq.push(u.url); });

    var map = {}, images = [], failed = 0;
    if (downloadImages !== false && uniq.length) {
      var CONC = 6, idx = 0, done = 0;
      var results = {}, t0 = Date.now();
      async function worker() {
        while (idx < uniq.length) {
          var u = uniq[idx++];
          try {
            var res = await fetch(u, { mode: 'cors', credentials: 'omit' });
            if (!res.ok) throw new Error('HTTP ' + res.status);
            var blob = await res.blob();
            results[u] = await new Promise(function (resolve, reject) {
              var fr = new FileReader();
              fr.onload = function () { resolve(fr.result); };
              fr.onerror = function () { reject(new Error('read fail')); };
              fr.readAsDataURL(blob);
            });
          } catch (e) { results[u] = null; failed++; }
          done++;
          var ms = Date.now() - t0;
          var eta = done < uniq.length ? Math.ceil((ms / done) * (uniq.length - done) / 1000) : 0;
          setProgress('import', '下载图片 ' + done + '/' + uniq.length + (eta ? '，约还需 ' + eta + 's' : ''));
        }
      }
      var pool = [];
      for (var k = 0; k < Math.min(CONC, uniq.length); k++) pool.push(worker());
      await Promise.all(pool);
      var slot = 1;
      uniq.forEach(function (u) {
        if (results[u]) { map[u] = '【图片' + slot + '】'; images.push({ slot: slot, dataUrl: results[u], name: '' }); slot++; }
      });
    }
    var md = convertNotion(raw, { title: title, images: map });
    return { ok: true, page: { id: pageId, title: title }, markdown: md, images: images,
             stats: { rawChars: raw.length, outChars: md.length, imageTotal: uniq.length, imageFailed: failed } };
  }

  /* 浏览器模式的转换（与主进程 lib/convert.js 保持一致的规则） */
  function convertNotion(s, opt) {
    opt = opt || {};
    s = String(s || '');
    s = s.replace(/\$`([^`]*?)`\$/g, function (_, e) { return '$' + e + '$'; });
    var ICON = { '💡': 'tip', '📝': 'note', 'ℹ️': 'note', '⚠️': 'warning', '🚨': 'warning', '✅': 'success', '📌': 'note', '📋': 'note', '❓': 'note', '🔗': 'note' };
    function body(icon, inner) {
      var type = ICON[icon.trim()] || 'tip';
      var lines = inner.split('\n').map(function (l) { return l.replace(/^\t/, ''); });
      while (lines.length && !lines[0].trim()) lines.shift();
      var title = '';
      if (lines.length && !/^[#>\-*\d]/.test(lines[0].trim())) title = lines.shift().trim();
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      return ':::' + type + (title ? ' ' + title : '') + '\n\n' + lines.join('\n').trim() + '\n\n:::end';
    }
    s = s.replace(/<callout icon="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/callout>/g, function (_, ic, inner) { return body(ic, inner); });
    s = s.replace(/<callout icon="([^"]*)"[^>]*>([\s\S]*?)<\/callout>/g, function (_, ic, inner) { return body(ic, inner.replace(/\t/g, '')); });
    s = s.replace(/<table[^>]*>\n?([\s\S]*?)\n?<\/table>/g, function (_, inner) {
      var rows = [], rre = /<tr[^>]*>([\s\S]*?)<\/tr>/g, m;
      while ((m = rre.exec(inner)) !== null) {
        var cells = [], cre = /<td[^>]*>([\s\S]*?)<\/td>/g, c;
        while ((c = cre.exec(m[1])) !== null) cells.push(c[1].replace(/\n/g, ' ').replace(/\|/g, '\\|').trim());
        if (cells.length) rows.push(cells);
      }
      if (!rows.length) return '';
      var w = 0; rows.forEach(function (r) { w = Math.max(w, r.length); });
      var out = [];
      rows.forEach(function (r, i) { while (r.length < w) r.push(''); out.push('| ' + r.join(' | ') + ' |'); if (i === 0) { var s2 = []; for (var q = 0; q < w; q++) s2.push('---'); out.push('| ' + s2.join(' | ') + ' |'); } });
      return out.join('\n');
    });
    var CMAP = { gray: '#787774', brown: '#9f6b53', orange: '#d9730d', yellow: '#cb912f', green: '#448361', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47', gray_bg: '#e3e2e0', brown_bg: '#eee0da', orange_bg: '#fadec9', yellow_bg: '#fdecc8', green_bg: '#dbeddb', blue_bg: '#d3e5ef', purple_bg: '#e8deee', pink_bg: '#f5e0e9', red_bg: '#ffe2dd' };
    s = s.replace(/<span\s+color="([^"]+)"\s*>([\s\S]*?)<\/span>/g, function (_, c, inner) { return CMAP[c] ? '<font color="' + CMAP[c] + '">' + inner + '</font>' : inner; });
    s = s.replace(/<mention-page[^>]*\/>/g, '').replace(/<mention-page[^>]*>([\s\S]*?)<\/mention-page>/g, '$1');
    s = s.replace(/<mention-(?:user|database|data-source|agent)[^>]*\/>/g, '').replace(/<mention-(?:user|database|data-source|agent)[^>]*>([\s\S]*?)<\/mention-\w+>/g, '$1');
    s = s.replace(/<mention-date[^>]*\/>/g, '').replace(/<empty-block\/>/g, '').replace(/<table_of_contents[^>]*\/>/g, '');
    s = s.replace(/<br\s*\/?>/g, '  \n').replace(/<\/?synced_block[^>]*>/g, '').replace(/<unknown[^>]*\/>/g, '');
    s = s.replace(/<\/?columns[^>]*>/g, '').replace(/<\/?column[^>]*>/g, '');
    s = s.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g, function (_, t, b) { return ':::note ' + t.trim() + '\n\n' + b.replace(/\t/g, '').trim() + '\n\n:::end'; });
    // ⚠️ (?<!!) 不能少：Notion 会把 #notion_record=... 也塞进图片 URL，
    // 没这个负向断言会把图片 URL 改掉，导致后面按 URL 换占位符时全部失配、图片静默丢失
    s = s.replace(/(?<!!)\]\((https?:\/\/[^)]+?)#notion_record=[^)]*\)/g, ']($1)');
    s = s.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
    // 图片：整段 ![alt](url) 换成【图片N|题注】
    if (opt.images) {
      var stripRec = function (x) { return String(x).replace(/#notion_record=[^)]*$/, ''); };
      var normMap = {};
      Object.keys(opt.images).forEach(function (k) { normMap[stripRec(k)] = opt.images[k]; });
      s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, alt, url) {
        var ph = opt.images[url] || normMap[stripRec(url)];
        if (!ph) return m;
        var cap = String(alt || '').replace(/^(?:Figure|图)\s*\d+\s*[:：]\s*/i, '').trim();
        return cap ? ph.replace(/】$/, '|' + cap + '】') : ph;
      });
    }
    s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
    if (opt.title && !new RegExp('^#{1,3}\\s*' + opt.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(s)) s = '# ' + opt.title + '\n\n' + s;
    return s;
  }

  /* ======================================================== 样式 ==== */
  function injectCss() {
    if ($('xhmV3Css')) return;
    var st = document.createElement('style');
    st.id = 'xhmV3Css';
    st.textContent = [
      '#btnNotion{background:rgba(124,110,245,.16)!important;border:1px solid rgba(124,110,245,.45)!important;color:#b9aefc!important}',
      '#btnNotion:hover{background:rgba(124,110,245,.28)!important}',
      /* ---------- 右侧助手栏（停靠式，不是遮罩弹窗） ---------- */
      ':root{--sb-w:372px}',
      '#sbRoot{position:fixed;top:54px;right:0;bottom:0;width:var(--sb-w);background:var(--ui-toast,#1e1f2e);border-left:1px solid var(--ui-toast-border,#3b3f54);display:flex;flex-direction:column;transform:translateX(102%);transition:transform .2s ease;z-index:900;box-shadow:-10px 0 28px rgba(0,0,0,.3)}',
      '#sbRoot.open{transform:none}',
      'body.sb-open .main{padding-right:var(--sb-w)}',
      'body.sb-open .status-bar{padding-right:var(--sb-w)}',
      '#sbBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:899;opacity:0;pointer-events:none;transition:opacity .2s}',
      'body.sb-mobile.sb-open #sbBackdrop{opacity:1;pointer-events:auto}',
      '.sb-head{padding:10px 14px;border-bottom:1px solid var(--ui-toast-border,#3b3f54);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;gap:8px}',
      '.sb-title{color:var(--ui-text,#a9bacd);font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px}',
      '.sb-title .dot{width:7px;height:7px;border-radius:50%;background:#8fd6ac}',
      '.sb-title .sub{font-size:11px;color:var(--ui-text-dim,#565f89);font-weight:400}',
      '.sb-x{background:none;border:none;color:var(--ui-text-dim,#565f89);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:6px;font-family:inherit}',
      '.sb-x:hover{color:var(--ui-text,#a9bacd);background:rgba(255,255,255,.06)}',
      '.sb-tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--ui-toast-border,#3b3f54);flex-shrink:0;overflow-x:auto}',
      '.sb-tab{padding:9px 13px;font-size:12px;color:var(--ui-text-dim,#565f89);cursor:pointer;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit;white-space:nowrap}',
      '.sb-tab:hover{color:var(--ui-text,#a9bacd)}',
      '.sb-tab.on{color:#b9aefc;border-bottom-color:#7c6ef5}',
      '.sb-body{padding:14px 15px;overflow-y:auto;flex:1}',
      '.sb-foot{padding:8px 15px;border-top:1px solid var(--ui-toast-border,#3b3f54);flex-shrink:0}',
      '#sbFab{position:fixed;right:16px;bottom:22px;z-index:901;display:none;width:52px;height:52px;border-radius:50%;border:1px solid rgba(124,110,245,.5);background:rgba(124,110,245,.9);color:#fff;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.4);font-family:inherit}',
      'body.sb-mobile #sbFab{display:block}',
      '.sb-steps{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}',
      '.sb-steps .s{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--ui-text-dim,#565f89)}',
      '.sb-steps .s .n{width:16px;height:16px;border-radius:50%;border:1px solid var(--ui-border,#1e1f2e);display:flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}',
      '.sb-steps .s.done{color:#8fd6ac}.sb-steps .s.done .n{border-color:#8fd6ac;color:#8fd6ac}',
      /* 数据看板：指标卡 */
      '.sb-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}',
      '.sb-stat{background:rgba(255,255,255,.03);border:1px solid var(--ui-border,#1e1f2e);border-radius:8px;padding:8px 4px;text-align:center}',
      '.sb-stat b{display:block;color:var(--ui-text,#a9bacd);font-size:16px;line-height:1.25;font-weight:700}',
      '.sb-stat span{display:block;font-size:10px;color:var(--ui-text-dim,#565f89);margin-top:2px}',
      /* 对齐与间距统一：输入框/按钮同高、行内元素垂直居中、分隔清晰 */
      '.sb-body .xv-sec{border-bottom:1px solid rgba(255,255,255,.05);padding-bottom:14px}',
      '.sb-body .xv-sec:last-child{border-bottom:none}',
      '.xv-row{align-items:center;gap:8px}',
      '.xv-in,.xv-btn{height:32px;box-sizing:border-box}',
      '.xv-btn{padding:0 13px;line-height:30px}',
      '.xv-btn.xv-big{height:36px;line-height:34px;padding:0 20px}',
      '.xv-btn.sb-wide{display:block;width:100%;height:36px;line-height:34px;text-align:center;font-weight:600}',
      '.xv-seg{width:100%;display:grid;grid-template-columns:1fr 1fr 1fr}',
      '.xv-segb{padding:0 6px;height:32px;line-height:32px;text-align:center;font-size:11px}',
      '.xv-in:read-only{opacity:.85}',
      '.xv-status{margin-top:6px}',
      '.xv-sec{margin-bottom:18px}',
      '.xv-sec h4{color:var(--ui-accent,#7aa2f7);font-size:11px;letter-spacing:.5px;text-transform:uppercase;margin:0 0 8px;font-weight:600}',
      '.xv-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.xv-in{flex:1;min-width:120px;background:var(--ui-bg,#1a1b26);border:1px solid var(--ui-border,#1e1f2e);color:var(--ui-text,#a9bacd);border-radius:7px;padding:8px 11px;font-size:12px;font-family:inherit;outline:none}',
      '.xv-in:focus{border-color:var(--ui-accent,#7aa2f7)}',
      '.xv-btn{background:var(--ui-btn-bg,rgba(255,255,255,.05));border:1px solid var(--ui-border,#1e1f2e);color:var(--ui-text,#a9bacd);border-radius:7px;padding:8px 14px;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:background .12s}',
      '.xv-btn:hover:not(:disabled){background:var(--ui-btn-hover,rgba(255,255,255,.1))}',
      '.xv-btn:disabled{opacity:.4;cursor:not-allowed}',
      '.xv-btn.pri{background:rgba(124,110,245,.22);border-color:rgba(124,110,245,.5);color:#c3b9ff}',
      '.xv-btn.ok{background:rgba(68,131,97,.22);border-color:rgba(68,131,97,.5);color:#8fd6ac}',
      '.xv-btn.danger{background:rgba(212,76,71,.18);border-color:rgba(212,76,71,.45);color:#f0a3a0}',
      '.xv-list{max-height:240px;overflow-y:auto;border:1px solid var(--ui-border,#1e1f2e);border-radius:9px;margin-top:9px}',
      '.xv-item{padding:9px 12px;border-bottom:1px solid var(--ui-border,#1e1f2e);cursor:pointer;display:flex;justify-content:space-between;gap:10px;align-items:center}',
      '.xv-item:last-child{border-bottom:none}',
      '.xv-item:hover{background:var(--ui-btn-hover,rgba(255,255,255,.1))}',
      '.xv-item.sel{background:rgba(124,110,245,.16)}',
      '.xv-item .t{color:var(--ui-text,#a9bacd);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xv-item .d{color:var(--ui-text-dim,#565f89);font-size:11px;white-space:nowrap;flex-shrink:0}',
      '.xv-empty{padding:18px;text-align:center;color:var(--ui-text-dim,#565f89);font-size:12px}',
      '.xv-status{font-size:11px;color:var(--ui-text-dim,#565f89);margin-top:8px;min-height:15px;white-space:pre-wrap;line-height:1.6}',
      '.xv-kv{display:flex;gap:8px;font-size:12px;color:var(--ui-text,#a9bacd);margin:4px 0;align-items:center}',
      '.xv-kv .k{color:var(--ui-text-dim,#565f89);min-width:96px}',
      '.xv-bar{height:4px;background:var(--ui-border,#1e1f2e);border-radius:2px;overflow:hidden;margin-top:8px;display:none}',
      '.xv-bar.on{display:block}',
      '.xv-bar>i{display:block;height:100%;background:linear-gradient(90deg,#7c6ef5,#7aa2f7);width:0;transition:width .25s}',
      '.xv-help{font-size:11px;color:var(--ui-text-dim,#565f89);line-height:1.7;margin-top:6px}',
      '.xv-help a{color:var(--ui-accent,#7aa2f7);cursor:pointer;text-decoration:none}',
      '.xv-help a:hover{text-decoration:underline}',
      '.xv-note{background:rgba(124,110,245,.1);border-left:3px solid #7c6ef5;padding:8px 12px;border-radius:0 7px 7px 0;font-size:11px;color:var(--ui-text,#a9bacd);line-height:1.7;margin:8px 0}',
      '.xv-warn{background:rgba(217,115,13,.12);border-left:3px solid #d9730d;padding:8px 12px;border-radius:0 7px 7px 0;font-size:11px;color:var(--ui-text,#a9bacd);line-height:1.7;margin:8px 0}',
      '.xv-chk{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text,#a9bacd);cursor:pointer}',
      '.xv-tag{display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;background:rgba(124,110,245,.18);color:#b9aefc;margin-left:6px}',
      '.xv-tag.g{background:rgba(68,131,97,.2);color:#8fd6ac}',
      '.xv-tag.r{background:rgba(212,76,71,.2);color:#f0a3a0}',
      /* 存档：模式切换（分段控件） */
      '.xv-seg{display:flex;gap:0;margin-top:10px;border:1px solid var(--ui-border,#1e1f2e);border-radius:8px;overflow:hidden;width:fit-content}',
      '.xv-segb{background:var(--ui-bg,#1a1b26);border:none;border-right:1px solid var(--ui-border,#1e1f2e);color:var(--ui-text-dim,#565f89);padding:8px 18px;font-size:12px;cursor:pointer;font-family:inherit;transition:background .12s,color .12s}',
      '.xv-segb:last-child{border-right:none}',
      '.xv-segb:hover{color:var(--ui-text,#a9bacd);background:var(--ui-btn-hover,rgba(255,255,255,.06))}',
      '.xv-segb.on{background:rgba(124,110,245,.24);color:#c3b9ff;font-weight:600}',
      '.xv-hint{font-size:11px;color:var(--ui-text-dim,#565f89);margin-top:7px;line-height:1.6}',
      /* 已选目标页面 */
      '.xv-picked{flex:1;min-width:0;display:flex;align-items:center;gap:8px;background:rgba(124,110,245,.08);border:1px solid rgba(124,110,245,.28);border-radius:7px;padding:7px 11px;font-size:12px}',
      '.xv-picked .k{color:var(--ui-text-dim,#565f89);flex-shrink:0}',
      '.xv-picked .v{color:var(--ui-text,#a9bacd);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.xv-btn.xv-big{padding:10px 22px;font-size:13px;font-weight:600}',
      '.xv-link{color:var(--ui-accent,#7aa2f7);cursor:pointer;text-decoration:underline}',
      '.xv-ok{color:#8fd6ac}',
      /* ---------- 响应式：窄屏改成抽屉 + 手机排版优化 ---------- */
      '@media (max-width:900px){',
      '  #sbRoot{top:0;width:min(100vw,430px);z-index:1000}',
      '  body.sb-open .main,body.sb-open .status-bar{padding-right:0}',
      '  .sb-tab{padding:9px 11px;font-size:12px}',
      '  .sb-body{padding:12px}',
      '}',
      '@media (max-width:768px){',
      '  .toolbar{height:auto!important;min-height:54px;flex-wrap:wrap;padding:6px 10px!important;row-gap:6px}',
      '  .toolbar-left,.toolbar-right{flex-wrap:wrap;gap:5px}',
      '  .toolbar .tb-sep{display:none}',
      '  #editorPanel,#previewPanel{min-height:0}',
      '  .panel-header{font-size:11px;padding:5px 10px}',
      '  .preview-scroll{padding:10px}',
      '  .status-bar{font-size:10px;flex-wrap:wrap;row-gap:3px}',
      '  .btn{padding:5px 9px!important;font-size:11px!important}',
      '}',
      '@media (max-width:620px){',
      '  .logo{display:none}',
      '  #sbRoot{width:100vw}',
      '  .sb-head{padding:9px 12px}',
      '  .xv-sec h4{font-size:10px}',
      '}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function setProgress(scope, msg) { S.lastProgress = msg; setText('xvProg', msg); }

  /* ==================================================== 面板 HTML ==== */
  /* ================================================ 右侧助手栏 HTML ==== */
  /* 业务主线：① 从 Notion 导入 → ② 在左边排版 → ③ 推送公众号
     旁支：④ 文稿（本机自动保存）+ 手动「保存到 Notion」—— 一律不自动执行。 */
  function buildPanel() {
    if ($('sbRoot')) return;
    var d = document.createElement('div');
    d.id = 'sbRoot';
    d.innerHTML = [
      '<div class="sb-head">',
      '  <div class="sb-title"><span class="dot"></span>创作台助手<span class="sub" id="xvMode"></span></div>',
      '  <button class="sb-x" id="sbClose" title="收起（Ctrl+B）">&times;</button>',
      '</div>',
      '<div class="sb-tabs">',
      '  <button class="sb-tab on" data-tab="import">① 导入</button>',
      '  <button class="sb-tab" data-tab="push">② 推送公众号</button>',
      '  <button class="sb-tab" data-tab="docs">③ 同步 Notion</button>',
      '  <button class="sb-tab" data-tab="data">数据</button>',
      '  <button class="sb-tab" data-tab="settings">设置</button>',
      '</div>',
      '<div class="sb-body">',

      /* ---------------- ① 导入 ---------------- */
      '  <div class="sb-pane" data-pane="import">',
      '    <div class="sb-steps">',
      '      <div class="s" id="stp1"><span class="n">1</span>从 Notion 选一篇笔记</div>',
      '      <div class="s" id="stp2"><span class="n">2</span>在左边调排版</div>',
      '      <div class="s" id="stp3"><span class="n">3</span>到「推送公众号」发草稿</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>从 Notion 导入</h4>',
      '      <div class="xv-row">',
      '        <input class="xv-in" id="xvQuery" placeholder="搜索标题（留空 = 最近编辑的 40 篇）">',
      '        <button class="xv-btn" id="xvSearch">搜索</button>',
      '      </div>',
      '      <div class="xv-list" id="xvList"><div class="xv-empty">输入关键字后搜索</div></div>',
      '      <label class="xv-chk" style="margin-top:10px"><input type="checkbox" id="xvOptImg" checked> 同时下载图片转 base64（发微信必需）</label>',
      '      <div class="xv-row" style="margin-top:8px">',
      '        <button class="xv-btn pri" id="xvImport" disabled>导入到编辑器</button>',
      '        <span class="xv-status" id="xvImportStatus" style="margin:0"></span>',
      '      </div>',
      '      <div class="xv-note">导入只是把内容拉到编辑器里：<b>不会改动 Notion，也不会自动存档</b>。排版满意后再去「推送公众号」。</div>',
      '    </div>',
      '  </div>',

      /* ---------------- ② 推送公众号 ---------------- */
      '  <div class="sb-pane" data-pane="push" style="display:none">',
      '    <div class="xv-sec">',
      '      <h4>先体检（可选）</h4>',
      '      <div class="xv-row"><button class="xv-btn" id="xvProbe">一键自检</button>',
      '        <span class="xv-status" id="xvProbeStatus" style="margin:0"></span></div>',
      '      <div id="xvProbeDetail"></div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>推送到公众号草稿箱</h4>',
      '      <div class="xv-row">',
      '        <button class="xv-btn ok" id="xvPush">推送到草稿箱</button>',
      '        <button class="xv-btn" id="xvDry">先干跑体检</button>',
      '      </div>',
      '      <div class="xv-row" style="margin-top:6px">',
      '        <button class="xv-btn" id="xvCopyHint">复制到微信（Ctrl+Shift+C）</button>',
      '      </div>',
      '      <div class="xv-bar" id="xvBar"><i id="xvBarFill"></i></div>',
      '      <div class="xv-status" id="xvPushStatus"></div>',
      '      <div class="xv-warn">微信限制：正文必须少于 <b>2 万字符</b>，图片只能用微信自己的图床。'
        + '<b>公式密集型长文请用「复制到微信」</b>——那条路没有大小限制。'
        + '个人订阅号没有发布接口权限，草稿需在公众号后台手动发表。</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>草稿箱</h4>',
      '      <div class="xv-row"><button class="xv-btn" id="xvDrafts">刷新草稿列表</button>',
      '        <button class="xv-btn danger" id="xvCleanTest">删除我的测试草稿</button>',
      '        <button class="xv-btn" id="xvOpenMp">打开公众号后台</button></div>',
      '      <div class="xv-list" id="xvDraftList"><div class="xv-empty">尚未加载草稿</div></div>',
      '    </div>',
      '  </div>',

      /* ---------------- ③ 同步 Notion ---------------- */
      '  <div class="sb-pane" data-pane="docs" style="display:none">',
      '    <div class="xv-sec">',
      '      <h4>同步到 Notion</h4>',
      '      <div class="xv-note" id="nsLinked" style="display:none"></div>',
      '      <div class="xv-seg" id="nsSeg">',
      '        <button class="xv-segb on" data-mode="new">新建页面</button>',
      '        <button class="xv-segb" data-mode="update">更新已存页面</button>',
      '        <button class="xv-segb" data-mode="append">追加到页面</button>',
      '      </div>',
      '      <div class="xv-hint" id="nsHint"></div>',
      '      <div class="xv-row" id="nsParentRow" style="margin-top:10px">',
      '        <input class="xv-in" id="nsParentId" placeholder="父页面 ID（留空 = 工作区顶层）">',
      '        <button class="xv-btn" id="nsPickParent">选择父页面</button>',
      '      </div>',
      '      <div class="xv-row" id="nsTargetRow" style="margin-top:10px;display:none">',
      '        <div class="xv-picked"><span class="k">目标</span><span class="v" id="nsTargetName">尚未选择</span></div>',
      '        <button class="xv-btn" id="nsPick">选择页面</button>',
      '      </div>',
      '      <div id="nsPickWrap" style="display:none">',
      '        <div class="xv-row" style="margin-top:8px">',
      '          <input class="xv-in" id="nsPickQuery" placeholder="按标题搜索（留空 = 最近 40 篇）">',
      '          <button class="xv-btn" id="nsPickSearch">搜索</button>',
      '          <button class="xv-btn" id="nsPickClose">收起</button>',
      '        </div>',
      '        <div class="xv-list" id="nsPickList"></div>',
      '      </div>',
      '      <button class="xv-btn pri sb-wide" id="nsSave" style="margin-top:12px">保存到 Notion（更新那一页）</button>',
      '      <div class="xv-status" id="nsStatus"></div>',
      '      <div class="xv-note">文稿与 Notion 页面一一对应：已关联的文稿默认执行<b>更新</b>，不会重复建页。'
        + '编辑器内容在本机自动保存。</div>',
      '    </div>',
      '  </div>',

      /* ---------------- ④ 数据看板 ---------------- */
      '  <div class="sb-pane" data-pane="data" style="display:none">',
      '    <div class="xv-sec">',
      '      <h4>内容产出</h4>',
      '      <div class="sb-stats">',
      '        <div class="sb-stat"><b id="dashDrafts">–</b><span>草稿</span></div>',
      '        <div class="sb-stat"><b id="dashImages">–</b><span>图片素材</span></div>',
      '        <div class="sb-stat"><b id="dashVideos">–</b><span>视频素材</span></div>',
      '        <div class="sb-stat"><b id="dashNews">–</b><span>图文素材</span></div>',
      '        <div class="sb-stat"><b id="dashDocs">–</b><span>本机文稿</span></div>',
      '        <div class="sb-stat"><b id="dashLinked">–</b><span>已存 Notion</span></div>',
      '      </div>',
      '      <div class="xv-row" style="margin-top:10px">',
      '        <button class="xv-btn pri" id="dashRefresh">刷新数据</button>',
      '        <button class="xv-btn" id="dashOpenMp">打开公众号后台</button>',
      '      </div>',
      '      <div class="xv-status" id="dashStatus"></div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>草稿产出节奏（近 4 周）</h4>',
      '      <div id="dashChart" style="height:118px;width:100%"></div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>最近草稿</h4>',
      '      <div class="xv-list" id="dashList"><div class="xv-empty">尚未加载数据</div></div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>互动数据（阅读 / 点赞 / 分享 / 关注）</h4>',
      '      <div class="xv-warn" id="dashInteract">尚未加载数据后显示接口实测状态。</div>',
      '      <div class="xv-help">这类数据微信只开放给认证服务号等账号类型，个人订阅号在 API 侧拿不到；'
        + '后台仍可人工查看：公众号后台 → 内容分析 → 图文分析。</div>',
      '    </div>',
      '  </div>',

      /* ---------------- ⑤ 设置 ---------------- */
      '  <div class="sb-pane" data-pane="settings" style="display:none">',
      '    <div class="xv-sec">',
      '      <h4>密钥存储</h4>',
      '      <div class="xv-note" id="xvCryptNote">🔒 Notion Token / 微信 AppID / AppSecret 均以 <b>Windows DPAPI 加密</b>后落盘（密钥绑定当前 Windows 用户），配置文件里不会出现明文。</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>Notion API</h4>',
      '      <div class="xv-row"><input class="xv-in" id="xvNotionToken" type="password" placeholder="Notion Token（ntn_ 开头）"></div>',
      '      <div class="xv-row" style="margin-top:6px"><button class="xv-btn" id="xvSaveNotion">保存</button>',
      '        <button class="xv-btn" id="xvVerifyNotion">验证</button>',
      '        <span class="xv-status" id="xvNotionCfgStatus" style="margin:0"></span></div>',
      '      <div class="xv-help">在 <a data-open="https://www.notion.so/developers/tokens">notion.so/developers/tokens</a> 建 PAT，能力勾 <b>Notion API</b>。留空保存 = 不改动已存的密钥。</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>微信公众号 API</h4>',
      '      <div class="xv-row"><input class="xv-in" id="xvAppId" placeholder="AppID（wx 开头）"></div>',
      '      <div class="xv-row" style="margin-top:6px"><input class="xv-in" id="xvSecret" type="password" placeholder="AppSecret">',
      '        <button class="xv-btn" id="xvSaveWechat">保存</button>',
      '        <button class="xv-btn" id="xvVerifyWechat">验证</button></div>',
      '      <div class="xv-status" id="xvWechatCfgStatus"></div>',
      '      <div class="xv-help">公众号后台 → 设置与开发 → 基本配置。别忘了把本机出口 IP 加进 <b>IP 白名单</b>，否则会报 40164。</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>行为</h4>',
      '      <label class="xv-chk" style="margin:6px 0"><input type="checkbox" id="xvWriteback" checked> 推送公众号后自动回写 Notion（沉淀发布记录）</label>',
      '      <label class="xv-chk" style="margin:6px 0"><input type="checkbox" id="xvAutoPublish"> 建完草稿后顺便提交发布（个人订阅号会失败，仅认证号有意义）</label>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>手机访问（局域网）</h4>',
      '      <label class="xv-chk" style="margin:6px 0"><input type="checkbox" id="xvLan"> 开启局域网服务</label>',
      '      <div class="xv-row" style="margin-top:8px"><span class="xv-kv"><span class="k">端口</span></span><input class="xv-in" id="xvLanPort" style="max-width:110px" placeholder="8899">',
      '        <button class="xv-btn" id="xvSaveLan">应用</button></div>',
      '      <div class="xv-status" id="xvLanStatus"></div>',
      '      <div class="xv-help">开启后手机连同一 Wi-Fi 打开下面地址即可排版（手机端可导入 Notion、调排版、复制到微信；存档与推草稿建议在电脑端做）。</div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>本机出口 IP（公众号 IP 白名单用）</h4>',
      '      <div class="xv-row"><input class="xv-in" id="xvEgressIp" placeholder="点「获取」显示本机出口 IP" readonly>',
      '        <button class="xv-btn" id="xvGetIp">获取</button>',
      '        <button class="xv-btn" id="xvCopyIp">复制</button></div>',
      '      <div class="xv-status" id="xvIpStatus"></div>',
      '      <div class="xv-help">这个 IP 要加进「公众号后台 → 设置与开发 → 基本配置 → IP 白名单」，否则报 40164。'
        + '<b>换一台电脑运行、或 VPN 重连后出口 IP 会变，需要重新加一次。</b></div>',
      '    </div>',
      '    <div class="xv-sec">',
      '      <h4>其它</h4>',
      '      <div class="xv-row"><button class="xv-btn" id="xvOpenCfgDir">打开配置文件夹</button>',
      '        <button class="xv-btn danger" id="xvQuit">退出应用 (Ctrl+Q)</button></div>',
      '      <div class="xv-status" id="xvCfgPath"></div>',
      '    </div>',
      '  </div>',

      '</div>',
      '<div class="sb-foot"><span class="xv-status" id="xvProg" style="margin:0"></span></div>',
      '</div>'].join('\n');
    document.body.appendChild(d);

    var bd = document.createElement('div');
    bd.id = 'sbBackdrop';
    document.body.appendChild(bd);

    var fab = document.createElement('button');
    fab.id = 'sbFab';
    fab.type = 'button';
    fab.title = '打开创作台助手（导入 / 推送 / 文稿）';
    fab.textContent = '助手';
    fab.addEventListener('click', open);
    document.body.appendChild(fab);
  }


  /* ==================================================== 动作实现 ==== */
  const busy = (on) => { S.busy = on; ['xvSearch', 'xvImport', 'nsSave', 'xvPush', 'xvDry', 'docNew', 'docSaveNow'].forEach(function (id) { var e = $(id); if (e) e.disabled = on || (id === 'xvImport' && !S.page); }); };

  async function doSearch() {
    busy(true); setText('xvImportStatus', '搜索中…');
    try {
      var r = await API.search(val('xvQuery').trim());
      if (!r.ok) { setText('xvImportStatus', '❌ ' + r.error + (r.hint ? '（' + r.hint + '）' : '')); return; }
      S.results = r.items || [];
      setText('xvImportStatus', '找到 ' + S.results.length + ' 篇');
      renderList();
    } finally { busy(false); }
  }

  function renderList() {
    var box = $('xvList');
    if (!S.results.length) { box.innerHTML = '<div class="xv-empty">没有结果</div>'; return; }
    box.innerHTML = S.results.map(function (r) {
      return '<div class="xv-item' + (S.page && S.page.id === r.id ? ' sel' : '') + '" data-id="' + esc(r.id) + '">' +
        '<span class="t">' + esc(r.title) + '</span><span class="d">' + esc(r.edited) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.xv-item'), function (el) {
      el.addEventListener('click', function () {
        S.page = S.results.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0] || null;
        renderList();
        $('xvImport').disabled = !S.page;
        if (S.page) setText('xvImportStatus', '已选：' + S.page.title + '（点「导入到编辑器」把内容拉进来）');
      });
    });
  }

  async function doImport() {
    if (!S.page) return;
    if (window.editor.value && window.editor.value.trim() && !confirm('编辑器里已有内容，导入会覆盖。继续？')) return;
    busy(true);
    try {
      var r = await API.importPage(S.page.id, $('xvOptImg').checked);
      if (!r.ok) { setText('xvImportStatus', '❌ ' + r.error + (r.hint ? '（' + r.hint + '）' : '')); return; }
      // 写入 imageStore（复用 V2 的【图片N】管线）
      var maxSlot = window.imageCounter || 0;
      (r.images || []).forEach(function (im) {
        window.imageStore[im.slot] = { dataUrl: im.dataUrl, name: im.name || ('image_' + im.slot) };
        if (im.slot > maxSlot) maxSlot = im.slot;
      });
      window.imageCounter = maxSlot;
      window.editor.value = r.markdown;
      if (typeof window.pushUndoState === 'function') window.pushUndoState();
      if (typeof window.render === 'function') await window.render();
      // 记录来源页面：这样之后 Ctrl+S / 保存按钮默认就是"更新这一页"，不会新建重复页
      S.doc = Object.assign({}, S.doc, {
        title: r.page.title || (S.doc && S.doc.title) || '未命名文稿',
        notionPageId: r.page.id, notionUrl: r.page.url || '',
      });
      S.nsTargetId = r.page.id; S.nsTargetTitle = r.page.title || '';
      if (IS_DESKTOP && N.docs) {
        await N.docs.save({ id: S.doc.id, title: S.doc.title, content: editorValue(), imageStore: window.imageStore || {}, notionPageId: r.page.id, notionUrl: r.page.url || '' });
      }
      updateNsUI();
      var st = r.stats || {};
      setText('xvImportStatus', '✅ 已导入「' + r.page.title + '」 ' + st.outChars + ' 字符' +
        (st.imageTotal ? '，图片 ' + (st.imageTotal - (st.imageFailed || 0)) + '/' + st.imageTotal + ' 已内嵌' : '') +
        '（' + ((st.elapsedMs || 0) / 1000).toFixed(1) + 's）');
      toast('已导入：' + r.page.title, 'success');
      busy(false);
      // 导入后**不做任何写回**：只是把内容放进了编辑器，接着排版即可
      updateSteps();
      scheduleAutosave();
    } finally { busy(false); }
  }

  /* ==================================================== 数据看板 ==== */
  var dashChart = null;

  async function doDashboard() {
    if (!IS_DESKTOP) { setStatus('dashStatus', '数据看板需要在电脑端桌面版使用'); return; }
    setStatus('dashStatus', '读取公众号数据…');
    $('dashRefresh').disabled = true;
    try {
      var r = await API.wechatDashboard();
      var m = (r && r.material) || {};
      var d = (r && r.drafts) || {};
      var loc = (r && r.local) || {};
      var num = function (v) { return (v === undefined || v === null) ? '–' : v; };
      setText('dashDrafts', num(d.total));
      setText('dashImages', num(m.image_count));
      setText('dashVideos', num(m.video_count));
      setText('dashNews', num(m.news_count));
      setText('dashDocs', num(loc.docs));
      setText('dashLinked', num(loc.docsLinked));

      if (!r.ok) {
        setStatus('dashStatus', '❌ ' + r.error + (r.hint ? '（' + r.hint + '）' : ''));
      } else {
        setStatus('dashStatus', '✅ 已更新 ' + nowHHMM() + (d.total ? '　草稿 ' + d.total + ' 篇' : ''));
      }

      var items = d.items || [];
      var box = $('dashList');
      if (!items.length) box.innerHTML = '<div class="xv-empty">没有取到草稿（或接口无权限）</div>';
      else box.innerHTML = items.map(function (it) {
        var t = it.updated ? new Date(it.updated) : null;
        var when = t ? ((t.getMonth() + 1) + '-' + t.getDate() + ' ' + ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2)) : '';
        return '<div class="xv-item"><span class="t">' + esc(it.title) + '</span><span class="d">' + esc(when) + '</span></div>';
      }).join('');

      renderDashChart(items);

      var s = (r.interact && r.interact.getusersummary) || {};
      var extra = (s.httpStatus !== undefined)
        ? ('（接口实测：HTTP ' + s.httpStatus + (s.hasBody ? '，有返回体' : '，空返回体') + (s.errcode ? '，errcode=' + s.errcode : '') + '）')
        : '';
      setText('dashInteract', '⚠️ ' + (r.interactNote || '未探测') + extra);
    } finally { $('dashRefresh').disabled = false; }
  }

  /** 按周聚合草稿更新时间 */
  function renderDashChart(items) {
    var el = $('dashChart');
    if (!el) return;
    if (typeof window.echarts === 'undefined') { el.innerHTML = '<div class="xv-empty">图表库未加载</div>'; return; }
    var now = Date.now();
    var weeks = [];
    for (var w = 3; w >= 0; w--) {
      weeks.push({
        label: w === 0 ? '本周' : (w + ' 周前'),
        from: now - (w + 1) * 7 * 86400000,
        to: now - w * 7 * 86400000,
        n: 0,
      });
    }
    (items || []).forEach(function (it) {
      if (!it.updated) return;
      var t = new Date(it.updated).getTime();
      for (var i = 0; i < weeks.length; i++) {
        if (t >= weeks[i].from && t < weeks[i].to) { weeks[i].n++; break; }
      }
    });
    try {
      if (!dashChart) dashChart = window.echarts.init(el, null, { renderer: 'svg' });
      dashChart.setOption({
        grid: { left: 4, right: 8, top: 12, bottom: 16, containLabel: true },
        xAxis: {
          type: 'category',
          data: weeks.map(function (x) { return x.label; }),
          axisLabel: { fontSize: 9, color: '#565f89' },
          axisLine: { lineStyle: { color: '#2a2e42' } },
          axisTick: { show: false },
        },
        yAxis: {
          type: 'value', minInterval: 1,
          axisLabel: { fontSize: 9, color: '#565f89' },
          splitLine: { lineStyle: { color: '#22263a' } },
        },
        tooltip: { trigger: 'axis' },
        series: [{ type: 'bar', data: weeks.map(function (x) { return x.n; }), barWidth: '46%', itemStyle: { color: '#7c6ef5', borderRadius: [3, 3, 0, 0] } }],
      });
    } catch (e) { el.innerHTML = '<div class="xv-empty">图表渲染失败：' + esc(e.message) + '</div>'; }
  }

  /* ==================================================== 文稿（本机持久化） */
  /* 主线：从 Notion 导入 → 排版 → 推送公众号。文稿只在**本机**自动保存；
     存回 Notion 一律是显式动作，且同一篇文稿只对应一个 Notion 页面（防重复存档）。 */
  var AUTOSAVE_MS = 2500;
  var autosaveTimer = null;
  var LS_DOCS = 'xhm_v3_docs';

  function editorValue() { return (window.editor && window.editor.value) || ''; }
  function nowHHMM() { var t = new Date(); return ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2); }
  /** 写状态文字（元素不存在就安静跳过；cls 可选，用于染色） */
  function setStatus(id, t, cls) {
    var e = $(id);
    if (!e) return;
    e.textContent = t || '';
    if (cls !== undefined) e.className = 'xv-status' + (cls ? ' ' + cls : '');
  }

  function docTitleGuess() {
    var m = editorValue().match(/^#\s+(.+)$/m);
    if (m) return m[1].trim().slice(0, 120);
    return (S.doc && S.doc.title) || '未命名文稿';
  }

  /* ---- 浏览器/手机模式的兜底存储（桌面版走主进程文稿库） ---- */
  function readLocalDocs() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_DOCS) || '{}');
      return Object.keys(raw).map(function (id) {
        var d = raw[id];
        return { id: id, title: d.title, updatedAt: d.updatedAt, chars: (d.content || '').length, images: Object.keys(d.imageStore || {}).length, notionPageId: d.notionPageId || '' };
      }).sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
    } catch (e) { return []; }
  }
  function writeLocalDoc(doc) {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_DOCS) || '{}');
      var id = doc.id || ('d' + Date.now().toString(36));
      raw[id] = { title: doc.title, content: doc.content, imageStore: doc.imageStore || {}, updatedAt: new Date().toISOString(), notionPageId: doc.notionPageId || '' };
      localStorage.setItem(LS_DOCS, JSON.stringify(raw));
      S.doc = Object.assign({}, S.doc, { id: id, title: doc.title, content: doc.content, imageStore: doc.imageStore });
      return id;
    } catch (e) { return null; }
  }

  /* ---- 文稿列表 ---- */
  async function refreshDocs() {
    if (IS_DESKTOP && N.docs) {
      var r = await N.docs.list().catch(function () { return null; });
      S.docs = (r && r.items) || [];
      S.docCurrentId = (r && r.currentId) || '';
    } else {
      S.docs = readLocalDocs();
    }
    renderDocList();
  }

  function renderDocList() {
    var box = $('docList');
    if (!box) return;
    if (!S.docs || !S.docs.length) { box.innerHTML = '<div class="xv-empty">还没有文稿 —— 点「新建文稿」，或从 Notion 导入</div>'; return; }
    box.innerHTML = S.docs.map(function (d) {
      var cur = (S.doc && S.doc.id === d.id) ? ' sel' : '';
      var t = new Date(d.updatedAt || Date.now());
      var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
      var tag = d.notionPageId ? ' · Notion✓' : '';
      return '<div class="xv-item' + cur + '" data-doc="' + esc(d.id) + '">' +
        '<span class="t">' + esc(d.title || '未命名文稿') + '</span>' +
        '<span class="d">' + (d.chars || 0) + ' 字 · ' + hh + tag + ' <span data-deldoc="' + esc(d.id) + '" title="删除这篇文稿">✕</span></span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-doc]'), function (el) {
      el.addEventListener('click', function (ev) {
        if (ev.target && ev.target.getAttribute && ev.target.getAttribute('data-deldoc')) return;
        openDoc(el.getAttribute('data-doc'));
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-deldoc]'), function (el) {
      el.addEventListener('click', async function (ev) {
        ev.stopPropagation();
        var id = el.getAttribute('data-deldoc');
        if (!window.confirm('删除这篇文稿？（只删本机文稿，不影响 Notion）')) return;
        if (IS_DESKTOP && N.docs) await N.docs.remove(id);
        else { try { var raw = JSON.parse(localStorage.getItem(LS_DOCS) || '{}'); delete raw[id]; localStorage.setItem(LS_DOCS, JSON.stringify(raw)); } catch (e) { /* 忽略 */ } }
        if (S.doc && S.doc.id === id) { S.doc = null; applyDoc({ content: '', imageStore: {} }); }
        await refreshDocs();
      });
    });
  }

  /* ---- 当前文稿 → 编辑器 ---- */
  function applyDoc(doc) {
    S.doc = Object.assign({ id: '', title: '', content: '', imageStore: {}, notionPageId: '', notionUrl: '' }, doc || {});
    if (window.editor) window.editor.value = S.doc.content || '';
    window.imageStore = S.doc.imageStore || {};
    if (typeof window.updateEditorStats === 'function') window.updateEditorStats();
    if (typeof window.debouncedRender === 'function') window.debouncedRender();
    if (typeof window.markContentSaved === 'function') window.markContentSaved();
    renderDocList();
    updateNsUI();
    updateSteps();
  }

  async function openDoc(id) {
    if (S.doc && S.doc.id === id) return;
    if (IS_DESKTOP && N.docs) {
      var r = await N.docs.get(id);
      if (r && r.doc) { await N.docs.select(id); applyDoc(r.doc); setStatus('docStatus', '已打开「' + r.doc.title + '」'); }
    } else {
      try {
        var raw = JSON.parse(localStorage.getItem(LS_DOCS) || '{}');
        if (raw[id]) applyDoc(Object.assign({ id: id }, raw[id]));
      } catch (e) { /* 忽略 */ }
    }
  }

  /** 新建后把光标放到 H1 标题上并选中占位文字，直接打字就能替换 */
  function focusTitle() {
    if (!window.editor) return;
    try {
      window.editor.focus();
      var m = (window.editor.value || '').match(/^#\s+(.+)$/m);
      if (m) window.editor.setSelectionRange(2, 2 + m[1].length);
      window.editor.scrollTop = 0;
    } catch (e) { /* 忽略 */ }
  }

  /** 编辑器里是否有"真正的内容"（空文稿模板不算内容） */
  function hasRealContent() {
    var s = editorValue().trim();
    if (!s) return false;
    // 只有一行 H1 且是"未命名文稿"占位标题 → 视为空
    return !/^#\s*未命名文稿(\s*\d+)?$/.test(s);
  }

  async function newDoc() {
    // 当前已经是空文稿（含刚生成的模板）→ 直接复用，不再堆一篇空稿
    if (!hasRealContent() && S.doc && S.doc.id) {
      setStatus('docStatus', '当前就是一篇空文稿，当前已是空白文稿');
      focusTitle();
      return;
    }
    // 有内容时先落盘（本来就在自动保存，不需要弹确认框打断）
    if (editorValue().trim()) await saveDocNow(true);

    var seq = (S.docs || []).filter(function (d) { return /^未命名文稿/.test(d.title || ''); }).length + 1;
    var title = seq > 1 ? ('未命名文稿 ' + seq) : '未命名文稿';
    var blank = '# ' + title + '\n\n';
    var made = null;
    if (IS_DESKTOP && N.docs) {
      var r = await N.docs.create(title, blank);
      made = r && r.doc;
    } else {
      var id = writeLocalDoc({ title: title, content: blank, imageStore: {} });
      made = { id: id, title: title, content: blank, imageStore: {} };
    }
    if (made) applyDoc(made);
    await refreshDocs();
    updateSteps();
    setStatus('docStatus', '已新建「' + title + '」，标题已选中，可直接输入');
    focusTitle();
  }

  /* ---- 保存（本地）---- */
  async function saveDocNow(silent) {
    var payload = {
      id: (S.doc && S.doc.id) || undefined,
      title: docTitleGuess(),
      content: editorValue(),
      imageStore: window.imageStore || {},
    };
    window.__saveDbg = { images: Object.keys(payload.imageStore || {}).length, contentLen: payload.content.length, id: payload.id || '(新)', at: Date.now() };
    if (IS_DESKTOP && N.docs) {
      var r = await N.docs.save(payload).catch(function (e) { return { ok: false, error: e.message }; });
      if (r && r.ok) {
        S.doc = Object.assign({}, S.doc, { id: r.doc.id, title: r.doc.title, content: payload.content, imageStore: payload.imageStore });
        if (typeof window.markContentSaved === 'function') window.markContentSaved();
        setStatus('docStatus', '已保存 ' + nowHHMM());
        await refreshDocs();
        if (!silent) toast('文稿已保存到本机', 'success');
        return true;
      }
      setStatus('docStatus', '❌ ' + ((r && r.error) || '保存失败'));
      return false;
    }
    var id = writeLocalDoc(Object.assign({ id: (S.doc && S.doc.id) || undefined }, payload));
    if (id) { setStatus('docStatus', '已保存 ' + nowHHMM() + '（本机）'); return true; }
    setStatus('docStatus', '❌ 浏览器本地存储写入失败');
    return false;
  }

  function scheduleAutosave() {
    if (autosaveTimer) clearTimeout(autosaveTimer);
    setStatus('docStatus', '编辑中…');
    autosaveTimer = setTimeout(function () { saveDocNow(true); }, AUTOSAVE_MS);
  }

  /* ---- 三步进度提示 ---- */
  function updateSteps() {
    var has = !!editorValue().trim();
    var linked = !!(S.doc && S.doc.notionPageId);
    var e1 = $('stp1'), e2 = $('stp2'), e3 = $('stp3');
    if (e1) e1.classList.toggle('done', has);
    if (e2) e2.classList.toggle('done', has);
    if (e3) e3.classList.toggle('done', linked);
  }

  /* ============================================ 保存到 Notion（手动、防重复） */
  function nsMode() {
    var on = document.querySelector('#nsSeg .xv-segb.on');
    return on ? on.getAttribute('data-mode') : 'new';
  }

  function nsTarget() {
    var d = S.doc || {};
    return { id: S.nsTargetId || d.notionPageId || '', title: S.nsTargetTitle || (d.notionPageId ? d.title : '') };
  }

  function setNsMode(mode) {
    if (['new', 'update', 'append'].indexOf(mode) === -1) mode = 'new';
    S.nsMode = mode;
    Array.prototype.forEach.call(document.querySelectorAll('#nsSeg .xv-segb'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === mode);
    });
    var isNew = mode === 'new';
    $('nsParentRow').style.display = isNew ? '' : 'none';
    $('nsTargetRow').style.display = isNew ? 'none' : '';
    closeNsPicker();
    var hints = {
      new: '在父页面下新建一篇文章。父页面留空 = 存到工作区顶层。',
      update: '用编辑器内容整体替换该页面的内容（这篇文稿之前存过的那一页）。',
      append: '把编辑器内容追加到所选页面的末尾，页面原有内容不动。',
    };
    setText('nsHint', hints[mode]);
    setText('nsTargetName', '');
    var t = nsTarget();
    setText('nsTargetName', t.id ? ((t.title || '(无标题)') + '　' + String(t.id).slice(0, 8) + '…') : '尚未选择（点右边「选择页面」）');
    var btn = $('nsSave');
    if (btn) btn.textContent = { new: '保存到 Notion（新建）', update: '保存到 Notion（更新那一页）', append: '保存到 Notion（追加）' }[mode];
  }

  /** 关联状态 + 默认模式：存过 Notion 的文稿默认走"更新那一页"，从根上避免重复存档 */
  function updateNsUI() {
    var d = S.doc || {};
    var linked = !!d.notionPageId;
    var box = $('nsLinked');
    if (box) {
      if (linked) {
        box.style.display = 'block';
        box.innerHTML = '✅ 这篇文稿已存到 Notion：<b>' + esc(d.title || '') + '</b>　' +
          '<span class="xv-link" data-open-url="' + esc(d.notionUrl || '') + '">在 Notion 打开 ↗</span>';
        var a = box.querySelector('[data-open-url]');
        if (a) a.addEventListener('click', function () { API.openExternal(a.getAttribute('data-open-url')); });
      } else {
        box.style.display = 'none';
        box.innerHTML = '';
      }
    }
    S.nsTargetId = d.notionPageId || '';
    S.nsTargetTitle = d.notionPageId ? (d.title || '') : '';
    setNsMode(linked ? 'update' : 'new');
  }

  async function doNotionSave() {
    window.__nsDebug = { t: Date.now(), busy: S.busy, mdLen: editorValue().length, mode: nsMode(), target: nsTarget().id, hasDoc: !!S.doc };
    if (S.busy) { window.__nsDebug.early = 'busy'; return; }
    var md = editorValue();
    if (!md.trim()) { window.__nsDebug.early = 'empty'; setStatus('nsStatus', '❌ 编辑器为空，无可提交内容'); return; }
    var doc = S.doc || {};
    var mode = nsMode();
    var target = nsTarget();

    // 防重复存档的第一道闸：已经存过的文稿，选「新建」会明确提醒
    if (mode === 'new' && doc.notionPageId) {
      var goNew = window.confirm('这篇文稿该文稿已关联 Notion 页面。\n\n点「确定」= 仍然新建（将产生重复页面）\n点「取消」= 改为更新已关联页面（推荐）');
      if (!goNew) { setNsMode('update'); return; }
    }
    if (mode !== 'new' && !target.id) {
      setStatus('nsStatus', '❌ 未选择目标页面：点「选择页面」挑一篇');
      openNsPicker('target');
      return;
    }
    if (mode === 'update' && !window.confirm('更新会把「' + (target.title || target.id) + '」这一页的原有内容整体替换，确定继续？')) return;

    busy(true);
    setStatus('nsStatus', { new: '正在新建页面…', update: '正在更新页面…', append: '正在追加…' }[mode]);
    try {
      var r = await API.archive({
        mode: mode === 'update' ? 'replace' : mode,
        pageId: mode === 'new' ? null : target.id,
        parentId: val('nsParentId').trim() || null,
        title: docTitleGuess(),
        markdown: md,
        imageStore: window.imageStore || {},
      });
      if (!r.ok) {
        setStatus('nsStatus', '❌ ' + r.error + (r.hint ? '（' + r.hint + '）' : ''));
        toast('保存到 Notion 失败：' + r.error, 'error');
        return;
      }
      var pageId = r.pageId || target.id;
      // 记住关联：下次再来默认就是"更新这一页"。只写一次盘（合并 notionPageId，避免重复整份写）
      S.doc = Object.assign({}, S.doc, { notionPageId: pageId, notionUrl: r.url });
      S.nsTargetId = pageId; S.nsTargetTitle = docTitleGuess();
      if (IS_DESKTOP && N.docs) {
        await N.docs.save({
          id: S.doc.id, title: docTitleGuess(), content: editorValue(),
          imageStore: window.imageStore || {}, notionPageId: pageId, notionUrl: r.url,
        });
        if (typeof window.markContentSaved === 'function') window.markContentSaved();
      }

      var label = { new: '已新建', update: '已更新', append: '已追加到' }[mode] || '已保存';
      var st = $('nsStatus');
      st.textContent = '✅ ' + label + '「' + docTitleGuess() + '」· 正文 ' + (r.mdBlocks || 0) + ' 块' +
        (r.images ? '、图片 ' + r.images + ' 张' : '') + (r.imageFailures ? '（' + r.imageFailures + ' 张失败）' : '') + '　';
      var link = document.createElement('span');
      link.className = 'xv-link';
      link.textContent = '在 Notion 打开 ↗';
      link.addEventListener('click', function () { API.openExternal(r.url); });
      st.appendChild(link);
      toast('已保存到 Notion', 'success');
      updateNsUI();
      updateSteps();
      await refreshDocs();
    } finally { busy(false); }
  }

  function buildPackage() {
    var prev = $('preview');
    if (!prev) throw new Error('找不到预览区');
    // 与 copyForWeChat 相同的清理规则
    try {
      if (typeof window.htmlMode !== 'undefined' && window.htmlMode) {
        if (typeof window.convertChartsToImages === 'function') window.convertChartsToImages(prev);
        if (typeof window.computedStylesToInline === 'function') window.computedStylesToInline(prev);
      }
    } catch (e) {}
    var tmp = document.createElement('div');
    tmp.innerHTML = prev.innerHTML;
    if (typeof window.cleanMathJaxForExport === 'function') { try { window.cleanMathJaxForExport(tmp); } catch (e) {} }
    var keep = { svg: 1, use: 1, path: 1, g: 1, defs: 1, rect: 1, line: 1, circle: 1, text: 1, tspan: 1, img: 1 };
    var els = tmp.getElementsByTagName('*');
    for (var i = 0; i < els.length; i++) {
      var tag = els[i].tagName.toLowerCase();
      els[i].removeAttribute('class');
      if (!keep[tag]) els[i].removeAttribute('id');
    }
    var html = tmp.innerHTML;
    var images = [];
    html.replace(/src="(data:image\/[^"]+)"/g, function (m, d) { images.push({ dataUrl: d }); return m; });
    var plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    var title = (S.page && S.page.title) || '';
    if (!title) { var h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i); title = h1 ? h1[1].replace(/<[^>]+>/g, '').trim() : '未命名文章'; }
    var b64 = images.reduce(function (a, im) { return a + im.dataUrl.length; }, 0);
    return {
      version: 1,
      title: (docTitleGuess() || title).slice(0, 32),
      digest: plain.slice(0, 100),
      author: '', html: html, images: images,
      sourcePageId: S.page ? S.page.id : null,
      estimatedContentLength: html.length - b64 + images.length * 120,
    };
  }

  async function doDry() {
    try {
      var p = buildPackage();
      var lines = [];
      lines.push('正文 HTML ' + p.html.length + ' 字符（含 base64 图）');
      lines.push('换图后估算 ' + p.estimatedContentLength + ' / 20000 字符 ' + (p.estimatedContentLength > 20000 ? '❌ 超限，请用「复制到微信」' : '✅'));
      lines.push('图片 ' + p.images.length + ' 张；公式 SVG ' + ((p.html.match(/<svg/g) || []).length) + ' 个');
      if (!p.images.length) lines.push('❌ 没有图片 → 拿不到封面，微信无法建草稿');
      setText('xvPushStatus', lines.join('\n'));
    } catch (e) { setText('xvPushStatus', '❌ ' + e.message); }
  }

  async function doPush() {
    var p;
    try { p = buildPackage(); } catch (e) { setText('xvPushStatus', '❌ ' + e.message); return; }
    busy(true);
    $('xvBar').classList.add('on'); $('xvBarFill').style.width = '3%';
    setText('xvPushStatus', '开始推送…');
    try {
      var r = await API.wechatPush(p);
      if (!r.ok) {
        setText('xvPushStatus', '❌ ' + r.error + (r.hint ? '\n' + r.hint : ''));
        toast(r.error, 'error');
      } else {
        setText('xvPushStatus', '✅ 已进草稿箱（media_id=' + String(r.mediaId).slice(0, 16) + '…）\n' +
          '图片 ' + r.images + '/' + p.images.length + (r.failed ? '（' + r.failed + ' 张失败）' : '') + '\n' +
          '正文最终 ' + r.finalLength + ' 字符\n' +
          (r.published ? '已提交发布' : '请到手机/公众平台点「发表」') + '\n' +
          (r.writeback && r.writeback.ok ? '已回写 Notion 发布记录 ✅' : ''));
        toast('已推送到公众号草稿箱', 'success');
        $('xvBarFill').style.width = '100%';
      }
    } finally { busy(false); setTimeout(function () { $('xvBar').classList.remove('on'); $('xvBarFill').style.width = '0'; }, 1500); }
  }

  async function doProbe() {
    setText('xvProbeStatus', '自检中…');
    busy(true);
    try {
      var r = await API.wechatProbe();
      var box = $('xvProbeDetail');
      var lines = [];
      var tags = [];
      tags.push('本机出口 IP：' + (r.ip ? '<b>' + esc(r.ip) + '</b>' : '取不到') + '　（这个要加进公众号 IP 白名单）');
      if (r.notion) tags.push('Notion：' + (r.notion.ok ? '✅ 连接正常（' + esc((r.notion.user || {}).name || '') + '）' : '❌ ' + esc(r.notion.error || '') + (r.notion.code === 'NO_TOKEN' ? '（去「设置」里填 Token）' : '')));
      if (r.wechat) {
        if (!r.wechat.ok) tags.push('公众号：❌ ' + esc(r.wechat.error || '') + (r.wechat.hint ? '（' + esc(r.wechat.hint) + '）' : ''));
        else {
          var d = r.wechat.detail || {};
          tags.push('公众号：✅ 凭据有效');
          Object.keys(d).forEach(function (k) {
            tags.push('　· ' + k + '：' + (d[k].ok ? '✅ 可用' : '❌ ' + esc(d[k].message || '')));
          });
        }
      }
      box.innerHTML = '<div class="xv-note">' + tags.join('<br>') + '</div>';
      setText('xvProbeStatus', '完成');
    } finally { busy(false); }
  }

  async function doDrafts() {
    setText('xvPushStatus', '读取草稿列表…'); busy(true);
    try {
      var r = await API.wechatDrafts(20);
      var box = $('xvDraftList');
      if (!r.ok) { box.innerHTML = '<div class="xv-empty">❌ ' + esc(r.error) + '</div>'; return; }
      if (!r.items.length) { box.innerHTML = '<div class="xv-empty">草稿箱是空的</div>'; return; }
      box.innerHTML = r.items.map(function (d) {
        return '<div class="xv-item"><span class="t">' + esc(d.title) + '</span>' +
          '<span class="d">' + (d.updateTime ? new Date(d.updateTime * 1000).toLocaleString('zh-CN') : '') +
          ' <button class="xv-btn danger" style="padding:2px 8px;font-size:10px" data-del="' + esc(d.mediaId) + '">删除</button></span></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function (b) {
        b.addEventListener('click', async function (ev) {
          ev.stopPropagation();
          if (!confirm('删除这篇草稿？')) return;
          var id = b.getAttribute('data-del');
          var rr = await API.wechatDeleteDraft(id);
          setText('xvPushStatus', rr.ok ? '✅ 已删除' : '❌ ' + rr.error);
          if (rr.ok) doDrafts();
        });
      });
      setText('xvPushStatus', '草稿箱共 ' + r.total + ' 篇');
    } finally { busy(false); }
  }

  async function doCleanTest() {
    var r = await API.wechatDrafts(20);
    if (!r.ok) { setText('xvPushStatus', '❌ ' + r.error); return; }
    var targets = r.items.filter(function (d) { return /^ZZ\s/.test(d.title); });
    if (!targets.length) { setText('xvPushStatus', '没有以「ZZ 」开头的测试草稿'); return; }
    if (!confirm('删除这 ' + targets.length + ' 篇测试草稿？')) return;
    var n = 0;
    for (var i = 0; i < targets.length; i++) {
      var rr = await API.wechatDeleteDraft(targets[i].mediaId);
      if (rr.ok) n++;
    }
    setText('xvPushStatus', '✅ 已删除 ' + n + '/' + targets.length + ' 篇');
    doDrafts();
  }

  async function loadCfgIntoUI() {
    S.cfg = await API.cfgGet();
    $('xvOptImg').checked = true;
    if (S.cfg.notionParentPageId) $('nsParentId').value = S.cfg.notionParentPageId;
    $('xvWriteback').checked = S.cfg.notionWriteback !== false;
    $('xvAutoPublish').checked = !!S.cfg.publishAfterDraft;
    $('xvLan').checked = !!S.cfg.lanServer;
    $('xvLanPort').value = S.cfg.lanPort || 8899;
    $('xvAppId').value = S.cfg.wechatAppId || '';
    setStatus('xvNotionCfgStatus', S.cfg.hasNotionToken ? ('已配置 ' + S.cfg.notionTokenMasked + '　🔒 已加密') : '尚未配置');
    setStatus('xvWechatCfgStatus', S.cfg.hasWechatCreds
      ? ('已配置 ' + (S.cfg.wechatAppId || '') + ' / ' + (S.cfg.wechatSecretMasked || '') + '　🔒 已加密')
      : '尚未配置');
    if (S.cfg.crypto) {
      var bad = (S.cfg.crypto.undecryptable || []);
      if (bad.length) {
        setText('xvCryptNote', '⚠️ 已存的密钥解不开了（换过电脑/账户，或配置目录里的 Local State 被清理过）：' +
          bad.join('、') + '。请重新填写一次，其余设置不受影响。');
      } else {
        setText('xvCryptNote', S.cfg.crypto.available
          ? '🔒 Notion Token / 微信 AppID / AppSecret 均以 Windows DPAPI 加密后落盘（密钥绑定当前 Windows 用户），配置文件里不会出现明文。'
          : '⚠️ 当前系统加密不可用，密钥只能明文保存 —— 请检查 Windows 凭据服务。');
      }
    }
    $('xvMode').textContent = IS_DESKTOP ? '桌面版' : '手机/局域网';
    if (!IS_DESKTOP) {
      $('xvPush').disabled = true; $('xvDry').disabled = true; $('xvProbe').disabled = true;
      $('xvDrafts').disabled = true; $('xvCleanTest').disabled = true; $('nsSave').disabled = true;
      setStatus('xvImportStatus', '手机/浏览器模式：可导入 Notion、调排版、复制到微信；存档与推草稿请在电脑端做');
    }
    updateNsUI();
    if (IS_DESKTOP) refreshLan();
  }

  async function refreshLan() {
    var info = await API.lanInfo();
    if (info.enabled && info.urls && info.urls.length) setStatus('xvLanStatus', '手机访问：' + info.urls.join('　'));
    else if ($('xvLan').checked) setStatus('xvLanStatus', '已开启，但没检测到局域网 IP（检查是否连着 Wi-Fi）');
    else setStatus('xvLanStatus', '未开启');
  }

  /* ==================================================== 页面选择器 ==== */
  function openNsPicker(kind) {
    S.nsPickKind = kind;
    $('nsPickWrap').style.display = 'block';
    if (kind === 'target') { $('nsPickQuery').value = ''; loadNsTargets(); }
    else loadNsParents();
  }
  function closeNsPicker() { var e = $('nsPickWrap'); if (e) e.style.display = 'none'; }

  async function loadNsTargets() {
    var box = $('nsPickList');
    box.innerHTML = '<div class="xv-empty">读取中…</div>';
    var rs = await API.search(val('nsPickQuery').trim());
    if (!rs.ok) { box.innerHTML = '<div class="xv-empty">❌ ' + esc(rs.error) + '</div>'; return; }
    var items = rs.items || [];
    if (!items.length) { box.innerHTML = '<div class="xv-empty">没有搜到页面</div>'; return; }
    box.innerHTML = items.map(function (p) {
      return '<div class="xv-item" data-pick="' + esc(p.id) + '" data-title="' + esc(p.title) + '">' +
        '<span class="t">' + esc(p.title) + '</span><span class="d">' + esc(p.edited || '') + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-pick]'), function (el) {
      el.addEventListener('click', function () {
        S.nsTargetId = el.getAttribute('data-pick');
        S.nsTargetTitle = el.getAttribute('data-title');
        setText('nsTargetName', (S.nsTargetTitle || '') + '　' + String(S.nsTargetId).slice(0, 8) + '…');
        closeNsPicker();
      });
    });
  }

  async function loadNsParents() {
    var box = $('nsPickList');
    box.innerHTML = '<div class="xv-empty">读取中…（列出该父页面的子页面；留空则列工作区顶层）</div>';
    var pid = val('nsParentId').trim();
    var r = await N.notion.children(pid || null).catch(function (e) { return { ok: false, error: e.message }; });
    if (!r.ok) { box.innerHTML = '<div class="xv-empty">❌ ' + esc(r.error) + '</div>'; return; }
    if (!r.items.length) { box.innerHTML = '<div class="xv-empty">这个页面下没有子页面（可以可在该页面下新建）</div>'; return; }
    box.innerHTML = r.items.map(function (p) {
      return '<div class="xv-item" data-pick="' + esc(p.id) + '"><span class="t">' + esc(p.title) + '</span></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('[data-pick]'), function (el) {
      el.addEventListener('click', function () {
        $('nsParentId').value = el.getAttribute('data-pick');
        API.cfgSet({ notionParentPageId: el.getAttribute('data-pick') });
        closeNsPicker();
      });
    });
  }

  /* ==================================================== 侧栏开关 ==== */
  function isNarrow() { return window.innerWidth <= 900; }
  function applyLayout() { document.body.classList.toggle('sb-mobile', isNarrow()); }

  function injectButton() {
    if ($('btnNotion')) return true;
    var imp = $('btnImport');
    if (!imp || !imp.parentNode) return false;
    var b = document.createElement('button');
    b.className = 'btn btn-import';
    b.id = 'btnNotion';
    b.title = '创作台助手：从 Notion 导入 · 推送公众号 · 文稿与存档（Ctrl+B）';
    b.textContent = '助手';
    b.addEventListener('click', function () { ($('sbRoot').classList.contains('open') ? close : open)(); });
    imp.parentNode.insertBefore(b, imp.nextSibling);
    return true;
  }

  function switchTab(name) {
    S.tab = name;
    Array.prototype.forEach.call(document.querySelectorAll('.sb-tab'), function (t) {
      t.classList.toggle('on', t.getAttribute('data-tab') === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sb-pane'), function (p) {
      p.style.display = p.getAttribute('data-pane') === name ? '' : 'none';
    });
    if (name === 'docs') refreshDocs();
    if (name === 'data' && IS_DESKTOP) doDashboard();
  }

  function open() {
    applyLayout();
    $('sbRoot').classList.add('open');
    document.body.classList.add('sb-open');
    loadCfgIntoUI();
    updateSteps();
    if (IS_DESKTOP && S.cfg.hasNotionToken && !S.results.length) doSearch();
  }
  function close() {
    $('sbRoot').classList.remove('open');
    document.body.classList.remove('sb-open');
  }
  function toggle() { $('sbRoot').classList.contains('open') ? close() : open(); }

  /* ==================================================== 事件绑定 ==== */
  function bind() {
    $('sbClose').addEventListener('click', close);
    $('sbBackdrop').addEventListener('click', close);
    Array.prototype.forEach.call(document.querySelectorAll('.sb-tab'), function (t) {
      t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-open]'), function (a) {
      a.addEventListener('click', function () { API.openExternal(a.getAttribute('data-open')); });
    });

    /* ① 导入 */
    $('xvSearch').addEventListener('click', doSearch);
    $('xvQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
    $('xvImport').addEventListener('click', doImport);

    /* ② 推送 */
    $('xvProbe').addEventListener('click', doProbe);
    $('xvPush').addEventListener('click', doPush);
    $('xvDry').addEventListener('click', doDry);
    $('xvCopyHint').addEventListener('click', function () {
      if (typeof window.copyForWeChat === 'function') window.copyForWeChat();
      else toast('请使用工具栏的复制按钮', 'error');
    });
    $('xvDrafts').addEventListener('click', doDrafts);
    $('xvCleanTest').addEventListener('click', doCleanTest);
    $('xvOpenMp').addEventListener('click', function () { API.openExternal('https://mp.weixin.qq.com/'); });

    /* ③-b 数据看板 */
    $('dashRefresh').addEventListener('click', doDashboard);
    $('dashOpenMp').addEventListener('click', function () { API.openExternal('https://mp.weixin.qq.com/'); });

    /* ③ 同步 Notion（本机文稿只是缓存，界面上不再展示；自动保存在后台静默进行） */
    $('nsSeg').addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.xv-segb') : null;
      if (b) { S.nsModeTouched = true; setNsMode(b.getAttribute('data-mode')); }
    });
    $('nsPick').addEventListener('click', function () { openNsPicker('target'); });
    $('nsPickParent').addEventListener('click', function () { openNsPicker('parent'); });
    $('nsPickSearch').addEventListener('click', loadNsTargets);
    $('nsPickQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') loadNsTargets(); });
    $('nsPickClose').addEventListener('click', closeNsPicker);
    $('nsSave').addEventListener('click', doNotionSave);
    $('nsParentId').addEventListener('change', function () { API.cfgSet({ notionParentPageId: val('nsParentId').trim() }); });

    /* 编辑器输入 → 自动保存（防丢稿）+ 进度提示 */
    if (window.editor) {
      window.editor.addEventListener('input', function () { scheduleAutosave(); updateSteps(); });
    }

    /* ④ 设置 */
    $('xvSaveNotion').addEventListener('click', async function () {
      var t = val('xvNotionToken').trim();
      if (!t) { setStatus('xvNotionCfgStatus', '请先粘贴 Token（留空 = 不改动已存的）'); return; }
      await API.cfgSet({ notionToken: t });
      $('xvNotionToken').value = '';
      await loadCfgIntoUI();
      setStatus('xvNotionCfgStatus', '已加密保存，正在验证…');
      var v = await API.verify();
      setStatus('xvNotionCfgStatus', v.ok ? ('✅ 连接正常（bot：' + ((v.user || {}).name || '') + '）🔒 已加密') : ('❌ ' + v.error + (v.hint ? '（' + v.hint + '）' : '')));
      if (v.ok) doSearch();
    });
    $('xvVerifyNotion').addEventListener('click', async function () {
      setStatus('xvNotionCfgStatus', '验证中…');
      var v = await API.verify();
      setStatus('xvNotionCfgStatus', v.ok ? ('✅ 连接正常（bot：' + ((v.user || {}).name || '') + '）') : ('❌ ' + v.error + (v.hint ? '（' + v.hint + '）' : '')));
    });
    $('xvSaveWechat').addEventListener('click', async function () {
      var id = val('xvAppId').trim(), sec = val('xvSecret').trim();
      var patch = {};
      if (id) patch.wechatAppId = id;
      if (sec) patch.wechatSecret = sec;
      if (!Object.keys(patch).length) { setStatus('xvWechatCfgStatus', '留空表示不修改已存密钥'); return; }
      await API.cfgSet(patch);
      $('xvSecret').value = '';
      await loadCfgIntoUI();
      setStatus('xvWechatCfgStatus', '✅ 已加密保存。建议点「验证」确认 IP 白名单。');
    });
    $('xvVerifyWechat').addEventListener('click', async function () {
      setStatus('xvWechatCfgStatus', '验证中…（通常 2～3 秒）');
      var r = await API.wechatProbe();
      var w = (r && r.wechat) || {};
      setStatus('xvWechatCfgStatus', w.ok ? '✅ 微信接口连通（Token 获取成功）' : ('❌ ' + (w.error || '验证失败') + (w.hint ? '（' + w.hint + '）' : '')));
    });
    $('xvWriteback').addEventListener('change', function () { API.cfgSet({ notionWriteback: this.checked }); });
    $('xvAutoPublish').addEventListener('change', function () { API.cfgSet({ publishAfterDraft: this.checked }); });
    $('xvSaveLan').addEventListener('click', async function () {
      var port = parseInt(val('xvLanPort'), 10) || 8899;
      await API.cfgSet({ lanServer: $('xvLan').checked, lanPort: port });
      setStatus('xvLanStatus', '已应用，重启应用后生效');
    });
    $('xvLan').addEventListener('change', function () { API.cfgSet({ lanServer: this.checked }); setStatus('xvLanStatus', '已切换，重启应用后生效'); });
    $('xvOpenCfgDir').addEventListener('click', async function () {
      if (!IS_DESKTOP) return;
      var p = await N.cfg.path();
      setStatus('xvCfgPath', p);
      await N.app.openPath(p.replace(/[\\/][^\\/]+$/, ''));
    });
    $('xvQuit').addEventListener('click', function () { quitApp(); });
    $('xvGetIp').addEventListener('click', async function () {
      setStatus('xvIpStatus', '获取中…');
      try {
        var r = await API.wechatIp();
        if (r && r.ok && r.ip) { $('xvEgressIp').value = r.ip; setStatus('xvIpStatus', '✅ 本机出口 IP：' + r.ip + '（记得加进公众号白名单）'); }
        else setStatus('xvIpStatus', '❌ ' + ((r && r.error) || '取不到'));
      } catch (e) { setStatus('xvIpStatus', '❌ ' + e.message); }
    });
    $('xvCopyIp').addEventListener('click', async function () {
      var v = val('xvEgressIp').trim();
      if (!v) { setStatus('xvIpStatus', '请先获取 IP'); return; }
      try {
        if (window.navigator && navigator.clipboard) await navigator.clipboard.writeText(v);
        setStatus('xvIpStatus', '✅ 已复制 ' + v);
      } catch (e) { setStatus('xvIpStatus', '复制失败，请手动选中上面的 IP'); }
    });

    /* 快捷键：Ctrl+S 保存文稿（本机）· Ctrl+Shift+S 保存到 Notion · Ctrl+B 侧栏 · Ctrl+Q 退出 */
    document.addEventListener('keydown', function (e) {
      var k = (e.key || '').toLowerCase();
      if (!e.ctrlKey && !e.metaKey) {
        if (k === 'escape') { if ($('nsPickWrap').style.display === 'block') closeNsPicker(); }
        return;
      }
      if (e.altKey) return;
      if (k === 's') {
        e.preventDefault(); e.stopPropagation();
        doNotionSave();            // Ctrl+S = 同步到 Notion（本机缓存自动进行）
      } else if (k === 'b') { e.preventDefault(); e.stopPropagation(); toggle(); }
      else if (k === 'q') { e.preventDefault(); e.stopPropagation(); quitApp(); }
    }, true);
  }

  /** 退出应用：走主进程统一退出入口（清场 + 兜底强退） */
  async function quitApp() {
    if (IS_DESKTOP) { try { await saveDocNow(true); } catch (e) { /* 忽略 */ } await API.quit(); return; }
    toast('浏览器模式请直接关闭页面');
  }

  function boot() {
    injectCss();
    buildPanel();
    bind();
    applyLayout();
    window.addEventListener('resize', function () { applyLayout(); if (isNarrow() && $('sbRoot').classList.contains('open')) { /* 保持打开 */ } });
    if (!injectButton()) { setTimeout(injectButton, 800); setTimeout(injectButton, 2000); }

    /* 恢复上次的文稿（桌面版走主进程文稿库；手机/浏览器走 localStorage） */
    (async function restore() {
      await refreshDocs();
      if (IS_DESKTOP && N.docs) {
        var r = await N.docs.get(null).catch(function () { return null; });
        if (r && r.doc && (r.doc.content || '').trim()) {
          applyDoc(r.doc);
          setStatus('docStatus', '已恢复上次编辑：' + (r.doc.title || ''));
        } else { applyDoc({ content: '', imageStore: {} }); }
      } else {
        var list = S.docs || [];
        if (list.length) {
          try {
            var raw = JSON.parse(localStorage.getItem(LS_DOCS) || '{}');
            var first = raw[list[0].id];
            if (first) applyDoc(Object.assign({ id: list[0].id }, first));
          } catch (e) { /* 忽略 */ }
        }
      }
      updateSteps();
    })();

    if (IS_DESKTOP && N.onProgress) {
      N.onProgress(function (p) {
        if (!p) return;
        if (p.message) setProgress(p.scope, p.message);
        else if (p.phase === 'md') setProgress('save', '写入正文 ' + p.done + '/' + p.total + '（本块 ' + p.chars + ' 字符）');
        else if (p.phase === 'image') setProgress('save', '上传图片 ' + (p.done || p.slot) + (p.bytes ? '（' + (p.bytes / 1024).toFixed(0) + ' KB）' : ''));
        else if (p.phase === 'imageFail') setProgress('save', '图片 ' + p.slot + ' 失败：' + p.error);
        else if (p.phase === 'retry') setProgress('save', p.what + ' 第 ' + p.attempt + ' 次重试，' + Math.round(p.delayMs / 1000) + 's 后继续');
      });
    }
    if (IS_DESKTOP && N.onLanChanged) N.onLanChanged(function () { refreshLan(); });
    console.log('[小黑喵 V3] ' + (IS_DESKTOP ? '桌面版' : '浏览器模式') + ' 就绪（助手栏已挂载）');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  window.addEventListener('load', function () { injectButton(); });
})();
