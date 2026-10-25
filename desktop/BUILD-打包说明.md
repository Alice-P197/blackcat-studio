# 小黑喵创作台 · 桌面版打包说明

## 产物（dist/）

| 文件 | 大小 | 说明 |
|---|---|---|
| `小黑喵创作台V3-便携版.exe` | **71.8 MB** | 单文件，双击即用，自解压到 `%TEMP%` 后启动，不安装 |
| `小黑喵创作台V3-安装包.exe` | ~72 MB | NSIS 安装包，可选安装目录、建桌面/开始菜单快捷方式、可卸载 |
| `win-unpacked/` | 271.7 MB | 未压缩目录版（调试用，`小黑喵创作台.exe` 已打标） |

## 一键重建

```powershell
# 推荐：一条命令搞定（前置检查 → 目录版 → 打标 → 便携版 → 安装包 → 交付 + 校验）
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
build-electron-app.ps1 `
  -Project <项目根目录> `
  -DeliverTo <桌面> `
  -KillRunning
```

这条通用脚本已固化成技能 **`electron-package-win`**（DSH 里说"打包 exe / 出便携版"即触发）。
常用开关：`-DirOnly`（只出目录版，最快自测）、`-SkipInstaller`、`-SkipBranding`、`-KillRunning`。
完整避坑清单在 `<electron-package-win SKILL.md>`。

<details>
<summary>手动分步（脚本出问题时的兜底）</summary>

```powershell
cd <本目录>
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # 必须！否则 Electron 退化成纯 Node

# 1) 先出目录版（内层 exe 会被 electron-builder 的 asar 完整性步骤处理）
.\node_modules\.bin\electron-builder.cmd --win --x64 --dir

# 2) 给内层 exe 补图标与版本信息（见下方「为什么要单独补」）
.\apply-branding.ps1 -Targets .\dist\win-unpacked\小黑喵创作台.exe

# 3) 用已打标的目录直接封装成便携版/安装包（--prepackaged 会跳过重新打包，保住打标结果）
.\node_modules\.bin\electron-builder.cmd --win portable --x64 --prepackaged .\dist\win-unpacked
.\node_modules\.bin\electron-builder.cmd --win nsis     --x64 --prepackaged .\dist\win-unpacked
```

</details>

> `apply-branding.ps1` 需要能执行脚本：`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`。
> 脚本文件必须带 UTF-8 BOM，否则 Windows PowerShell 5.1 按 ANSI 读会把中文/`©`/`↔` 读花导致语法错误。
> 应用若正在运行会锁住 exe（便携版的 NSIS 启动器也会一直占着），覆盖会失败 → 先关掉或用 `-KillRunning`。

## 为什么 `win.signAndEditExecutable: false`

`electron-builder.yml` 里这一项**不能删**。原因链：

1. app-builder 的 `rcedit` 命令**即使在 Windows 上**也会去下载 `winCodeSign` 二进制包
   （`app-builder.exe` 里硬编码，见 `app-builder-lib/out/codeSign/windowsSignToolManager.js:22` → `getSignVendorPath()`）。
2. `winCodeSign-2.6.0.7z` 内含 macOS 的 `darwin/10.12/lib/libcrypto.dylib`、`libssl.dylib` **符号链接**。
3. 本机不是管理员、也没开 Windows 开发者模式 → 7za 建符号链接被拒 →
   `ERROR: Cannot create symbolic link ... 客户端没有所需的特权` → `⨯ cannot execute exit status 2` → 打包整体退出 1。
4. 设为 `false` 后 electron-builder 完全不调用 rcedit/签名，上述整条链不再触发。
   （签名本来就跳过：无证书时 `windowsSignToolManager` 打印 "no signing info identified, signing is skipped"。）

## ⚠️ 不要对便携版/安装包用 rcedit

NSIS 产物的应用程序数据是**追加在 PE 尾部的 overlay**。rcedit 重写 PE 时会丢弃 overlay：
```powershell
# 实测：71.81 MB 的便携版 exe 被 rcedit 处理后只剩 0.09 MB（94 KB），payload 全没了
```
NSIS 产物**本来就有**图标和版本信息（由 `makensis` 从 `win.icon: build/icon.png` 生成并写入），
不需要也不允许再动。`apply-branding.ps1` 只处理 `win-unpacked/` 里那个没有 overlay 的内层 exe。

## 图标/版本信息

| 对象 | 来源 |
|---|---|
| 便携版 / 安装包 exe | NSIS 内置（`win.icon` → `dist/.icon-ico/icon.ico`） |
| `win-unpacked/小黑喵创作台.exe` | `apply-branding.ps1` 用 `tools/rcedit-x64.exe` 写入 |

`tools/rcedit-x64.exe` 是从 `winCodeSign` 缓存里**只取那一个文件**解出来的（不解符号链接）：
```powershell
node_modules\7zip-bin\win\x64\7za.exe e <winCodeSign>.7z -o tools -snl- -y "-ir!*rcedit-x64.exe"
```

已验证（像素统计比对，本机识图通道不可用时的替代证据）：
内层 exe 与便携版 exe 的图标平均 RGB 均为 (201,198,188)、暗像素 20.9%，
与 `build/icon.png` 缩放值 (201,199,190)/17.8% 基本一致，明显区别于 Electron 默认图标 (64,71,83)/81.8%。

## 本机环境注意事项

- **DSH 沙箱**：`workspace-write` 下 electron-builder 会因 `spawn EPERM` 失败——
  它必须用**管道 stdio** 启动 `app-builder.exe`，而受限沙箱禁止命名管道。
  同理 Electron 运行时也依赖命名管道（`platform_channel.cc` FATAL），**打包和烟测都需放宽沙箱**。
- **构建缓存**：受限沙箱禁止写 `%LOCALAPPDATA%`，可用 `ELECTRON_BUILDER_CACHE=<可写目录>` 重定向；
  正常权限下留空即可（缓存到 `%LOCALAPPDATA%\electron-builder\Cache`）。

## 烟测

```powershell
$exe = "dist\小黑喵创作台V3-便携版.exe"
$p = Start-Process $exe -PassThru
Start-Sleep -Seconds 25
Get-Process -Name "小黑喵创作台" | Select-Object Id, MainWindowTitle, Responding, Path
Get-Process -Name "小黑喵创作台" | Stop-Process -Force
```
通过标准：出现 4 个进程（主进程 + 渲染/GPU），`MainWindowTitle = 小黑喵创作台`、`Responding = True`。

已知无害警告：启动时 renderer 打印 `Missing button: btnLang / btnFormula / btnBgBox`——
桌面壳层不渲染这三个 Web 端按钮，`native-module.js` 里是防御性日志，不影响功能。
