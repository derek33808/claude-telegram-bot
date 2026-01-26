# Multi-Bot Parallel Execution System

> **Status**: Future Feature / Research Design
> **Created**: 2026-01-25
> **Priority**: Low (待需要时实现)

## Background

当前 Bot 是单实例设计，一次只能处理一个任务。当需要同时执行多个任务时（如：写代码 + 写测试 + 写文档），需要排队等待。

本文档记录多 Bot 并行执行的设计思路，供未来功能演进参考。

---

## Design Overview

### Architecture

```
                         ┌─────────────────────────┐
                         │    User (Telegram)      │
                         └───────────┬─────────────┘
                                     │
                                     ▼
                         ┌─────────────────────────┐
                         │   Master Bot (协调者)    │
                         │   - 接收用户命令         │
                         │   - 管理任务队列         │
                         │   - 分配任务到 Worker    │
                         └───────────┬─────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
              ▼                      ▼                      ▼
    ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
    │  Worker Bot #1   │    │  Worker Bot #2   │    │  Worker Bot #3   │
    │  独立 Telegram   │    │  独立 Telegram   │    │  独立 Telegram   │
    │  独立 Session    │    │  独立 Session    │    │  独立 Session    │
    └─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Key Features

1. **多 Telegram 对话** - 每个 Worker 是独立的 Telegram Bot，用户可在多个对话框中同时查看不同 Worker 的处理过程

2. **动态扩缩容** - 根据任务队列长度自动启动/停止 Worker
   - 待处理任务 > 3 且无空闲 Worker → 启动新 Worker
   - 空闲 Worker > 2 且无任务 → 停止空闲 Worker
   - 限制：MIN=1, MAX=5

3. **任务队列** - 支持优先级、自动分配、指定 Worker

---

## User Experience

### Telegram 视图

```
聊天列表:
├── 🤖 Claude Master    ← 协调者，发任务、查队列
├── 🔵 Claude Worker 1  ← 独立对话，看处理过程
├── 🟢 Claude Worker 2  ← 独立对话，看处理过程
└── 🟡 Claude Worker 3  ← 独立对话，看处理过程
```

### 交互模式

| 模式 | 操作 | 结果 |
|------|------|------|
| 通过 Master | 给 Master 发消息 | 自动分配，Worker 对话框显示 |
| 直接与 Worker | 给 Worker 发消息 | 该 Worker 直接处理 |
| 指定 Worker | `@worker2 <prompt>` | 指定 Worker 处理 |

### Commands

| Command | Description |
|---------|-------------|
| `/workers` | 显示所有 Worker 状态 |
| `/queue` | 显示任务队列 |
| `/cancel <id>` | 取消任务 |

---

## Technical Design

### Database Extensions

```sql
-- Worker 注册表
CREATE TABLE workers (
  worker_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  telegram_username TEXT,
  status TEXT DEFAULT 'idle',  -- idle/busy/offline/error
  current_task_id TEXT,
  last_heartbeat TEXT
);

-- 任务队列
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  title TEXT,
  prompt TEXT NOT NULL,
  priority INTEGER DEFAULT 5,
  status TEXT DEFAULT 'pending',  -- pending/running/completed/failed
  assigned_worker_id TEXT,
  result TEXT,
  created_at TEXT,
  completed_at TEXT
);
```

### New Components

| Component | File | Purpose |
|-----------|------|---------|
| WorkerManager | `src/orchestration/worker-manager.ts` | 管理 Worker 池 |
| TaskQueue | `src/orchestration/task-queue.ts` | 任务调度 |
| MasterBot | `src/orchestration/master-bot.ts` | 协调者 |
| WorkerBot | `src/orchestration/worker-bot.ts` | Worker 实现 |
| ScalingManager | `src/orchestration/scaling-manager.ts` | 动态扩缩容 |

### Code Changes

| File | Changes |
|------|---------|
| `src/session.ts` | 从单例改为工厂函数 |
| `src/config.ts` | 添加多 Bot 配置 |
| `src/index.ts` | 多 Bot 启动逻辑 |
| `src/db/store.ts` | workers/tasks 操作 |

---

## Configuration

```bash
# Master Bot
MASTER_BOT_TOKEN=xxx

# Worker Token 池 (预配置，按需激活)
WORKER_TOKEN_POOL=token1,token2,token3,token4,token5

# 扩缩容配置
MIN_WORKERS=1
MAX_WORKERS=5
SCALE_UP_THRESHOLD=3
SCALE_DOWN_DELAY=60
```

---

## Implementation Phases

1. **Phase 1: Foundation** - Database schema, WorkerManager, TaskQueue
2. **Phase 2: Workers** - 重构 Session, WorkerBot 类
3. **Phase 3: Orchestration** - MasterBot, 自动分配
4. **Phase 4: Scaling** - 动态扩缩容
5. **Phase 5: Polish** - 命令、错误处理、测试

---

## References

- 当前架构分析: 见 `DESIGN.md`
- SQLite 多设备同步: 见 `src/db/store.ts`
- 详细设计: 见 `~/.claude/plans/scalable-finding-church.md`
