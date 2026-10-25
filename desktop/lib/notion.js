/**
 * Notion 客户端（跑在 Electron 主进程里 —— 没有 CORS，也不用把 token 放进网页）
 */
'use strict';
const { json, request, sleep } = require('./net.js');

const API = 'https://api.notion.com/v1';
const VER = '2026-03-11';

class Notion {
  constructor(getToken) {
    this.getToken = getToken;          // () => token，支持运行时改
  }

  headers(extra) {
    const t = this.getToken();
    if (!t) {
      const e = new Error('还没配置 Notion Token');
      e.code = 'NO_TOKEN';
      throw e;
    }
    return Object.assign({ Authorization: 'Bearer ' + t, 'Notion-Version': VER }, extra || {});
  }

  async call(pathname, opts) {
    opts = opts || {};
    const r = await request(API + pathname, {
      method: opts.method || 'GET',
      headers: this.headers(),
      json: opts.body,
      retries: 5,
      timeoutMs: opts.timeoutMs || 120000,
      onRetry: opts.onRetry,
    });
    if (!r.ok) {
      const d = r.data || {};
      const e = new Error('Notion ' + r.status + ': ' + (d.code || '') + ' ' + (d.message || r.text.slice(0, 160)));
      e.status = r.status;
      e.code = d.code;
      if (r.status === 401) e.hint = 'Token 无效或已过期';
      if (r.status === 429) e.hint = '触发限流，稍候重试';
      throw e;
    }
    return r.data;
  }

  /* ---------------------------------------------------------- 读取 */
  async verify() {
    const me = await this.call('/users/me');
    return { name: me.name || '', id: me.id || '', type: me.type || '' };
  }

  async search(query, pageSize) {
    const body = { page_size: pageSize || 40, sort: { direction: 'descending', timestamp: 'last_edited_time' } };
    if (query) body.query = query;
    const r = await this.call('/search', { method: 'POST', body });
    return (r.results || [])
      .filter((x) => x.object === 'page' && !x.in_trash)
      .map((p) => ({
        id: p.id,
        title: titleOf(p),
        edited: (p.last_edited_time || '').slice(0, 10),
        url: p.url,
        parent: p.parent && p.parent.type,
      }));
  }

  async getPageMarkdown(pageId) {
    const r = await this.call('/pages/' + pageId + '/markdown', { timeoutMs: 180000 });
    return r.markdown || '';
  }

  async getPage(pageId) {
    const p = await this.call('/pages/' + pageId);
    return { id: p.id, title: titleOf(p), url: p.url };
  }

  /** 列出可作为"保存目标"的页面（顶层可写页面） */
  async listChildPages(pageId) {
    const out = [];
    let cursor = null;
    do {
      const q = '/blocks/' + pageId + '/children?page_size=100' + (cursor ? '&start_cursor=' + cursor : '');
      const r = await this.call(q);
      (r.results || []).forEach((b) => { if (b.type === 'child_page') out.push({ id: b.id, title: b.child_page.title }); });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    return out;
  }

  /* ---------------------------------------------------------- 写入 */
  async createPage(parentId, title, markdown) {
    const body = {
      parent: parentId ? { type: 'page_id', page_id: parentId } : { type: 'workspace', workspace: true },
      properties: { title: [{ type: 'text', text: { content: String(title || '未命名').slice(0, 1900) } }] },
    };
    // ⚠️ 注意：建页时同时给 markdown，正文里的首个 # H1 会被 Notion 静默吞掉，
    // 所以这里只建空页，内容一律用 appendMarkdown 追加。
    if (markdown) body.markdown = markdown;
    const p = await this.call('/pages', { method: 'POST', body, timeoutMs: 180000 });
    return { id: p.id, url: p.url };
  }

  async appendMarkdown(pageId, markdown, onRetry) {
    if (!markdown || !markdown.trim()) return;
    await this.call('/pages/' + pageId + '/markdown', {
      method: 'PATCH',
      body: { type: 'insert_content', insert_content: { content: markdown, position: { type: 'end' } } },
      timeoutMs: 300000,
      onRetry,
    });
  }

  async replaceMarkdown(pageId, markdown) {
    await this.call('/pages/' + pageId + '/markdown', {
      method: 'PATCH',
      body: { type: 'replace_content', replace_content: { new_str: markdown, allow_deleting_content: true } },
      timeoutMs: 300000,
    });
  }

  /* -------------------------------------------------------- 文件上传 */
  async uploadFile(buffer, filename, contentType) {
    const fu = await this.call('/file_uploads', {
      method: 'POST',
      body: { filename, content_type: contentType || guessMime(filename) },
    });
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(buffer)], { type: contentType || guessMime(filename) }), filename);
    const r = await request('https://api.notion.com/v1/file_uploads/' + fu.id + '/send', {
      method: 'POST',
      headers: this.headers(),
      form,
      retries: 4,
      timeoutMs: 300000,
    });
    if (!r.ok) {
      const d = r.data || {};
      throw new Error('上传文件失败 HTTP ' + r.status + ': ' + (d.message || ''));
    }
    return fu.id;
  }

  async appendImageBlock(pageId, fileUploadId, caption) {
    const image = { type: 'file_upload', file_upload: { id: fileUploadId } };
    if (caption) image.caption = [{ type: 'text', text: { content: String(caption).slice(0, 1900) } }];
    await this.call('/blocks/' + blockIdOf(pageId) + '/children', {
      method: 'PATCH',
      body: { children: [{ object: 'block', type: 'image', image }] },
    });
  }

  async appendFileBlock(pageId, fileUploadId, name, caption) {
    const file = { type: 'file_upload', file_upload: { id: fileUploadId }, name: name || 'file' };
    if (caption) file.caption = [{ type: 'text', text: { content: String(caption).slice(0, 1900) } }];
    await this.call('/blocks/' + blockIdOf(pageId) + '/children', {
      method: 'PATCH',
      body: { children: [{ object: 'block', type: 'file', file }] },
    });
  }

  /* ------------------------------------------- 下载远程图片转 data URL */
  /** 主进程里下载不受 CORS 限制，这是桌面版相比网页版的一大优势 */
  async fetchImageAsDataUrl(url, timeoutMs) {
    const r = await request(url, { retries: 3, timeoutMs: timeoutMs || 60000 });
    if (!r.ok) throw new Error('下载图片失败 HTTP ' + r.status);
    // request() 已把 body 读成文本，这里需要原始字节 —— 单独用 fetch 再取一次
    const res = await fetch(url);
    if (!res.ok) throw new Error('下载图片失败 HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = res.headers.get('content-type') || 'image/png';
    return { dataUrl: 'data:' + mime.split(';')[0] + ';base64,' + buf.toString('base64'), bytes: buf.length, mime };
  }

  /**
   * 按"分段"写入一个新建页面：md 段用 markdown 端点，image 段走 file_upload + image block。
   * 顺序天然保持。这是从 Obsidian 迁移时验证过的做法。
   */
  async createPageFromSegments(opts) {
    const { parentId, title, segments, chunkSize, onProgress, signal } = opts;
    const { chunkMarkdown } = require('./convert.js');
    const size = chunkSize || 120000;

    const page = await this.createPage(parentId, title, null);
    if (onProgress) onProgress({ phase: 'page', pageId: page.id, url: page.url });

    let mdCount = 0, imgCount = 0, imgFail = 0;
    const totalMd = segments.filter((s) => s.type === 'md').length;
    let idx = 0;

    for (const seg of segments) {
      if (signal && signal.aborted) throw new Error('已取消');
      if (seg.type === 'md') {
        const chunks = chunkMarkdown(seg.text, size);
        for (let i = 0; i < chunks.length; i++) {
          await this.appendMarkdown(page.id, chunks[i], (n, msg, d) => {
            if (onProgress) onProgress({ phase: 'retry', what: '写入正文', attempt: n, message: msg, delayMs: d });
          });
          mdCount++;
          if (onProgress) onProgress({ phase: 'md', done: mdCount, total: totalMd, chars: chunks[i].length, pageId: page.id });
        }
      } else if (seg.type === 'image') {
        try {
          const m = String(seg.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
          if (!m) throw new Error('图片数据格式不对');
          const buf = Buffer.from(m[2], 'base64');
          const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
          const fuId = await this.uploadFile(buf, 'bc-' + seg.slot + '.' + ext, m[1]);
          await this.appendImageBlock(page.id, fuId, seg.caption);
          imgCount++;
          if (onProgress) onProgress({ phase: 'image', done: imgCount, slot: seg.slot, bytes: buf.length, pageId: page.id });
        } catch (e) {
          imgFail++;
          if (onProgress) onProgress({ phase: 'imageFail', slot: seg.slot, error: e.message });
          // 图失败不中断整体，插一句文字标记，避免静默丢内容
          try { await this.appendMarkdown(page.id, '（图片 ' + seg.slot + ' 上传失败：' + e.message + '）'); } catch (e2) { /* 忽略 */ }
        }
      }
      idx++;
    }
    return { pageId: page.id, url: page.url, mdBlocks: mdCount, images: imgCount, imageFailures: imgFail };
  }

  /**
   * 把「分段」写进一个**已存在**的页面：支持追加到末尾或先清空再写入。
   *
   * 为什么不用 replace_content 一把梭：这个 API 版本的 replace/insert 只吃 markdown 字符串，
   * 图片必须走 file_upload + image block，所以文本和图片要分开按顺序写。
   * 覆盖模式的顺序是：先用第一段文本 replace 掉整页（顺带清空旧内容），再把剩余段落依次追加，
   * 这样图片和文字的相对顺序不会乱。
   *
   * @param {object} opts { pageId, segments, replace, chunkSize, onProgress, signal }
   */
  async writeSegmentsToPage(opts) {
    const { pageId, segments, replace, chunkSize, onProgress, signal } = opts;
    const { chunkMarkdown } = require('./convert.js');
    const size = chunkSize || 120000;

    let mdCount = 0, imgCount = 0, imgFail = 0;
    const totalMd = segments.filter((s) => s.type === 'md').length;
    let first = true;   // 第一段文本在覆盖模式下用 replace 写入

    for (const seg of segments) {
      if (signal && signal.aborted) throw new Error('已取消');

      if (seg.type === 'md') {
        const chunks = chunkMarkdown(seg.text, size);
        for (const chunk of chunks) {
          if (replace && first) {
            await this.replaceMarkdown(pageId, chunk);
          } else {
            await this.appendMarkdown(pageId, chunk, (n, msg, d) => {
              if (onProgress) onProgress({ phase: 'retry', what: '写入正文', attempt: n, message: msg, delayMs: d });
            });
          }
          first = false;
          mdCount++;
          if (onProgress) onProgress({ phase: 'md', done: mdCount, total: totalMd, chars: chunk.length, pageId });
        }
      } else if (seg.type === 'image') {
        try {
          const m = String(seg.dataUrl).match(/^data:([^;]+);base64,(.+)$/);
          if (!m) throw new Error('图片数据格式不对');
          const buf = Buffer.from(m[2], 'base64');
          const ext = (m[1].split('/')[1] || 'png').replace('jpeg', 'jpg');
          const fuId = await this.uploadFile(buf, 'bc-' + seg.slot + '.' + ext, m[1]);
          await this.appendImageBlock(pageId, fuId, seg.caption);
          imgCount++;
          if (onProgress) onProgress({ phase: 'image', done: imgCount, slot: seg.slot, bytes: buf.length, pageId });
        } catch (e) {
          imgFail++;
          if (onProgress) onProgress({ phase: 'imageFail', slot: seg.slot, error: e.message });
          try { await this.appendMarkdown(pageId, '（图片 ' + seg.slot + ' 上传失败：' + e.message + '）'); } catch (e2) { /* 忽略 */ }
        }
      }
    }

    // 覆盖模式但正文里一段文本都没有（例如整页只有图）时，replace 没被调用过 -> 仍需清空旧内容
    if (replace && first) await this.replaceMarkdown(pageId, ' ');

    return { pageId, mdBlocks: mdCount, images: imgCount, imageFailures: imgFail };
  }
}

/* ------------------------------------------------------------- 小工具 */
function titleOf(p) {
  const props = (p && p.properties) || {};
  const t = props.title || props.Name || props['名称'] || props['标题'];
  if (t && t.title && t.title.length) return t.title.map((x) => x.plain_text).join('');
  if (p && p.child_page && p.child_page.title) return p.child_page.title;
  return '(无标题)';
}
/** 页面 id 与 block id 在 Notion 里是同一个东西，统一处理 */
function blockIdOf(id) { return String(id).replace(/-/g, ''); }

function guessMime(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return ({
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
    pdf: 'application/pdf', txt: 'text/plain', html: 'text/html', md: 'text/markdown',
  })[ext] || 'application/octet-stream';
}

module.exports = { Notion, titleOf, guessMime };
