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
  /** Input prompt: "❯" followed by optional text, or traditional ">" */
  PROMPT: /^❯\s*$/m,

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
  SEPARATOR: /^─{10,}/m,
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

    // Only process new content
    if (cleaned.length <= this.processedLength) {
      // Check for completion even if no new content
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
   */
  private parseContent(content: string): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Skip empty lines, horizontal separators, and TUI chrome
      if (!trimmedLine || PATTERNS.SEPARATOR.test(line)) {
        continue;
      }

      // Skip UI elements like "? for shortcuts", version info, etc.
      if (trimmedLine.includes("for shortcuts") ||
          trimmedLine.includes("Claude Code v") ||
          trimmedLine.includes("Opus") ||
          trimmedLine.startsWith("▐") ||
          trimmedLine.startsWith("▝") ||
          trimmedLine.startsWith("▘") ||
          trimmedLine.includes("Auto-update") ||
          trimmedLine.includes("Chrome enabled") ||
          trimmedLine.includes("claude doctor") ||
          trimmedLine.includes("esc to interrupt") ||
          trimmedLine.startsWith("·") ||
          trimmedLine.startsWith("✢") ||
          trimmedLine.includes("Stewing") ||
          trimmedLine.includes("Fiddle-faddling") ||
          trimmedLine.includes("thinking)")) {
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
          }
          this.currentBlockContent = "";
        }
        this.state = ParseState.COMPLETE;
        blocks.push({ type: "prompt", content: trimmedLine });
        this.promptDetectedAt = Date.now();
        continue;
      }

      // Check for tool start
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

      // Accumulate content based on state
      switch (this.state) {
        case ParseState.THINKING:
          this.currentBlockContent += (this.currentBlockContent ? "\n" : "") + line;
          break;

        case ParseState.TOOL_USE:
          // Tool output, might want to capture it
          break;

        case ParseState.TEXT_OUTPUT:
        case ParseState.IDLE:
        default:
          // Regular text output
          if (trimmedLine && !PATTERNS.USAGE.test(line)) {
            this.currentBlockContent += (this.currentBlockContent ? "\n" : "") + line;
            this.textAccumulator += (this.textAccumulator ? "\n" : "") + line;
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
    const lastLines = lines.slice(-3).join("\n");

    if (PATTERNS.PROMPT.test(lastLines)) {
      if (this.state !== ParseState.COMPLETE) {
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

    // Add a small delay to ensure all output has been captured
    // (tmux output can be slightly delayed)
    const timeSincePrompt = Date.now() - this.promptDetectedAt;
    return timeSincePrompt >= 500; // 500ms stability delay
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
