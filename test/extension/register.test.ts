import { describe, expect, it } from "vitest";
import { withStateDir } from "../support/env";
import factory from "../../index";

interface RegisteredTool {
  name: string;
  description?: string;
  parameters: unknown;
  execute: (...args: never[]) => unknown;
}

interface FakePi {
  tools: Map<string, RegisteredTool>;
  commands: Map<string, unknown>;
  handlers: Map<string, (...args: never[]) => unknown>;
  on: (event: string, handler: (...args: never[]) => unknown) => void;
  registerTool: (tool: RegisteredTool) => void;
  registerCommand: (name: string, options: unknown) => void;
}

function makePi(): FakePi {
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, unknown>();
  const handlers = new Map<string, (...args: never[]) => unknown>();
  return {
    tools,
    commands,
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    registerCommand(name, options) {
      commands.set(name, options);
    },
  };
}

describe("extension registration", () => {
  it("registers the five hybrid tools and lifecycle hooks", () => {
    withStateDir();
    const pi = makePi();
    factory(pi as never);

    expect([...pi.tools.keys()].sort()).toEqual(["edit", "grep", "insert", "read", "undo"]);
    // Every tool carries the pieces pi needs: name, description, parameters, execute.
    for (const [name, tool] of pi.tools) {
      expect(tool.name).toBe(name);
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
    // Tool descriptions are short and carry the core protocol rules.
    expect(pi.tools.get("edit")!.description).toContain("anchors");
    expect(pi.tools.get("edit")!.description).toMatch(/nothing is modified/i);
    expect(pi.tools.get("edit")!.description).toContain("one transaction");
    expect(pi.tools.get("insert")!.description).toContain("anchor");
    expect(pi.tools.get("undo")!.description).toMatch(/without overwriting anything/);

    expect(pi.handlers.has("session_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.handlers.has("tool_result")).toBe(true);
    expect(pi.commands.has("toggle-auto-read")).toBe(true);
  });
});
