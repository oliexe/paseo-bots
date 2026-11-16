import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithinOrigin } from "@modelcontextprotocol/sdk/shared/transport.js";
import { oauthFetch, validateOAuthUrl } from "../server/mcp-oauth-network";

const dns = vi.hoisted(() => ({ lookup: vi.fn(async (_name: string, _options: unknown) => [{ address: "8.8.8.8", family: 4 }]) }));
vi.mock("node:dns/promises", () => ({ lookup: dns.lookup }));

let server: Server;
let origin: string;
const received: { url: string; method: string; body: string; host: string | undefined }[] = [];
let closedStreams = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received.push({ url: request.url!, method: request.method!, body: Buffer.concat(chunks).toString(), host: request.headers.host });
      if (request.url === "/redirect") { response.writeHead(302, { Location: "/metadata" }); response.end(); return; }
      if (request.url === "/private-redirect") { response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" }); response.end(); return; }
      if (request.url === "/loop") { response.writeHead(302, { Location: "/loop" }); response.end(); return; }
      if (request.url === "/slow") return;
      if (request.url === "/stream") {
        response.on("close", () => { closedStreams++; });
        response.writeHead(200, { "Content-Type": "text/event-stream", "WWW-Authenticate": 'Bearer scope="tools:read"' });
        response.write("event: endpoint\ndata: /messages\n\n");
        return;
      }
      if (request.url === "/large") { response.writeHead(200, { "Content-Length": 1024 * 1024 + 1 }); response.end("x"); return; }
      if (request.url === "/chunks") { response.writeHead(200); response.write("x".repeat(16)); response.end("y".repeat(16)); return; }
      if (request.url === "/compressed") { response.writeHead(200, { "Content-Encoding": "gzip" }); response.end("compressed"); return; }
      if (request.url === "/empty") { response.writeHead(204); response.end(); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
beforeEach(() => {
  received.length = 0;
  closedStreams = 0;
  dns.lookup.mockReset();
  dns.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});

describe("OAuth endpoint policy", () => {
  it.each([
    "http://auth.example/token", "https://user:secret@auth.example/token", "https://auth.example/token#fragment", "https://auth.example/token#", "file:///etc/passwd",
    "https://127.0.0.1/token", "https://0x7f000001/token", "https://2130706433/token", "https://[::1]/token", "https://[::ffff:127.0.0.1]/token",
    "https://[::ffff:7f00:1]/token", "https://169.254.169.254/token", "https://10.1.2.3/token", "https://172.20.1.1/token", "https://192.168.1.1/token",
    "https://100.64.1.1/token", "https://0.0.0.0/token", "https://224.0.0.1/token", "https://[fc00::1]/token", "https://[fe80::1]/token",
    "https://[64:ff9b::a00:1]/token", "https://[2002:a00:1::]/token", "https://[2001:db8::1]/token",
  ])("refuses unsafe OAuth destination %s", async (url) => {
    await expect(validateOAuthUrl(url, "https://mcp.example/mcp")).rejects.toThrow();
  });

  it("permits the explicitly configured LAN host, but not unrelated LAN endpoints", async () => {
    expect((await validateOAuthUrl("https://10.2.3.4:8443/token", "https://10.2.3.4/mcp")).hostname).toBe("10.2.3.4");
    dns.lookup.mockResolvedValue([{ address: "192.168.2.8", family: 4 }]);
    await expect(validateOAuthUrl("https://internal.company/token", "https://internal.company/mcp")).resolves.toBeInstanceOf(URL);
    await expect(validateOAuthUrl("https://different.company/token", "https://internal.company/mcp")).rejects.toThrow("private or reserved");
    await expect(validateOAuthUrl("http://internal.company/token", "http://internal.company/mcp")).rejects.toThrow("HTTPS");
  });

  it("rejects private/mixed DNS answers and unexpected loopback rebinding", async () => {
    dns.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.2", family: 4 }]);
    await expect(validateOAuthUrl("https://auth.example/token", "https://mcp.example/mcp")).rejects.toThrow("private or reserved");
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(validateOAuthUrl("https://mcp.example/token", "https://mcp.example/mcp")).rejects.toThrow("private or reserved");
  });

  it("accepts public IPv4, IPv6 and IPv4-mapped IPv6 without DNS", async () => {
    for (const target of ["https://8.8.8.8/token", "https://[2606:4700:4700::1111]/token", "https://[::ffff:8.8.8.8]/token"]) {
      await expect(validateOAuthUrl(target, "https://mcp.example/mcp")).resolves.toBeInstanceOf(URL);
    }
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it("allows HTTP loopback only when the configured MCP itself is loopback", async () => {
    await expect(validateOAuthUrl(`${origin}/token`, `${origin}/mcp`)).resolves.toBeInstanceOf(URL);
    dns.lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(validateOAuthUrl(`${origin}/token`, "http://localhost/mcp")).resolves.toBeInstanceOf(URL);
    await expect(validateOAuthUrl("http://localhost.evil/token", `${origin}/mcp`)).rejects.toThrow("HTTPS");
  });
});

describe("bounded OAuth network requests", () => {
  it("supports SDK form/JSON requests, response cloning and empty responses", async () => {
    const fetch = oauthFetch(`${origin}/mcp`);
    // The SDK runs on Node; React Native's ambient BodyInit omits URLSearchParams.
    const response = await fetch(`${origin}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: "test code", code_verifier: "test-verifier" }) as never });
    expect(response.url).toBe(`${origin}/token`);
    expect(await response.clone().json()).toEqual({ ok: true });
    expect(await response.json()).toEqual({ ok: true });
    expect(received[0]).toMatchObject({ method: "POST", body: "code=test+code&code_verifier=test-verifier" });
    expect((await fetch(`${origin}/empty`)).status).toBe(204);
  });

  it("reads challenge headers and closes an open SSE body without waiting for completion", async () => {
    const fetch = oauthFetch(origin, { headersOnly: true, timeoutMs: 500 });
    const response = await fetch(`${origin}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("www-authenticate")).toBe('Bearer scope="tools:read"');
    expect(response.url).toBe(`${origin}/stream`);
    expect(response.body).toBeNull();
    await vi.waitFor(() => expect(closedStreams).toBe(1));
    // Ignored bodies cannot exceed the buffer limit, and redirect policy still applies.
    expect((await fetch(`${origin}/large`)).status).toBe(200);
    expect((await fetch(`${origin}/private-redirect`)).status).toBe(302);
    await expect(fetch(`${origin}/redirect`, { redirect: "error" })).rejects.toThrow("redirect was refused");
  });

  it("pins the resolved address for the socket and freezes the configured host for later requests", async () => {
    const localOrigin = origin.replace("127.0.0.1", "localhost");
    dns.lookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]).mockResolvedValue([{ address: "127.0.0.2", family: 4 }]);
    const fetch = oauthFetch(`${localOrigin}/mcp`);
    expect((await fetch(`${localOrigin}/metadata`)).status).toBe(200);
    expect((await fetch(`${localOrigin}/token`, { method: "POST", body: "code=test" })).status).toBe(200);
    expect(dns.lookup).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(2);
    expect(received[0]!.host).toBe(new URL(localOrigin).host);
  });

  it("returns redirects manually and lets the SDK follow only the original origin", async () => {
    const fetch = oauthFetch(`${origin}/mcp`);
    expect((await fetch(`${origin}/redirect`)).status).toBe(302);
    expect(received.map((request) => request.url)).toEqual(["/redirect"]);
    expect(await (await fetchWithinOrigin(fetch)(`${origin}/redirect`)).json()).toEqual({ ok: true });
    expect((await fetchWithinOrigin(fetch)(`${origin}/private-redirect`)).status).toBe(302);
    expect(received.some((request) => request.url.includes("meta-data"))).toBe(false);
    await expect(fetch(`${origin}/redirect`, { redirect: "error" })).rejects.toThrow("redirect was refused");
  });

  it("limits both declared and streamed bodies without decompressing hostile payloads", async () => {
    await expect(oauthFetch(origin)(`${origin}/large`)).rejects.toThrow("size limit");
    await expect(oauthFetch(origin, { maxResponseBytes: NaN })(`${origin}/large`)).rejects.toThrow("size limit");
    await expect(oauthFetch(origin, { maxResponseBytes: 20 })(`${origin}/chunks`)).rejects.toThrow("size limit");
    await expect(oauthFetch(origin)(`${origin}/compressed`)).rejects.toThrow("Compressed");
    await expect(oauthFetch(origin)(`${origin}/token`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).rejects.toThrow("too large");
  });

  it("aborts slow responses and DNS within the overall deadline", async () => {
    await expect(oauthFetch(origin, { timeoutMs: 30 })(`${origin}/slow`)).rejects.toThrow("timed out");
    dns.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(oauthFetch("https://mcp.example", { timeoutMs: 30 })("https://auth.example/token")).rejects.toThrow("timed out");
  });

  it("honors caller cancellation without issuing an already-canceled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(oauthFetch(origin)(`${origin}/metadata`, { signal: controller.signal })).rejects.toThrow();
    expect(received).toHaveLength(0);
    const active = new AbortController();
    const response = oauthFetch(origin)(`${origin}/slow`, { signal: active.signal });
    await vi.waitFor(() => expect(received).toHaveLength(1));
    active.abort();
    await expect(response).rejects.toThrow();
  });

  it("cancels endpoint validation while DNS is pending", async () => {
    dns.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = validateOAuthUrl("https://auth.example/token", "https://mcp.example", controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("refuses request framing overrides before reaching the fixture", async () => {
    for (const name of ["Host", "Connection", "Transfer-Encoding", "Content-Length", "Cookie", "Proxy-Authorization"]) {
      await expect(oauthFetch(origin)(`${origin}/metadata`, { headers: { [name]: "unsafe" } })).rejects.toThrow("Unsafe");
    }
    expect(received).toHaveLength(0);
  });
});
