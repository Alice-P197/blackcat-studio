/**
 * 两个方向的格式转换（纯函数，可在 Node 里独立测试）
 *
 *   notionToBlackCat  Notion 页面 markdown  ->  创作台方言
 *   blackcatToNotion  创作台 markdown       ->  Notion 页面 markdown + 分段（图片需另行走 file_upload）
 *
 * 分段模型：把正文切成 [{type:'md',text}] 和 [{type:'image',slot,caption}]，
 * 调用方按顺序「追加 markdown / 追加图片块」，顺序天然保持。
 * （这套模型在从 Obsidian 迁移到 Notion 时已被验证过。）
 */
'use strict';

/* ============================ 共用小工具 ============================ */
const ICON_OF_TYPE = {
  tip: '💡', hint: '💡', note: '📝', info: 'ℹ️', warning: '⚠️', caution: '⚠️',
  danger: '🚨', error: '🚨', success: '✅', check: '✅', question: '❓', quote: '❓',
  example: '📋', section: '📌', rounded: '📦', diagonal: '📦', column: '📦',
  abstract: '📄', summary: '📄', link: '🔗', cite: '🔗', important: '❗',
  todo: '📋', failure: '❌', bug: '🐞', formula: '🧮', axiom: '📐',
  cover: '🖼', highlights: '⭐', divider: '➖', follow: '🔔', signature: '✍️', subtitle: '🔤',
};
const TYPE_OF_ICON = {
  '💡': 'tip', '📝': 'note', 'ℹ️': 'note', '⚠️': 'warning', '🚨': 'warning',
  '✅': 'success', '❌': 'warning', '❗': 'warning', '📌': 'note', '📋': 'note',
  '❓': 'note', '🔗': 'note', '📦': 'note', '📄': 'note', '🧮': 'formula',
  '📐': 'axiom', '🖼': 'cover', '⭐': 'highlights', '➖': 'divider',
  '🔔': 'follow', '✍️': 'signature', '🔤': 'subtitle',
};

/** Notion 颜色名 <-> 创作台用的 hex */
const COLOR_HEX = {
  gray: '#787774', brown: '#9f6b53', orange: '#d9730d', yellow: '#cb912f',
  green: '#448361', blue: '#337ea9', purple: '#9065b0', pink: '#c14c8a', red: '#d44c47',
  gray_bg: '#e3e2e0', brown_bg: '#eee0da', orange_bg: '#fadec9', yellow_bg: '#fdecc8',
  green_bg: '#dbeddb', blue_bg: '#d3e5ef', purple_bg: '#e8deee', pink_bg: '#f5e0e9', red_bg: '#ffe2dd',
};
const hexToColorName = (hex) => {
  const h = String(hex).trim().toLowerCase();
  for (const [name, v] of Object.entries(COLOR_HEX)) if (v.toLowerCase() === h) return name;
  return null;   // 认不出来就丢颜色、保文字
};
const COLOR_NAME_SET = new Set(Object.keys(COLOR_HEX));

/* ======================= 方向一：Notion -> 创作台 ======================= */

function normalizeInlineMath(s) {
  // Notion 读回的行内公式是 $`E=mc^2`$，创作台的 MathJax 要 $E=mc^2$
  return s.replace(/\$`([^`]*?)`\$/g, function (_, e) { return '$' + e + '$'; });
}

function convertCalloutsFromNotion(s) {
  function body(icon, inner) {
    const type = TYPE_OF_ICON[icon.trim()] || 'tip';
    const lines = inner.split('\n').map((l) => l.replace(/^\t/, ''));
    while (lines.length && !lines[0].trim()) lines.shift();
    let title = '';
    if (lines.length && !/^[#>\-*\d]/.test(lines[0].trim())) title = lines.shift().trim();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    return ':::' + type + (title ? ' ' + title : '') + '\n\n' + lines.join('\n').trim() + '\n\n:::end';
  }
  s = s.replace(/<callout icon="([^"]*)"[^>]*>\n([\s\S]*?)\n<\/callout>/g, (_, ic, inner) => body(ic, inner));
  s = s.replace(/<callout icon="([^"]*)"[^>]*>([\s\S]*?)<\/callout>/g, (_, ic, inner) => body(ic, inner.replace(/\t/g, '')));
  return s;
}

function tablesFromNotion(s) {
  return s.replace(/<table[^>]*>\n?([\s\S]*?)\n?<\/table>/g, function (_, inner) {
    const rows = [];
    const rre = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
    let m;
    while ((m = rre.exec(inner)) !== null) {
      const cells = [];
      const cre = /<td[^>]*>([\s\S]*?)<\/td>/g;
      let c;
      while ((c = cre.exec(m[1])) !== null) cells.push(c[1].replace(/\n/g, ' ').replace(/\|/g, '\\|').trim());
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return '';
    const w = Math.max.apply(null, rows.map((r) => r.length));
    const out = [];
    rows.forEach(function (r, i) {
      while (r.length < w) r.push('');
      out.push('| ' + r.join(' | ') + ' |');
      if (i === 0) out.push('| ' + new Array(w).fill('---').join(' | ') + ' |');
    });
    return out.join('\n');
  });
}

function spanColorToFont(s) {
  return s.replace(/<span\s+color="([^"]+)"\s*>([\s\S]*?)<\/span>/g, function (_, c, inner) {
    const name = COLOR_NAME_SET.has(c) ? c : null;
    const hex = name ? COLOR_HEX[name] : (/^#[0-9a-f]{3,8}$/i.test(c) ? c : null);
    return hex ? '<font color="' + hex + '">' + inner + '</font>' : inner;
  });
}

function cleanNotionTags(s) {
  s = s.replace(/<mention-page[^>]*\/>/g, '');
  s = s.replace(/<mention-page[^>]*>([\s\S]*?)<\/mention-page>/g, '$1');
  s = s.replace(/<mention-(?:user|database|data-source|agent)[^>]*\/>/g, '');
  s = s.replace(/<mention-(?:user|database|data-source|agent)[^>]*>([\s\S]*?)<\/mention-\w+>/g, '$1');
  s = s.replace(/<mention-date[^>]*\/>/g, '');
  s = s.replace(/<empty-block\/>/g, '');
  s = s.replace(/<table_of_contents[^>]*\/>/g, '');
  s = s.replace(/<br\s*\/?>/g, '  \n');
  s = s.replace(/<\/?synced_block[^>]*>/g, '');
  s = s.replace(/<unknown[^>]*\/>/g, '');
  s = s.replace(/<\/?columns[^>]*>/g, '').replace(/<\/?column[^>]*>/g, '');
  s = s.replace(/<details[^>]*>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
    (_, t, b) => ':::note ' + t.trim() + '\n\n' + b.replace(/\t/g, '').trim() + '\n\n:::end');
  // ⚠️ 必须是 (?<!!) —— Notion 会把 #notion_record=... 也塞进**图片 URL** 里，
  // 早先的写法会把图片 URL 改掉，导致后面按 URL 做图片替换时全部匹配不上、图片静默丢失。
  s = s.replace(/(?<!!)\]\((https?:\/\/[^)]+?)#notion_record=[^)]*\)/g, ']($1)');
  s = s.replace(/\\\[/g, '[').replace(/\\\]/g, ']');
  return s;
}

/**
 * @param {string} md   Notion 页面 markdown
 * @param {object} opt  { title, images: {url: '【图片N】'} }
 */
function notionToBlackCat(md, opt) {
  opt = opt || {};
  let s = String(md == null ? '' : md);
  s = normalizeInlineMath(s);
  s = convertCalloutsFromNotion(s);
  s = tablesFromNotion(s);
  s = spanColorToFont(s);
  s = cleanNotionTags(s);
  // 图片：把整段 ![alt](url) 换成创作台的【图片N|题注】占位符（而不是只换 URL，
  // 否则会留下 ![alt] 这样的残渣）。两边都做一次 #notion_record 归一化，保证能配上。
  if (opt.images) {
    const stripRec = (x) => String(x).replace(/#notion_record=[^)]*$/, '');
    const normMap = {};
    Object.keys(opt.images).forEach((k) => { normMap[stripRec(k)] = opt.images[k]; });
    s = s.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, function (m, alt, url) {
      const ph = opt.images[url] || normMap[stripRec(url)];
      if (!ph) return m;
      const cap = String(alt || '').replace(/^(?:Figure|图)\s*\d+\s*[:：]\s*/i, '').trim();
      return cap ? ph.replace(/】$/, '|' + cap + '】') : ph;
    });
  }
  s = s.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '');
  if (opt.title && !new RegExp('^#{1,3}\\s*' + escRe(opt.title)).test(s)) s = '# ' + opt.title + '\n\n' + s;
  return s;
}

/* ======================= 方向二：创作台 -> Notion ======================= */

function escRe(t) { return String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 解析 :::kind 后面的部分 —— 可能是 "标题"、"[标题](链接) 描述"、"[标题]" */
function parseContainerRest(rest) {
  rest = (rest || '').trim();
  const br = rest.match(/^\[([^\]]*)\](?:\(([^)]*)\))?\s*([\s\S]*)$/);
  if (br) return { title: br[1] || '', link: br[2] || '', tail: (br[3] || '').trim(), hasBracket: true };
  // 无方括号：整段就是标题，没有正文尾巴（之前把两者都当成 rest，导致标题输出两次）
  return { title: rest, link: '', tail: '', hasBracket: false };
}

/** 把创作台的 ::: 容器转成 Notion callout / 或降级成普通内容 */
function containersToNotion(s) {
  const lines = s.split('\n');
  const out = [];
  const stack = [];

  /** 生成一个容器的 Notion 表示（同一行开闭 / 多行开 都用这一套） */
  function emit(kind, rest) {
    const p = parseContainerRest(rest);
    if (kind === 'divider') { out.push('---'); return; }
    if (kind === 'subtitle' || kind === 'signature' || kind === 'follow' || kind === 'cover') {
      const txt = [p.title, p.tail].filter(Boolean).join(' ');
      out.push('**' + txt + '**');
      return;
    }
    if (kind === 'link' || (p.link && p.hasBracket)) {
      // 创作台的链接卡片 Notion 没有对应块，降级成一行普通链接
      if (p.link) out.push('[' + p.title + '](' + p.link + ')' + (p.tail ? ' ' + p.tail : ''));
      else out.push(p.title + (p.tail ? ' ' + p.tail : ''));
      return;
    }
    out.push('<callout icon="' + (ICON_OF_TYPE[kind] || '📝') + '">');
    if (p.title) out.push('\t' + p.title);
    if (p.tail) out.push('\t' + p.tail);
  }

  for (const line of lines) {
    const same = line.match(/^(\s*):::([A-Za-z-]+)\s*(.*?)\s*:::end\s*$/);
    if (same) {
      const kind = same[2].toLowerCase();
      emit(kind, same[3]);
      if (!['divider', 'subtitle', 'signature', 'follow', 'cover', 'link'].includes(kind)) out.push('</callout>');
      continue;
    }
    if (/^\s*:::(end)?\s*$/.test(line)) {
      if (stack.length) { stack.pop(); out.push('</callout>'); }
      continue;
    }
    const open = line.match(/^(\s*):::([A-Za-z-]+)\s*(.*)$/);
    if (open && open[2].toLowerCase() !== 'end') {
      const kind = open[2].toLowerCase();
      const p = parseContainerRest(open[3]);
      if (['divider', 'subtitle', 'signature', 'follow', 'cover', 'link'].includes(kind) || (p.link && p.hasBracket)) {
        emit(kind, open[3]);
        continue;
      }
      emit(kind, open[3]);
      stack.push(kind);
      continue;
    }
    out.push(stack.length && line.trim() ? '\t' + line : line);
  }
  while (stack.length) { stack.pop(); out.push('</callout>'); }
  return out.join('\n');
}

/** 创作台 <font color> / <div style> -> Notion */
function fontsToNotion(s) {
  s = s.replace(/<font\s+color="([^"]+)"\s*>([\s\S]*?)<\/font>/g, function (_, c, inner) {
    const name = COLOR_NAME_SET.has(c) ? c : hexToColorName(c);
    return name ? '<span color="' + name + '">' + inner + '</span>' : inner;
  });
  // Notion 的段落没有对齐属性，去掉居中/对齐包裹但保留内容
  s = s.replace(/<div\s+style="text-align:[^"]*"\s*>([\s\S]*?)<\/div>/g, '$1');
  s = s.replace(/<span\s+style="color:\s*([^";]+)[^"]*"\s*>([\s\S]*?)<\/span>/g, function (_, c, inner) {
    const name = hexToColorName(c);
    return name ? '<span color="' + name + '">' + inner + '</span>' : inner;
  });
  return s;
}

/**
 * 创作台 markdown -> { markdown, segments }
 * @param {string} md
 * @param {object} images  imageStore：{ "1": {dataUrl, name} }
 * @returns {{markdown:string, segments:Array}}
 */
function blackcatToNotion(md, images) {
  images = images || {};
  let s = String(md == null ? '' : md);

  s = containersToNotion(s);
  s = fontsToNotion(s);
  // 创作台的内部锚点 [文字](#标题) 在 Notion 里无对应；保留文字
  s = s.replace(/\[([^\]]*)\]\(#[^)]*\)/g, '$1');

  // 图片占位符 -> 分段
  const segments = [];
  const parts = s.split(/(【图片\d+(?:\|[^】]*)?】)/g);
  let buf = '';
  for (const p of parts) {
    const m = p.match(/^【图片(\d+)(?:\|([^】]*))?】$/);
    if (m) {
      if (buf.trim()) { segments.push({ type: 'md', text: buf.replace(/^\n+|\n+$/g, '') }); buf = ''; }
      const slot = Number(m[1]);
      const img = images[slot];
      if (!img || !img.dataUrl) {
        // 图片丢了就留个文字标记，别静默吞掉
        segments.push({ type: 'md', text: '（原图缺失：图片' + slot + '）' });
      } else {
        segments.push({ type: 'image', slot, caption: (m[2] || img.name || '').trim(), dataUrl: img.dataUrl });
      }
    } else buf += p;
  }
  if (buf.trim()) segments.push({ type: 'md', text: buf.replace(/^\n+|\n+$/g, '') });

  // 合并相邻的 md 段
  const merged = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (seg.type === 'md' && last && last.type === 'md') last.text += '\n\n' + seg.text;
    else merged.push(seg);
  }

  // 清理：段落间多余空行（Notion 会把空行当空块）
  merged.forEach((seg) => {
    if (seg.type === 'md') seg.text = seg.text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '');
  });

  return { markdown: merged.filter((x) => x.type === 'md').map((x) => x.text).join('\n\n'), segments: merged };
}

/** 正文分块（不切断代码围栏 / 数学块），用于大内容分次写入 */
function chunkMarkdown(text, budget) {
  budget = budget || 120000;
  if (text.length <= budget) return [text];
  const lines = text.split('\n');
  const chunks = [];
  let cur = [], curLen = 0, inFence = false, fenceMark = '', inMath = false;
  const safePush = () => { if (cur.length) { chunks.push(cur.join('\n')); cur = []; curLen = 0; } };
  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[1][0]; }
      else if (fence[1][0] === fenceMark) inFence = false;
    } else if (!inFence) {
      if ((line.match(/\$\$/g) || []).length % 2 === 1) inMath = !inMath;
    }
    const len = line.length + 1;
    if (curLen + len > budget && cur.length && !inFence && !inMath) safePush();
    cur.push(line); curLen += len;
  }
  safePush();
  return chunks;
}

module.exports = {
  notionToBlackCat,
  blackcatToNotion,
  chunkMarkdown,
  COLOR_HEX,
  hexToColorName,
  ICON_OF_TYPE,
  TYPE_OF_ICON,
  _internals: { containersToNotion, fontsToNotion, tablesFromNotion, convertCalloutsFromNotion, cleanNotionTags, normalizeInlineMath },
};
