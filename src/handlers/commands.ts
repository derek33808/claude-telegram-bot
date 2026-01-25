/**
 * Command handlers for Claude Telegram Bot.
 *
 * /start, /new, /stop, /status, /resume, /restart
 */

import type { Context } from "grammy";
import { session } from "../session";
import { WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "../config";
import { isAuthorized } from "../security";

/**
 * /start - Show welcome message and status.
 */
export async function handleStart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized. Contact the bot owner for access.");
    return;
  }

  const status = session.isActive ? "Active session" : "No active session";
  const workDir = WORKING_DIR;

  await ctx.reply(
    `🤖 <b>Claude Telegram Bot</b>\n\n` +
      `状态: ${status}\n` +
      `工作目录: <code>${workDir}</code>\n\n` +
      `<b>命令:</b>\n` +
      `/help - 显示所有命令\n` +
      `/new - 开始新对话\n` +
      `/stop - 中断当前查询\n` +
      `/status - 查看详细状态\n` +
      `/resume - 恢复 Bot 会话\n` +
      `/sessions - 接管终端会话\n` +
      `/retry - 重试上条消息\n` +
      `/health - 系统健康检查\n` +
      `/restart - 重启机器人\n\n` +
      `<b>提示:</b>\n` +
      `• 用 <code>!</code> 前缀可中断当前查询\n` +
      `• 使用"思考"关键词触发深度推理\n` +
      `• 支持发送图片、语音、文档`,
    { parse_mode: "HTML" }
  );
}

/**
 * /help - Show all available commands with descriptions.
 */
export async function handleHelp(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  await ctx.reply(
    `📚 <b>Claude Telegram Bot - 命令帮助</b>\n\n` +
      `<b>会话管理:</b>\n` +
      `/start - 显示欢迎消息和当前状态\n` +
      `/new - 开始新的对话会话\n` +
      `/stop - 中断当前正在执行的查询\n` +
      `/status - 查看详细的会话状态信息\n` +
      `/resume - 恢复之前保存的 Bot 会话\n` +
      `/sessions - 列出并接管终端 Claude Code 会话\n` +
      `/retry - 重新发送上一条消息\n\n` +
      `<b>系统管理:</b>\n` +
      `/health - 检查 Bot 健康状态（内存、运行时间等）\n` +
      `/restart - 重启 Bot 进程\n` +
      `/help - 显示此帮助信息\n\n` +
      `<b>特殊功能:</b>\n` +
      `• 发送 <code>!</code> 开头的消息可立即中断当前查询\n` +
      `• 消息中包含"思考"关键词会触发深度推理模式\n` +
      `• 支持发送图片、语音消息、文档文件\n` +
      `• Hook 机制会拦截敏感操作（文件写入、Git 等）并推送审批\n\n` +
      `<b>会话接管:</b>\n` +
      `使用 /sessions 可以接管在终端运行的 Claude Code 会话，实现远程控制。`,
    { parse_mode: "HTML" }
  );
}

/**
 * /new - Start a fresh session.
 */
export async function handleNew(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Stop any running query
  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      await Bun.sleep(100);
      session.clearStopRequested();
    }
  }

  // Clear session
  await session.kill();

  await ctx.reply("🆕 Session cleared. Next message starts fresh.");
}

/**
 * /stop - Stop the current query (silently).
 */
export async function handleStop(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isRunning) {
    const result = await session.stop();
    if (result) {
      // Wait for the abort to be processed, then clear stopRequested so next message can proceed
      await Bun.sleep(100);
      session.clearStopRequested();
    }
    // Silent stop - no message shown
  }
  // If nothing running, also stay silent
}

/**
 * /status - Show detailed status.
 */
export async function handleStatus(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["📊 <b>Bot Status</b>\n"];

  // Bot uptime
  const uptime = process.uptime();
  const uptimeStr = formatUptime(uptime);
  lines.push(`⏱️ Uptime: ${uptimeStr}`);

  // Session status
  if (session.isActive) {
    lines.push(`\n✅ <b>Session</b>: Active`);
    lines.push(`   ID: <code>${session.sessionId?.slice(0, 16)}...</code>`);
  } else {
    lines.push("\n⚪ <b>Session</b>: None");
  }

  // Query status
  if (session.isRunning) {
    const elapsed = session.queryStarted
      ? Math.floor((Date.now() - session.queryStarted.getTime()) / 1000)
      : 0;
    lines.push(`\n🔄 <b>Query</b>: Running (${elapsed}s)`);
    if (session.currentTool) {
      lines.push(`   └─ Tool: ${session.currentTool}`);
    }
  } else {
    lines.push("\n⚪ <b>Query</b>: Idle");
    if (session.lastTool) {
      lines.push(`   └─ Last: ${session.lastTool}`);
    }
  }

  // Last activity
  if (session.lastActivity) {
    const ago = Math.floor(
      (Date.now() - session.lastActivity.getTime()) / 1000
    );
    lines.push(`\n⏰ Last activity: ${formatDuration(ago)} ago`);
  }

  // Usage stats
  if (session.lastUsage) {
    const usage = session.lastUsage;
    lines.push(
      `\n📈 <b>Last query usage</b>:`,
      `   Input: ${usage.input_tokens?.toLocaleString() || "?"} tokens`,
      `   Output: ${usage.output_tokens?.toLocaleString() || "?"} tokens`
    );
    if (usage.cache_read_input_tokens) {
      lines.push(
        `   Cache read: ${usage.cache_read_input_tokens.toLocaleString()}`
      );
    }
  }

  // System resources
  const memUsage = process.memoryUsage();
  const memUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);
  const memTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(1);
  lines.push(
    `\n💾 <b>Memory</b>: ${memUsedMB} / ${memTotalMB} MB`,
    `   RSS: ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`
  );

  // Error status
  if (session.lastError) {
    const ago = session.lastErrorTime
      ? Math.floor((Date.now() - session.lastErrorTime.getTime()) / 1000)
      : "?";
    lines.push(
      `\n⚠️ <b>Last error</b> (${formatDuration(ago)} ago):`,
      `   <code>${session.lastError.slice(0, 100)}</code>`
    );
  } else {
    lines.push(`\n✅ <b>Errors</b>: None`);
  }

  // Working directory
  lines.push(`\n📁 <b>Working dir</b>:\n<code>${WORKING_DIR}</code>`);

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * Helper: Format uptime into human-readable string.
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);

  return parts.join(" ");
}

/**
 * Helper: Format duration in seconds into human-readable string.
 */
function formatDuration(seconds: number | string): string {
  if (typeof seconds === "string") return seconds;

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;

  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * /resume - Show list of sessions to resume with inline keyboard.
 */
export async function handleResume(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  if (session.isActive) {
    await ctx.reply("Sessione già attiva. Usa /new per iniziare da capo.");
    return;
  }

  // Get saved sessions
  const sessions = session.getSessionList();

  if (sessions.length === 0) {
    await ctx.reply("❌ Nessuna sessione salvata.");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "18/01 10:30"
    const date = new Date(s.saved_at);
    const dateStr = date.toLocaleDateString("it-IT", {
      day: "2-digit",
      month: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate title for button (max ~40 chars to fit)
    const titlePreview =
      s.title.length > 35 ? s.title.slice(0, 32) + "..." : s.title;

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - "${titlePreview}"`,
        callback_data: `resume:${s.session_id}`,
      },
    ];
  });

  await ctx.reply("📋 <b>Sessioni salvate</b>\n\nSeleziona una sessione da riprendere:", {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * /restart - Restart the bot process.
 */
export async function handleRestart(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const chatId = ctx.chat?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const msg = await ctx.reply("🔄 Restarting bot...");

  // Save message info so we can update it after restart
  if (chatId && msg.message_id) {
    try {
      await Bun.write(
        RESTART_FILE,
        JSON.stringify({
          chat_id: chatId,
          message_id: msg.message_id,
          timestamp: Date.now(),
        })
      );
    } catch (e) {
      console.warn("Failed to save restart info:", e);
    }
  }

  // Give time for the message to send
  await Bun.sleep(500);

  // Exit - launchd will restart us
  process.exit(0);
}

/**
 * /sessions - List Claude Code sessions to take over.
 */
export async function handleSessions(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Get Claude Code sessions
  const sessions = session.getClaudeCodeSessions();

  if (sessions.length === 0) {
    await ctx.reply("❌ 没有找到 Claude Code 会话。");
    return;
  }

  // Build inline keyboard with session list
  const buttons = sessions.map((s) => {
    // Format date: "01/25 10:30"
    const date = new Date(s.modified);
    const dateStr = date.toLocaleDateString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
    });
    const timeStr = date.toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });

    // Truncate summary for button (max ~35 chars to fit)
    const summaryPreview = s.summary
      ? s.summary.length > 30
        ? s.summary.slice(0, 27) + "..."
        : s.summary
      : s.firstPrompt?.slice(0, 27) + "..." || "无标题";

    return [
      {
        text: `📅 ${dateStr} ${timeStr} - ${summaryPreview}`,
        callback_data: `ccsession:${s.sessionId}`,
      },
    ];
  });

  await ctx.reply(
    "🖥️ <b>Claude Code 会话列表</b>\n\n" +
      "选择一个会话来接管（将继承该会话的完整上下文）：",
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: buttons,
      },
    }
  );
}

/**
 * /health - Show system health check.
 */
export async function handleHealth(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  const lines: string[] = ["🏥 <b>System Health Check</b>\n"];

  // Bot status
  const botStatus = session.isRunning ? "🟢 Running" : "🟡 Idle";
  lines.push(`Bot: ${botStatus}`);

  // Session health
  if (session.isActive) {
    lines.push(`Session: 🟢 Active`);
  } else {
    lines.push(`Session: 🟡 No active session`);
  }

  // Error health
  if (session.lastError && session.lastErrorTime) {
    const errorAge = Date.now() - session.lastErrorTime.getTime();
    // Recent error (< 5 min) is concerning
    if (errorAge < 5 * 60 * 1000) {
      lines.push(`Errors: 🔴 Recent error detected`);
    } else {
      lines.push(`Errors: 🟢 No recent errors`);
    }
  } else {
    lines.push(`Errors: 🟢 No errors`);
  }

  // Memory health
  const memUsage = process.memoryUsage();
  const memUsedMB = memUsage.heapUsed / 1024 / 1024;
  const memTotalMB = memUsage.heapTotal / 1024 / 1024;
  const memPercent = (memUsedMB / memTotalMB) * 100;

  let memStatus = "🟢";
  if (memPercent > 90) memStatus = "🔴";
  else if (memPercent > 70) memStatus = "🟡";

  lines.push(
    `Memory: ${memStatus} ${memPercent.toFixed(1)}% (${memUsedMB.toFixed(1)}MB)`
  );

  // Uptime health
  const uptime = process.uptime();
  const uptimeStr = formatUptime(uptime);
  lines.push(`Uptime: 🟢 ${uptimeStr}`);

  // Working directory check
  try {
    const dirExists = await Bun.file(WORKING_DIR).exists();
    lines.push(`Working dir: ${dirExists ? "🟢" : "🔴"} ${dirExists ? "OK" : "Not found"}`);
  } catch {
    lines.push(`Working dir: 🔴 Error checking`);
  }

  // Overall status
  const allGreen =
    !session.lastError &&
    memPercent < 70 &&
    session.isActive;
  lines.push(
    `\n<b>Overall</b>: ${allGreen ? "🟢 Healthy" : "🟡 Running with warnings"}`
  );

  // Quick stats
  lines.push(
    `\n<b>Quick Stats</b>:`,
    `• Process ID: <code>${process.pid}</code>`,
    `• Node version: <code>${process.version}</code>`,
    `• Platform: <code>${process.platform}</code>`
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/**
 * /retry - Retry the last message (resume session and re-send).
 */
export async function handleRetry(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;

  if (!isAuthorized(userId, ALLOWED_USERS)) {
    await ctx.reply("Unauthorized.");
    return;
  }

  // Check if there's a message to retry
  if (!session.lastMessage) {
    await ctx.reply("❌ No message to retry.");
    return;
  }

  // Check if something is already running
  if (session.isRunning) {
    await ctx.reply("⏳ A query is already running. Use /stop first.");
    return;
  }

  const message = session.lastMessage;
  await ctx.reply(`🔄 Retrying: "${message.slice(0, 50)}${message.length > 50 ? "..." : ""}"`);

  // Simulate sending the message again by emitting a fake text message event
  // We do this by directly calling the text handler logic
  const { handleText } = await import("./text");

  // Create a modified context with the last message
  const fakeCtx = {
    ...ctx,
    message: {
      ...ctx.message,
      text: message,
    },
  } as Context;

  await handleText(fakeCtx);
}
