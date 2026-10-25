# 小黑喵创作台 · Black Cat Studio

> 专为微信公众号文章创作设计的 Markdown 排版编辑器 —— 单文件网页应用，浏览器打开即用，无需安装。

**👉 在线使用：<https://alice-p197.github.io/blackcat-studio/>**

- 版本：3.0.0（2026 年 10 月 25 日）
- 网页版：V3.0 [`blackcat-v3.html`](./blackcat-v3.html)（推荐，含 Notion 模块）｜ V2.7 [`wechat-markdown-editor.html`](./wechat-markdown-editor.html)
- 桌面版（Windows）：便携版 / 安装包见 [Releases](https://github.com/Alice-P197/blackcat-studio/releases/latest)，Electron 源码在 [`desktop/`](./desktop/) 目录
- 在线图文教程：[V3 使用说明](https://alice-p197.github.io/blackcat-studio/guide-v3.html)（源文件 [`guide-v3.html`](./guide-v3.html)）；完整操作手册见《[小黑喵创作台-操作手册.docx](./小黑喵创作台-操作手册.docx)》
- 更新日志：[CHANGELOG.md](./CHANGELOG.md)

---

## ✨ 核心特色

| 功能 | 说明 |
| --- | --- |
| **实时预览** | 左侧编写 Markdown，右侧即时显示排版效果 |
| **一键复制到微信** | 排版完成后一键复制，直接粘贴进微信公众号编辑器（样式全部内联） |
| **多主题切换** | 内置 6 套预设主题 + 自定义配色（Custom） |
| **数学公式** | 基于 MathJax，支持行内 `$...$` 与区块 `$$...$$` 公式，输出 SVG 可直接进微信 |
| **代码高亮** | 基于 highlight.js，支持上百种编程语言的语法高亮 |
| **中英双语界面** | 界面中文 / English 一键切换 |
| **字体分离** | 中文字体（13 种）与英文字体（14 种）可分别设置，字号 14px–22px 可选 |
| **文字颜色与对齐** | 选中文字设置颜色；支持单行 / 单段 居中、左、右、两端对齐 |
| **模板系统** | 内置 8 套文章模板，还可保存自定义模板 |
| **HTML 直渲模式** | 支持直接写 HTML + 内联 CSS，可嵌 ECharts 图表（复制到微信时自动转内联样式 / 图表转图片） |

## 🐾 Notion 模块（V3 新增）

V3 在 V2.7 全部能力之上追加了自包含的 Notion 模块（V2 原文件未改动，V3 是独立文件）：

- **搜索 / 导入 Notion 笔记**，公式、表格、高亮、折叠块自动转换
- **Notion 图片自动下载并内嵌**（6 路并行 + 会话内缓存，面板实时显示进度），粘贴进微信编辑器不丢图
- **发布后一键回写**：点「标记为已发布并回写」，发布记录自动追加到对应 Notion 笔记末尾

### 快速上手

1. 打开 [`blackcat-v3.html`](https://alice-p197.github.io/blackcat-studio/blackcat-v3.html)（需联网）
2. 工具栏点 **Notion** 按钮
3. 第一次用：到 <https://www.notion.so/developers/tokens> 建一个集成令牌（能力勾 **Notion API**，建议 7 天有效期），粘进面板点「保存」；并到要导入的 Notion 页面「···」→ Connections 里连接该集成
4. 搜索 → 点一篇笔记 → 「导入到编辑器」
5. 在创作台里调排版（主题 / 字体 / 公式框等，都是 V2 原有能力）
6. **Ctrl+Shift+C** 一键复制 → 粘到微信公众号编辑器
7. 回 Notion 面板点「标记为已发布并回写」，发布记录自动沉淀到笔记

### 导入时自动转换

| Notion 里 | 创作台里 |
| --- | --- |
| 正文文字、标题、列表 | 直接对应转换 |
| 行内公式 `$…$` / 区块公式 `$$…$$` | MathJax 输出 SVG（微信要求） |
| Callout 提示块 | `:::tip` / `:::note` / `:::warning` / `:::success` |
| 表格 / 折叠块 / 文字高亮 | markdown 表格 / `:::note` 容器 / `<font color>` |
| 图片（Notion S3） | 下载 → base64 内嵌 → 正文写【图片N】占位符 |
| 页面提及、转义符号 | 自动清理 |

> 微信正文不能引用外部图片，所以导入时就把图抓下来转成 base64 内嵌——这就是粘贴进微信不丢图的原因。同一篇笔记重复导入不会重新下载图片。

### 两种发布方式

| | 一键复制（Ctrl+Shift+C） | 推送到草稿箱（桌面版） |
| --- | --- | --- |
| 操作 | 复制后粘进微信编辑器 | 草稿自动出现在公众号后台 |
| 图片 | base64 内嵌，直接可用 | 自动上传微信图床后替换 |
| 篇幅 | 无限制 | 正文 < 2 万字符、< 1M |
| 适合 | **所有文章**，尤其公式多的长文 | 常规篇幅文章 |

> 微信「一键发表」接口自 2025 年 7 月起对个人订阅号关闭，且草稿正文图片必须来自微信图床——所以「自动推进草稿箱 + 手动点发表」已是个人号的上限，这是微信平台的限制。另外：本机若走 VPN / 代理，出口 IP 变化后调微信接口会报 `40164`，需去公众号后台重新加 IP 白名单。

### 已知边界

- 刚在 Notion 新建 / 改名的页面，搜索索引有十几秒延迟
- 图片下载失败会保留原 URL 并在状态栏提示，重新导入即可
- Token 只存在浏览器本地（localStorage），不上传任何服务器；建议用短期令牌，用完随时吊销
- V3 需要联网打开（CDN 依赖与 V2 相同）

## 🖥️ 桌面版（Windows）

Electron 桌面应用，[便携版 / 安装包下载](https://github.com/Alice-P197/blackcat-studio/releases/latest)，源码见 [`desktop/`](./desktop/) 目录：

- 主进程代理全部 Notion / 微信 API：无跨域限制，Token / AppSecret 经 Windows DPAPI 加密存储
- 一键推送公众号草稿箱：图片自动传微信图床、封面传永久素材、正文限制预检
- 多文稿库管理，自动保存到本机
- **局域网服务**：一键开启后，手机连同一 Wi-Fi 打开 `http://电脑IP:8899` 即可在手机上导入与排版

## 🖼️ 界面布局

- **顶部工具栏**：渲染（Ctrl+S）、深色/浅色切换（Ctrl+D）、帮助（Ctrl+/）、模板（TEMP）、MD/HTML 模式切换、中英文切换、导入、导出、复制到微信（Ctrl+Shift+C）
- **格式栏（第二行）**：主题选择、标题样式（Title）、颜色工坊（Color）、中文字体 / 英文字体 / 字号、文字对齐（L/C/R/J）、文字颜色、同步滚动（Sync）
- **右侧侧边栏**：目录（TOC）、行内/区块公式、矩阵/积分/求和公式模板、代码块、表格、链接卡片、信息框（INFO）、警告框（WARN）、公式框（Form）、公理框（Axiom）
- **主编辑区**：左侧 Markdown 源码编辑（支持行号、Tab 缩进、Ctrl+V 粘贴图片），右侧实时预览
- **底部状态栏**：字符 / 词 / 行数统计、渲染耗时、图片题注语言切换（图1：/ Figure 1:）

## 🎨 主题与配色

内置主题一键切换：

| 主题 | 风格特点 | 适用场景 |
| --- | --- | --- |
| Default | 经典暖色调，赤陶橙为主色 | 通用场景，日常文章 |
| Elegant | 优雅素净，衬线字体为主 | 散文随笔，文艺类文章 |
| Tech | 科技蓝色调，代码友好 | 技术博客，编程教程 |
| Forest | 自然绿色调，护眼舒适 | 教程指南，学习笔记 |
| Ink | 水墨黑白，学术风格 | 研究笔记，学术文章 |
| Rose | 玫瑰粉色调，柔和温暖 | 读书笔记，生活分享 |
| Custom | 用户自定义配色 | 个性化风格，品牌统一 |

更多样式能力：

- **标题样式**：H1 提供 5 种猫咪主题装饰（猫爪印 / 猫脸 / 爱心猫 / 可爱猫 / 猫爪虚线框），H2 提供 10 种装饰风格
- **代码块风格**：Plain / Arrow / Neon Glow / Rainbow / Watercolor / Glass 六种
- **颜色工坊**：30 套预设配色（Warm / Cool / Neutral / Vibrant / Pastel），可自定义 Accent / Heading / Text / Link / Code 等 10 项颜色，支持配色方案 JSON 导入 / 导出

## 📄 模板系统

内置 8 套精选模板：**技术博客 · 产品测评 · 散文随笔 · 教程指南 · 研究笔记 · 周报汇报 · 读书笔记 · 简洁图文**。在模板面板中可将当前文章保存为自定义模板（存于浏览器本地），也可删除不需要的自定义模板。

## 🧮 扩展语法速览

- **数学公式**：`$行内公式$`、`$$区块公式$$`，侧边栏提供矩阵 / 积分 / 求和模板；`:::formula ... :::end` 创建带自动编号的公式框，`:::axiom ... :::end` 创建公理框
- **特殊容器块**：`:::tip`（提示）、`:::warning`（警告）、`:::note`（笔记）、`:::success`（成功）
- **链接卡片**：`:::link[标题](URL) 描述`（Ctrl+K）
- **文字颜色**：选中文字点颜色块，或直接写 `<font color="red">…</font>` / `<span style="color:#ff0000">…</span>`
- **文字对齐**：选中文字点对齐按钮循环切换 左→中→右→两端对齐，生成 `<div style="text-align:...">`
- **图片**：编辑器中 Ctrl+V 直接粘贴剪贴板图片，自动生成【图片1】占位符，复制到微信时正确嵌入

## ⌨️ 常用快捷键

| 快捷键 | 功能 | 快捷键 | 功能 |
| --- | --- | --- | --- |
| Ctrl+B / Ctrl+I | 加粗 / 斜体 | Ctrl+S / Ctrl+Enter | 渲染预览 |
| Ctrl+` / Ctrl+Shift+` | 行内代码 / 代码块 | Ctrl+D | 深色/浅色切换 |
| Ctrl+M / Ctrl+Shift+M | 行内 / 区块公式 | Ctrl+E | 导出菜单 |
| Ctrl+Q | 引用块 | Ctrl+Shift+C | 复制到微信 |
| Ctrl+L / Ctrl+Shift+L | 表格 / 有序列表 | Ctrl+T | 切换目录 |
| Ctrl+U | 无序列表 | Ctrl+/ | 帮助面板 |
| Ctrl+K | 链接卡片 | | |

## 📥 导入与导出

- **导入**：支持 `.md` / `.markdown` / `.html` / `.htm` / `.txt` 及图片文件（自动嵌入为占位符）
- **导出**（Ctrl+E）：PDF（打印存档）、独立 HTML（网页发布 / 离线查看）、Markdown 源文件（备份）

## 📁 仓库文件说明

| 文件 | 说明 |
| --- | --- |
| `blackcat-v3.html` | **V3 主程序**（单文件网页应用，含 Notion 模块） |
| `wechat-markdown-editor.html` | V2.7 主程序（经典单文件版，无 Notion 模块） |
| `index.html` | 项目主页 / 导航页 |
| `guide-v3.html` | V3 在线图文使用说明 |
| `小黑喵创作台-操作手册.docx` | 完整操作手册（功能详解与使用指南） |
| `CHANGELOG.md` | 更新日志 |
| `desktop/` | 桌面版（Electron）完整源码与打包说明 |

## 🔗 技术依赖

页面运行时通过 CDN 加载以下库（需联网）：

- [marked](https://github.com/markedjs/marked) 12.0.2 — Markdown 解析
- [MathJax](https://www.mathjax.org/) 3 — LaTeX 公式渲染（SVG 输出）
- [highlight.js](https://highlightjs.org/) 11.9.0 — 代码语法高亮
- [ECharts](https://echarts.apache.org/) 5.4.3 — HTML 模式下的数据图表
- Google Fonts：Noto Serif SC / Noto Sans SC / JetBrains Mono

## 💡 使用提示

1. 打开页面，在左侧写 Markdown，右侧实时预览（输入停顿约 300ms 自动渲染）
2. 用格式栏选主题、字体、配色，用侧边栏插入公式 / 表格 / 代码块等
3. 满意后点「复制」（Ctrl+Shift+C），到微信公众号后台编辑器直接粘贴即可，所有样式（字体、颜色、代码高亮、公式 SVG）均已内联

如有问题请在编辑器中按 `Ctrl+/` 打开帮助面板。
