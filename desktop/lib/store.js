/**
 * 配置持久化：存在 Electron 的 userData 目录，不依赖 localStorage，
 * 且主进程能直接读到（API 调用需要）。
 *
 * 🔒 密钥加密存储：
 *   notionToken / wechatAppId / wechatSecret 一律以 `enc:v1:<base64>` 形式落盘，
 *   加密用 Electron safeStorage —— Windows 上底层是 DPAPI（密钥由当前用户登录凭据派生），
 *   只有本机、本用户能解开；文件被拷到别的机器/别的账户都解不开。
 *
 *   为什么不是"哈希"：哈希是单向的，而调用 Notion / 微信 API 时**必须把密钥原文发出去**，
 *   一旦哈希就再也拿不回来，功能直接报废。要同时满足"磁盘上不是明文"和"还能用"，
 *   只能用可逆的、绑定当前用户的加密（DPAPI）——浏览器保存密码用的也是加密而不是哈希。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'blackcat-config.json');

/** 需要加密落盘的字段 */
const SECRET_FIELDS = ['notionToken', 'wechatAppId', 'wechatSecret'];
const ENC_PREFIX = 'enc:v1:';

const DEFAULTS = {
  notionToken: '',
  wechatAppId: '',
  wechatSecret: '',
  notionParentPageId: '',      // 新建页面时的默认父页面
  notionWriteback: true,       // 推送公众号后是否回写 Notion
  publishAfterDraft: false,    // 建完草稿是否顺便提交发布（个人订阅号会失败）
  lanServer: false,            // 是否开启局域网服务（手机访问）
  lanPort: 8899,
  lastNotionPage: null,        // 最近导入/存档的页面
  archiveMode: 'new',          // 存档模式：new | append | replace
  archiveTargetId: '',         // 追加/覆盖的目标页面 id
  archiveTargetTitle: '',      // 目标页面标题（仅用于界面显示）
  windowBounds: null,
};

let cache = null;
let cryptoWarned = false;
/** 解密失败的字段 → 保留原始密文，绝不写空覆盖（否则会真的把用户的密钥弄丢） */
const failedFields = new Set();

function cryptoAvailable() {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (e) {
    return false;
  }
}

function encryptValue(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return '';
  if (s.startsWith(ENC_PREFIX)) return s;              // 已经是密文
  if (!cryptoAvailable()) {
    if (!cryptoWarned) {
      console.warn('[配置] 系统加密不可用，密钥将以明文保存（仅发生在系统异常时）');
      cryptoWarned = true;
    }
    return s;
  }
  return ENC_PREFIX + safeStorage.encryptString(s).toString('base64');
}

function decryptValue(stored) {
  const s = String(stored == null ? '' : stored);
  if (!s) return '';
  if (!s.startsWith(ENC_PREFIX)) return s;             // 旧的明文值：读出来参与下面的迁移
  if (!cryptoAvailable()) return '';
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), 'base64'));
  } catch (e) {
    console.warn('[配置] 解密失败（换过电脑/账户，或 userData 下的 Local State 被清过？）：', e.message);
    return null;                                       // null = 解不开，写回时要保留原密文
  }
}

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeFile(rawObj, plain) {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const out = Object.assign({}, rawObj);
  for (const f of SECRET_FIELDS) {
    // 解不开的字段：原样保留密文，避免把用户的密钥写成空（要重新登录才能恢复）
    if (failedFields.has(f) && !plain[f] && rawObj[f]) { out[f] = rawObj[f]; continue; }
    out[f] = encryptValue(plain[f]);
  }
  fs.writeFileSync(FILE(), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function load() {
  if (cache) return cache;
  const raw = readFile();
  const data = Object.assign({}, DEFAULTS, raw);
  let plainSecretsFound = false;
  for (const f of SECRET_FIELDS) {
    if (typeof raw[f] === 'string' && raw[f] && !raw[f].startsWith(ENC_PREFIX)) plainSecretsFound = true;
    const v = decryptValue(raw[f]);
    if (v === null) { failedFields.add(f); data[f] = ''; }   // 解不开：内存里当空，但磁盘上保留密文
    else data[f] = v;
  }
  cache = data;
  // 一次性迁移：把历史明文密钥就地加密落盘
  if (plainSecretsFound && cryptoAvailable()) {
    try {
      writeFile(raw, cache);
      console.log('[配置] 已把历史明文密钥迁移为加密存储');
    } catch (e) {
      console.error('[配置] 迁移加密失败:', e.message);
    }
  }
  return cache;
}

function save(patch) {
  const cur = load();
  const clean = Object.assign({}, patch || {});
  // 防呆：渲染进程若把"掩码"回传（含 ••••），一律忽略，避免把真密钥覆盖成掩码
  for (const f of SECRET_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(clean, f)) {
      const v = String(clean[f] == null ? '' : clean[f]);
      if (v.includes('•')) delete clean[f];
    }
  }
  Object.assign(cur, clean);
  try {
    writeFile(readFile(), cur);
  } catch (e) {
    console.error('保存配置失败:', e.message);
  }
  return cur;
}

const mask = (s) => (s ? String(s).slice(0, 4) + '••••' + String(s).slice(-4) : '');

/** 给渲染进程用的安全视图：不外发密钥原文，只告诉它有没有配、掩码长什么样 */
function safeView() {
  const c = load();
  return {
    notionTokenMasked: mask(c.notionToken),
    hasNotionToken: !!c.notionToken,
    // AppID 是公开标识（每篇公众号文章链接里都带），非密钥，可以明文回给界面
    wechatAppId: c.wechatAppId,
    wechatSecretMasked: mask(c.wechatSecret),
    hasWechatCreds: !!(c.wechatAppId && c.wechatSecret),
    notionParentPageId: c.notionParentPageId,
    notionWriteback: !!c.notionWriteback,
    publishAfterDraft: !!c.publishAfterDraft,
    lanServer: !!c.lanServer,
    lanPort: c.lanPort,
    lastNotionPage: c.lastNotionPage,
    archiveMode: c.archiveMode || 'new',
    archiveTargetId: c.archiveTargetId || '',
    archiveTargetTitle: c.archiveTargetTitle || '',
    configPath: FILE(),
    crypto: {
      available: cryptoAvailable(),
      scheme: 'Windows DPAPI（Electron safeStorage，绑定当前用户）',
      encryptedFields: SECRET_FIELDS.slice(),
      // 解不开的字段（换过电脑/账户，或 userData 下的 Local State 被清过）→ 界面要提示重填
      undecryptable: Array.from(failedFields),
    },
  };
}

module.exports = { load, save, safeView, DEFAULTS, FILE, SECRET_FIELDS };
