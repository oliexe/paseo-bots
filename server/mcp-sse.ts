const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

/** Preserve SSE framing, including CRLF split between chunks, without buffering an unbounded line. */
async function* lines(body: ReadableStream<Uint8Array>, limit: number): AsyncGenerator<{ raw: string; continuation?: true }> {
  const reader = body.getReader();
  let parts: Buffer[] = [];
  let bytes = 0;
  let pendingCR = false;
  let crLineBytes = 0;
  const append = (part: Buffer) => {
    bytes += part.byteLength;
    if (bytes > limit) throw new Error("The MCP server event exceeds the buffer limit.");
    if (part.byteLength) parts.push(part);
  };
  const take = () => { const line = Buffer.concat(parts, bytes).toString("utf8"); parts = []; bytes = 0; return line; };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) { if (bytes) yield { raw: take() }; return; }
      if (!value.byteLength) continue;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      let start = 0;
      if (pendingCR) {
        pendingCR = false;
        if (chunk[0] === 10) {
          if (crLineBytes + 1 > limit) throw new Error("The MCP server event exceeds the buffer limit.");
          start = 1;
          yield { raw: "\n", continuation: true };
        }
      }
      for (let index = start; index < chunk.length; index++) {
        if (chunk[index] !== 10 && chunk[index] !== 13) continue;
        const cr = chunk[index] === 13;
        if (cr && chunk[index + 1] === 10) index++;
        append(chunk.subarray(start, index + 1));
        start = index + 1;
        // CR is a complete delimiter on its own. Do not wait for another chunk to dispatch an event.
        if (cr && chunk[index] === 13 && start === chunk.length) { pendingCR = true; crLineBytes = bytes; }
        yield { raw: take() };
      }
      append(chunk.subarray(start));
    }
  } finally { await reader.cancel().catch(() => {}); }
}

interface Line { raw: string; field: string; value: string; ending: string }

/** Only legacy MCP endpoint data changes; comments, IDs, retry delays and other events retain their framing. */
export async function* rewriteSseEndpoints(
  body: ReadableStream<Uint8Array>,
  rewrite: (endpoint: string) => Promise<string>,
  maxBufferBytes = MAX_BUFFER_BYTES,
): AsyncGenerator<string> {
  let event = "message";
  let buffered: Line[] = [];
  let bytes = 0;
  let first = true;
  for await (const part of lines(body, maxBufferBytes)) {
    const raw = part.raw;
    if (part.continuation) {
      if (buffered.length) {
        if (++bytes > maxBufferBytes) throw new Error("The MCP server event exceeds the buffer limit.");
        const previous = buffered[buffered.length - 1]!;
        previous.raw += raw; previous.ending += raw;
      } else yield raw;
      continue;
    }
    const ending = /(?:\r\n|\r|\n)$/.exec(raw)?.[0] ?? "";
    let text = ending ? raw.slice(0, -ending.length) : raw;
    // EventSource ignores a leading UTF-8 BOM. Keep it in the forwarded bytes.
    if (first) { text = text.replace(/^\uFEFF/, ""); first = false; }
    if (!text && ending) {
      if (buffered.length) {
        if (event === "endpoint") {
          const endpoint = await rewrite(buffered.filter((line) => line.field === "data").map((line) => line.value).join("\n"));
          if (/[\r\n]/.test(endpoint)) throw new Error("The rewritten MCP endpoint contains a line break.");
          let replaced = false;
          for (const line of buffered) {
            if (line.field !== "data") yield line.raw;
            else if (!replaced) { yield `data: ${endpoint}${line.ending}`; replaced = true; }
          }
        } else {
          for (const line of buffered) yield line.raw;
        }
      }
      yield raw;
      event = "message"; buffered = []; bytes = 0;
      continue;
    }
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    const value = colon < 0 ? "" : text.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    // Heartbeats and reconnect metadata before data need not wait for an event separator.
    if (field !== "data" && !buffered.length) { yield raw; continue; }
    bytes += Buffer.byteLength(raw);
    if (bytes > maxBufferBytes) throw new Error("The MCP server event exceeds the buffer limit.");
    buffered.push({ raw, field, value, ending });
  }
  // An unterminated event is not dispatched by EventSource. Do not manufacture a separator at EOF.
  for (const line of buffered) yield line.raw;
}
