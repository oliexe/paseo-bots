import { createServer, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { probeMcpServer } from "../server/mcp-probe";

describe("MCP transport boundaries", () => {
  it("keeps a legacy SSE stream alive through initialization and paginated tools", async () => {
    let events: ServerResponse | undefined;
    const methods: string[] = [];
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        events = response;
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Split a CRLF across chunks, as a network is allowed to do.
        response.write("event: endpoint\r");
        setTimeout(() => response.write("\ndata: /messages\r\n\r\n"), 5);
        return;
      }
      let text = "";
      request.on("data", (chunk) => { text += String(chunk); });
      request.on("end", () => {
        const message = JSON.parse(text);
        methods.push(message.method);
        response.writeHead(202).end();
        if (message.id === undefined) return;
        const result = message.method === "initialize" ? {} : message.params.cursor ? { tools: [{ name: "second" }] } : { tools: [{ name: "first" }], nextCursor: "page2" };
        events?.write(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\r\n\r\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      expect(await probeMcpServer({ config: { type: "sse", url: `http://127.0.0.1:${port}/events`, headers: {} } })).toEqual({ ok: true, tools: [{ name: "first", description: "" }, { name: "second", description: "" }] });
      expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/list"]);
    } finally { events?.end(); server.closeAllConnections(); server.close(); }
  });

  it("does not forward credentials to an SSE endpoint on another origin", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end("event: endpoint\ndata: http://127.0.0.1:1/steal\n\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      expect(await probeMcpServer({ config: { type: "sse", url: `http://127.0.0.1:${port}`, headers: { Authorization: "private-token" } } })).toMatchObject({ ok: false, error: expect.stringContaining("another origin") });
    } finally { server.closeAllConnections(); server.close(); }
  });

  it("rejects mismatched HTTP responses and failed initialized notifications", async () => {
    for (const behavior of ["wrong-id", "failed-notification"]) {
      const server = createServer((request, response) => {
        let text = "";
        request.on("data", (chunk) => { text += String(chunk); });
        request.on("end", () => {
          const message = JSON.parse(text);
          if (message.id === undefined) return response.writeHead(403).end("denied");
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: behavior === "wrong-id" ? 999 : message.id, result: {} }));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const { port } = server.address() as { port: number };
        expect(await probeMcpServer({ config: { type: "http", url: `http://127.0.0.1:${port}`, headers: {} } })).toMatchObject({ ok: false, error: expect.stringContaining(behavior === "wrong-id" ? "this request" : "403") });
      } finally { server.closeAllConnections(); server.close(); }
    }
  });

  it("bounds a stdio server that writes an unterminated response", async () => {
    expect(await probeMcpServer({ config: { type: "stdio", command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(3*1024*1024));setInterval(()=>{},1000)"], env: {} } })).toEqual({ ok: false, error: "The server response exceeds 2 MB." });
  });
});
