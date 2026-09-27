import { describe, expect, it } from "vitest";
import { classifyFile, formatBytes, rejectReason, toWire } from "../shared/attachments";

describe("attachments", () => {
  it("classifies images, text and other files", () => {
    expect(classifyFile("a.png", "image/png")).toBe("image");
    expect(classifyFile("a.svg", "image/svg+xml")).toBe("file");
    expect(classifyFile("notes.md", "")).toBe("text");
    expect(classifyFile("data.json", "application/json")).toBe("text");
    expect(classifyFile("report.pdf", "application/pdf")).toBe("file");
  });

  it("enforces limits and host-only uploads", () => {
    expect(rejectReason("image", 11 * 1024 * 1024, true)).toMatch(/10 MB/);
    expect(rejectReason("file", 1000, false)).toMatch(/this host/);
    expect(rejectReason("text", 2 * 1024 * 1024, true)).toBeNull();
    expect(rejectReason("file", 1000, true)).toBeNull();
  });

  it("maps to Paseo's images and attachments", () => {
    expect(
      toWire([
        { kind: "image", id: "1", name: "a.png", mimeType: "image/png", size: 3, data: "AAA" },
        { kind: "text", id: "2", name: "notes.md", size: 5, text: "hello" },
        { kind: "file", id: "3", name: "r.pdf", mimeType: "application/pdf", size: 9, path: "/x/r.pdf" },
      ]),
    ).toEqual({
      images: [{ data: "AAA", mimeType: "image/png" }],
      attachments: [
        { type: "text", mimeType: "text/plain", title: "notes.md", text: "hello" },
        { type: "uploaded_file", id: "3", fileName: "r.pdf", mimeType: "application/pdf", size: 9, path: "/x/r.pdf" },
      ],
    });
    expect(formatBytes(1536)).toBe("1.5 KB");
  });
});

import { displayTitle } from "../shared/chat";

describe("chat titles", () => {
  it("hides the bot-name prefix older chats carry", () => {
    expect(displayTitle("[Email Manager] Triage my inbox")).toBe("Triage my inbox");
    expect(displayTitle("plain")).toBe("plain");
    expect(displayTitle(null)).toBe("New chat");
  });
});

import { avatarSvg, spriteAvatar } from "../shared/avatar";

describe("project icon", () => {
  it("renders the robot sprite as SVG", () => {
    const svg = avatarSvg(spriteAvatar("robot", 3));
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg.match(/<rect /g)!.length).toBeGreaterThan(20);
  });
});

import { getFileTypeLabel, normalizeMimeType, preflightFile } from "../shared/attachments";

describe("attachment preflight", () => {
  it("checks size before reading and demotes large text to a file", () => {
    expect(preflightFile("a.png", "image/png", 11 * 1024 * 1024, true)).toEqual({ kind: "image", reason: "Images can be up to 10 MB." });
    expect(preflightFile("big.log", "text/plain", 2 * 1024 * 1024, true)).toEqual({ kind: "file", reason: null });
    expect(preflightFile("big.log", "text/plain", 2 * 1024 * 1024, false).reason).toMatch(/this host/);
    expect(preflightFile("notes.md", "", 100, false)).toEqual({ kind: "text", reason: null });
  });

  it("normalises MIME types and labels file types like Paseo", () => {
    expect(normalizeMimeType("image/JPG")).toBe("image/jpeg");
    expect(normalizeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    expect(getFileTypeLabel("report.final.pdf")).toBe("PDF");
    expect(getFileTypeLabel("/tmp/x/notes.md")).toBe("MD");
    expect(getFileTypeLabel("Pasted text (12 words)")).toBeNull();
    expect(getFileTypeLabel(".env")).toBeNull();
    expect(getFileTypeLabel("Makefile")).toBeNull();
  });
});
