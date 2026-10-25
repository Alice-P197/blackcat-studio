# STATUS · 小黑喵创作台（桌面版）

**最后更新**：2026-10-05 18:30 ｜ **更新者**：DSH

---

## ⚠️ 业务逻辑（已按用户要求重做，别再走回老路）

```
主流程：  Notion 导入素材  →  在创作台排版  →  推送微信公众号
旁支：    在创作台写新文章  →  手动「保存到 Notion」（可选，绝不自动）
本机：    编辑时自动保存文稿（持久化，关掉应用不丢）
```

**三条硬规则：**
1. **导入不做任何写回**。导入只是把 Notion 内容拉进编辑器，不会自动存档、不会改 Notion。
2. **存回 Notion 必须是显式动作**（点按钮或 Ctrl+Shift+S），且只有三种模式：新建 / 更新已存页面 / 追加。
3. **同一篇文稿只对应一个 Notion 页面**：存过一次后文稿记下 `notionPageId`，默认模式自动变成
   「更新已存页面」；想再新建必须显式选择且会二次确认 —— 从根上避免重复存档。

界面：右侧停靠式助手栏（不是遮罩弹窗），四个标签：① 导入 / ② 推送公众号 / ③ 文稿（含存到 Notion）/ ④ 设置。
窄屏（≤900px）自动变抽屉 + 悬浮「助手」按钮，工具栏换行，不再挤压正文。

## 现在谁在做 / 做到哪

| 智能体 | 目录 / 分支 | 正在做 | 开始时间 | 状态 |
|---|---|---|---|---|
| DSH | `<项目根目录>` | 业务逻辑重构 + 右侧栏 + 文稿持久化 + 手机适配 | 10-05 17:10 | 已完成，待验收 |

## 本次改动（2026-10-05 第二轮）

1. **右侧助手栏**：`#sbRoot` 停靠右侧 372px；打开时给 `.main`/`.status-bar` 加 padding 让位；
   窄屏改抽屉 + 遮罩 + 悬浮按钮；Ctrl+B 开关。
2. **文稿持久化**（新增 `lib/docs.js`）：`<userData>/documents.json` 存全部文稿（正文 + imageStore）；
   编辑后 2.5s 防抖自动保存；启动恢复上次文稿；文稿列表可切换/新建/删除；每篇记 `notionPageId`。
3. **保存到 Notion 改成手动 + 防重复**：三种模式（新建 / 更新已存页面 / 追加），目标页面独立搜索选择；
   第一次保存后自动记录关联页面，之后默认「更新那一页」；选「新建」会提示会重复。
4. **导入不再触发任何写回**；Ctrl+S = 保存文稿（本机），Ctrl+Shift+S = 保存到 Notion，Ctrl+Q = 退出。
5. **手机/电脑排版**：≤900px 抽屉式侧栏；≤768px 工具栏换行 + 编辑器/预览各占半屏；≤620px 隐藏 logo、侧栏全宽。
6. 修掉第一轮遗留的两个真 bug：
   - `setStatus` 未定义（新代码到处调用它）→ 点保存静默抛异常、状态栏空白；
   - `lib/docs.js` 首次创建文稿时丢掉 `imageStore` → **新文稿第一次自动保存会丢图**。

## 验证结果（可复现）

| 测试 | 命令 | 结果 |
|---|---|---|
| 自检（源码） | `electron . --self-test` | **27/27 通过**（含手机端布局 6 项） |
| 自检（打包版） | `dist\win-unpacked\小黑喵创作台.exe --self-test` | 见 `docs/selftest-packaged.log` |
| 端到端实测 | `electron . --live-test` | **29/29 通过**（真连 Notion：导入→推送→新建→再存=更新同一页→追加→持久化→加密） |

关键断言：`② 关联页面 id 没变（没有另起新页）`、`③ 搜索里也只有一篇（没有重复页面）`、`文稿里带着图片数据`。

> ⚠️ 跑测试必须清掉环境变量 `ELECTRON_RUN_AS_NODE`（DSH 的 node 垫片会设它，Electron 会退化成纯 Node）。
> 测试 profile 要**同时复制 `blackcat-config.json` 和 `Local State`** —— 后者存着 OSCrypt 的 AES 密钥，
> 少了它密钥解不开（这是测试环境问题，不是产品缺陷）。命令见 `docs/`，用独立 `--user-data-dir` 避开单实例锁。

## 构建与交付

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
build-electron-app.ps1 -Project <项目根目录> -DeliverTo <桌面> -KillRunning
```

产物（2026-10-05 18:2x）：

| 文件 | 大小 | sha256 前 16 位 |
|---|---|---|
| `dist\小黑喵创作台V3-便携版.exe` | 71.84 MB | `A34A8264F2A66FEB` |
| `dist\小黑喵创作台V3-安装包.exe` | 79.12 MB | `B8BC8C8ABBDB51CB` |

桌面已同步。

## 已知限制 / 待办

- 微信公众号：正文 < 2 万字符、图片必须走微信图床；长文请用「复制到微信」。个人订阅号无发布接口权限。
- 手机/局域网模式只能导入与排版；存档与推草稿请在电脑端做（界面已提示）。
- Notion 搜索有索引延迟，刚建的页面在「选择页面」列表里可能要十几秒才出现（用「更新已存页面」不受影响）。
- Electron 的 `safeStorage` 依赖 `<userData>\Local State`；该文件被清理过会导致已存密钥解不开，
  此时界面会提示重填（磁盘上的密文会保留，不会被写成空）。


## 本次改动（2026-10-05）

1. **工具栏按钮 `Notion` → `存档`**（`renderer/native-module.js` 的 `injectButton`）。
2. **存档三种模式**：新建页面 / 追加到页面末尾 / 覆盖页面，统一走 `notion:archive` IPC；
   追加与覆盖都保留图片与顺序（文本走 markdown 端点、图片走 file_upload + image block）。
3. **Ctrl+S 随时存档**（capture 阶段拦截，面板关着也能用）；设置页与选择器都加了相应入口。
4. **设置里可配 Notion API 与微信公众号 API**，并带「验证」按钮。
5. **密钥加密落盘**：`notionToken` / `wechatAppId` / `wechatSecret` 用 Windows DPAPI（Electron safeStorage）
   加密成 `enc:v1:<base64>` 再写 `blackcat-config.json`；**旧明文配置首次启动会自动迁移**。
   注意：这里必须是**可逆加密**而不是哈希 —— 调 API 要把密钥原文发出去，哈希了就取不回来。
6. **修掉"关不掉"的 bug**：根因是编辑器注册的 `beforeunload` 在 Electron 里会**静默取消关窗**。
   现在主进程接管 `will-prevent-unload`：弹「有未保存的改动，仍要退出？」让用户选；
   同时补了退出清场（关局域网服务 + 断 keep-alive 连接）与 2.5 秒兜底强退，并加了 Ctrl+Q / 「退出应用」按钮。
7. 界面打磨：存档区改为分段控件 + 独立的目标页面选择器（带自己的搜索框与「用最近存档的」快捷）、
   已选目标展示、成功后可直接在 Notion 打开、设置页加密状态提示。

## 验证结果（可复现）

| 测试 | 命令 | 结果 |
|---|---|---|
| 自检（源码） | `electron . --self-test` | **17/17 通过** |
| 自检（打包版） | `dist\win-unpacked\小黑喵创作台.exe --self-test` | **17/17 通过** |
| 端到端实测 | `electron . --live-test` | **23/23 通过**（真连 Notion 跑完 新建/追加/覆盖 + 加密校验） |
| 干净关窗 | `docs\quit-dirty-test.ps1` 前半段 | 关窗 0.5 秒内进程全部退出 |
| 有改动关窗 | `docs\quit-dirty-test.ps1` | 弹出「有未保存的改动」确认框，等用户选择 |

> ⚠️ 跑 electron 时必须清掉环境变量 `ELECTRON_RUN_AS_NODE`（DSH 的 node 垫片会设它，
> 否则 Electron 会退化成纯 Node，报 `ipcMain undefined`）。测试用独立 `--user-data-dir` 开，
> 避免和在跑的实例抢单实例锁。

## 构建与交付

```powershell
# 共享工具链（不要 npm install electron）
$env:ELECTRON_BUILDER_CACHE = "<electron-builder 缓存>"
<toolchain>/node_modules\.bin\electron-builder.cmd --win --x64 --dir
.\apply-branding.ps1 -Targets .\dist\win-unpacked\小黑喵创作台.exe
<toolchain>/node_modules\.bin\electron-builder.cmd --win portable --x64 --prepackaged .\dist\win-unpacked
<toolchain>/node_modules\.bin\electron-builder.cmd --win nsis     --x64 --prepackaged .\dist\win-unpacked
```

产物（2026-10-05 16:44）：

| 文件 | 大小 | sha256 前 16 位 |
|---|---|---|
| `dist\小黑喵创作台V3-便携版.exe` | 71.83 MB | `FD534C91ADDC414C` |
| `dist\小黑喵创作台V3-安装包.exe` | 79.12 MB | `ED64F986059C6546` |

桌面已同步这两个文件。

## 下一步 / 待人工确认

1. **旧实例要结束掉**：桌面上那个 10-04 启动的实例跑的是旧版，它的 `beforeunload` 会拦住关窗
   （正是本次修的 bug）。新版本启动会撞单实例锁、只会聚焦旧窗口。
   处理办法：先在旧窗口里 Ctrl+A / Ctrl+C 把内容复制出来，再用任务管理器结束「小黑喵创作台」4 个进程。
   结束后可以删 `%TEMP%\3KC2CzKaDRJ3SHZ1L3TEqQ0D5iT`（约 272 MB 的旧解压目录）。
2. 旧配置里的明文密钥会在**新版首次启动时自动加密迁移**，可对比 `%APPDATA%\blackcat-studio\blackcat-config.json` 验证。
3. 打包产物未做代码签名，首次运行可能有 SmartScreen 提示。

## 已知限制

- 微信公众号接口：正文必须 < 2 万字符、图片必须走微信图床；公式密集型长文请用「复制到微信」。
  个人订阅号没有发布接口权限，草稿建好后需在手机上手动发表（应用已明确提示）。
- 浏览器/局域网模式（手机访问）只能导入与排版，存档与推草稿请在桌面版做。
