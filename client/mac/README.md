# Mac 双击启动包 — Phase 2.1 MVP

> **这是 Phase 2.1 Mac 开发验证版，不是最终 .app 客户端产品。**

## 怎么双击运行

1. 第一次使用，先双击 `client/mac/安装运行依赖.command`
2. 安装完成后，双击 `client/mac/TikTok AI 视频工作台.command`
3. Terminal 窗口会显示启动进度，服务就绪后浏览器自动打开工作台

**第一次运行**可能需要先授权（见下方"macOS 权限问题"）。

---

## 如果 macOS 提示"无法打开，因为无法验证开发者"

macOS Gatekeeper 会阻止未签名的脚本。解决方法：

**方法一（推荐）：右键打开**
1. 右键（或 Control+点击）`TikTok AI 视频工作台.command`
2. 选择「打开」
3. 在弹出的提示框中点「打开」

**方法二：命令行授权**
```bash
chmod +x "client/mac/TikTok AI 视频工作台.command"
xattr -d com.apple.quarantine "client/mac/TikTok AI 视频工作台.command"
```

之后双击即可正常运行。

---

## 如果提示"Operation not permitted"或权限错误

```bash
chmod +x "client/mac/TikTok AI 视频工作台.command"
```

---

## 它会做什么

双击后，Terminal 窗口会依次：

1. 定位项目根目录
2. 检查 Node.js 是否可用
3. 调用 `node client/launcher.mjs`，由 launcher 完成：
   - 检查端口 5678 / 8788（已有服务则复用）
   - 启动 n8n（隔离 `N8N_USER_FOLDER`）
   - 启动工作台 UI
   - 健康检查通过后打开浏览器 → `http://127.0.0.1:8788/`
4. 如果启动失败，显示错误信息并等待回车，**不会自动关闭窗口**（方便排查）

---

## 停止服务

在 Terminal 窗口中按 `Ctrl+C`，launcher 会优雅停止由它启动的子进程。

---

## 当前限制（Phase 2.1）

- 这是一个 `.command` 脚本，不是 `.app`，不能放到 Dock 或 Applications 文件夹以外的地方拖拽安装
- 仅在 macOS 上测试，不支持 Windows
- 没有代码签名（Apple Developer 证书），首次运行需要手动授权
- 没有自动更新、授权保护或 Electron 封装
- 后续计划见 `docs/CLIENT_PACKAGING_PLAN.md`（Phase 2.3 升级为 Electron .app）
