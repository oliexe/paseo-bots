import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";

const DEADLINE_MS = 30_000;
const BODY_BYTES = 1024 * 1024;
type Address = { address: string; family: number };

function ranges(entries: readonly [string, number, "ipv4" | "ipv6"][]): BlockList {
  const result = new BlockList();
  for (const [address, prefix, family] of entries) result.addSubnet(address, prefix, family);
  return result;
}
const ipv4 = ranges([["0.0.0.0", 0, "ipv4"]]);
const loopback = ranges([["127.0.0.0", 8, "ipv4"], ["::1", 128, "ipv6"]]);
const lan = ranges([["10.0.0.0", 8, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["fc00::", 7, "ipv6"]]);
const nonPublicV4 = ranges([
  ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"], ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"], ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"],
  ["192.88.99.0", 24, "ipv4"], ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"], ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"], ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
]);
const globalV6 = ranges([["2000::", 3, "ipv6"]]);
const nonPublicV6 = ranges([["2001::", 23, "ipv6"], ["2001:db8::", 32, "ipv6"], ["2002::", 16, "ipv6"], ["3fff::", 20, "ipv6"]]);

function within(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return !!family && list.check(address, family === 4 ? "ipv4" : "ipv6");
}
function publicAddress(address: string): boolean {
  // Node's parser also matches IPv4-mapped IPv6 against IPv4 subnets.
  return within(ipv4, address) ? !within(nonPublicV4, address) : within(globalV6, address) && !within(nonPublicV6, address);
}
function hostname(url: URL): string { return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase(); }
function localName(name: string): boolean { return name === "localhost" || within(loopback, name); }

function parse(input: string | URL): URL {
  const url = new URL(String(input));
  if (url.username || url.password || url.href.includes("#")) throw new Error("OAuth URLs cannot contain credentials or fragments.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("OAuth URLs must use HTTPS.");
  return url;
}

function policy(serverUrl: string | URL) {
  const server = parse(serverUrl);
  const configuredHost = hostname(server);
  const local = localName(configuredHost);
  if (server.protocol !== "https:" && !local) throw new Error("OAuth requires HTTPS except for a configured loopback MCP server.");
  let configuredAddresses: Promise<Address[]> | null = null;
  const resolve = async (name: string): Promise<Address[]> => {
    const family = isIP(name);
    const addresses = family ? [{ address: name, family }] : await lookup(name, { all: true });
    if (!addresses.length || addresses.some((entry) => !isIP(entry.address) || isIP(entry.address) !== entry.family)) throw new Error("OAuth host did not resolve to a valid address.");
    return addresses;
  };
  return async (input: string | URL): Promise<{ url: URL; address: Address }> => {
    const url = parse(input);
    const name = hostname(url);
    if (url.protocol !== "https:" && !(local && localName(name))) throw new Error("OAuth requires HTTPS except for a configured loopback MCP server.");
    // Freeze the user's configured host for this OAuth operation, including its LAN
    // address if explicitly configured. A public DNS answer cannot later rebind to LAN.
    const addresses = name === configuredHost
      ? await (configuredAddresses ??= resolve(name).catch((error) => { configuredAddresses = null; throw error; }))
      : await resolve(name);
    if (addresses.some(({ address }) => !publicAddress(address)
      && !(name === configuredHost && within(lan, address))
      && !(local && localName(name) && within(loopback, address)))) {
      throw new Error("OAuth discovery cannot access a private or reserved host other than the configured MCP host.");
    }
    if (url.protocol === "http:" && addresses.some(({ address }) => !within(loopback, address))) throw new Error("Plain HTTP OAuth is restricted to loopback addresses.");
    return { url, address: addresses.find((entry) => entry.family === 4) ?? addresses[0]! };
  };
}

function aborted(signal: AbortSignal): Error {
  const reason = (signal as AbortSignal & { reason?: unknown }).reason;
  return reason instanceof Error ? reason : new Error("OAuth request was canceled.");
}
function awaitSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); return Promise.reject(aborted(signal)); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(aborted(signal));
    signal.addEventListener("abort", cancel, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", cancel));
  });
}
async function deadline<T>(signal: AbortSignal | null | undefined, milliseconds: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  // React Native narrows the global AbortController declaration, but this file
  // runs only on Node, whose controller supports an abort reason.
  const controller = new AbortController() as { signal: AbortSignal; abort(reason?: unknown): void };
  const cancel = () => controller.abort(signal ? aborted(signal) : undefined);
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new Error("OAuth request timed out.")), milliseconds);
  timer.unref();
  try {
    if (controller.signal.aborted) throw aborted(controller.signal);
    return await awaitSignal(work(controller.signal), controller.signal);
  }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}

/** Validate a metadata/browser endpoint, including its current DNS answers. */
export async function validateOAuthUrl(input: string | URL, serverUrl: string | URL, signal?: AbortSignal): Promise<URL> {
  return deadline(signal, DEADLINE_MS, async (active) => (await awaitSignal(policy(serverUrl)(input), active)).url);
}

type OAuthFetchOptions = { timeoutMs?: number; maxResponseBytes?: number; headersOnly?: boolean };
function bounded(value: number | undefined, maximum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : maximum;
}

/** Bounded OAuth JSON transport. Redirects stay manual; the SDK enforces same-origin redirects. */
export function oauthFetch(serverUrl: string | URL, options: OAuthFetchOptions = {}): FetchLike {
  const destination = policy(serverUrl);
  const timeout = bounded(options.timeoutMs, DEADLINE_MS);
  const limit = bounded(options.maxResponseBytes, BODY_BYTES);
  return (input, init = {}) => deadline(init.signal, timeout, async (signal) => {
    const { url, address } = await awaitSignal(destination(input), signal);
    if (signal.aborted) throw aborted(signal);
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST"].includes(method)) throw new Error("Unsupported OAuth request method.");
    let body: Buffer | undefined;
    if (init.body != null) {
      if (typeof init.body === "string" || init.body instanceof URLSearchParams) body = Buffer.from(String(init.body));
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(init.body);
      else if (ArrayBuffer.isView(init.body)) body = Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
      else throw new Error("OAuth requests require a buffered body.");
      if (body.length > BODY_BYTES) throw new Error("OAuth request is too large.");
      if (method !== "POST") throw new Error("Only OAuth POST requests may contain a body.");
    }
    const headers = new Headers(init.headers);
    for (const name of headers.keys()) {
      if (["host", "connection", "transfer-encoding", "content-length", "cookie"].includes(name) || name.startsWith("proxy-")) throw new Error("Unsafe OAuth request header.");
    }
    headers.set("accept-encoding", "identity");
    if (body) headers.set("content-length", String(body.length));
    const pinnedLookup: RequestOptions["lookup"] = (_name, lookupOptions, callback) => {
      if (lookupOptions.all) callback(null, [{ address: address.address, family: address.family }]);
      else callback(null, address.address, address.family);
    };
    return new Promise<Response>((resolve, reject) => {
      let incoming: IncomingMessage | undefined;
      let settled = false;
      const finish = (error?: Error, response?: Response) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", cancel);
        if (error) { incoming?.destroy(); request.destroy(); reject(error); }
        else resolve(response!);
      };
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method, headers: Object.fromEntries(headers), lookup: pinnedLookup, agent: false, maxHeaderSize: 16 * 1024,
      }, (response) => {
        incoming = response;
        const asResponse = (body: Buffer | null) => {
          const status = response.statusCode ?? 502;
          if (init.redirect === "error" && [301, 302, 303, 307, 308].includes(status)) throw new Error("OAuth redirect was refused.");
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
          const result = new Response(method === "HEAD" || [204, 205, 304].includes(status) ? null : body, { status, headers: responseHeaders });
          Object.defineProperty(result, "url", { value: url.href });
          return result;
        };
        if (options.headersOnly) {
          // An unauthenticated MCP endpoint may already open an SSE stream. Its
          // challenge headers are sufficient; never wait for that stream to end.
          try { finish(undefined, asResponse(null)); }
          catch (error) { finish(error instanceof Error ? error : new Error("Invalid OAuth response.")); }
          response.destroy();
          request.destroy();
          return;
        }
        const contentLength = Number(response.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > limit) { finish(new Error("OAuth response exceeds the size limit.")); return; }
        if (response.headers["content-encoding"] && response.headers["content-encoding"] !== "identity") { finish(new Error("Compressed OAuth responses are not supported.")); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) finish(new Error("OAuth response exceeds the size limit."));
          else chunks.push(chunk);
        });
        response.on("aborted", () => finish(new Error("OAuth response ended before completion.")));
        response.on("error", (error) => finish(error));
        response.on("end", () => {
          try {
            finish(undefined, asResponse(Buffer.concat(chunks)));
          } catch (error) { finish(error instanceof Error ? error : new Error("Invalid OAuth response.")); }
        });
      });
      const cancel = () => finish(aborted(signal));
      request.on("error", (error) => finish(error));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else request.end(body);
    });
  });
}
