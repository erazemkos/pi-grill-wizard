import type { GrillWorkflowState } from "./state.ts";

export const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "grill_prepare_questionnaire",
]);

const MUTATING_TOOL_NAME = /(^|[_-])(write|edit|patch|replace|apply|delete|remove|move|rename|create|generate|migrate|install|commit|checkout|reset|branch)([_-]|$)/i;

const SIMPLE_READ_COMMANDS = new Set([
  "pwd",
  "ls",
  "tree",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "fd",
  "find",
  "wc",
  "diff",
  "file",
  "stat",
  "du",
  "df",
  "which",
  "whereis",
  "type",
  "env",
  "printenv",
  "uname",
  "whoami",
  "id",
  "uptime",
  "ps",
]);

const FORBIDDEN_SHELL_SYNTAX = [
  /(?:^|[^<])>(?:>|&)?/,
  /<</,
  /`/,
  /\$\(/,
  /<\(/,
  />\(/,
  /\b(?:sudo|su|doas)\b/i,
  /\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|update|upgrade|ci|link|publish|exec|create|init)\b/i,
  /\b(?:pip|pipx|uv|poetry|cargo|go|gem|brew|apt|apt-get|dnf|yum)\s+(?:install|add|remove|uninstall|update|upgrade|init|new|generate)\b/i,
  /\b(?:npx|pnpx)\b/i,
  /\b(?:prisma|alembic|sequelize|knex|typeorm|rails|django-admin)\b.*\b(?:migrate|upgrade|generate|db:)\b/i,
  /\b(?:vim|vi|nano|emacs|code|subl)\b/i,
  /(?:^|\s)--(?:output|pre|pre-glob|hostname-bin|pager|paginate|ext-diff|textconv|open-files-in-pager)(?:=|\s|$)/i,
  /(?:^|\s)-(?:o|O)(?:\s|$)/,
  /(?:^|\s)--fix(?:\s|$)/i,
];

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const character of command.trim()) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else token += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }
    token += character;
  }
  if (escaped || quote) return [];
  if (token) tokens.push(token);
  return tokens;
}

function hasDangerousOption(tokens: string[]): boolean {
  return tokens.some(
    (token) =>
      /^(?:--(?:output|pre|pre-glob|hostname-bin|pager|paginate|ext-diff|textconv|open-files-in-pager))(?:=|$)/i.test(token) ||
      /^-(?:o|O)(?:.|$)/.test(token),
  );
}

function isReadOnlyGit(tokens: string[]): boolean {
  const subcommand = tokens[1];
  if (!subcommand) return false;
  if (["status", "log", "describe", "rev-parse", "ls-files", "ls-tree"].includes(subcommand)) {
    return true;
  }
  if (subcommand === "remote") {
    return tokens.length === 2 || tokens.slice(2).every((token) => ["-v", "--verbose", "show", "get-url"].includes(token));
  }
  if (subcommand === "config") return tokens[2] === "--get" || tokens[2] === "--get-all" || tokens[2] === "--list";
  if (subcommand === "branch") {
    return tokens.slice(2).every((token) => ["--list", "--show-current", "-a", "-r", "-v", "-vv", "--contains", "--no-contains"].includes(token));
  }
  return false;
}

function isReadOnlyPackageQuery(tokens: string[]): boolean {
  if (!["npm", "pnpm", "yarn", "bun"].includes(tokens[0] ?? "")) return false;
  if (!["list", "ls", "view", "info", "why", "outdated", "audit"].includes(tokens[1] ?? "")) return false;
  if (tokens[1] === "audit" && tokens.slice(2).some((token) => !token.startsWith("-"))) return false;
  return true;
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = tokenize(segment);
  if (tokens.length === 0 || hasDangerousOption(tokens)) return false;
  const command = tokens[0]!;
  if (SIMPLE_READ_COMMANDS.has(command)) {
    if (
      command === "find" &&
      tokens.some((token) =>
        ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls"].includes(token) ||
        token.startsWith("-fprint") ||
        token.startsWith("-fprintf"),
      )
    ) return false;
    if (command === "env" && tokens.length > 1) return false;
    if (
      command === "fd" &&
      tokens.some((token) => token === "-x" || token === "-X" || token.startsWith("--exec"))
    ) return false;
    if (command === "tree" && tokens.some((token) => token === "-o" || token.startsWith("-o"))) return false;
    return true;
  }
  if (command === "git") return isReadOnlyGit(tokens);
  if (isReadOnlyPackageQuery(tokens)) return true;
  if (["node", "python", "python3", "ruby", "go", "rustc", "cargo"].includes(command)) {
    return tokens.length === 2 && ["--version", "-V", "version"].includes(tokens[1]!);
  }
  return false;
}

export function isReadOnlyShellCommand(command: string): boolean {
  if (typeof command !== "string" || command.trim() === "") return false;
  if (FORBIDDEN_SHELL_SYNTAX.some((pattern) => pattern.test(command)) || /\$/.test(command)) return false;
  const withoutLogicalOperators = command.replace(/&&|\|\|/g, "");
  if (/\n/.test(command) || /(^|[^\\]);/.test(command) || /\|&/.test(command) || /&/.test(withoutLogicalOperators)) return false;

  const segments = command.split(/\s*(?:&&|\|\||\|)\s*/);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

export function gateAllowsMutation(state: GrillWorkflowState): boolean {
  // `approved` is a persisted review decision, not an execution turn. Keeping it
  // gated prevents later sibling tool calls from the questionnaire batch from
  // mutating before the queued specification starts its own agent turn.
  return state === "implementing";
}

export function mutationBlockReason(
  state: GrillWorkflowState,
  toolName: string,
  input: unknown,
): string | undefined {
  if (gateAllowsMutation(state)) return undefined;
  if (toolName === "bash") {
    const command = (input as { command?: unknown } | undefined)?.command;
    if (typeof command === "string" && isReadOnlyShellCommand(command)) return undefined;
    return `Grill Wizard state '${state}' permits only demonstrably read-only shell commands`;
  }
  if (READ_ONLY_TOOL_NAMES.has(toolName)) return undefined;
  if (MUTATING_TOOL_NAME.test(toolName) || !READ_ONLY_TOOL_NAMES.has(toolName)) {
    return `Grill Wizard state '${state}' blocks '${toolName}' until explicit implementation approval`;
  }
  return undefined;
}

export function restrictedToolSet(allToolNames: string[]): string[] {
  return allToolNames.filter((name) => READ_ONLY_TOOL_NAMES.has(name));
}

export function restoredToolSet(current: string[], withheld: string[] | undefined): string[] {
  return [...new Set([...current, ...(withheld ?? [])])];
}
