import { describe, expect, it, vi } from "vitest";
import { rewriteSseEndpoints } from "../server/mcp-sse";

function stream(chunks: (string | Uint8Array)[], cancel = vi.fn()) {
  const encoded = chunks.map((chunk) => typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return new ReadableStream<Uint8Array>({ pull(controller) { const next = encoded.shift(); if (next) controller.enqueue(next); else controller.close(); }, cancel });
}
async function collect(body: ReadableStream<Uint8Array>, rewrite: (data: string) => Promise<string> = async (data) => `local:${data}`, limit?: number) {
  let result = "";
  for await (const chunk of rewriteSseEndpoints(body, rewrite, limit)) result += chunk;
  return result;
}

describe("legacy MCP SSE framing", () => {
  it("preserves comments, id, retry, unknown fields and message data while replacing only endpoint data", async () => {
    const input = ": heartbeat\r\nid: previous\r\nretry: 1500\r\n\r\nevent: endpoint\r\nid: connection\r\ndata: /messages?session=a\r\nx-extra: keep\r\n: within endpoint\r\n\r\nevent: message\nid: tool-2\nretry: 3000\ndata: {\"ok\":true}\n\n";
    expect(await collect(stream([input]))).toBe(input.replace("data: /messages?session=a", "data: local:/messages?session=a"));
  });

  it("handles CRLF and UTF-8 split at every byte boundary and bare CR separators", async () => {
    const input = "\uFEFF: café\r\nevent: endpoint\rdata:/messages\rid: číslo\r\rdata: hello 🌍\n\n";
    const bytes = Buffer.from(input); const chunks = [...bytes].map((byte) => Uint8Array.of(byte));
    expect(await collect(stream(chunks))).toBe(input.replace("data:/messages", "data: local:/messages"));
  });

  it("flushes heartbeat comments and retry instructions without waiting for a blank line or stream close", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const iterator = rewriteSseEndpoints(body, async () => "unused");
    controller.enqueue(Buffer.from(": ping\nretry: 2500\n"));
    expect(await iterator.next()).toEqual({ value: ": ping\n", done: false });
    expect(await iterator.next()).toEqual({ value: "retry: 2500\n", done: false });
    await iterator.return(undefined);
  });

  it("dispatches bare-CR endpoint events immediately while the upstream stream remains open", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const rewrite = vi.fn(async () => "local:/messages");
    const iterator = rewriteSseEndpoints(body, rewrite);
    controller.enqueue(Buffer.from("event: endpoint\rdata: /messages\r\r"));
    expect(await iterator.next()).toEqual({ value: "event: endpoint\r", done: false });
    expect(await iterator.next()).toEqual({ value: "data: local:/messages\r", done: false });
    expect(rewrite).toHaveBeenCalledExactlyOnceWith("/messages");
    expect(await iterator.next()).toEqual({ value: "\r", done: false });
    // A later LF completes the previous CRLF; it must not become a second blank line.
    controller.enqueue(Buffer.from("\n: ping\r"));
    expect(await iterator.next()).toEqual({ value: "\n", done: false });
    expect(await iterator.next()).toEqual({ value: ": ping\r", done: false });
    await iterator.return(undefined);
  });

  it("uses the final event field and joins multiple data fields without dropping intervening metadata", async () => {
    const rewrite = vi.fn(async () => "http://127.0.0.1/local");
    const input = "data:/one\nid: 2\ndata: /two\nevent: ignored\nevent: endpoint\nretry: 30\n\n";
    expect(await collect(stream([input]), rewrite)).toBe("data: http://127.0.0.1/local\nid: 2\nevent: ignored\nevent: endpoint\nretry: 30\n\n");
    expect(rewrite).toHaveBeenCalledExactlyOnceWith("/one\n/two");
    const reset = "event: endpoint\ndata: unchanged\nevent:\n\n";
    expect(await collect(stream([reset]), rewrite)).toBe(reset);
  });

  it("preserves an unterminated event and trailing CR without inventing a dispatch", async () => {
    const rewrite = vi.fn(async () => "changed");
    const input = "event: endpoint\ndata: /messages\rid: last";
    expect(await collect(stream([input]), rewrite)).toBe(input); expect(rewrite).not.toHaveBeenCalled();
    expect(await collect(stream([": heartbeat\r"]))).toBe(": heartbeat\r");
  });

  it("bounds line and event buffers by UTF-8 bytes and cancels the upstream reader on overflow", async () => {
    const cancel = vi.fn();
    const longLine = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from(`: ${"é".repeat(20)}`)); }, cancel });
    await expect(collect(longLine, undefined, 32)).rejects.toThrow("buffer limit"); expect(cancel).toHaveBeenCalledOnce();
    await expect(collect(stream(["data: first\nid: second\ndata: third\n\n"]), undefined, 32)).rejects.toThrow("buffer limit");
    // Limits are per buffered event, not all events delivered by a long-lived connection.
    const many = "data: ok\n\n".repeat(100); expect(await collect(stream([many]), undefined, 32)).toBe(many);
  });

  it("rejects a rewrite that would inject additional SSE fields", async () => {
    await expect(collect(stream(["event: endpoint\ndata: /messages\n\n"]), async () => "local\nid: injected")).rejects.toThrow("line break");
  });
});
