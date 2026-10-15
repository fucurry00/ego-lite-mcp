import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { z } from "zod";

const BIN = process.env.EGO_BROWSER_BIN || "ego-browser";
const SKILL = `${homedir()}/.agents/skills/ego-browser/SKILL.md`;
const TIMEOUT_MS = 180_000;
const MAX_CHARS = 100_000;

// ponytail: single passthrough tool. Splitting read-only from acting is the
// planned next step if "always allow" ever becomes tempting for this tool.

const cap = (s) =>
  s.length <= MAX_CHARS
    ? s
    : `${s.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} of ${s.length} chars. Narrow the output: page.snapshot({ scope: "subtree", root: "@N" }), or extract just what you need with page.evaluate().]`;

function runScript(script) {
  return new Promise((resolve) => {
    const child = execFile(
      BIN,
      ["nodejs"],
      { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const hint =
            err.code === "ENOENT"
              ? `\n\nego-browser was not found at "${BIN}". Set the EGO_BROWSER_BIN environment variable to its absolute path.`
              : err.killed
                ? `\n\nThe script was killed after ${TIMEOUT_MS / 1000}s. Split the work across several calls.`
                : "\n\nIf this says the browser service is unreachable, ego lite is not running. Ask the user to open ego lite.";
          resolve({
            content: [{ type: "text", text: cap(`ERROR: ${stderr || err.message}${hint}`) }],
            isError: true,
          });
          return;
        }
        // ego-browser の埋め込み Node は console.log を stderr に書く。
        // 成功時の出力もここに来るため、stderr を異常扱いせず連結する。
        const out = stdout + stderr;
        resolve({
          content: [
            { type: "text", text: cap(out.trim() || "(no output — the script must console.log() what it wants back)") },
          ],
        });
      },
    );
    // A failed spawn makes writes to stdin emit EPIPE; swallow it so the
    // server survives and the execFile callback reports the real cause.
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

const server = new McpServer({ name: "ego-lite", version: "0.1.0" });

server.registerTool(
  "ego_run_script",
  {
    title: "Run a script in the ego lite browser",
    description: `Run JavaScript in ego lite, a Chromium browser holding the user's own logged-in sessions. Use it to open pages, read their content, fill forms, click, and take screenshots.

The script runs in Node.js (ESM, top-level await), NOT inside the page. window/document/location are unavailable here; put page-side code inside page.evaluate(). console.log() is the only way to return data. Variables do not survive between calls, but task spaces and pages do.

First call in a session: run \`console.log(await help())\` for the full API reference (~15k chars), or \`help("taskSpace")\` for one entry. Read the operating conventions once with:
  const fs = await import("node:fs/promises");
  console.log(await fs.readFile(${JSON.stringify(SKILL)}, "utf8"));

Minimum to get going:
  const task = await taskSpace("what the user asked for");
  const page = task.page("p1");
  await page.goto("https://example.com");
  console.log(task.spaceId, await page.snapshot());
Print spaceId so later calls can resume with taskSpace(id). Use one task space per user goal. When the goal is done, call await task.finish({ keep: [] }) exactly once.

These are the user's real logged-in accounts. Anything that sends, posts, buys, or deletes is irreversible and takes their identity. Never perform such an action unless the user asked for that specific action in this conversation; hand control back with await task.handOff() instead.`,
    inputSchema: { script: z.string().describe("JavaScript to execute. Use console.log() to return results.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ({ script }) => runScript(script),
);

await server.connect(new StdioServerTransport());
