# Phase 2.1 Mac MVP — 本地启动器

> **这是 Phase 2.1 Mac 开发验证版，不是最终客户端产品。** 后续计划见 `docs/CLIENT_PACKAGING_PLAN.md`。

## 运行方法

```bash
npm run start:client              # 启动所有服务并打开工作台
node client/launcher.mjs --help   # 显示帮助并退出（不启动任何服务）
```

从项目根目录（`tiktok-n8n-workflow-pack/`）执行即可。

---

## 它会做什么

1. **检查 Node.js 版本**（需要 v18+）
2. **找到 n8n 可执行文件**（先找项目内 `node_modules/.bin/n8n`，再找 PATH 和 `~/.npm-global/bin/n8n`）
3. **检查端口 5678 / 8788**
   - 服务已健康运行 → 直接复用，不重复启动
   - 端口被占但健康检查失败 → 报错退出，提示如何清理
4. **启动 n8n**，配置如下：
   - `N8N_USER_FOLDER` 指向项目内的 `.n8n-local-cache/`（隔离数据）
   - `N8N_DISABLE_UI=true`（隐藏 n8n 编辑器 UI，防止普通用户误进）
   - stdout/stderr → `logs/launcher/n8n.log`
5. **启动工作台 UI**（`版本测试/serve-review-assets.mjs`，端口 8788）
   - stdout/stderr → `logs/launcher/ui-8788.log`
6. **健康检查轮询**，等两个服务就绪后继续
7. **自动打开浏览器**到 `http://127.0.0.1:8788/`
8. **Ctrl+C** 时优雅停止由本启动器启动的子进程（SIGTERM → 3s → SIGKILL）

---

## 常见问题

### 端口被占用

```
❌ 端口 5678 被占用，但 n8n 健康检查失败
```

有其他进程（非 n8n）占用了该端口，找到并停止：

```bash
lsof -ti:5678 | xargs kill -9
lsof -ti:8788 | xargs kill -9
```

### 找不到 n8n

```
❌ 找不到 n8n 可执行文件
```

如果是测试包，先双击：

```bash
client/mac/安装运行依赖.command
```

如果你懂命令行，也可以安装依赖：

```bash
npm install
```

确认安装后可以找到：

```bash
which n8n
ls ~/.npm-global/bin/n8n
```

### 服务启动超时

n8n 超时（45s）或 UI 超时（20s）时会报错退出，查看日志排查：

```bash
tail -50 logs/launcher/n8n.log
tail -50 logs/launcher/ui-8788.log
```

### 日志在哪里

| 文件 | 内容 |
|------|------|
| `logs/launcher/n8n.log` | n8n 启动输出 |
| `logs/launcher/ui-8788.log` | 工作台 UI 输出 |

每次启动会在日志文件末尾追加（`append` 模式），不会覆盖历史。

---

## 关于 N8N_DISABLE_UI

启动器设置 `N8N_DISABLE_UI=true`，屏蔽 n8n 自带的工作流编辑器页面（避免普通用户误操作工作流）。

**n8n 的 Webhook 和 REST API 仍然完全正常**，工作台所有功能不受影响。

如需临时访问 n8n 编辑器（开发调试），手动启动：

```bash
N8N_USER_FOLDER="$(pwd)/.n8n-local-cache" n8n start
```

---

## 开发环境说明（本机 launchd 托管）

这台开发机上的 n8n 和 8788 UI 由 **macOS launchd** 托管（`~/Library/LaunchAgents/com.drew.n8n.plist` 等）。

**重要区别**：

| 场景 | 行为 |
|------|------|
| 普通 `kill <PID>` | launchd 会立即重启服务 |
| `launchctl unload xxx.plist` | 真正停止，不会重启 |
| `node client/launcher.mjs` 启动的子进程 | 由 launcher 管理，Ctrl+C 可优雅停止 |

**冷启动测试步骤**（开发用）：

```bash
# 1. 停掉 launchd 托管的服务
launchctl unload ~/Library/LaunchAgents/com.drew.n8n.plist
launchctl unload ~/Library/LaunchAgents/com.drew.n8n-review-assets-8788.plist

# 2. 运行启动器（冷启动）
node client/launcher.mjs

# 3. 测试完后，Ctrl+C 停止 launcher 子进程
# 4. 恢复 launchd 托管
launchctl load ~/Library/LaunchAgents/com.drew.n8n.plist
launchctl load ~/Library/LaunchAgents/com.drew.n8n-review-assets-8788.plist
```

**正式客户端目标**：由启动器自己管理服务生命周期，不依赖开发机 launchd，用户机器上不存在此问题。

---

## 当前限制（Phase 2.1）

- 仅在 macOS 测试验证
- 不支持 Windows（路径、进程管理等差异较大，见 Phase 2.2）
- 没有自动更新机制
- 没有授权/机器码保护（见 Phase 2.3）
- 不是 Electron 应用，无法打包为 `.app`（见 Phase 2.3）
- `open` 命令为 macOS 专用，Linux 需改为 `xdg-open`
