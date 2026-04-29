// Spawn the compiled MCP server, send list_tools + a simple call over stdio,
// to verify the server boots and answers JSON-RPC correctly.
import { spawn } from "node:child_process";

const proc = spawn("node", ["dist/server.js"], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
proc.stdout.on("data", (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) {
      try { console.log("<-", JSON.stringify(JSON.parse(line))); }
      catch { console.log("<-", line); }
    }
  }
});

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + "\n");

// MCP requires `initialize` first.
send({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.1" },
  },
});

setTimeout(() => {
  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
}, 200);

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 3, method: "tools/call",
         params: { name: "status", arguments: {} } });
}, 400);

setTimeout(() => {
  send({ jsonrpc: "2.0", id: 4, method: "tools/call",
         params: { name: "list_folders", arguments: {} } });
}, 700);

setTimeout(() => { proc.kill(); process.exit(0); }, 1500);
