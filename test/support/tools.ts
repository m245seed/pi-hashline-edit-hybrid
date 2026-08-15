import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export async function runTool(
  tool: ToolDefinition<any, any>,
  params: unknown,
  cwd: string,
): Promise<ToolResult> {
  const result = (await tool.execute(
    "test-call-id",
    params,
    undefined,
    undefined,
    { cwd } as never,
  )) as unknown as ToolResult;
  return result;
}

export function textOf(result: ToolResult): string {
  return (result.content ?? [])
    .filter((entry): entry is { type: string; text: string } => typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n");
}

export function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-hybrid-proj-"));
  return dir;
}

export function writeFileAt(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, "utf-8");
  return path;
}

export function readFileAt(path: string): string {
  return require("fs").readFileSync(path, "utf-8");
}
