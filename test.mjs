// Drives server.mjs over stdio the way Claude Desktop does.
// Run: node test.mjs
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const child = spawn("node", [new URL("server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, EGO_BROWSER_BIN: process.env.EGO_BROWSER_BIN ?? "ego-browser" },
});

const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let nl; (nl = buffer.indexOf("\n")) >= 0; ) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  }
});

let nextId = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const notify = (method, params) =>
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);

const init = await call("initialize", {
  protocolVersion: "2025-11-25",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});
assert.equal(init.result.serverInfo.name, "ego-lite");
notify("notifications/initialized");

const list = await call("tools/list", {});
assert.deepEqual(
  list.result.tools.map((t) => t.name),
  ["ego_run_script"],
);
assert.ok(list.result.tools[0].inputSchema.properties.script, "script parameter is declared");

const ok = await call("tools/call", {
  name: "ego_run_script",
  arguments: { script: 'console.log("ROUNDTRIP", (await help("taskSpace")).split("\\n")[0])' },
});
assert.equal(ok.result.isError, undefined);
assert.match(ok.result.content[0].text, /ROUNDTRIP taskSpace/);

const failed = await call("tools/call", {
  name: "ego_run_script",
  arguments: { script: "throw new Error('boom')" },
});
assert.equal(failed.result.isError, true, "a throwing script is reported as an error");
assert.match(failed.result.content[0].text, /boom/);

child.kill();
console.log("all checks passed");
