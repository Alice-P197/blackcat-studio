/**
 * 文稿库：把编辑器里的文章持久化到 <userData>/documents.json，关掉应用也不丢。
 *
 * 设计取舍：
 *   - 一个 JSON 存全部文稿（含 imageStore 的 base64 图）。文章量不大时最简单可靠，
 *     写盘用「临时文件 + 改名」保证不会写出半个文件。
 *   - 列表接口只回元数据（标题/时间/字数/是否已存过 Notion），不回正文，避免每次刷新都传几 MB。
 *   - 每篇文稿记录 notionPageId：这是**防重复存档**的关键 —— 同一篇文稿再存一次就是更新那一页，
 *     不会又新建一篇。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'documents.json');
const MAX_DOCS = 200;

let cache = null;

function read() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    if (j && Array.isArray(j.docs)) return { docs: j.docs, currentId: j.currentId || null };
  } catch (e) { /* 首次运行或文件损坏 */ }
  return { docs: [], currentId: null };
}

function load() {
  if (!cache) cache = read();
  return cache;
}

/** 图片单独存盘：<userData>/doc-images/<docId>.json
 *  为什么分开：图片是 base64（一篇带 5 张图就 2MB+），塞进 documents.json 会让每次自动保存
 *  都整份同步写 2MB+，主进程被写盘阻塞 → 整个界面卡死。文本走小文件、图片按需单独写。 */
const IMG_DIR = () => path.join(app.getPath('userData'), 'doc-images');
const IMG_FILE = (id) => path.join(IMG_DIR(), String(id).replace(/[^\w-]/g, '') + '.json');

function readImages(id) {
  try { return JSON.parse(fs.readFileSync(IMG_FILE(id), 'utf8')) || {}; } catch (e) { return {}; }
}
function writeImages(id, store) {
  try {
    fs.mkdirSync(IMG_DIR(), { recursive: true });
    fs.writeFileSync(IMG_FILE(id), JSON.stringify(store || {}), 'utf8');
  } catch (e) { console.error('[文稿] 图片落盘失败:', e.message); }
}
function imagesChanged(id, store) {
  const cur = Object.keys(readImages(id));
  const next = Object.keys(store || {});
  if (cur.length !== next.length) return true;
  for (const k of next) if (cur.indexOf(k) === -1) return true;
  return false;
}

function flush() {
  const data = load();
  const tmp = FILE() + '.tmp';
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  // 只写文本（图片已分离），所以这里永远是小文件、写得很快
  const light = {
    currentId: data.currentId,
    docs: data.docs.map((d) => ({
      id: d.id, title: d.title, content: d.content || '',
      notionPageId: d.notionPageId || '', notionUrl: d.notionUrl || '',
      images: Object.keys(d.imageStore || {}).length,   // 只记数量，正文不含图
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    })),
  };
  fs.writeFileSync(tmp, JSON.stringify(light), 'utf8');
  fs.renameSync(tmp, FILE());
  return true;
}

function newId() {
  return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 标题：优先显式传入，其次正文第一个 H1，最后兜底 */
function deriveTitle(title, content) {
  const t = String(title || '').trim();
  if (t) return t.slice(0, 120);
  const m = String(content || '').match(/^#\s+(.+)$/m);
  return (m ? m[1].trim() : '未命名文稿').slice(0, 120);
}

function list() {
  const d = load();
  return d.docs
    .slice()
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((x) => ({
      id: x.id,
      title: x.title,
      updatedAt: x.updatedAt,
      chars: (x.content || '').length,
      images: Object.keys(x.imageStore || {}).length,
      notionPageId: x.notionPageId || '',
      notionUrl: x.notionUrl || '',
      current: x.id === d.currentId,
    }));
}

function get(id) {
  const d = load();
  const hit = d.docs.find((x) => x.id === id) || d.docs.find((x) => x.id === d.currentId);
  if (!hit) return null;
  return {
    id: hit.id, title: hit.title, content: hit.content || '',
    imageStore: readImages(hit.id),          // 图片从独立文件读回
    notionPageId: hit.notionPageId || '', notionUrl: hit.notionUrl || '',
    updatedAt: hit.updatedAt,
  };
}

/** 新建（或返回当前）文稿。传 content/imageStore 时直接落内容 */
function create(title, content, imageStore) {
  const d = load();
  const doc = {
    id: newId(),
    title: deriveTitle(title, content),
    content: content || '',
    imageStore: (imageStore && typeof imageStore === 'object') ? imageStore : {},
    notionPageId: '', notionUrl: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  d.docs.unshift(doc);
  d.currentId = doc.id;
  if (d.docs.length > MAX_DOCS) d.docs = d.docs.slice(0, MAX_DOCS);
  flush();
  return get(doc.id);
}

/**
 * 保存一篇文稿。不传 id 且没有 currentId 时自动新建。
 * 只有显式传了 notionPageId/notionUrl 才覆盖关联（传 undefined 表示不动）。
 */
function save(patch) {
  const d = load();
  const p = patch || {};
  let doc = p.id ? d.docs.find((x) => x.id === p.id) : null;
  if (!doc) {
    // 没有 id 且没有当前文稿 → 视为新建；⚠️ 必须把 imageStore 一起带上，否则第一次保存会丢图
    if (!d.currentId || !d.docs.find((x) => x.id === d.currentId)) return create(p.title, p.content, p.imageStore);
    doc = d.docs.find((x) => x.id === d.currentId);
  }
  if (typeof p.title === 'string' && p.title.trim()) doc.title = p.title.trim().slice(0, 120);
  if (typeof p.content === 'string') {
    doc.content = p.content;
    if (!doc.title || doc.title === '未命名文稿') doc.title = deriveTitle('', p.content);
  }
  // 图片：只在"图片集合真的变了"时才写独立文件（避免每次自动保存都写 2MB）
  if (p.imageStore && typeof p.imageStore === 'object') {
    if (imagesChanged(doc.id, p.imageStore)) writeImages(doc.id, p.imageStore);
    doc.imageStore = {};                     // 主文件不存图
  }
  if (typeof p.notionPageId === 'string') doc.notionPageId = p.notionPageId;
  if (typeof p.notionUrl === 'string') doc.notionUrl = p.notionUrl;
  doc.updatedAt = new Date().toISOString();
  d.currentId = doc.id;
  flush();
  return { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, notionPageId: doc.notionPageId, notionUrl: doc.notionUrl, images: Object.keys(readImages(doc.id)).length };
}

/** 只切换"当前文稿"，不改内容（打开文稿时用） */
function select(id) {
  const d = load();
  if (!d.docs.find((x) => x.id === id)) return false;
  d.currentId = id;
  flush();
  return true;
}

function remove(id) {
  const d = load();
  const i = d.docs.findIndex((x) => x.id === id);
  if (i < 0) return false;
  d.docs.splice(i, 1);
  try { fs.unlinkSync(IMG_FILE(id)); } catch (e) { /* 没有图就忽略 */ }
  if (d.currentId === id) d.currentId = d.docs.length ? d.docs[0].id : null;
  flush();
  return true;
}

function currentId() { return load().currentId; }

module.exports = { list, get, save, create, select, remove, currentId, FILE };
