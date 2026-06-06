# 客户端封装工程方案

**审计日期：** 2026-05-15  
**当前版本：** iteration-v1（WF01 / WF02A / WF02B / WF03）  
**文档状态：** 方案阶段，不修改任何可运行代码

---

## 1. 当前系统运行组件

### 1.1 组件清单

| 组件 | 启动方式 | 端口 | 说明 |
|---|---|---|---|
| **n8n 服务** | `N8N_USER_FOLDER=... n8n start` | 5678 | workflow 执行引擎，REST API |
| **8788 UI 服务** | `node 版本测试/serve-review-assets.mjs` | 8788 | 工作台、配置页、分镜审核、脚本框架 |
| **n8n webhook** | n8n 内部 | 5678 | WF01 表单、WF02A/B 触发端点 |

### 1.2 目录结构（关键路径）

```
~/Downloads/tiktok-n8n-workflow-pack/          ← 项目根（当前硬编码为此路径）
├── 版本测试/
│   ├── serve-review-assets.mjs               ← 8788 UI 服务入口
│   ├── config/local-config.json              ← API Key、输出目录、服务地址
│   ├── reset-test-state.mjs                  ← 数据清空脚本
│   └── 正式导入文件/iteration-v1/            ← workflow JSON（通过符号链接）
├── 正式导入文件/iteration-v1/
│   ├── n8n01.json    (WF01, ID: rKHHjD2QBlL6EhaM)
│   ├── n8n02a.json   (WF02A, ID: scriptGenerateV1)
│   ├── n8n02b.json   (WF02B, ID: storyboardGenerateV1)
│   └── n8n03.json    (WF03, ID: reviewSubmitVeoV2)
├── .n8n-local-cache/                          ← n8n 数据库 + 运行时缓存（当前 118MB）
│   ├── concept-context/                       ← 创意方向 JSON
│   ├── script-context/                        ← 脚本框架 JSON
│   ├── review-context/                        ← 分镜图上下文
│   ├── project-state/                         ← 项目状态
│   ├── input-images/                          ← 上传产品图
│   ├── nanobanana/                            ← 合图临时文件
│   └── logs/                                  ← n8n 运行日志
├── prompts/                                   ← 系统提示词文本
└── ~/Downloads/n8n分镜图裁剪/                 ← 分镜图输出（可配置）
    ~/Downloads/n8n视频/                       ← 视频输出（可配置）
```

### 1.3 运行时依赖（审计结果）

| 依赖 | 当前版本 | 安装位置 | 普通用户是否已有 |
|---|---|---|---|
| Node.js | v24.14.0 | 系统 | ❌ 基本没有 |
| npm | 11.9.0 | 系统 | ❌ |
| n8n | 2.16.1 | `~/.npm-global/bin/n8n` | ❌ |
| ffmpeg | 8.1 | `/opt/homebrew/bin/ffmpeg`（Homebrew） | ❌ |
| sharp | n8n 内置 | n8n node_modules | 随 n8n 分发 |
| @google/genai | 1.50.1 | 项目 node_modules | 随项目分发 |

### 1.4 已知路径硬编码

这是封装的**最大工程债**。以下地方硬编码了项目路径：

1. **n8n Code 节点内**（WF01/02A/02B/03）：  
   ```javascript
   const newPath = path.join(os.homedir(), 'Downloads', 'tiktok-n8n-workflow-pack', '版本测试', 'config', 'local-config.json');
   ```
2. **serve-review-assets.mjs**：通过 `__dirname` 或相对路径解析 `.n8n-local-cache`、`prompts/`、`config/`
3. **reset-test-state.mjs**：  
   ```javascript
   const ROOT = path.join(os.homedir(), 'Downloads', 'tiktok-n8n-workflow-pack');
   ```
4. **local-config.json** 中的输出目录：默认为 `~/Downloads/n8n分镜图裁剪`

**结论**：Code 节点里的路径目前通过 `os.homedir() + 'Downloads/tiktok-n8n-workflow-pack'` 拼接，这意味着只要项目放在用户的 `Downloads` 目录、名字不变，就能工作。封装时需要引入环境变量 `APP_HOME` 并在客户端启动时注入，或将路径改为读取 `N8N_USER_FOLDER`（n8n 已支持此变量）。

---

## 2. 客户端封装目标

### 2.1 用户体验目标

| 目标 | 说明 |
|---|---|
| **双击启动** | 打开 .app（Mac）或 .exe（Windows）即启动全套服务 |
| **自动启动 n8n** | 后台拉起 n8n 进程，用户不感知 |
| **自动启动 8788 UI** | 后台拉起工作台服务 |
| **自动打开工作台** | 启动完成后在浏览器或 WebView 中打开 `http://127.0.0.1:8788` |
| **API Key 在 UI 填写** | 现有配置页已支持，保持不变 |
| **保存目录可配置** | 现有配置页已支持，保持不变 |
| **错误日志可导出** | 新增：启动器收集 stdout/stderr，写入用户可找到的目录 |
| **零命令行要求** | 用户全程不需要打开终端 |

### 2.2 不在本期目标内

- 内嵌 n8n 编辑器（n8n 本身的 UI）
- 视频剪辑功能
- 云端部署支持
- 多用户/团队功能

---

## 3. Mac / Windows 差异分析

### 3.1 依赖安装差异

| 依赖 | Mac | Windows |
|---|---|---|
| Node.js | 通过 Homebrew 或官方 pkg 安装 | 官方 .msi 安装包 |
| npm | 随 Node.js | 随 Node.js |
| n8n | `npm install -g n8n` | 同左，但 Windows 路径映射不同 |
| ffmpeg | Homebrew / 官方二进制 | 官方 .zip 解压，需加 PATH |
| sharp | n8n 依赖，自动安装（可能需重新编译） | 同左，可能需 node-gyp + Visual C++ |

**关键问题**：ffmpeg 和 sharp 在 Windows 需要额外处理——ffmpeg 需手动下载二进制，sharp 可能因 node-gyp 编译失败。**建议打包时附带平台预编译二进制**，客户端启动前解压到临时目录并设 PATH。

### 3.2 路径差异

| 场景 | Mac | Windows |
|---|---|---|
| 用户 home 目录 | `/Users/username` | `C:\Users\username` |
| 项目目录 | `~/Downloads/tiktok-n8n-workflow-pack` | `%USERPROFILE%\Downloads\tiktok-n8n-workflow-pack` |
| n8n 二进制 | `~/.npm-global/bin/n8n` | `%APPDATA%\npm\n8n.cmd` |
| 路径分隔符 | `/` | `\`（Node.js path 模块已处理） |

**建议**：所有路径通过 `path.join(os.homedir(), ...)` 或环境变量构造，严禁字符串拼接硬编码分隔符。

### 3.3 端口占用检查

启动前需检查 5678 和 8788 是否被占用：

```javascript
// 检查端口的通用方法（无外部依赖）
import net from 'net';
function checkPort(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(port, '127.0.0.1', () => { srv.close(); resolve(true); });
    srv.on('error', () => resolve(false));
  });
}
```

若端口被占用，提示用户关闭冲突程序，或尝试 5679 / 8789 备用端口并写入 config。

### 3.4 权限问题

| 场景 | Mac | Windows |
|---|---|---|
| 监听 >1024 端口 | 无需 root | 无需管理员 |
| 写入用户目录 | 正常 | 正常（`%USERPROFILE%`） |
| 写入 `/usr/local/bin` | 需 sudo | 需管理员 |
| 防火墙弹窗 | 首次运行可能弹窗 | 首次运行一定弹窗 |

**建议**：始终将文件写到用户目录（`~/Library/Application Support/TikTokAI/` on Mac，`%APPDATA%\TikTokAI\` on Windows），从不要求管理员权限。

### 3.5 启动脚本差异

| 场景 | Mac | Windows |
|---|---|---|
| Shell | zsh/bash | cmd / PowerShell |
| 后台进程 | `child_process.spawn` | 同左，但需 `detached: true` + `shell: true` |
| 进程树清理 | `kill(-pgid)` | `taskkill /T /F /PID` |
| 开机启动 | LaunchAgent plist | 注册表 / 任务计划 |

---

## 4. 封装路线比较

### 4.1 方案 A：纯本地启动器 + 浏览器打开

**工作方式**：一个 Node.js 脚本（或用 `pkg` 打包成单可执行文件）负责启动 n8n 和 8788 UI，然后调用系统命令打开默认浏览器。

| 维度 | 评分 | 说明 |
|---|---|---|
| **开发速度** | ⭐⭐⭐⭐⭐ | 就是 Node.js，1-2 天 MVP |
| **用户体验** | ⭐⭐⭐ | 浏览器体验良好，但启动时有短暂命令行窗口（Windows 尤其明显） |
| **本地文件夹选择** | ⭐⭐ | 只能靠 UI 文本输入，无原生 picker |
| **隐藏内部文件** | ⭐⭐ | `pkg` 打包可隐藏 JS 源码，但 workflow JSON 和 .n8n 数据库仍在用户目录可见 |
| **Mac 打包难度** | ⭐⭐⭐⭐ | `pkg` → 单文件，再用 Automator 包成 .app |
| **Windows 打包难度** | ⭐⭐⭐ | `pkg` → .exe，用 NSIS/Inno Setup 打安装包 |
| **授权扩展性** | ⭐⭐⭐ | 可在启动器层加授权检查，但容易被绕过 |

**适合**：Phase 2.1 Mac MVP，快速验证市场反应。

### 4.2 方案 B：Electron

**工作方式**：Electron app 嵌入 Node.js runtime，main process 管理 n8n 和 8788 子进程，renderer 内嵌 WebView 展示 8788 UI。

| 维度 | 评分 | 说明 |
|---|---|---|
| **开发速度** | ⭐⭐⭐ | 需要搭 Electron 脚手架，约 1-2 周 |
| **用户体验** | ⭐⭐⭐⭐⭐ | 原生窗口，无浏览器切换，系统托盘，完整控制 |
| **本地文件夹选择** | ⭐⭐⭐⭐⭐ | `dialog.showOpenDialog` 原生 picker |
| **隐藏内部文件** | ⭐⭐⭐⭐ | `asar` 打包可隐藏 JS/JSON，但 n8n 数据库在用户目录 |
| **Mac 打包难度** | ⭐⭐⭐⭐ | `electron-builder` 标准流程，支持代码签名 |
| **Windows 打包难度** | ⭐⭐⭐⭐ | 同上，需 Windows Code Sign 证书 |
| **授权扩展性** | ⭐⭐⭐⭐ | 可在 main process 做机器码/激活码验证，更难绕过 |

**缺点**：安装包体积约 150-200MB（Chromium 本体），内存开销比纯启动器大 200-400MB。

**适合**：Phase 2.3+ 商业版本，正式 ToB/ToC 分发。

### 4.3 方案 C：Tauri

**工作方式**：Rust 写 native shell，系统 WebView（macOS 用 WKWebView，Windows 用 WebView2）展示 8788 UI，bundle 体积约 10-15MB。

| 维度 | 评分 | 说明 |
|---|---|---|
| **开发速度** | ⭐⭐ | 团队需要 Rust，学习成本高，约 3-4 周 |
| **用户体验** | ⭐⭐⭐⭐⭐ | 体积最小，启动最快，原生 UI |
| **本地文件夹选择** | ⭐⭐⭐⭐⭐ | Tauri 内置文件对话框 |
| **隐藏内部文件** | ⭐⭐⭐⭐ | 与 Electron 相似 |
| **Mac 打包难度** | ⭐⭐⭐ | 需 Rust 工具链，但 `tauri build` 自动化 |
| **Windows 打包难度** | ⭐⭐⭐ | 依赖 WebView2 Runtime（Win11 内置，Win10 需安装） |
| **授权扩展性** | ⭐⭐⭐⭐ | Rust 层更难逆向 |

**适合**：有 Rust 资源时，作为终态客户端选择。当前阶段不推荐。

---

## 5. 推荐方案

### 结论

**两阶段推进：Phase 2.1 用纯启动器，Phase 2.3 升级 Electron。**

工程判断依据：

1. **最快验证**：纯启动器（方案 A）1-2 天就能有一个 Mac 用户可运行的包，不引入新框架，不破坏现有代码结构。

2. **Electron 是终态**：一旦有付费用户，需要原生文件夹 picker、系统托盘、开机启动、防截图 workflow、机器码授权，这些 Electron 全部原生支持。方案 A 天花板太低。

3. **Tauri 暂不推荐**：需要 Rust，且 Windows 上 WebView2 的兼容性比 Electron 差，在面向普通用户的 Windows 场景下风险较高。

### 分阶段推进路线

```
Phase 2.1（纯启动器 MVP）
  └─ Node.js launcher.mjs
  └─ pkg 打包 Mac 单文件
  └─ Automator .app 包装

Phase 2.2（Windows 适配）
  └─ Windows 路径 / 进程 / ffmpeg 二进制适配
  └─ NSIS 安装包

Phase 2.3（Electron 升级）
  └─ 替换 launcher → Electron main process
  └─ 8788 UI 嵌入 WebView
  └─ 原生文件 picker、系统托盘、开机启动
  └─ 机器码授权层

Phase 2.4（商业化）
  └─ 激活服务、更新、反馈包
```

---

## 6. 最小可行封装 MVP（Phase 2.1）

### 6.1 启动器能力清单

```
launcher.mjs
├── 1. 环境检查
│   ├── Node.js >= 20（当前运行在 v24，需向下兼容）
│   ├── n8n 是否可执行（检查 PATH + ~/.npm-global/bin）
│   ├── ffmpeg 是否可用
│   └── 端口 5678 / 8788 是否空闲
│
├── 2. 路径解析
│   ├── APP_HOME 环境变量（未来 Electron 注入）
│   └── 回退到 dirname(process.execPath) 或 __dirname
│
├── 3. 启动 n8n
│   ├── 设 N8N_USER_FOLDER=<APP_HOME>/.n8n-local-cache
│   ├── spawn('n8n', ['start'], { env, stdio: 'pipe' })
│   └── 健康检查：轮询 http://127.0.0.1:5678/healthz 直到 200
│
├── 4. 启动 8788 UI
│   ├── spawn('node', ['版本测试/serve-review-assets.mjs'], { cwd: APP_HOME })
│   └── 健康检查：轮询 http://127.0.0.1:8788/ 直到 200
│
├── 5. 打开工作台
│   └── open('http://127.0.0.1:8788')（用 open 包或 start/xdg-open）
│
├── 6. 进程守护
│   ├── 监听 n8n 进程退出 → 记录日志 → 尝试重启
│   └── SIGINT/SIGTERM → 清理子进程 → 退出
│
└── 7. 日志
    ├── n8n stdout/stderr → <APP_HOME>/logs/n8n.log
    └── UI stdout/stderr → <APP_HOME>/logs/ui.log
```

### 6.2 MVP 文件结构草案

```
client/
├── launcher.mjs           ← 主入口，上述逻辑
├── health-check.mjs       ← 健康检查工具函数
├── process-manager.mjs    ← 子进程管理
├── logger.mjs             ← 日志写入
└── package.json           ← { "type": "module", "bin": "launcher.mjs" }
```

### 6.3 健康检查实现草案

```javascript
// health-check.mjs
async function waitForService(url, maxWaitMs = 30000, intervalMs = 500) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Service at ${url} did not start within ${maxWaitMs}ms`);
}
```

### 6.4 Mac .app 包装方案（无 Electron）

```
TikTokAI.app/
└── Contents/
    ├── Info.plist             ← LSUIElement=true（不显示 Dock 图标）
    ├── MacOS/
    │   └── TikTokAI           ← shell script: #!/bin/bash\nexec node launcher.mjs
    └── Resources/
        └── AppIcon.icns
```

用 Automator 或 `platypus` 工具生成 .app 包装，内部调用 `node launcher.mjs`。

**更好的方案**：用 `pkg` 将 `launcher.mjs` 和依赖打包成单个二进制，再包装到 .app 中，用户无需安装 Node.js。

```bash
# 打包命令
npx pkg client/launcher.mjs --target node20-macos-arm64 --output dist/TikTokAI-mac-arm64
npx pkg client/launcher.mjs --target node20-macos-x64   --output dist/TikTokAI-mac-x64
```

**注意**：`pkg` 当前支持到 Node.js 20，项目运行在 v24。需要将 launcher 的目标 Node 固定为 20，或等 `pkg` 支持 v24，或改用 `@yao-pkg/pkg`（活跃维护的 fork，支持 v22+）。

---

## 7. 未来商业化保护（方案设计，不实现）

### 7.1 授权码 / 机器码

**方案**：客户端启动时，收集机器特征（Mac Serial + 用户名哈希，Windows MachineGUID），向激活服务器请求 token，token 有效期 24h，本地缓存签名。

- 激活服务器：极简 Node.js + SQLite，部署在 Railway/Fly.io，成本 <$5/月
- 离线保护：token 签名用非对称加密（私钥在服务器，公钥打包进客户端），离线 72h 内仍可用
- 实现位置：Launcher main process 最早期，检查失败则整体不启动

### 7.2 Workflow JSON 保护

**核心问题**：n8n 的工作流是 JSON，n8n 本身开源，用户可以在 n8n 编辑器里直接查看所有节点内容，包括 Code 节点里的 prompt 拼装逻辑。

**可行的保护措施**（从高到低）：

| 措施 | 效果 | 实现难度 |
|---|---|---|
| 关闭 n8n 编辑器 UI（`N8N_DISABLE_UI=true`） | 用户无法在浏览器打开 n8n 编辑器 | 简单，一个环境变量 |
| workflow JSON 不落盘，启动时动态注入 n8n DB | 发布包里没有明文 JSON | 中等，需了解 n8n DB API |
| Code 节点逻辑外移到加密的外部脚本 | 核心逻辑在 n8n 外部 | 较复杂，需重构 Code 节点 |
| prompt 内容托管在激活服务器，按需下载 | 离线无法使用，但最难被搬运 | 复杂，需网络依赖 |

**实际建议**：Phase 2.3 先做 `N8N_DISABLE_UI=true` + 不落盘 JSON，这对普通用户就足够了；进阶版再考虑 prompt 云端托管。

### 7.3 防止文件夹直接搬运

- 激活 token 绑定机器码，复制到另一台机器 token 失效
- `.n8n-local-cache/database.sqlite` 可以加密（需 n8n 支持或替换 SQLite 驱动）
- 核心不可搬运的是：服务端激活记录 + 机器码绑定

### 7.4 版本更新

- 客户端启动时检查更新 API（`GET /api/version?current=2.1.0`）
- 若有新版本，显示提示，引导用户下载新安装包
- Phase 2.4 实现增量更新（只更新 workflow JSON + UI 文件）

### 7.5 售后反馈包

- 用户点击"导出问题报告"
- 收集：logs/n8n.log 最后 500 行、config（脱敏，去掉 API Key）、n8n 版本、OS 版本
- 打包为 zip，用户上传到反馈邮箱或问题单

---

## 8. 风险清单

### 8.1 n8n 开源 / 工作流可见

- **风险**：n8n 是 fair-code 协议（非完全开源，但可免费使用），workflow 在 n8n 编辑器里完全可见，包括所有 Code 节点的 prompt 拼装逻辑。
- **影响**：技术用户可以直接复制 workflow，绕过客户端。
- **缓解**：见第 7.2 节；核心护城河应在产品体验和持续迭代，而非代码保密。

### 8.2 API Key 本地存储安全

- **风险**：`local-config.json` 明文存储 API Key，macOS 和 Windows 上任何有文件读取权限的进程都可以读取。
- **影响**：恶意软件可以窃取 Key。
- **缓解**：
  - Mac：将 API Key 存入 Keychain（`security add-generic-password`），通过 Electron 的 `safeStorage.encryptString` 实现。
  - Windows：使用 DPAPI（`safeStorage` in Electron 自动使用）。
  - Phase 2.3 Electron 版本应迁移到 `safeStorage`。

### 8.3 Windows 环境复杂度

- **风险**：Windows 用户的 Node.js 安装、npm 全局路径、ffmpeg 依赖、网络代理、杀毒软件误报等问题远多于 Mac。
- **影响**：客服成本高，安装成功率低。
- **缓解**：
  - 将 Node.js 和 ffmpeg 二进制打包进安装包（自包含，不依赖系统 PATH）
  - 用 NSIS 安装包，引导用户完成依赖检查
  - Windows Phase 2.2 充分测试：Win10 21H2、Win11 23H2 这两个版本

### 8.4 ffmpeg / sharp 二进制依赖

- **风险**：ffmpeg 是平台原生二进制，sharp 需要 libvips，两者在不同平台、不同架构（M1/M2/x64）下需要不同的二进制。
- **影响**：打包复杂，安装包需要多个平台版本。
- **缓解**：
  - ffmpeg：使用 `ffmpeg-static` npm 包（已包含预编译二进制），避免依赖系统 ffmpeg
  - sharp：通过 `sharp` 的 `--ignore-scripts` + prebuilt 二进制安装
  - 当前版本如果 ffmpeg 和 sharp 都通过 n8n 内部调用，审计 n8n 版本以确认内置支持

### 8.5 视频 API 不稳定

- **风险**：WF03 依赖外部视频生成 API（ModelHub/Veo），API 可能断线、超时、变更接口。
- **影响**：视频生成阶段完全失败，用户体验差。
- **缓解**：
  - 超时配置化（当前已在 WF03 节点设置）
  - 启动器展示"视频生成依赖外部 API，失败属正常，请重试"明确提示
  - Phase 2.4 考虑多 API 兜底配置

### 8.6 Node.js 版本 v24 兼容性

- **风险**：项目目前运行在 Node.js v24.14.0（最新 LTS 为 v22），而 `pkg` 等打包工具最新支持到 v22。
- **影响**：打包时需降级到 v22，或使用 `@yao-pkg/pkg`。
- **缓解**：launcher 本身对 Node.js 版本要求不高，降到 v22 目标即可；`serve-review-assets.mjs` 需测试在 v22 上的兼容性。

---

## 9. 建议执行顺序

### Phase 2.0：启动器审计（本轮，已完成）

- [x] 审计当前组件清单
- [x] 识别路径硬编码位置
- [x] 评估封装方案选型
- [x] 输出本文档

### Phase 2.1：Mac 单机启动器 MVP ✅ 已完成（2026-05-15）

**目标**：交付一个可运行的 Mac 启动器脚本，双击或一条命令启动所有服务并打开工作台。

**已完成**：
- [x] `client/launcher.mjs`：环境检查 → 端口检查（TCP connect，支持 `0.0.0.0` 绑定）→ 启动 n8n → 启动 8788 → 健康检查 → 打开浏览器 → Ctrl+C 优雅停止
- [x] `client/mac/TikTok AI 视频工作台.command`：双击启动包装脚本
- [x] 冷启动测试通过（3 秒内 n8n + UI 双服务就绪）
- [x] `--help` / `-h` 参数支持
- [x] 日志写入 `logs/launcher/`

**开发机环境说明（launchd 托管）**：

这台开发机上 n8n 和 8788 UI 由 macOS launchd 托管（`~/Library/LaunchAgents/com.drew.n8n.plist` 等）。普通 `kill` 会被 launchd 立即重启；冷启动测试需先 `launchctl unload` 停掉托管服务。正式客户端部署到用户机器时不存在此问题，由 launcher 自己管理服务生命周期。

**不在 Phase 2.1 内**：
- Windows 适配（Phase 2.2）
- 授权码（Phase 2.3）
- Electron 迁移（Phase 2.3）
- `@yao-pkg/pkg` 打包为单文件二进制（Phase 2.3）

### Phase 2.2：Windows 启动器适配（预计 3-5 天）

1. 适配 Windows 进程管理（`taskkill`，`shell: true`，路径分隔符）
2. 解决 ffmpeg Windows 二进制问题（引入 `ffmpeg-static`）
3. 用 NSIS 或 Inno Setup 打 Windows 安装包
4. 测试：Win10 / Win11 干净环境

### Phase 2.3：授权与防搬运（预计 1 周）

1. 迁移到 Electron（替换纯启动器的 .app 包装）
2. 嵌入 8788 UI 到 Electron WebView
3. 实现机器码生成 + 激活服务器（极简版）
4. `N8N_DISABLE_UI=true` 关闭 n8n 编辑器
5. API Key 迁移到 `safeStorage`
6. workflow JSON 不落盘动态注入

### Phase 2.4：安装包与更新（预计 1 周）

1. `electron-builder` 完整打包（dmg for Mac，exe/msi for Windows）
2. 代码签名（Mac 需 Apple Developer 证书，Windows 需 EV 证书）
3. 更新检查机制（GitHub Releases 或自托管）
4. 反馈包导出功能

---

## 附录：关键工具参考

| 工具 | 用途 | 链接 |
|---|---|---|
| `@yao-pkg/pkg` | Node.js 打包为单可执行文件 | npm |
| `platypus` | Mac .app 包装器（无需 Xcode） | https://sveinbjorn.org/platypus |
| `electron-builder` | Electron 打包（dmg/exe/deb） | electron.build |
| `ffmpeg-static` | 预编译 ffmpeg 二进制 npm 包 | npm |
| `NSIS` | Windows 安装包制作 | nsis.sourceforge.io |
| `node-keytar` | 系统 Keychain 访问（在 Electron safeStorage 前） | npm |

---

*本文档由 Claude 基于代码审计生成，审计时间 2026-05-15。*  
*Phase 2.1 已完成（2026-05-15）。下一步：Phase 2.2 — Windows 启动器适配。*
