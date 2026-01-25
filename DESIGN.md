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
