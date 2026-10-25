/**
 * 微信公众号客户端（跑在 Electron 主进程）
 *
 * 实测结论（Robin小黑喵 这个号）：
 *   ✅ 永久素材 material/add_material（封面必须走这个）
 *   ✅ 图床 media/uploadimg（正文图片必须换成它给的 mmbiz.qpic.cn URL）
 *   ✅ 草稿箱 draft/add
 *   ❌ freepublish/* （48001 未开放 —— 个人订阅号，微信 2025-07 起回收）
 *   另外实测：草稿箱会保留内联 <svg>，所以 MathJax 公式能直接进草稿箱。
 */
'use strict';
const { json, request, sleep, makeLimiter } = require('./net.js');

const API = 'https://api.weixin.qq.com';
const CONTENT_MAX = 20000;          // 微信限制：content 必须少于 2 万字符

const ERR = {
  0: '成功',
  40001: 'AppSecret 错误', 40013: 'AppID 无效', 40125: 'AppSecret 无效',
  40164: 'IP 不在白名单 —— 公众号后台 → 设置与开发 → 基本配置 → IP白名单',
  41001: '缺少 access_token', 42001: 'access_token 已过期',
  45009: '接口调用超过当日限额', 45002: '内容超长', 45004: '内容含非法字符',
  45166: 'content 里有非法图片（外部图片 URL 会被过滤）',
  48001: 'api unauthorized —— 该接口对本账号类型未开放',
  61004: '没有该接口权限',
};
const errText = (code, msg) => code + ' ' + (ERR[code] || msg || '');

class WeChat {
  constructor(getCreds) {
    this.getCreds = getCreds;         // () => {appid, secret}
    this.token = null;
    this.expireAt = 0;
    this.limiter = makeLimiter(280);  // 约 3.5 req/s
  }

  async call(pathname, opts) {
    opts = opts || {};
    const r = await request(API + pathname, {
      method: opts.method || 'GET',
      json: opts.body,
      form: opts.form,
      retries: 4,
      timeoutMs: opts.timeoutMs || 120000,
      limiter: this.limiter,
      onRetry: opts.onRetry,
    });
    const d = r.data;
    if (!r.ok || !d) {
      const e = new Error('微信接口 HTTP ' + r.status + (d && d.errmsg ? ': ' + d.errmsg : ''));
      e.status = r.status;
      throw e;
    }
    if (d.errcode !== undefined && d.errcode !== 0) {
      const e = new Error(opts.what ? (opts.what + ' 失败: ') + errText(d.errcode, d.errmsg) : errText(d.errcode, d.errmsg));
      e.errcode = d.errcode;
      e.hint = ERR[d.errcode];
      throw e;
    }
    return d;
  }

  async getToken(force) {
    if (!force && this.token && this.expireAt > Date.now() + 60000) return this.token;
    const c = this.getCreds();
    if (!c || !c.appid || !c.secret) {
      const e = new Error('还没配置公众号 AppID / AppSecret');
      e.code = 'NO_CREDS';
      throw e;
    }
    let d;
    try {
      d = await this.call('/cgi-bin/stable_token', {
        method: 'POST',
        body: { grant_type: 'client_credential', appid: c.appid, secret: c.secret, force_refresh: !!force },
      });
    } catch (e) { /* 老账号可能不支持 stable_token，下面回退 */ }
    if (!d || !d.access_token) {
      d = await this.call('/cgi-bin/token?grant_type=client_credential&appid=' + encodeURIComponent(c.appid) + '&secret=' + encodeURIComponent(c.secret));
    }
    if (!d.access_token) throw new Error('取 access_token 失败');
    this.token = d.access_token;
    this.expireAt = Date.now() + ((d.expires_in || 7200) - 300) * 1000;
    return this.token;
  }

  async authed(pathname, opts) {
    opts = opts || {};
    const t = await this.getToken();
    const sep = pathname.indexOf('?') === -1 ? '?' : '&';
    try {
      return await this.call(pathname + sep + 'access_token=' + t, opts);
    } catch (e) {
      if (e.errcode === 40001 || e.errcode === 42001) {
        await this.getToken(true);
        const t2 = this.token;
        return await this.call(pathname + sep + 'access_token=' + t2, opts);
      }
      throw e;
    }
  }

  /* --------------------------------------------------------- 素材 */
  async uploadContentImage(buf, filename, mime) {
    const t = await this.getToken();
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(buf)], { type: mime || 'image/png' }), filename);
    const d = await this.call('/cgi-bin/media/uploadimg?access_token=' + t, { method: 'POST', form, what: '上传正文图片' });
    return d.url;
  }

  async uploadPermanentImage(buf, filename, mime) {
    const t = await this.getToken();
    const form = new FormData();
    form.append('media', new Blob([new Uint8Array(buf)], { type: mime || 'image/png' }), filename);
    const d = await this.call('/cgi-bin/material/add_material?access_token=' + t + '&type=image', { method: 'POST', form, what: '上传封面素材' });
    return { mediaId: d.media_id, url: d.url };
  }

  /* --------------------------------------------------------- 草稿 */
  async createDraft(a) {
    const d = await this.authed('/cgi-bin/draft/add', {
      method: 'POST',
      what: '新增草稿',
      body: {
        articles: [{
          article_type: 'news',
          title: String(a.title || '未命名').slice(0, 32),
          author: String(a.author || '').slice(0, 16),
          digest: String(a.digest || '').slice(0, 120),
          content: a.html,
          content_source_url: a.sourceUrl || '',
          thumb_media_id: a.thumbMediaId,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        }],
      },
    });
    return d.media_id;
  }

  async getDraft(mediaId) {
    const d = await this.authed('/cgi-bin/draft/get', { method: 'POST', body: { media_id: mediaId } });
    return d.news_item || [];
  }

  async listDrafts(count) {
    const d = await this.authed('/cgi-bin/draft/batchget', {
      method: 'POST', body: { offset: 0, count: count || 20, no_content: 1 },
    });
    return {
      total: d.total_count,
      items: (d.item || []).map((it) => {
        const n = (it.content && it.content.news_item && it.content.news_item[0]) || {};
        return { mediaId: it.media_id, title: n.title || '(无标题)', updateTime: it.update_time };
      }),
    };
  }

  async deleteDraft(mediaId) {
    await this.authed('/cgi-bin/draft/delete', { method: 'POST', body: { media_id: mediaId }, what: '删除草稿' });
  }

  async submitPublish(mediaId) {
    try {
      const d = await this.authed('/cgi-bin/freepublish/submit', { method: 'POST', body: { media_id: mediaId }, what: '提交发布' });
      return { ok: true, publishId: d.publish_id };
    } catch (e) {
      if (e.errcode === 48001) return { ok: false, reason: '该账号没有发布接口权限（个人订阅号，微信 2025-07 起回收）' };
      throw e;
    }
  }

  /* ------------------------------------------------------- 完整流水 */
  /**
   * 把创作台导出的文章推成草稿。
   * @param {object} pkg  { title, digest, author, html, images:[{dataUrl}], sourcePageId }
   */
  async pushArticle(pkg, opts) {
    opts = opts || {};
    const log = opts.log || (() => {});
    const images = Array.isArray(pkg.images) ? pkg.images : [];

    const b64 = images.reduce((a, im) => a + String(im.dataUrl || '').length, 0);
    const est = pkg.html.length - b64 + images.length * 120;   // 图片换成微信 URL 后的估算长度
    log(`正文：HTML ${pkg.html.length} 字符（含 base64 图 ${b64}），换图后约 ${est} / ${CONTENT_MAX}`);
    if (est > CONTENT_MAX) {
      const e = new Error(`换图后仍约 ${est} 字符，超过微信上限 ${CONTENT_MAX}。这类长文请用创作台的「复制到微信」（无大小限制）。`);
      e.code = 'TOO_LONG';
      throw e;
    }
    if (!images.length) throw new Error('文章里没有图片 —— 微信图文消息必须有封面，无法建草稿');

    // 图片：并行上传，但第一张要另外走永久素材做封面
    let html = pkg.html, done = 0, failed = 0;
    let cover = null;
    for (let i = 0; i < images.length; i++) {
      if (opts.signal && opts.signal.aborted) throw new Error('已取消');
      const dataUrl = images[i].dataUrl;
      const m = String(dataUrl).match(/^data:([^;]+);base64,(.+)$/);
      if (!m) { failed++; log(`图片 ${i + 1} 数据格式不对，跳过`); continue; }
      const mime = m[1], buf = Buffer.from(m[2], 'base64');
      const ext = (mime.split('/')[1] || 'png').replace('jpeg', 'jpg');
      try {
        const url = await this.uploadContentImage(buf, `bc-${i + 1}.${ext}`, mime);
        html = html.split(dataUrl).join(url);
        done++;
        if (i === 0) {
          try { cover = await this.uploadPermanentImage(buf, `bc-cover.${ext}`, mime); }
          catch (e) { log('封面素材上传失败：' + e.message); }
        }
        log(`图片 ${i + 1}/${images.length} ✅ ${(buf.length / 1024).toFixed(0)} KB`);
        if (opts.onProgress) opts.onProgress({ phase: 'image', done: i + 1, total: images.length });
      } catch (e) {
        failed++;
        log(`图片 ${i + 1}/${images.length} ❌ ${e.message}`);
        if (e.errcode === 40164) throw e;
      }
    }
    if (!cover) throw new Error('没拿到封面素材 media_id（第一张图上传失败）');
    if (html.length > CONTENT_MAX) {
      const e = new Error(`正文实际 ${html.length} 字符，超过微信上限 ${CONTENT_MAX}，请改用「复制到微信」。`);
      e.code = 'TOO_LONG';
      throw e;
    }

    log('创建草稿…');
    const mediaId = await this.createDraft({
      title: pkg.title, author: pkg.author, digest: pkg.digest,
      html, thumbMediaId: cover.mediaId, sourceUrl: opts.sourceUrl,
    });
    log('✅ 草稿已创建：' + mediaId);

    let published = false, publishNote = '';
    if (opts.publish) {
      const p = await this.submitPublish(mediaId);
      published = !!p.ok;
      publishNote = p.ok ? ('publish_id=' + p.publishId) : p.reason;
      log(p.ok ? '✅ 已提交发布' : '⚠️ ' + p.reason);
    }
    return { mediaId, images: done, failed, published, publishNote, finalLength: html.length };
  }

  /* --------------------------------------------------------- 探测 */
  /**
   * 数据看板数据源。
   *
   * ⚠️ 实测结论（2026-10-05，本机账号）：
   *   - 素材 / 草稿 类接口：**有权限**，能拿到素材数量与草稿清单；
   *   - 数据统计（datacube/*）：**HTTP 404 空响应** = 该账号类型无权限；
   *   - user/get（关注者）、freepublish/batchget（已发布列表）：**48001 api unauthorized**。
   *   所以「阅读 / 点赞 / 分享 / 关注」这类互动数据在 API 侧拿不到（个人订阅号限制），
   *   这里只聚合确实拿得到的，并把互动接口的真实状态一并回报，界面如实展示。
   */
  async dashboard() {
    const tk = await this.getToken();
    const out = { at: new Date().toISOString(), material: null, drafts: null, interact: null, interactNote: '' };

    // 素材库统计
    try {
      const r = await fetch(`${API}/cgi-bin/material/get_materialcount?access_token=${tk}`);
      const d = await r.json();
      if (d && d.errcode === undefined) out.material = d;
      else out.materialError = (d && d.errmsg) || ('HTTP ' + r.status);
    } catch (e) { out.materialError = e.message; }

    // 草稿清单（不含正文，轻量）
    try {
      const r = await fetch(`${API}/cgi-bin/draft/batchget?access_token=${tk}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offset: 0, count: 20, no_content: 1 }),
      });
      const d = await r.json();
      if (d && d.errcode === undefined) {
        out.drafts = {
          total: d.total_count || 0,
          items: (d.item || []).map((it) => {
            const news = (it.content && it.content.news_item) || [];
            return {
              title: news.map((x) => x.title).filter(Boolean).join(' / ') || '(无标题)',
              updated: it.update_time ? new Date(it.update_time * 1000).toISOString() : '',
              articles: news.length,
            };
          }),
        };
      } else out.draftsError = (d && d.errmsg) || ('HTTP ' + r.status);
    } catch (e) { out.draftsError = e.message; }

    // 互动数据接口可用性探测（查一天前，避开当日未统计）
    const bid = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const probe = {};
    for (const api of ['getusersummary', 'getarticletotal']) {
      try {
        const r = await fetch(`${API}/cgi-bin/datacube/${api}?access_token=${tk}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ begin_date: bid, end_date: bid }),
        });
        const t = await r.text();
        let j = null;
        try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
        probe[api] = { httpStatus: r.status, hasBody: !!t, errcode: j && j.errcode, listCount: (j && j.list && j.list.length) || 0, sample: (j && j.list && j.list[0]) || null };
      } catch (e) { probe[api] = { error: e.message }; }
      await new Promise((r2) => setTimeout(r2, 600));
    }
    out.interact = probe;
    const s = probe.getusersummary || {};
    if (s.httpStatus === 404 || (!s.hasBody && !s.errcode)) {
      out.interactNote = '该账号类型没有「数据统计」接口权限（实测返回 HTTP 404 空响应），阅读/点赞/分享/关注数据无法通过 API 获取。';
    } else if (s.errcode) {
      out.interactNote = '数据统计接口返回 errcode=' + s.errcode + '（' + (ERR[s.errcode] || '') + '）。';
    } else {
      out.interactNote = s.listCount ? '互动数据可读取。' : '接口可用，但查询日暂无数据（需要该日有群发/阅读记录）。';
    }
    return out;
  }

  async probe() {
    await this.getToken(true);
    const out = {};
    const probes = [
      ['永久素材', () => this.authed('/cgi-bin/material/get_materialcount')],
      ['草稿箱', () => this.authed('/cgi-bin/draft/batchget', { method: 'POST', body: { offset: 0, count: 1, no_content: 1 } })],
      ['发布接口', () => this.authed('/cgi-bin/freepublish/batchget', { method: 'POST', body: { offset: 0, count: 1, no_content: 1 } })],
    ];
    for (const [label, fn] of probes) {
      try { await fn(); out[label] = { ok: true }; }
      catch (e) { out[label] = { ok: false, code: e.errcode, message: e.message }; }
      await sleep(300);
    }
    return out;
  }
}

/** 当前出口 IP（VPN 换 IP 后要重新加白名单） */
async function egressIp() {
  for (const u of ['https://ipv4.icanhazip.com', 'https://api.ipify.org']) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      const t = (await r.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(t)) return t;
    } catch (e) { /* 换下一个 */ }
  }
  return null;
}

module.exports = { WeChat, egressIp, errText, CONTENT_MAX, ERR };
