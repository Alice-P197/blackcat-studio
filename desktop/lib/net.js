/**
 * 带限流与退避重试的 HTTP 客户端。
 * 所有外部 API 调用都走这里，统一处理 429/5xx，避免"点一下就卡死"。
 */
'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 简易令牌桶：默认 3 req/s，避免被 Notion / 微信限流 */
function makeLimiter(intervalMs) {
  let last = 0;
  return async function wait() {
    const d = intervalMs - (Date.now() - last);
    if (d > 0) await sleep(d);
    last = Date.now();
  };
}

/**
 * @param {string} url
 * @param {object} opts  { method, headers, body, json, form, retries, onRetry, timeoutMs, limiter }
 */
async function request(url, opts) {
  opts = opts || {};
  const retries = opts.retries === undefined ? 5 : opts.retries;
  const limiter = opts.limiter || makeLimiter(0);
  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter();
    const init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers) };
    if (opts.form) init.body = opts.form;
    else if (opts.json !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.json);
    }
    let ctl = null, timer = null;
    if (opts.timeoutMs) {
      ctl = new AbortController();
      init.signal = ctl.signal;
      timer = setTimeout(() => ctl.abort(), opts.timeoutMs);
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = new Error('网络请求失败: ' + (e.name === 'AbortError' ? '超时' : e.message));
      if (attempt < retries) {
        const d = Math.min(2 ** attempt, 15) * 1000;
        if (opts.onRetry) opts.onRetry(attempt + 1, lastErr.message, d);
        await sleep(d);
        continue;
      }
      throw lastErr;
    }
    if (timer) clearTimeout(timer);

    if (res.status === 429 || res.status === 529 || [500, 502, 503, 504].includes(res.status)) {
      const ra = Number(res.headers.get('retry-after'));
      const d = (Number.isFinite(ra) && ra > 0 ? ra : Math.min(2 ** attempt, 20)) * 1000;
      lastErr = new Error('HTTP ' + res.status + '（服务端限流或抖动）');
      if (attempt < retries) {
        if (opts.onRetry) opts.onRetry(attempt + 1, lastErr.message, d);
        await sleep(d + Math.random() * 300);
        continue;
      }
      throw lastErr;
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    return { ok: res.ok, status: res.status, headers: res.headers, data, text };
  }
  throw lastErr || new Error('请求失败');
}

/** 取 JSON，非 2xx 抛错（带可读信息） */
async function json(url, opts) {
  const r = await request(url, opts);
  if (!r.ok) {
    const msg = r.data && (r.data.message || r.data.errmsg) ? (r.data.message || r.data.errmsg) : r.text.slice(0, 200);
    const e = new Error('HTTP ' + r.status + ': ' + msg);
    e.status = r.status;
    e.data = r.data;
    throw e;
  }
  return r.data;
}

module.exports = { request, json, sleep, makeLimiter };
