# 小黑喵创作台 V3（桌面版）

> 面向**后续接手的开发 agent**。本文只写事实与可执行步骤；改代码前请通读「业务主线」和「避坑清单」两节。

- 项目根目录：`<项目根目录>`（**唯一真身**，不要在别处复制副本；并行开发用 `git worktree`）
- 技术栈：Electron 33（本机 toolchain 实为 33.4.11）+ 原生 HTML/CSS/JS，**无打包器、无框架、无 TypeScript**
- 版本：`package.json` 3.0.0；appId `com.alicep197.blackcatstudio`；productName「小黑喵创作台」
- 交接状态另见 `docs/STATUS.md`；打包细节另见 `BUILD-打包说明.md`（与本文第 6 节互为补充）
- **版本迭代记录（Notion）**：项目主页「小黑喵创作台」<（私有 Notion 项目库条目，链接不公开）>，其 `文档` 关系挂着「小黑喵创作台V3」（Spec，版本历史）、「版本迭代」（更新，每日进展）、「开发与测试计划」（Strategy，P0–P4 路线 + 测试计划）；详见第 11 节

---

## 1. 项目定位与业务主线

这是一个把「Notion 素材 → 微信排版 → 公众号草稿」串起来的桌面工作台。**业务主线是设计核心，代码结构完全围绕它组织**：

```
① 从 Notion 导入文章  →  ② 在创作台排版  →  ③ 推送微信公众号草稿箱

旁支：编辑器内容随时 Ctrl+S 同步回 Notion（更新已关联页面，绝不新建重复页）
本机：编辑器内容自动保存为缓存（静默进行，界面不展示文稿库）
```

三条硬规则（改任何面板前先确认没违背）：

1. **导入不做任何写回**。导入只把 Notion 内容拉进编辑器，不改 Notion、不自动存档。
2. **创作台 → Notion 必须是显式动作**（Ctrl+S 或「同步 Notion」面板的按钮），只有三种模式：新建 / 更新已关联页面 / 追加。
3. **一篇文稿只对应一个 Notion 页面**。导入即记录来源页面 id，已关联的文稿默认走「更新」，从根上避免重复存档；实测搜索里只有 1 篇。

> 为什么用 Electron 而不是网页：主进程调 Notion / 微信 API 没有 CORS 限制，密钥不出现在页面里，耗时操作（下载图片、分块写入）不卡界面。

---

## 2. 目录结构与各文件职责

```
blackcat-studio/
├─ main.js                  Electron 主进程（48 KB，~930 行）
├─ preload.js               contextBridge 安全桥
├─ lib/
│  ├─ store.js              配置持久化 + 密钥加密
│  ├─ docs.js               文稿缓存（文本 / 图片分离落盘）
│  ├─ notion.js             Notion 客户端
│  ├─ wechat.js             公众号客户端 + dashboard() + egressIp()
│  ├─ convert.js            markdown 双向转换
│  └─ net.js                统一 HTTP（重试 / 退避 / 限流器）
├─ renderer/
│  ├─ editor.html           编辑器主体（V2 遗产，560 KB，⚠️ 勿动结构）
│  └─ native-module.js      桌面增强层（87 KB，助手栏与全部交互）
├─ vendor/                  本地化前端依赖（离线可用，勿删）
│  ├─ marked.min.js  highlight.min.js  echarts.min.js  tex-svg.js
├─ build/icon.png           源图标（175 KB）
├─ tools/rcedit-x64.exe     打标工具（被 .gitignore 排除）
├─ dist/                    打包产物（被 .gitignore 排除）
├─ electron-builder.yml     打包配置
├─ apply-branding.ps1       给产物补图标与版本信息
├─ BUILD-打包说明.md        打包说明
└─ docs/
   ├─ STATUS.md             交接状态（开工先读、收工必写）
   ├─ selftest.log          自检输出
   ├─ livetest.log          端到端实测输出
   └─ quit-dirty-test.ps1   关窗/退出行为测试
```

### `main.js` — Electron 主进程
窗口与生命周期（尺寸记忆、单实例锁、`second-instance` 聚焦）、退出清场（`quitApp()` 关局域网服务 + 2.5 秒兜底强退）、**全部 IPC handler**、局域网 HTTP 服务（手机访问）、以及两套内置测试 `--self-test` / `--live-test`。

IPC 命名空间（handler 与 `preload.js` 一一对应）：

| 前缀 | handler |
|---|---|
| `cfg:` | `cfg:get` `cfg:set` `cfg:path` |
| `notion:` | `verify` `search` `children` `import` `saveNew` `updatePage` `archive` `writeback` |
| `wechat:` | `ip` `probe` `push` `drafts` `deleteDraft` `dashboard` |
| `docs:` | `list` `get` `save` `create` `select` `delete` |
| `app:` | `saveJson` `openPath` `limits` `quit`；另有 `shell:openExternal`、`lan:info` |

### `preload.js` — 安全桥
`contextBridge.exposeInMainWorld('bcNative', {...})`，暴露 `bcNative.cfg / notion / wechat / docs / app`、`onProgress`、`onLanChanged`。渲染进程拿不到 Node，也拿不到密钥原文。

### `lib/store.js` — 配置持久化
- 文件：`<userData>/blackcat-config.json`（即 `%APPDATA%\blackcat-studio\blackcat-config.json`）
- `notionToken` / `wechatAppId` / `wechatSecret` 用 Electron `safeStorage`（Windows 底层 DPAPI）加密成 `enc:v1:<base64>` 落盘；**旧明文首次启动自动迁移**
- 解密失败（换机器 / 换账户 / `Local State` 被清）时 **保留原密文，绝不写空覆盖**，并在 `safeView().crypto.undecryptable` 里报告，界面提示重填
- 为什么是可逆加密而不是哈希：调 API 必须把密钥原文发出去，哈希了就取不回来
- `cfg:set` 有字段白名单；渲染进程若把掩码（含 `••••`）回传会被忽略，避免把真密钥覆盖成掩码

### `lib/docs.js` — 文稿缓存
- 文本：`<userData>/documents.json`；图片：`<userData>/doc-images/<id>.json`
- **为什么图片要分开存**：图片是 base64，一篇带 5 张图就 2 MB+，塞进 `documents.json` 会让每次自动保存都整份同步写 2 MB+，主进程被写盘阻塞 → 界面卡顿。分开后自动保存只写小文件
- 写盘用「临时文件 + rename」，不会写出半个文件
- 每篇记录 `notionPageId` / `notionUrl`：**这是防重复存档的依据**
- `list()` 只回元数据（不含正文、图片只给数量），避免刷新列表就传几 MB；最多 200 篇

### `lib/notion.js` — Notion 客户端
`Notion-Version: 2026-03-11`。**本 API 版本的关键差异（务必记住）**：

| 用途 | 正确调用 | 错误调用 |
|---|---|---|
| 追加 markdown | `PATCH /v1/pages/{id}/markdown` + `{type:'insert_content', insert_content:{content, position:{type:'end'}}}` | `POST /blocks/{id}/children` → 返回 `invalid_request_url` |
| 覆盖整页 | `PATCH /v1/pages/{id}/markdown` + `{type:'replace_content', replace_content:{new_str, allow_deleting_content:true}}` | — |
| 写图片 | 新建 `POST /file_uploads` → `POST /file_uploads/{id}/send` → `PATCH /blocks/{id}/children` + image/file block（`file_upload`） | markdown 端点吃不进图片 |

其他要点：
- 建页时**不要**同时给 `markdown`：正文首个 `# H1` 会被静默吞掉。一律建空页再 `appendMarkdown`
- 页面 id 与 block id 是同一个东西，`blockIdOf()` 负责去掉连字符
- 重试 5 次、超时 120 s（长页面 markdown 端点给到 180–300 s）

### `lib/wechat.js` — 公众号客户端
`CONTENT_MAX = 20000`（微信正文硬上限）。限流器约 3.5 req/s，最多重试 4 次。能力：
- `material/add_material`（永久素材，封面必须走这个）、`media/uploadimg`（正文图床，换成 `mmbiz.qpic.cn` URL）、`draft/add`、`draft/batchget`、`draft/delete`
- `freepublish/submit`（发布）：个人订阅号返回 **48001**，代码优雅降级为提示
- `dashboard()`：数据看板聚合（素材数 / 草稿清单 / 互动接口可用性探测）
- `egressIp()`：取本机出口 IP（`ipv4.icanhazip.com` → `api.ipify.org` 兜底）
- 草稿箱会保留内联 `<svg>`，所以 MathJax 公式能直接进草稿箱

### `lib/convert.js` — markdown 双向转换
`notionToBlackCat(md, {title, images})` / `blackcatToNotion(md, images)` / `chunkMarkdown(text, budget)`。负责 `:::tip` 等容器、`【图片N】` 占位符、行内与块级公式、表格、callout、颜色 span 的互转。写入 Notion 时按 120 000 字符分段。

### `lib/net.js` — HTTP 基座
`request / json / sleep / makeLimiter`。统一重试、指数退避、限流、超时；`onRetry` 回调用于把重试进度回传界面。

### `renderer/editor.html` — 编辑器主体
**V2 遗产，560 KB。不要动它的结构**：它导出 `window.editor`、`window.preview`、`window.imageStore`、`window.copyForWeChat`、`window.convertBase64Images`、`window.resolveImages`、`window.debouncedRender`、`window.markContentSaved` 等，桌面增强层靠这些挂钩工作。要加东西请加到 `native-module.js`。

### `renderer/native-module.js` — 桌面增强层
- 注入工具栏按钮「**助手**」（原 `Notion` / `存档`）与右侧停靠式助手栏 `#sbRoot`（宽 372 px，打开时给 `.main` / `.status-bar` 加 padding 让位）
- 窄屏（≤900 px）自动变抽屉 + 遮罩 + 悬浮「助手」按钮；Ctrl+B 开关
- 五个标签：**① 导入 / ② 推送公众号 / ③ 同步 Notion / 数据 / 设置**
- 快捷键（capture 阶段拦截，面板关着也生效）：`Ctrl+S` = 同步到 Notion、`Ctrl+B` = 侧栏开关、`Ctrl+Q` = 退出、`Ctrl+Shift+C` = 复制到微信
- 浏览器（局域网手机访问）模式下降级为只读导入：写 Notion / 推草稿 / 数据看板会明确拒绝

---

## 3. 数据流（三条链路）

### 链路 ①：Notion → 创作台（导入）
```
助手栏「① 导入」→ 搜索页面（notion:search）
  → 点「导入到编辑器」→ IPC notion:import
  → 主进程并行 getPageMarkdown + getPage
  → 正则抽取全部 ![](http...) 图片 URL → 去重
  → 6 并发下载图片 → 转 base64（进度回传 progress('import')）
  → 建立 url → 【图片N】 占位符映射
  → convert.notionToBlackCat 转成创作台方言
  → 返回 {page, markdown, images, stats}
  → 渲染层写入 window.editor 与 window.imageStore，记录来源页面 id
  → 立刻落成一篇文稿（记 notionPageId）—— 这是防重复存档的关键
```
导入**不写 Notion**。真实数据点：`airy_beam` 4585 字符 / 5 张图，约 4.4 s。

### 链路 ②：创作台 → 微信公众号草稿箱（推送）
```
助手栏「② 推送公众号」→ buildPackage()
  （从预览区取 HTML：图表转图 → 计算样式内联 → 清 MathJax → 剥 class/id → 抽 dataURL 图）
  → 估算「换图后长度」> 20000 字符 → 直接拦截，提示改用「复制到微信」（无大小限制）
  → IPC wechat:push
  → 每张图 uploadimg 换成 mmbiz.qpic.cn URL（第一张另传永久素材做封面）
  → draft/add 建草稿
  → 可选 freepublish/submit（个人订阅号 48001，降级提示「后台手动发表」）
  → 若配置 notionWriteback=true，用 notion:writeback 把发布记录追加回来源页面
```
`sourcePageId` 由 `buildPackage()` 带出（`S.page.id`），是回写的落点。相关配置：`notionWriteback`、`publishAfterDraft`。

### 链路 ③：创作台 → Notion（同步，手动）
```
Ctrl+S（或「③ 同步 Notion」面板的保存按钮）→ doNotionSave()
  → 防重复第一道闸：已关联页面却选了「新建」→ confirm 提醒，取消则自动切回「更新」
  → 更新模式再 confirm 一次（会整体替换该页内容）
  → IPC notion:archive（mode = new | append | replace）
  → new：notion.createPageFromSegments（建空页 → 文本走 markdown 端点、图片走 file_upload）
     append / replace：notion.writeSegmentsToPage（replace 用第一段文本 replace 清空整页，其余顺序追加，
     这样图文相对顺序不会乱；整页只有图时补一次 replace(' ') 清空）
  → 成功后把 pageId / url 写回当前文稿（notionPageId / notionUrl），下次默认就是「更新那一页」
```
**本机缓存链（静默）**：编辑器内容变化后 2.5 s 防抖 → `docs:save` → `documents.json`（纯文本）+ `doc-images/<id>.json`（图片集合真的变了才写）。界面不展示文稿库，只是关掉应用不丢内容。

---

## 4. 本机运行与调试

### 环境前提
- `node_modules` 是**指向共享工具链的 junction**（`<toolchain>/node_modules`），**不要 `npm install electron`**
- 新项目接入：`link-toolchain.ps1 -Project "<项目目录>"`
- 二进制缓存已由用户级环境变量全局生效：`ELECTRON_CACHE` / `ELECTRON_BUILDER_CACHE` / `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR`（走 npmmirror）

### 启动应用（开发态）
```powershell
Set-Location <项目根目录>
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # ⚠️ 必须清，见避坑 3
& "<toolchain>/node_modules\electron\dist\electron.exe" . --user-data-dir=".devdata"
```
调试要点：
- 主进程日志直接看控制台；渲染进程用 `win.webContents.on('console-message')`（自检里已实现）或 DevTools
- 调试挂钩：`window.__nsDebug`（同步存档的入参/提前返回）、`window.__saveDbg`（最近一次本机保存的图片数与字符数）
- 关窗行为测试：`docs\quit-dirty-test.ps1`
- 单实例锁：**第二个实例会静默退出、没有任何输出**。调试/测试必须给独立 `--user-data-dir`

### 目录速查
| 内容 | 路径 |
|---|---|
| 配置（含密文密钥） | `%APPDATA%\blackcat-studio\blackcat-config.json` |
| 文稿文本 | `%APPDATA%\blackcat-studio\documents.json` |
| 文稿图片 | `%APPDATA%\blackcat-studio\doc-images\<id>.json` |
| DPAPI / OSCrypt 密钥 | `%APPDATA%\blackcat-studio\Local State` |
| 测试 profile | 项目内 `.testdata/`（已 .gitignore） |

---

## 5. 内置测试怎么跑

两套测试都跑真实的 Chromium + 真实 preload + 真实 IPC，`--self-test` 不联网、`--live-test` 真连 Notion 与微信。

```powershell
Set-Location <项目根目录>
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 自检（离线结构 + 客户端连通性）
& "<toolchain>/node_modules\electron\dist\electron.exe" . --self-test --user-data-dir=".testdata"

# 端到端实测（真连 Notion：导入 → 新建 → 再存=更新同一页 → 追加 → 持久化 → 加密校验）
& "<toolchain>/node_modules\electron\dist\electron.exe" . --live-test --user-data-dir=".testdata"
# 关键词可换（默认 airy），第一个非 -- 开头的参数即为搜索词
& "...\electron.exe" . --live-test 关键词 --user-data-dir=".testdata"
```

- 退出码：`0` 全通过、`2` 有未通过、`3` 测试自身异常
- `--self-test` 覆盖：页面与本地 vendor 加载、`bcNative` 桥、按钮与助手栏注入、五个标签页、各面板控件齐备、V2 原有能力、markdown 渲染（含公式 SVG）、主进程 Notion / 微信连通、出口 IP、窄屏布局 6 项
- `--live-test` 覆盖：导入（字符数 / 图片数 / 占位符）、推草稿箱（长文允许被 2 万字符上限拦下）、新建后记录 pageId、**再存一次必须更新同一页（搜索里只有 1 篇）**、追加模式、文稿持久化、密钥加密落盘与解密回读、静默缓存、数据看板（含互动接口状态标注）；跑完把测试页面丢进回收站
- 日志留档：`docs/selftest.log`、`docs/livetest.log`

**测试 profile 准备（重要）**：要复用真实凭据时，把 `%APPDATA%\blackcat-studio\` 下的 **`blackcat-config.json` 和 `Local State` 两个文件一起**复制到 `.testdata\`。少了 `Local State`（存 OSCrypt 的 AES 密钥）密钥解不开——这是测试环境问题，不是产品缺陷。

### 最新验证结果（2026-10-05）
| 测试 | 结果 |
|---|---|
| 自检 `--self-test` | **28/28 通过** |
| 端到端 `--live-test` | **35/35 通过** |
| 关键断言 | 导入 4585 字符 / 5 图；再存是「更新同一页」且搜索只有 1 篇；追加后原文还在；密钥 `enc:v1:` 落盘且解密回读正常 |

---

## 6. 构建与发版

**一键（推荐）**：前置检查 → 目录版 → 内层 exe 打标 → 便携版 → 安装包 → 交付到桌面 + 校验。

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
build-electron-app.ps1 -Project <项目根目录> -DeliverTo <桌面> -KillRunning
```
- `-DirOnly` 只出目录版（快速自测）；`-SkipInstaller` 跳过安装包；`-KillRunning` 先结束正在运行的实例（否则 exe 被占用、覆盖失败）
- 该脚本固化了避坑 1、2 的处理顺序，**优先用它，不要手搓 electron-builder 流程**

**手工分步（理解原理时看）**：
```powershell
$eb = "<toolchain>/node_modules\.bin\electron-builder.cmd"
& $eb --win --x64 --dir                                        # 1) 目录版
.\apply-branding.ps1 -Targets .\dist\win-unpacked\小黑喵创作台.exe   # 2) 只给内层 exe 打标
& $eb --win portable --x64 --prepackaged .\dist\win-unpacked   # 3) 便携版
& $eb --win nsis     --x64 --prepackaged .\dist\win-unpacked   # 4) 安装包
```

产物（`dist/`，也可在 `package.json` 的 `npm run build` 里跑 `electron-builder --win portable nsis --x64`）：

| 文件 | 大小 |
|---|---|
| `dist\小黑喵创作台V3-便携版.exe` | 71.85 MB |
| `dist\小黑喵创作台V3-安装包.exe` | 79.13 MB |

- `electron-builder.yml` 只打运行必需文件：`main.js` `preload.js` `lib/**` `renderer/**` `vendor/**` `package.json`。**`vendor/` 必须包含**，否则启动要等 CDN
- `asar: true`、`compression: maximum`
- 便携版 `requestExecutionLevel: user`；安装包 `oneClick: false`、可选目录、建桌面/开始菜单快捷方式、卸载不删 AppData
- 产物未做代码签名，首次运行可能有 SmartScreen 提示
- 打包/测试流程已固化为技能 `electron-package-win`

---

## 7. 避坑清单（都是本机实测踩出来的）

1. **`win.signAndEditExecutable: false` 必须保留。** 本机非管理员、未开 Windows 开发者模式，app-builder 的 rcedit 即使在 Windows 上也会去下载含 macOS 符号链接（`libcrypto.dylib` / `libssl.dylib`）的 winCodeSign，7za 建链接失败 → `Cannot create symbolic link` → 打包整体退出 1。代价是内层 exe 没有图标和版本信息，由 `apply-branding.ps1` 用 rcedit 单独补（`tools/rcedit-x64.exe` 是从 winCodeSign 压缩包里用 `7za e ... -snl- "-ir!*rcedit-x64.exe"` 单独取出来的）。

2. **rcedit 绝对不能用于 NSIS 产物**（便携版 / 安装包）。它们的数据是追加在 PE 尾部的 overlay，rcedit 会整段丢掉：实测 71.85 MB → 94 KB。顺序必须是 **`--dir` → 打标内层 exe → `--prepackaged` 封装**。`apply-branding.ps1` 里已有备份 + 缩水超 1% 就还原并报错的防呆。

3. **跑 electron 前必须清 `ELECTRON_RUN_AS_NODE`**。DSH 的 node 垫片会设这个变量，Electron 会退化成纯 Node，报 `ipcMain undefined`。每条命令前都清一次：
   `Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue`

4. **测试要用独立 `--user-data-dir`**，否则撞单实例锁，第二个实例会**静默退出、没有任何输出**（很容易误判成"测试挂了"）。测试 profile 必须**同时复制 `blackcat-config.json` 和 `Local State`**：后者存着 OSCrypt 的 AES 密钥，少了它已存密钥解不开。

5. **微信限制**：正文必须 < 2 万字符（按换图后的长度估算，超了要在推送前拦截）；图片必须走微信图床（外链会被过滤，报 45166）；图文消息必须有封面，没图建不了草稿；个人订阅号没有发布接口权限（`freepublish/*` → **48001**），草稿建好后要在公众号后台手动发表。公式密集型长文用「复制到微信」（`Ctrl+Shift+C`，无大小限制）。

6. **互动数据 API 实测无权限，别去"修"它**：`datacube/getusersummary`、`datacube/getarticletotal` 返回 **HTTP 404 空响应**（该账号类型无「数据统计」接口权限）；`user/get`、`freepublish/batchget` 返回 **48001**。所以数据看板只展示内容类数据（草稿 24 篇 / 图片素材 322 / 视频 16 / 产出趋势图），互动接口状态在界面上**如实标注**并给出公众号后台入口。

7. **Notion API 版本差异**：追加内容只能用 `PATCH /v1/pages/{id}/markdown` + `insert_content`（见第 2 节表格）；`POST /blocks/{id}/children` 会报 `invalid_request_url`；但**图片**用 `PATCH /blocks/{id}/children` + image block（`file_upload`）是可行的，所以文本与图片必须分开按顺序写。

8. **建 Notion 页时不要同时给 markdown**：正文首个 `# H1` 会被静默吞掉。建空页 → 再 `appendMarkdown`。

9. **编辑器注册的 `beforeunload` 会静默取消关窗**（不弹提示、窗口不关、进程常驻）。主进程必须接管 `will-prevent-unload` 弹明确选择；同时 `quitApp()` 里要有 2.5 秒兜底强退，`closeLanServer()` 要连 keep-alive 连接一起断，否则句柄拖住进程。

10. **图片不要塞进 `documents.json`**：base64 图片会让每次自动保存写 2 MB+，主进程被写盘阻塞 → 界面卡顿。图片走 `doc-images/`，且只在图片集合真的变化时才写。

11. **`renderer/editor.html` 是 V2 遗产**，560 KB 且结构被大量依赖。新功能一律加到 `renderer/native-module.js`，不要重构它的结构。

12. **Notion 搜索有索引延迟**：刚建的页面在「选择页面」列表里可能十几秒才出现（走「更新已存页面」不受影响）。

13. **本机不是 git 仓库**（只有 `.gitignore`，随时可 `git init`）。`dist/`、`.testdata/`、`*.log`、`tools/rcedit-x64.exe`、`build/.icon-ico/` 已排除。

---

## 8. 常用配置项

文件：`%APPDATA%\blackcat-studio\blackcat-config.json`（字段默认值见 `lib/store.js` 的 `DEFAULTS`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `notionToken` | string | `''` | Notion 集成 Token，**加密存储** `enc:v1:<base64>` |
| `wechatAppId` | string | `''` | 公众号 AppID，**加密存储**（AppID 本身是公开标识，界面可明文回显） |
| `wechatSecret` | string | `''` | 公众号 AppSecret，**加密存储** |
| `notionParentPageId` | string | `''` | 新建 Notion 页面时的默认父页面（留空 = 工作区顶层） |
| `notionWriteback` | bool | `true` | 推送公众号后是否把发布记录回写 Notion |
| `publishAfterDraft` | bool | `false` | 建完草稿是否顺便提交发布（个人订阅号会失败，返回 48001） |
| `lanServer` | bool | `false` | 是否开启局域网服务（手机连同一 Wi-Fi 访问排版） |
| `lanPort` | number | `8899` | 局域网服务端口 |
| `lastNotionPage` | object\|null | `null` | 最近导入/同步的页面 `{id, title, url, savedAt}` |
| `archiveMode` | string | `'new'` | 上次同步模式：`new` / `append` / `replace` |
| `archiveTargetId` | string | `''` | 追加/覆盖的目标页面 id |
| `archiveTargetTitle` | string | `''` | 目标页面标题（仅界面显示） |
| `windowBounds` | object\|null | `null` | 窗口位置尺寸记忆 |

只读视图（`cfg:get` 返回）：`notionTokenMasked`、`hasNotionToken`、`wechatSecretMasked`、`hasWechatCreds`、`configPath`，以及 `crypto: {available, scheme, encryptedFields, undecryptable}`。
`cfg:set` 只接受白名单字段，且会丢弃含 `••••` 的值。

**密钥策略**：统一读用户级环境变量，凭据库在 `<凭据库目录>（不入库）\`（`NOTION_TOKEN`、`WECHAT_APPID`、`WECHAT_SECRET` 等；改完跑 `secrets\set-env.ps1` 重新导出）。**不要在项目里放 token 文件，也不要硬编码密钥。** `%APPDATA%` 里那份配置文件是应用自己加密写的，两者不要混。

---

## 9. 术语表

| 术语 | 含义 |
|---|---|
| **文稿** | 本机缓存的编辑单元，存于 `<userData>/documents.json`。界面**不展示**文稿库，只在后台静默保存 |
| **助手栏** | 右侧停靠式面板 `#sbRoot`（372 px），五个标签：① 导入 / ② 推送公众号 / ③ 同步 Notion / 数据 / 设置。窄屏（≤900 px）自动变抽屉 + 悬浮按钮 |
| **导入** | 把 Notion 页面内容拉进编辑器。只读，不改 Notion、不自动存档 |
| **同步** | 创作台 → Notion 的手动写回（Ctrl+S）。三种模式：新建 / 更新已关联页面 / 追加 |
| **关联页面** | 文稿的 `notionPageId`。导入即记录来源页面 id；已关联的文稿默认执行「更新」，不再新建第二篇 |
| **本机缓存** | 编辑器内容 2.5 s 防抖自动落盘（`documents.json` + `doc-images/`），静默进行 |
| **推送** | 创作台 → 微信公众号草稿箱（`draft/add`），图片先换微信图床、第一张兼任封面 |
| **复制到微信** | `Ctrl+Shift+C`，直接复制富文本到公众号后台编辑器，**无 2 万字符限制**，长文兜底方案 |
| **📤 回写** | 推送成功后把发布记录（日期/标题/media_id/图片数/状态）追加到来源 Notion 页面 |
| **出口 IP** | 本机公网 IP，必须加进公众号「设置与开发 → 基本配置 → IP 白名单」，否则报 40164。换电脑或 VPN 重连后要在设置页重新获取/复制并更新白名单 |
| **创作台方言** | `lib/convert.js` 定义的中间 markdown 格式：`:::tip` 等容器、`【图片N】` 占位符、公式、表格、callout |

---

## 10. 已知限制

- 微信：正文 < 2 万字符、图片必须走微信图床、必须有封面；个人订阅号无发布接口权限，草稿需后台手动发表。
- 互动数据（阅读/点赞/分享/关注）API 侧拿不到（个人订阅号限制），看板只展示内容类数据并如实标注。
- 局域网/手机模式只能导入与排版，同步与推草稿请在电脑端做（界面已提示）。
- `safeStorage` 依赖 `<userData>\Local State`；该文件被清理会导致已存密钥解不开，此时界面提示重填，磁盘上的密文会保留、不会被写成空。
- Notion 搜索有索引延迟（见避坑 12）。

---

## 11. Notion：项目主页与三份关联文档

**项目主页**：Notion 项目库条目「小黑喵创作台」—— <（私有 Notion 项目库条目，链接不公开）>
（字段：`文档` / `任务` / `会议` / `时间轴`；页面正文写着当前进度、**核心技术栈**与长期方向）

| 文档 | 类型 | 作用 | 链接 |
|---|---|---|---|
| 小黑喵创作台V3 | Spec | 需求稿 + 功能 / 验收标准 / 产物构建 + 版本迭代段（版本维度历史，最新在上，每版分「更新内容 / 待修复」） | <（私有链接）> |
| 版本迭代 | 更新 | **每日进展**（最新在上，每天一节 `# 日期` + 「更新内容 / 待修复·已知问题」） | <（私有链接）> |
| 开发与测试计划 | Strategy | 核心技术栈（当前 + 规划）、P0–P5 分期路线、每期验收、测试计划与发版 gate、维护机制、风险 | <（私有链接）> |

项目的 `任务` 关系里挂着执行清单（2026-10-05 起）：历史 11 条 **Done**、P0–P5 共 14 条待办；
每条任务正文固定两块 —— **完成标准**（可勾选清单）+ **技术栈**，并带 状态 与 截止日期。

**长期维护的固定动作**：

- 每天收工 → 往「版本迭代」加当天一节（更新内容 / 待修复）
- 每次发版 → 产物大小与 hash 写进当天那一节；版本维度历史同步到 V3 页
- 每期收尾 → 回「开发与测试计划」勾进度、在「任务」里改状态（未开始 / 进行中 / Done）、补新发现的问题
- 交接 → 本 README（给接手 agent）+ `docs/STATUS.md`（开工先读、收工必写）

### 11.1 写入「版本迭代」页的硬性做法

- 追加用 markdown 端点（**不要**用 block JSON，会 `invalid_request_url`）：

```http
PATCH https://api.notion.com/v1/pages/<页面ID>/markdown
Authorization: Bearer $env:NOTION_TOKEN
Notion-Version: 2026-03-11
{"type":"insert_content","insert_content":{"content":"# 2026-10-06\n…","position":{"type":"end"}}}
```

- `position` 只接受 `start` / `end`（**没有** `after`），**不能插到页首那张图之后**；位置 `start` 会把新条目顶到页首 alias/图**上面**。所以「最新在上」的写法是**重建**，不是 append：

  1. `GET /v1/pages/{id}/markdown` 取回现有内容，把新一天拼到最前面
  2. `GET /v1/blocks/{id}/children` 拿块 id，把页面里**所有日期块**逐个 `DELETE /v1/blocks/{block_id}`（约 0.4 s 一次，避开限流）
  3. 此时页面只剩 alias + 图，再 `PATCH …/markdown` + `insert_content` + `position:{type:'end'}` 把整理好的日期块整体写回
  4. 回读校验：日期顺序、每天的 `**更新内容**` / `**待修复**` 两块都在

- 正文里写 `xxx.md` 这类文件名会被 Notion 自动转成外链（实测 `STATUS.md` → `http://status.md/`），写完必须回读并用 `PATCH /v1/blocks/{id}` 改回纯文本
- **读响应务必按 UTF-8 流式解码**（Node 里 `res.setEncoding('utf8')` 或 `Buffer.concat`）。按块 `buf += chunk.toString()` 攒字符串会把跨块的多字节汉字切碎成 `U+FFFD`，看着像 Notion 把中文写坏了，其实是自己读坏的（本次就因此误改过 3 个块）
- 分工：**本 README** = 项目说明与避坑；`docs/STATUS.md` = 交接状态；**每日进展只写「版本迭代」页**，**版本历史只写 V3 页的版本迭代段**，不要互相抄
