/**
 * Terminal Output Parser for Claude Code CLI.
 *
 * Parses raw terminal output from tmux and converts it to structured events
 * that can be sent to Telegram via statusCallback.
 */

import { ParseState, type ParsedBlock } from "./types";

/**
 * Regular expression patterns for detecting Claude Code output markers.
 *
 * Claude Code TUI format:
 * - Input: "❯ [user message]"
 * - Processing: "✽ Fiddle-faddling…" or similar
 * - Response: "⏺ [response text]"
 * - Prompt ready: "❯ " (empty, at bottom between horizontal lines)
 */
export const PATTERNS = {
  /** Input prompt: "❯" alone or with placeholder suggestion text */
  PROMPT: /^❯\s*$/m,

  /** Input prompt (relaxed): "❯" followed by anything (includes placeholder suggestions) */
  PROMPT_RELAXED: /^❯/m,

  /** User input line: "❯ " followed by text */
  USER_INPUT: /^❯\s+.+/m,

  /** Claude response line: "⏺ " followed by text */
  RESPONSE: /^⏺\s+(.+)/m,

  /** Processing indicator: "✽" spinner with status text */
  PROCESSING: /^✽\s+.+/m,

  /** Thinking block start */
  THINKING_START: /^(🧠|Thinking:|<thinking>|✽)/m,

  /** Thinking block end (when text or tool starts) */
  THINKING_END: /^(🔧|📁|📝|💻|🔍|Tool:|[A-Z][a-z]+:|⏺)/m,

  /** Tool use start - common tool emojis and names */
  TOOL_START: /^[🔧📁📝💻🔍🌐⚡]\s*\w+/m,

  /** Claude Code tool patterns - ● Read, ● Write, ● Bash, etc. */
  CLAUDE_TOOL: /^[●○◉◐]\s*(Read|Write|Edit|Bash|Glob|Grep|WebFetch|WebSearch|Task|TodoWrite|NotebookEdit|AskUserQuestion)/m,

  /** Tool output lines (indented with └ or │ or spaces) */
  TOOL_OUTPUT: /^[\s│└├─┬┴┼]+/,

  /** Collapsed content indicator */
  COLLAPSED: /^…\s*\+?\d+\s*lines?/,

  /** Tool execution indicator */
  TOOL_RUNNING: /^(Running|Executing|Reading|Writing|Searching)/m,

  /** Tool end markers */
  TOOL_END: /^(Done|✓|✅|Error:|⚠️|❌|Failed:)/m,

  /** Error pattern */
  ERROR: /^(Error:|❌|Failed:|⚠️\s*Error)/m,

  /** ANSI escape codes for stripping */
  ANSI: /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,

  /** Carriage return (line overwrite) */
  CARRIAGE_RETURN: /\r/g,

  /** Empty lines */
  EMPTY_LINE: /^\s*$/,

  /** Token usage line */
  USAGE: /^(Usage:|Tokens:|Cost:)/m,

  /** Horizontal line separator (Claude Code TUI) */
  SEPARATOR: /^[─━═]{5,}/m,

  /** Table border lines (horizontal separators with joints) */
  TABLE_BORDER: /^[│├┤┬┴┼┌┐└┘─━═\s]+$/,

  /** Pure UI chrome to filter out (ASCII art, borders, etc.) */
  UI_CHROME: /^(▐|▝|▜|▛|▘|█|░|▒|▓|·\s|✢)/,

  /** Box drawing characters for stripping from table cells */
  BOX_CHARS: /[│├┤┬┴┼┌┐└┘─━═]/g,

  /** Permission/confirmation prompts */
  PERMISSION_PROMPT: /^(Do you want to|Allow|Approve|Confirm|Accept|Would you like to)/i,

  /** Edit file indicator */
  EDIT_FILE: /^Edit\s+(file\s+)?[\w\/\.\-]+/,

  /** Diff line (added/removed) */
  DIFF_LINE: /^\d+\s*[+\-]/,

  /** Menu options (1. Yes, 2. No, etc.) */
  MENU_OPTION: /^\s*[>\s]*\d+\.\s+/,
};

/**
 * Strip ANSI escape codes from text.
 */
export function stripAnsi(text: string): string {
  return text.replace(PATTERNS.ANSI, "");
}

/**
 * Clean terminal output by stripping ANSI codes and handling carriage returns.
 */
export function cleanOutput(text: string): string {
  // Strip ANSI codes
  let cleaned = stripAnsi(text);

  // Handle carriage returns (line overwrites)
  // Split by lines and process each
  const lines = cleaned.split("\n");
  const processedLines: string[] = [];

  for (const line of lines) {
    // If line contains \r, take only the part after the last \r
    if (line.includes("\r")) {
      const parts = line.split("\r");
      processedLines.push(parts[parts.length - 1] || "");
    } else {
      processedLines.push(line);
    }
  }

  return processedLines.join("\n");
}

/**
 * Terminal output parser for Claude Code CLI.
 *
 * This is a state machine that processes incremental terminal output
 * and emits structured blocks.
 */
export class TerminalOutputParser {
  private state: ParseState = ParseState.IDLE;
  private buffer: string = "";
  private processedLength: number = 0;
  private blocks: ParsedBlock[] = [];
  private textAccumulator: string = "";
  private currentBlockContent: string = "";
  private promptDetectedAt: number = 0;
  private lastPromptCheck: number = 0;

  /**
   * Feed new terminal output to the parser.
   *
   * @param rawOutput - Raw output from tmux capture-pane
   * @returns Array of newly parsed blocks
   */
  feed(rawOutput: string): ParsedBlock[] {
    // Clean the output
    const cleaned = cleanOutput(rawOutput);

    // Detect content displacement (content shifted rather than grew)
    // This happens when the tmux scrollback anchor scrolls out
    if (cleaned.length <= this.processedLength && this.buffer) {
      // Check if the content actually changed (displacement) vs just no new content
      const bufferTail = this.buffer.slice(-200);
      const cleanedTail = cleaned.slice(-200);
      if (bufferTail !== cleanedTail && cleaned.length > 0) {
        // Content displaced - find overlap and adjust processedLength
        const overlapLen = Math.min(this.buffer.length, cleaned.length, 500);
        const oldTail = this.buffer.slice(-overlapLen);
        const idx = cleaned.lastIndexOf(oldTail);
        if (idx >= 0) {
          // Found overlap - only process content after the overlap
          this.processedLength = idx + overlapLen;
        } else {
          // No overlap found - reset and reprocess
          console.warn("Parser: content displacement with no overlap, resetting processedLength");
          this.processedLength = 0;
        }
      } else {
        // No change - just check completion
        this.checkCompletion(cleaned);
        return [];
      }
    }

    // Only process new content
    if (cleaned.length <= this.processedLength) {
      this.checkCompletion(cleaned);
      return [];
    }

    const newContent = cleaned.slice(this.processedLength);
    this.processedLength = cleaned.length;
    this.buffer = cleaned;

    // Parse the new content
    const newBlocks = this.parseContent(newContent);

    // Check for completion
    this.checkCompletion(cleaned);

    return newBlocks;
  }

  /**
   * Parse content and emit blocks.
   * Handles Claude Code TUI format with ❯ for input and ⏺ for response.
   *
   * Modified to preserve more information for Telegram display:
   * - Tool usage (Read, Write, Bash, etc.)
   * - Thinking/processing status
   * - Only filters pure UI chrome (ASCII art borders)
   */
  private parseContent(content: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines and horizontal separators
      if (!trimmedLine || PATTERNS.SEPARATOR.test(line)) {
        continue;
      }

      // Skip pure table border lines (only box drawing chars)
      if (PATTERNS.TABLE_BORDER.test(trimmedLine)) {
        continue;
      }

      // Skip only pure UI chrome (ASCII art borders, decorations)
      if (PATTERNS.UI_CHROME.test(trimmedLine)) {
        continue;
      }

      // Clean box drawing characters from table cells, convert to plain text
      // e.g., "│ 类型 │ 数量 │" -> "类型 | 数量"
      let cleanedLine = trimmedLine;
      if (PATTERNS.BOX_CHARS.test(trimmedLine)) {
        cleanedLine = trimmedLine
          .replace(PATTERNS.BOX_CHARS, "|")
          .replace(/\|{2,}/g, "|")
          .replace(/^\||\|$/g, "")
          .trim();
        // Skip if line becomes empty after cleaning
        if (!cleanedLine) continue;
      }

      // Skip repetitive status bar elements (but keep meaningful status)
      if (trimmedLine.includes("for shortcuts") ||
          trimmedLine.includes("shift+tab to cycle") ||
          trimmedLine.includes("esc to interrupt") ||
          trimmedLine.includes("Auto-update failed") ||
          trimmedLine.includes("claude doctor") ||
          trimmedLine.includes("npm i -g")) {
        continue;
      }

      // Check for Claude Code tool usage (● Read, ● Write, ● Bash, etc.)
      if (PATTERNS.CLAUDE_TOOL.test(line)) {
        // Emit any accumulated content first
        if (this.currentBlockContent) {
          blocks.push({ type: "text", content: this.currentBlockContent.trim() });
          this.currentBlockContent = "";
        }
        this.state = ParseState.TOOL_USE;
        // Replace ● with 🔧 for better visibility
        const toolLine = trimmedLine.replace(/^[●○◉◐]\s*/, "🔧 ");
        blocks.push({ type: "tool", content: toolLine });
        continue;
      }

      // Check for tool output lines (indented with └ │ etc.)
      if (this.state === ParseState.TOOL_USE && PATTERNS.TOOL_OUTPUT.test(line)) {
        // Capture tool output, clean up box-drawing characters
        const cleanedOutput = trimmedLine.replace(/^[└│├─┬┴┼]+\s*/, "  ");
        if (cleanedOutput.trim() && !PATTERNS.COLLAPSED.test(cleanedOutput)) {
          blocks.push({ type: "tool", content: cleanedOutput });
        }
        continue;
      }

      // Check for collapsed content (… +40 lines)
      if (PATTERNS.COLLAPSED.test(line)) {
        blocks.push({ type: "tool", content: `📄 ${trimmedLine}` });
        continue;
      }

      // Check for Edit file indicator
      if (PATTERNS.EDIT_FILE.test(trimmedLine)) {
        this.state = ParseState.TOOL_USE;
        blocks.push({ type: "tool", content: `📝 ${trimmedLine}` });
        continue;
      }

      // Check for diff lines (code changes)
      if (PATTERNS.DIFF_LINE.test(trimmedLine)) {
        // Keep diff lines as tool output
        blocks.push({ type: "tool", content: cleanedLine });
        continue;
      }

      // Check for permission/confirmation prompts
      if (PATTERNS.PERMISSION_PROMPT.test(trimmedLine)) {
        this.state = ParseState.WAITING_INPUT;
        blocks.push({ type: "text", content: `⚠️ ${trimmedLine}` });
        continue;
      }

      // Check for menu options (1. Yes, 2. No, etc.)
      if (PATTERNS.MENU_OPTION.test(line)) {
        blocks.push({ type: "text", content: cleanedLine });
        continue;
      }

      // Check for processing/thinking indicator (✽ Fiddle-faddling...)
      if (PATTERNS.PROCESSING.test(line)) {
        this.state = ParseState.THINKING;
        blocks.push({ type: "thinking", content: trimmedLine });
        continue;
      }

      // Check for Claude response (⏺ text)
      const responseMatch = line.match(PATTERNS.RESPONSE);
      if (responseMatch) {
        const responseText = responseMatch[1] || "";
        if (responseText) {
          this.textAccumulator += (this.textAccumulator ? "\n" : "") + responseText;
          this.currentBlockContent = responseText;
          this.state = ParseState.TEXT_OUTPUT;
          blocks.push({ type: "text", content: responseText });
        }
        continue;
      }

      // Check for user input line (❯ with text) - skip it
      if (PATTERNS.USER_INPUT.test(line)) {
        continue;
      }

      // Check for empty prompt (❯ alone) - indicates completion
      if (PATTERNS.PROMPT.test(line)) {
        // Emit any accumulated content
        if (this.currentBlockContent) {
          if (this.state === ParseState.THINKING) {
            blocks.push({ type: "thinking", content: this.currentBlockContent.trim() });
          } else if (this.currentBlockContent.trim()) {
            blocks.push({ type: "text", content: this.currentBlockContent.trim() });
          }
          this.currentBlockContent = "";
        }
        this.state = ParseState.COMPLETE;
        blocks.push({ type: "prompt", content: trimmedLine });
        this.promptDetectedAt = Date.now();
        continue;
      }

      // Check for tool start (emoji-based)
      if (PATTERNS.TOOL_START.test(line) || PATTERNS.TOOL_RUNNING.test(line)) {
        // Emit any accumulated content
        if (this.currentBlockContent && this.state === ParseState.THINKING) {
          blocks.push({ type: "thinking", content: this.currentBlockContent.trim() });
        } else if (this.currentBlockContent) {
          blocks.push({ type: "text", content: this.currentBlockContent.trim() });
        }
        this.currentBlockContent = "";
        this.state = ParseState.TOOL_USE;
        blocks.push({ type: "tool", content: trimmedLine });
        continue;
      }

      // Check for tool end
      if (this.state === ParseState.TOOL_USE && PATTERNS.TOOL_END.test(line)) {
        blocks.push({ type: "tool", content: trimmedLine });
        if (PATTERNS.ERROR.test(line)) {
          blocks.push({ type: "error", content: trimmedLine });
        }
        this.state = ParseState.TEXT_OUTPUT;
        continue;
      }

      // Check for error
      if (PATTERNS.ERROR.test(line)) {
        blocks.push({ type: "error", content: trimmedLine });
        continue;
      }

      // Accumulate content based on state (use cleanedLine for display)
      switch (this.state) {
        case ParseState.THINKING:
          this.currentBlockContent += (this.currentBlockContent ? "\n" : "") + cleanedLine;
          break;

        case ParseState.TOOL_USE:
          // Capture tool output too (file content, command output, etc.)
          if (cleanedLine && !PATTERNS.USAGE.test(line)) {
            blocks.push({ type: "tool", content: cleanedLine });
          }
          break;

        case ParseState.TEXT_OUTPUT:
        case ParseState.IDLE:
        default:
          // Regular text output (use cleanedLine which has box chars converted)
          if (cleanedLine && !PATTERNS.USAGE.test(line)) {
            this.currentBlockContent += (this.currentBlockContent ? "\n" : "") + cleanedLine;
            this.textAccumulator += (this.textAccumulator ? "\n" : "") + cleanedLine;
          }
          this.state = ParseState.TEXT_OUTPUT;
          break;
      }
    }

    // Add any pending blocks to our list
    this.blocks.push(...blocks);

    return blocks;
  }

  /**
   * Check if response is complete by looking for prompt at end of buffer.
   */
  private checkCompletion(buffer: string): void {
    // Get last few lines
    const lines = buffer.split("\n").filter((l) => l.trim());
    const lastLines = lines.slice(-5).join("\n");

    // First try strict prompt (empty ❯)
    if (PATTERNS.PROMPT.test(lastLines)) {
      // During TOOL_USE, a ❯ prompt may appear temporarily (e.g., tool confirmation).
      // Only mark complete if NOT in tool_use state, or if there's also a ⏺ response before the prompt.
      if (this.state === ParseState.TOOL_USE) {
        // Check if there's a response (⏺) between the tool and this prompt
        const lastResponseIdx = buffer.lastIndexOf("⏺");
        const lastToolIdx = Math.max(
          buffer.lastIndexOf("● "),
          buffer.lastIndexOf("○ "),
          buffer.lastIndexOf("◉ "),
          buffer.lastIndexOf("◐ ")
        );
        // If the last tool marker is after the last response, we're still mid-tool
        if (lastToolIdx > lastResponseIdx) {
          return; // Don't mark complete during tool execution
        }
      }
      if (this.state !== ParseState.COMPLETE) {
        this.state = ParseState.COMPLETE;
        this.promptDetectedAt = Date.now();
      }
      return;
    }

    // Relaxed check: after we've seen a response (⏺), any ❯ at the end
    // indicates completion. Claude Code v2.1+ shows placeholder suggestions
    // like "❯ help me start a new project" which won't match the strict pattern.
    // IMPORTANT: Only use relaxed check in TEXT_OUTPUT state, NOT TOOL_USE.
    // During tool execution, separators and prompts appear temporarily.
    if (this.state === ParseState.TEXT_OUTPUT) {
      // Check if the last non-empty lines contain a separator (─) followed by ❯
      // This is the Claude Code TUI pattern: response → separator → prompt
      const lastFew = lines.slice(-4);
      const hasSeparator = lastFew.some((l) => PATTERNS.SEPARATOR.test(l));
      const hasPrompt = lastFew.some((l) => PATTERNS.PROMPT_RELAXED.test(l));
      if (hasSeparator && hasPrompt) {
        this.state = ParseState.COMPLETE;
        this.promptDetectedAt = Date.now();
      }
    }
  }

  /**
   * Check if the response is complete (back at prompt).
   */
  isComplete(): boolean {
    // Must be in complete state
    if (this.state !== ParseState.COMPLETE) {
      return false;
    }

    // Stability delay: wait to ensure all output has been captured.
    // Claude CLI may show a prompt briefly during tool execution before
    // continuing with more output. A longer delay reduces false positives.
    const timeSincePrompt = Date.now() - this.promptDetectedAt;
    return timeSincePrompt >= 2000; // 2s stability delay
  }

  /**
   * Get the accumulated text response.
   */
  getTextResponse(): string {
    // Emit any remaining accumulated content
    if (this.currentBlockContent) {
      this.textAccumulator += (this.textAccumulator ? "\n" : "") + this.currentBlockContent;
    }
    return this.textAccumulator.trim();
  }

  /**
   * Get all parsed blocks.
   */
  getBlocks(): ParsedBlock[] {
    return this.blocks;
  }

  /**
   * Get current parser state.
   */
  getState(): ParseState {
    return this.state;
  }

  /**
   * Revoke a premature COMPLETE state (content changed after prompt detected).
   * Returns to TEXT_OUTPUT state so parsing continues.
   */
  revokeCompletion(): void {
    if (this.state === ParseState.COMPLETE) {
      this.state = ParseState.TEXT_OUTPUT;
      this.promptDetectedAt = 0;
    }
  }

  /**
   * Reset only the processedLength (used when content anchor is lost).
   * Preserves accumulated text and state so we don't lose parsed responses.
   */
  resetProcessedLength(): void {
    this.processedLength = 0;
    this.buffer = "";
  }

  /**
   * Reset parser state for a new response.
   */
  reset(): void {
    this.state = ParseState.IDLE;
    this.buffer = "";
    this.processedLength = 0;
    this.blocks = [];
    this.textAccumulator = "";
    this.currentBlockContent = "";
    this.promptDetectedAt = 0;
    this.lastPromptCheck = 0;
  }
}
