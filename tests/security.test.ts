/**
 * Security module tests
 * Run with: bun test tests/security.test.ts
 */

import { describe, test, expect } from "bun:test";

// Import the functions we want to test
// Note: We need to mock the config imports
process.env.ALLOWED_PATHS = "/Users/yuqiang/Documents,/tmp";
process.env.BLOCKED_PATTERNS = "rm -rf /,sudo rm,chmod 777";

import { checkCommandSafety, isPathAllowed } from "../src/security";

describe("Path Validation", () => {
  test("should allow paths in ALLOWED_PATHS", () => {
    expect(isPathAllowed("/Users/yuqiang/Documents/test.txt")).toBe(true);
    expect(isPathAllowed("/tmp/test.txt")).toBe(true);
  });

  test("should reject paths outside ALLOWED_PATHS", () => {
    expect(isPathAllowed("/etc/passwd")).toBe(false);
    expect(isPathAllowed("/usr/bin/bash")).toBe(false);
    expect(isPathAllowed("/root/.ssh/id_rsa")).toBe(false);
  });

  test("should handle path traversal attempts", () => {
    expect(isPathAllowed("/Users/yuqiang/Documents/../../../etc/passwd")).toBe(false);
  });
});

describe("Command Safety - rm parsing", () => {
  test("should allow simple rm in allowed path", () => {
    const [safe] = checkCommandSafety("rm /tmp/test.txt");
    expect(safe).toBe(true);
  });

  test("should reject rm outside allowed paths", () => {
    const [safe, reason] = checkCommandSafety("rm /etc/passwd");
    expect(safe).toBe(false);
    expect(reason).toContain("outside allowed paths");
  });

  test("should handle quoted paths correctly", () => {
    const [safe] = checkCommandSafety('rm "/tmp/file with spaces.txt"');
    expect(safe).toBe(true);
  });

  test("should reject command substitution $(...)", () => {
    const [safe, reason] = checkCommandSafety("rm $(cat files.txt)");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should reject backtick command substitution", () => {
    const [safe, reason] = checkCommandSafety("rm `whoami`/file");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should reject variable expansion ${...}", () => {
    const [safe, reason] = checkCommandSafety("rm ${HOME}/secret");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should reject pipe operators", () => {
    const [safe, reason] = checkCommandSafety("rm file.txt | cat /etc/passwd");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should reject semicolon chaining", () => {
    const [safe, reason] = checkCommandSafety("rm file.txt; cat /etc/passwd");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should reject background operator &", () => {
    const [safe, reason] = checkCommandSafety("rm file.txt & malicious");
    expect(safe).toBe(false);
    expect(reason).toContain("unsafe shell patterns");
  });

  test("should handle escaped spaces in paths", () => {
    const [safe] = checkCommandSafety("rm /tmp/path\\ with\\ spaces/file.txt");
    expect(safe).toBe(true);
  });

  test("should handle rm with flags", () => {
    const [safe] = checkCommandSafety("rm -rf /tmp/testdir");
    expect(safe).toBe(true);
  });
});

describe("Command Safety - blocked patterns", () => {
  test("should block rm -rf /", () => {
    const [safe] = checkCommandSafety("rm -rf /");
    expect(safe).toBe(false);
  });

  test("should block sudo rm", () => {
    const [safe] = checkCommandSafety("sudo rm /tmp/file");
    expect(safe).toBe(false);
  });

  test("should block chmod 777", () => {
    const [safe] = checkCommandSafety("chmod 777 /tmp/script.sh");
    expect(safe).toBe(false);
  });
});

console.log("Running security tests...");
