# 文件管理 · FISH Dock 插件

把 FISH Dock 变成随手可用的文件工作台：上半逛目录、下半看内容，左边还能把常用文件先「暂存」起来，随时拖进别的程序。

插件 id `jassdingk.filemgr`，宿主 API 1，兼容 **FISH Dock v1.2.3 及更早的官方发行版**，不要求宿主做任何改动。

## 功能

### 目录浏览 + 预览

- **目录浏览**：磁盘根目录、用户目录、桌面 / 文档 / 下载逐层进入；支持把文件 / 文件夹直接拖进面板。
- **预览**：Markdown 渲染、图片（PNG / JPEG / GIF / WebP / BMP / AVIF / ICO / SVG）、Office 文本抽取（docx 段落与标题、xlsx 多工作表、pptx 每页文字，原生解析 OOXML，不需要装 Office）、代码高亮行号、纯文本与二进制兜底。
- **上下并列**：上半是文件夹浏览器（面包屑 + 列表 + 上一级 / 刷新 / 常用文件夹 / 固定），下半是预览；中间分隔条可拖动调高，高度会被记住。
- **框选与拖入暂存**：在列表里拖出选框可批量选中（Ctrl / Shift 点选切换），选中项直接拖到左侧暂存区即批量加入；拖到一半拖出列表会自动从「框选」切到「搬运」。
- **常用文件夹**：记住打开过的目录，浮层里快速跳转；可把目录「固定」到最上面。

### 文件暂存（中转站）

- 拖入文件或文件夹即加入暂存区，也可以右键 / 按钮添加。
- **分组**：暂存区支持多个分组标签，点击切换，标签可折叠；删除分组只走标签右侧的 ×。分组之间完全隔离，切组不会串条目。
- **拖出**：把暂存项直接拖到桌面、资源管理器、微信等外部程序。
- 复制路径、复制为文件、多选批量、去重、清空，偏好持久化。

## 选择文件夹的两条路径

默认走**插件内自绘选择器**：点「打开文件夹」直接在面板里画出目录树，用后端 `preview.tree` 逐层浏览。全程不出窗口，任何宿主版本都能用，不会因为宿主失焦逻辑把面板收起来。

`位置` 里的「＋ 添加文件夹…」是**可选**的 Windows 原生对话框入口。它只在宿主实现了 `fish:hold` 时才真正弹出系统窗口，否则自动回落到内置选择器：

| 宿主 | 「打开文件夹」 | 「＋ 添加文件夹…」 |
|---|---|---|
| 官方发行版（≤ v1.2.3） | 内置选择器 | 内置选择器（自动回落） |
| 自行编译、带 `fish:hold` 的宿主 | 内置选择器 | Windows 原生对话框 + 临时锁定面板 |

原生对话框路径在弹窗前后调用 `bridge.js` 的 `hold(true)` / `hold(false)`：`hold(true)` 让宿主暂时不要因为失焦收起设置面板，选完立刻放开，平时浏览、拖放都不受影响。

宿主侧要支持这条路，需要三处改动：

1. `sdk/browser/bridge.js` 暴露 `hold(on)` → `parent.postMessage({type:'fish:hold', ticket, on}, '*')`
2. `Wakuwaku/src/pet/extension-page.js` 收 `fish:hold` 写入 `record.hold`，并新增 `onHold(record, on)` 回调；`park()` / `enter()` / `retire()` 各自同步
3. `Wakuwaku/src/pet/settings.js` 维护 `pluginHold` 标志，`onBlur` 判定里加 `!pluginHold`

只改插件包、不重编译宿主时，插件自动走内置选择器，功能完整不缺。

## 安装

### 方式一：打开发目录（给开发加载用）

```bash
node tools/build.mjs
# 产物 dist/filemgr 就是一个完整的开发目录（含 plugin.json），交给 FISH Dock 开发加载即可
```

### 方式二：直接打发行包

```bash
node tools/build.mjs
# 产物 dist/jassdingk.filemgr.fish-plugin，用 FISH Dock 插件页的「从文件安装」装上
```

### 方式三：装到插件目录

```bash
node tools/build.mjs
# 把 dist/filemgr 整个目录放到 %USERPROFILE%\.fish-dock\host\packages\jassdingk.filemgr\<version>\<digest>\
```

两种产物都由 `tools/build.mjs` 一次生成。`sdk/` 里带的 `bridge.js` 与 `plugin.mjs` 是 FISH Dock v1.2.3 的原始副本，打包时会分别拷到包根目录的 `bridge.js` 和 `plugins/filemgr/sdk.mjs`——与官方 `tools/stage-development.mjs` 的做法一致。

## 说明

- 只读取路径白名单内的文件，路径解析后必须落在允许的根目录之下；UNC 路径一律拒绝。
- 「＋ 添加文件夹…」在支持 `fish:hold` 的宿主上会短暂启动系统 PowerShell 调起 Windows 原生对话框（`pick-folder.ps1` / `pick-files.ps1`）；不加 `fish:hold` 的宿主上不会启动子进程。除此之外不启动任何子进程。
- 页面运行在宿主沙箱里（`default-src 'none'`），PDF 与音视频不做内联播放，会提示用系统程序打开。
- 不发起网络请求。
- 大文件保护：单次文本预览上限 800 KB、目录条目上限 2000 条、Office 文件上限 200 MB，超限会截断并给出提示，不会把插件进程撑死。

## 存储

偏好（布局、最近打开、额外根目录、暂存条目与分组、固定目录）保存在插件命名空间的 `config/prefs.json`。

## 目录结构

```
plugins/filemgr/
  backend.mjs          后端入口：命令路由 + 帧体积兜底
  preview.mjs          目录树 / 文本 / 图片 / Office 读取
  stash.mjs            暂存区数据与拖出服务
  page.html            页面结构（上下并列 + 左侧暂存）
  page.js              页面逻辑（浏览、预览、框选、暂存、目录选择器）
  page.css             布局与主题
  filemgr.css          浏览器列表、行内按钮、高亮
  stash.css            暂存区与分组标签
  dock.css             与宿主共享的配色变量
  pick-folder.ps1      原生文件夹对话框（内联 C#，不依赖 .cs 文件）
  pick-files.ps1       原生多文件对话框
  clip.ps1             复制到剪贴板
sdk/
  browser/bridge.js    宿主注入页面的桥（官方 v1.2.3 原版）
  node/plugin.mjs      后端 SDK（官方 v1.2.3 原版）
tools/
  build.mjs            打发行包 / 开发目录
```

## 许可

MIT。`sdk/` 下的两个文件来自 [Fish-under-sea/FISH-Dock](https://github.com/Fish-under-sea/FISH-Dock)（MIT），保留原作者版权。
