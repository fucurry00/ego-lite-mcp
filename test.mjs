// Drives server.mjs over stdio the way Claude Desktop does.
// Run: node test.mjs
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The taskSpace("x") comment in this script checks that a saved script never gets the guide attached.
const scripts = mkdtempSync(join(tmpdir(), "ego-scripts-"));
writeFileSync(join(scripts, "hello-1.js"), 'console.log("SAVED") // taskSpace("x")');
writeFileSync(join(scripts, "notes.txt"), "not a script");
writeFileSync(join(scripts, "Bad_Name.js"), "console.log(1)");
// A link would let the script change after placement, so only plain files count.
const outside = mkdtempSync(join(tmpdir(), "ego-outside-"));
writeFileSync(join(outside, "target.js"), 'console.log("LINKED")');
symlinkSync(join(outside, "target.js"), join(scripts, "linked.js"));
mkdirSync(join(scripts, "folder.js"));

const child = spawn("node", [new URL("server.mjs", import.meta.url).pathname], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, EGO_BROWSER_BIN: process.env.EGO_BROWSER_BIN ?? "ego-browser", EGO_SCRIPTS_DIR: scripts },
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
  ["ego_run_script", "ego_run_saved_script"],
);
assert.ok(list.result.tools[0].inputSchema.properties.script, "script parameter is declared");

const ok = await call("tools/call", {
  name: "ego_run_script",
  arguments: { script: 'console.log("ROUNDTRIP", (await help("taskSpace")).split("\\n")[0])' },
});
assert.equal(ok.result.isError, undefined);
assert.match(ok.result.content[0].text, /ROUNDTRIP taskSpace/);
assert.equal(ok.result.content.length, 1, "no guide when the script starts no task");

// The task-start check reads the script text only, so a comment exercises it without touching the browser.
const guideFor = async (script) =>
  (await call("tools/call", { name: "ego_run_script", arguments: { script } })).result.content;
for (const start of ['taskSpace("x")', "claimTaskSpace(7)", "takeOverTaskSpace(7)", "listTaskSpaces()"]) {
  const content = await guideFor(`console.log(1) // ${start}`);
  assert.equal(content.length, 2, `guide attached for ${start}`);
  assert.match(content[1].text, /name: ego-browser/, "guide carries SKILL.md");
}
assert.equal((await guideFor("console.log(1) // taskSpace(23)")).length, 1, "no guide on resume");

const failed = await call("tools/call", {
  name: "ego_run_script",
  arguments: { script: "throw new Error('boom')" },
});
assert.equal(failed.result.isError, true, "a throwing script is reported as an error");
assert.match(failed.result.content[0].text, /boom/);

const saved = async (args) => (await call("tools/call", { name: "ego_run_saved_script", arguments: args })).result;

const listing = await saved({});
assert.equal(listing.isError, undefined);
assert.match(listing.content[0].text, /hello-1/, "omitting the name lists saved scripts");
assert.doesNotMatch(listing.content[0].text, /notes/, "only .js files are scripts");
assert.doesNotMatch(listing.content[0].text, /Bad_Name/, "names the tool would reject are not listed");
assert.doesNotMatch(listing.content[0].text, /linked|folder/, "links and folders are not listed");

for (const name of ["../hello-1", "Hello", "a/b", "a.js", "", "a".repeat(65)]) {
  const bad = await saved({ name });
  assert.equal(bad.isError, true, `rejects ${JSON.stringify(name)}`);
  assert.doesNotMatch(bad.content[0].text, /SAVED/);
}

const missing = await saved({ name: "missing" });
assert.equal(missing.isError, true, "an unknown name is an error");
assert.match(missing.content[0].text, /hello-1/, "the error lists what exists");

for (const name of ["linked", "folder"]) {
  const refused = await saved({ name });
  assert.equal(refused.isError, true, `refuses ${name}`);
  assert.doesNotMatch(refused.content[0].text, /LINKED/);
  assert.match(refused.content[0].text, /plain file/);
}

const ran = await saved({ name: "hello-1" });
assert.equal(ran.isError, undefined);
assert.match(ran.content[0].text, /SAVED/);
assert.equal(ran.content.length, 1, "no guide for a saved script");

child.kill();
rmSync(scripts, { recursive: true });
rmSync(outside, { recursive: true });
console.log("all checks passed");
