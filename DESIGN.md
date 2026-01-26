# Claude Telegram Bot (Fork)

## 项目概述

这是 [linuz90/claude-telegram-bot](https://github.com/linuz90/claude-telegram-bot) 的 fork 版本，用于通过 Telegram 远程控制 Claude Code。

**Fork 目的**：
- 保持与上游的同步能力
- 添加个人定制化功能
- 本地化和优化

## 原项目功能

| 功能 | 说明 |
|------|------|
| 文字对话 | 直接在 Telegram 与 Claude 对话 |
| 语音消息 | 通过 OpenAI Whisper 转文字 |
| 图片分析 | 发送截图/照片让 Claude 分析 |
| 文档处理 | 支持 PDF、文本文件、压缩包 |
| 会话恢复 | 可以恢复之前的对话 |
| 消息队列 | Claude 工作时可继续发消息 |
| MCP 工具 | 支持自定义 MCP 服务器 |

## 技术架构

```
Telegram Bot
     │
     ▼
┌─────────────────────────────────────┐
│  Bun + grammY (Telegram Bot框架)    │
│  ~3,300 行 TypeScript               │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Claude Agent SDK V2                │
│  - 流式响应                         │
│  - 会话持久化                       │
│  - 安全检查                         │
└──────────────┬──────────────────────┘
               │
               ▼
┌─────────────────────────────────────┐
│  Claude Code (本地运行)             │
│  - CLI 认证 (推荐)                  │
│  - 或 API Key                       │
└─────────────────────────────────────┘
```

## 核心模块

| 模块 | 路径 | 职责 |
|------|------|------|
| 入口 | `src/index.ts` | 注册处理器，启动轮询 |
| 配置 | `src/config.ts` | 环境变量，MCP 加载 |
| 会话 | `src/session.ts` | Claude 会话管理，流式响应 |
| 安全 | `src/security.ts` | 速率限制，路径验证 |
| 格式化 | `src/formatting.ts` | Markdown→HTML 转换 |
| 工具 | `src/utils.ts` | 日志，语音转写 |

## 安全机制

1. **用户白名单** - 只有指定的 Telegram ID 可使用
2. **意图分类** - AI 过滤危险请求
3. **路径验证** - 文件访问受限于 `ALLOWED_PATHS`
4. **命令安全** - 阻止 `rm -rf /` 等危险命令
5. **速率限制** - 防止滥用
6. **审计日志** - 所有交互记录到日志

## 环境要求

- **Bun 1.0+** - 运行时环境
- **Claude Code** - 已登录认证
- **Telegram Bot Token** - 从 @BotFather 获取
- **OpenAI API Key** - (可选) 语音转写

## 配置说明

### 必需配置

```bash
# .env
TELEGRAM_BOT_TOKEN=xxx      # Telegram Bot Token
TELEGRAM_ALLOWED_USERS=xxx  # 你的 Telegram 用户 ID
```

### 推荐配置

```bash
CLAUDE_WORKING_DIR=/path/to/folder  # Claude 工作目录
OPENAI_API_KEY=sk-xxx               # 语音转写
```

## 运行方式

### 手动运行

```bash
bun install
bun run start
```

### macOS 服务 (LaunchAgent)

```bash
cp launchagent/com.claude-telegram-ts.plist.template ~/Library/LaunchAgents/com.claude-telegram-ts.plist
# 编辑 plist 配置
launchctl load ~/Library/LaunchAgents/com.claude-telegram-ts.plist
```

## 计划定制 (TODO)

- [ ] 中文本地化
- [ ] 自定义命令扩展
- [ ] 与 claude-monitor 集成
- [ ] 微信通道适配 (长期)

## 同步上游

```bash
git fetch upstream
git merge upstream/main
```

## 相关项目

- **claude-monitor** - Web 监控工具 (已暂停)
  - 定位：被动监控 + 远程确认
  - 互补：claude-telegram-bot 用于主动发任务

---

# Tmux Bridge 功能设计

## 功能目标

让 Telegram Bot 通过 tmux 与 Claude Code CLI 交互，实现：
1. **新建模式**：启动持久的 Claude Code 进程（保持内存和 KV cache）
2. **接管模式**：真正共享 CLI 终端的实时交互

## 架构设计

```
┌─────────────────────────────────────┐
│     Claude Code (tmux 中持久运行)    │
│     - 内存状态保持                   │
│     - KV cache 连续命中              │
└──────────┬─────────────┬────────────┘
           │             │
    tmux send-keys   tmux capture-pane
           │             │
      ┌────▼─────────────▼────┐
      │     TmuxBridge        │
      │  - 发送消息            │
      │  - 捕获输出            │
      │  - 解析事件            │
      └───────────┬───────────┘
                  │
           statusCallback
                  │
      ┌───────────▼───────────┐
      │   Telegram Handler    │
      └───────────────────────┘
```

## 设计决策

### 1. 触发方式

通过环境变量配置，启用后所有消息自动使用 tmux 模式：

```bash
TMUX_BRIDGE_ENABLED=true
```

### 2. tmux session 运行方式

- 后台运行（detached），不弹出 Terminal.app 窗口
- 用户可随时 `tmux attach -t <session>` 连接查看
- Claude Code CLI 在 tmux session 中持久运行

### 3. 并发控制 - 加锁机制

- Telegram 发消息时获取锁，响应完成后释放
- CLI 用户可以看到所有交互，但需等待锁释放后才能输入
- 防止混合输入导致的问题

### 4. 会话生命周期

| 创建方式 | 退出条件 | 行为 |
|---------|---------|------|
| Telegram 创建 | /new、/stop、切换 session | 标记可退出，10分钟后 tmux 自动关闭 |
| 接管 CLI | Telegram 退出或切换 | 只释放接管权，CLI 继续运行 |

### 5. 命令变化（tmux 模式下）

| 命令 | 行为 |
|------|------|
| `/new` | 结束当前 session，下次消息创建新的 |
| `/stop` | 发送 Ctrl+C 中断响应，session 保持 |
| `/sessions` | 列出运行中的 tmux sessions，选择接管 |
| `/tmux` | 显示当前 tmux session 状态（调试用） |

**移除的命令**：
- `/resume` - 功能合并到 `/sessions`

## 技术实现

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/tmux/types.ts` | 类型定义 |
| `src/tmux/config.ts` | 配置常量 |
| `src/tmux/parser.ts` | 终端输出解析器 |
| `src/tmux/bridge.ts` | TmuxBridge 核心类 |
| `src/tmux/index.ts` | 模块导出 |

### 修改文件

| 文件 | 修改内容 |
|------|---------|
| `src/session.ts` | 添加 tmux 桥接分支 |
| `src/handlers/commands.ts` | 修改命令行为，移除 /resume |
| `src/config.ts` | 添加 tmux 环境变量 |
| `src/index.ts` | 移除 /resume 命令注册 |
| `.env.example` | 添加 tmux 配置示例 |

### 配置项

```bash
# Tmux Bridge
TMUX_BRIDGE_ENABLED=false      # 启用 tmux 桥接
TMUX_SESSION_PREFIX=claude-tg  # session 名称前缀
TMUX_POLL_INTERVAL=100         # 输出轮询间隔 (ms)
```

## 验收标准

### 基础功能测试

1. 设置 `TMUX_BRIDGE_ENABLED=true`
2. 发送消息，确认创建了 tmux 会话
3. `tmux attach` 确认能看到交互
4. Telegram 发送更多消息，确认两边都更新

### 接管测试

5. 在 tmux 中启动 `claude`
6. 使用 `/sessions` 接管该会话
7. 确认 Telegram 能继续交互
8. `/new` 后确认 CLI 继续运行

### 生命周期测试

9. Telegram 创建 session 后 `/new`
10. 等待 10 分钟，确认 tmux 自动关闭

## 依赖

- **tmux**：需要系统安装（macOS: `brew install tmux`）
- 无需新增 npm 包
