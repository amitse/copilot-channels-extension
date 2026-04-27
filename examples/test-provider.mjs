#!/usr/bin/env node
// Quick test: connect to the tap provider gateway as a provider.
// Usage: TAP_PROVIDER_TOKEN=<token> node examples/test-provider.mjs

import WebSocket from "ws";

const TOKEN = process.env.TAP_PROVIDER_TOKEN;
if (!TOKEN) {
  console.error("Set TAP_PROVIDER_TOKEN env var (printed by tap on startup)");
  process.exit(1);
}

const PORT = process.env.TAP_GATEWAY_PORT || 9400;

function connect() {
  console.log(`Connecting to ws://localhost:${PORT} ...`);
  const ws = new WebSocket(`ws://localhost:${PORT}`);

  ws.on("open", () => {
    console.log("Connected. Sending auth...");
    ws.send(JSON.stringify({ type: "auth", token: TOKEN }));
  });

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    console.log("←", JSON.stringify(msg, null, 2));

    switch (msg.type) {
      case "sessions":
        if (!msg.active.length) {
          console.log("No active sessions. Closing.");
          ws.close();
          return;
        }
        console.log(`Binding to session: ${msg.active[0].id}`);
        ws.send(JSON.stringify({
          type: "hello",
          name: "test-provider",
          protocolVersion: 2,
          session: msg.active[0].id,
          tools: [{
            name: "test_greet",
            description: "A test tool that greets someone by name",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name to greet" }
              },
              required: ["name"]
            }
          }]
        }));
        break;

      case "hello.ack":
        console.log(`\n✅ Registered as ${msg.providerId}`);
        console.log("Provider is now BOUND. Waiting for tool calls...\n");
        break;

      case "tool.call":
        console.log(`\n🔧 Tool call: ${msg.tool}(${JSON.stringify(msg.args)})`);
        ws.send(JSON.stringify({
          type: "tool.result",
          id: msg.id,
          data: `Hello, ${msg.args.name}! (from test-provider)`
        }));
        console.log("   → sent result\n");
        break;

      case "tool.cancel":
        console.log(`⚠️  Tool cancel: ${msg.id}`);
        ws.send(JSON.stringify({
          type: "tool.result",
          id: msg.id,
          error: "Cancelled",
          errorCode: "CANCELLED"
        }));
        break;

      case "session.lifecycle":
        console.log(`📋 Lifecycle: ${msg.state}`);
        if (msg.state === "shutdown.pending") {
          console.log("Session shutting down. Sending goodbye.");
          ws.send(JSON.stringify({ type: "goodbye", reason: "session ending" }));
          ws.close();
        }
        break;

      case "error":
        console.error(`❌ Error [${msg.code}]: ${msg.message}`);
        if (msg.code === "AUTH_FAILED" || msg.code === "UNSUPPORTED_VERSION") {
          ws.close();
        }
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log("Disconnected.");
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

connect();
