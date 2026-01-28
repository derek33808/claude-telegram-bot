# 自动生命周期管理 (Auto Lifecycle)

## 需求概述

当前 bot 需要手动 `bun run start` 启动，用户希望：
1. **自动启动**：当 tmux 中启动 Claude CLI 时，bot 自动启动
2. **自动退出**：当手机端/电脑端都没有连接一段时间后，bot 自动退出

## 现有架构分析

### 当前启动方式
- `bun run start` 手动启动
- 支持 launchd 常驻服务（`com.claude-telegram-ts.plist`）
- 入口：`src/index.ts` 直接创建 Bot 实例并开始 long-polling

### 当前退出方式
- 手动 Ctrl+C (SIGINT/SIGTERM)
- tmux 会话有 `TMUX_IDLE_TIMEOUT`（10分钟），但只清理 tmux session，不退出 bot 进程

### 关键约束
- Bot 使用 grammY 的 `run()` runner 做 long-polling
- 有 tmux bridge 模式（`TMUX_BRIDGE_ENABLED`）和 SDK 直连模式
- 支持多设备通过 SQLite 同步状态

---

## 方案设计

### 一、自动启动：tmux session-created hook

**选定方案：tmux hook + 启动脚本**

原理：tmux 支持 `session-created` hook，当任何新 session 被创建时触发。我们检测 session 中是否运行了 Claude CLI，如果是则启动 bot。

#### 实现方式

1. **创建启动脚本** `scripts/auto-start.sh`：

```bash
#!/bin/bash
# 由 tmux hook 触发，检测是否需要启动 bot

SESSION_NAME="$1"
BOT_PID_FILE="/tmp/claude-telegram-bot.pid"
BOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 检查 bot 是否已在运行
if [ -f "$BOT_PID_FILE" ] && kill -0 "$(cat "$BOT_PID_FILE")" 2>/dev/null; then
    exit 0  # 已运行，不重复启动
fi

# 等待 session 初始化
sleep 2

# 检测该 session 是否在运行 claude
PANE_CMD=$(tmux display-message -t "$SESSION_NAME" -p '#{pane_current_command}' 2>/dev/null)
PANE_TITLE=$(tmux capture-pane -t "$SESSION_NAME" -p 2>/dev/null | head -5)

if echo "$PANE_CMD $PANE_TITLE" | grep -qi "claude"; then
    # 启动 bot
    cd "$BOT_DIR"
    nohup bun run start > /tmp/claude-telegram-bot-ts.log 2>&1 &
    echo $! > "$BOT_PID_FILE"
    echo "[$(date)] Auto-started bot (PID: $!) triggered by session: $SESSION_NAME"
fi
```

2. **注册 tmux hook**（在 `~/.tmux.conf` 中添加）：

```
set-hook -g session-created 'run-shell "~/.config/claude-telegram-bot/auto-start.sh #{session_name}"'
```

3. **一次性安装命令**（bot 提供 `scripts/install-hooks.sh`）：

```bash
#!/bin/bash
# 安装 tmux hooks
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_DIR="$HOME/.config/claude-telegram-bot"

mkdir -p "$CONFIG_DIR"
cp "$SCRIPT_DIR/auto-start.sh" "$CONFIG_DIR/"
chmod +x "$CONFIG_DIR/auto-start.sh"

# 写入 tmux.conf
if ! grep -q "claude-telegram-bot" ~/.tmux.conf 2>/dev/null; then
    echo "" >> ~/.tmux.conf
    echo "# Claude Telegram Bot auto-start" >> ~/.tmux.conf
    echo "set-hook -g session-created 'run-shell \"$CONFIG_DIR/auto-start.sh #{session_name}\"'" >> ~/.tmux.conf
    echo "Hook installed in ~/.tmux.conf"
fi
```

#### 为什么不选其他方案

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| tmux hook | 精准触发，原生支持 | 需要修改 tmux.conf | **选用** |
| shell wrapper (`claude-start`) | 简单 | 用户可能忘记用 wrapper | 不选 |
| launchd watch 文件 | 系统级 | 检测延迟大，复杂 | 不选 |
| fswatch 监控 tmux socket | 无需改配置 | 不可靠，高资源占用 | 不选 |

---

### 二、自动退出：空闲检测 + 连接追踪

**选定方案：Bot 内部空闲定时器**

核心逻辑：bot 启动后开始计时，每次收到 Telegram 消息或 tmux 活动时重置计时器。超过阈值且无活跃 tmux Claude session 时，bot 自行退出。

#### 2.1 空闲检测器模块

新建 `src/lifecycle.ts`：

```
LifecycleManager {
  - idleTimer: NodeJS.Timeout
  - IDLE_TIMEOUT: number (环境变量 BOT_IDLE_TIMEOUT，默认 30 分钟)
  - lastTelegramActivity: Date
  - lastTmuxActivity: Date

  方法：
  - resetIdleTimer()     // Telegram 消息或 tmux 活动时调用
  - checkIdleConditions() // 定时检查是否应退出
  - gracefulShutdown()   // 优雅退出
}
```

#### 2.2 退出条件（全部满足才退出）

1. **Telegram 空闲**：最后一次 Telegram 消息 > `BOT_IDLE_TIMEOUT`（默认 30 分钟）
2. **无活跃 Claude tmux session**：没有 bot 创建的或 bot 接管的 tmux session
3. **无正在处理的请求**：`session.isRunning === false`

#### 2.3 检查频率

- 每 5 分钟检查一次空闲条件
- 检查时扫描 tmux session 列表，确认是否还有活跃 Claude session

#### 2.4 退出流程

```
检测到空闲
  -> 向 Telegram 发送通知："Bot 因空闲自动关闭，下次 Claude CLI 启动时会自动恢复"
  -> 清理 tmux session metadata
  -> runner.stop()
  -> 删除 PID 文件
  -> process.exit(0)
```

#### 2.5 集成点

在 `src/index.ts` 中：

```
// 启动后创建 LifecycleManager
const lifecycle = new LifecycleManager(runner);

// 每个 handler 中调用
lifecycle.resetIdleTimer();  // 收到任何 Telegram 消息时

// 注册退出钩子
process.on('SIGTERM', () => lifecycle.gracefulShutdown());
```

在每个 handler（text、voice、photo、document、command）的入口处调用 `lifecycle.resetIdleTimer()`。

可通过 grammY middleware 统一处理：

```
bot.use((ctx, next) => {
  lifecycle.resetIdleTimer();
  return next();
});
```

---

### 三、配置项

新增环境变量：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `BOT_AUTO_LIFECYCLE` | `false` | 是否启用自动生命周期管理 |
| `BOT_IDLE_TIMEOUT` | `1800000` (30分钟) | 空闲多久后自动退出（毫秒） |
| `BOT_IDLE_CHECK_INTERVAL` | `300000` (5分钟) | 空闲检查间隔（毫秒） |
| `BOT_SHUTDOWN_NOTIFY_CHAT` | (空) | 关闭时通知的 Telegram chat ID |

---

### 四、PID 文件管理

- 路径：`/tmp/claude-telegram-bot.pid`
- bot 启动时写入 PID
- bot 退出时删除
- auto-start.sh 通过检查 PID 文件避免重复启动

---

### 五、完整生命周期流程

```
用户在 tmux 中启动 claude
  -> tmux session-created hook 触发
  -> auto-start.sh 检测到 claude 进程
  -> 启动 bot（写入 PID 文件）
  -> bot 正常服务

用户通过 Telegram 发送消息
  -> 重置空闲计时器
  -> 正常处理

无活动 30 分钟
  -> 空闲检查：Telegram 无消息 + 无活跃 tmux session
  -> 发送关闭通知
  -> bot 退出（删除 PID 文件）

用户再次在 tmux 中启动 claude
  -> hook 再次触发 -> bot 再次自动启动
```

---

### 六、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `src/lifecycle.ts` | 新建 | 生命周期管理器 |
| `src/index.ts` | 修改 | 集成 LifecycleManager，写入 PID 文件 |
| `src/config.ts` | 修改 | 添加新环境变量 |
| `scripts/auto-start.sh` | 新建 | tmux hook 触发的启动脚本 |
| `scripts/install-hooks.sh` | 新建 | 一键安装 tmux hook |
| `.env.example` | 修改 | 添加新配置项文档 |

---

### 七、边界情况处理

1. **bot 崩溃后 PID 文件残留**：auto-start.sh 使用 `kill -0` 检查进程是否存活，不依赖纯文件存在
2. **tmux 不可用**：空闲检测 fallback 到仅检查 Telegram 活动
3. **多个 claude session 同时运行**：只要有一个活跃就不退出
4. **用户手动 bun run start**：正常工作，不写 PID 文件（或通过环境变量区分）
5. **网络断开重连**：grammY runner 有自动重试，不触发空闲退出（因为 runner 仍在运行）

---

### 八、测试计划

1. 手动 tmux 中运行 `claude`，验证 bot 自动启动
2. 30 分钟无操作，验证 bot 自动退出
3. 退出前有活跃 tmux session，验证 bot 不退出
4. bot 崩溃后再次触发 hook，验证能正常重启
5. 手动 `bun run start` 时，tmux hook 不重复启动
