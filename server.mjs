import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { z } from "zod";

const BIN = process.env.EGO_BROWSER_BIN || "ego-browser";
const SKILL_DIR = `${homedir()}/.agents/skills/ego-browser`;
const SKILL = `${SKILL_DIR}/SKILL.md`;
// 保存済みスクリプトの実行用の場所。ここへの配置を利用者が承認する（ADR 0003）。
const SCRIPTS_DIR = process.env.EGO_SCRIPTS_DIR || `${homedir()}/.config/ego-lite-mcp/scripts`;
const NAME = /^[a-z0-9-]+$/;
// 作業の開始＝新しいタスクスペースの作成か、利用者のスペースへの介入。taskSpace(23) の再開は含まない。
// ponytail: literal match; taskSpace(nameVar) slips through. The description steers first calls to a literal.
const STARTS_TASK = /\btaskSpace\(\s*["'`]|\b(?:listTaskSpaces|claimTaskSpace|takeOverTaskSpace)\s*\(/;
const TIMEOUT_MS = 180_000;
const MAX_CHARS = 100_000;

const cap = (s) =>
  s.length <= MAX_CHARS
    ? s
    : `${s.slice(0, MAX_CHARS)}\n\n[truncated at ${MAX_CHARS} of ${s.length} chars. Narrow the output: page.snapshot({ scope: "subtree", root: "@N" }), or extract just what you need with page.evaluate().]`;

// SKILL.md は CLI 前提で書かれているため、MCP 経由での読み替えを前置きする。
async function guide() {
  const preamble = `ego-browser operating guide (SKILL.md), attached because this call started a task. Follow it for the rest of the task. You are using it through MCP, so read it this way:
- Where it says to run \`ego-browser nodejs\` with a heredoc or -e, pass the same JavaScript as this tool's \`script\` argument. Ignore the shell quoting notes.
- Relative paths such as references/api.md are under ${SKILL_DIR}. Read them with node:fs inside a script.
- You cannot view saved screenshot files here. Observe pages with snapshot() instead of screenshot().

`;
  try {
    return preamble + (await readFile(SKILL, "utf8"));
  } catch (e) {
    return `Could not read the operating guide at ${SKILL} (${e.code}). Run console.log(await help()) for the API reference.`;
  }
}

function runScript(script, withGuide = true) {
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
        const content = [
          { type: "text", text: cap(out.trim() || "(no output — the script must console.log() what it wants back)") },
        ];
        if (withGuide && STARTS_TASK.test(script)) guide().then((text) => resolve({ content: [...content, { type: "text", text }] }));
        else resolve({ content });
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

The script runs in Node.js (ESM, top-level await), NOT inside the page. window/document/location are unavailable here; put page-side code inside page.evaluate(). console.log() is the only way to return data.

Start every user goal with a call that only creates the task space and prints its id:
  const task = await taskSpace("what the user asked for");
  console.log(task.spaceId);
That call also returns the operating guide. Read it before doing anything else. Later calls resume with taskSpace(id). The API reference is console.log(await help()).

These are the user's real logged-in accounts. Anything that sends, posts, buys, or deletes is irreversible and takes their identity. Never perform such an action unless the user asked for that specific action in this conversation; hand control back with await task.handOff() instead.`,
    inputSchema: { script: z.string().describe("JavaScript to execute. Use console.log() to return results.") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  ({ script }) => runScript(script),
);

const savedNames = async () => {
  try {
    return (await readdir(SCRIPTS_DIR, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith(".js"))
      .map((d) => d.name.slice(0, -3))
      .filter((n) => NAME.test(n))
      .sort();
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
};
const listing = async () => {
  const names = await savedNames();
  return names.length ? `Saved scripts: ${names.join(", ")}` : `No saved scripts in ${SCRIPTS_DIR}.`;
};

server.registerTool(
  "ego_run_saved_script",
  {
    title: "Run a saved script in the ego lite browser",
    description: `Run a script the user has saved and approved, by name. The script is fixed: you cannot change what it does, only choose which one to run. Its console.log() output comes back as the result.

Call with no name to list the saved scripts.`,
    inputSchema: {
      name: z
        .string()
        .regex(NAME, "Use lowercase letters, digits, and hyphens only.")
        .max(64)
        .optional()
        .describe("Saved script name, without .js. Omit to list them."),
    },
    // ponytail: read-only by operating rule, not by code. Only read-only scripts are placed in SCRIPTS_DIR (ADR 0003).
    // A script that acts needs its own tool without this hint, kept out of "always allow".
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ name }) => {
    if (name === undefined) return { content: [{ type: "text", text: await listing() }] };
    const file = `${SCRIPTS_DIR}/${name}.js`;
    let stat;
    try {
      stat = await lstat(file);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      return { content: [{ type: "text", text: `No saved script named "${name}". ${await listing()}` }], isError: true };
    }
    // リンクの先は配置の承認を経ずに変わりうるので、コピーされた通常のファイルだけを実行する（ADR 0003）。
    // ponytail: SCRIPTS_DIR itself being a link is not checked; the docs make that an operating rule.
    if (!stat.isFile())
      return {
        content: [{ type: "text", text: `"${name}" is not a plain file. Saved scripts must be copied into ${SCRIPTS_DIR}, not linked.` }],
        isError: true,
      };
    const script = await readFile(file, "utf8");
    // 保存済みスクリプトは最後まで自分で走るので、操作手順の添付は要らない。
    return runScript(script, false);
  },
);

await server.connect(new StdioServerTransport());
