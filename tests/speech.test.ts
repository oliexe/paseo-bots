import { describe, expect, it } from "vitest";
import { speakableText, speechChunks } from "../shared/speech";

describe("reading replies aloud", () => {
  it("reads the words, not the markdown", () => {
    const reply = "## Done\n\nI **saved** the [report](https://x.test/r) as `report.md`:\n\n```ts\nconst a = 1;\n```\n\n- first\n- second\n\nSee https://example.com for more.";
    expect(speakableText(reply)).toBe("Done I saved the report as report.md: first second See for more.");
  });

  it("reads long replies in whole sentences of a couple hundred characters", () => {
    const sentence = "This sentence is about fifty characters long, ok. ";
    const chunks = speechChunks(sentence.repeat(10));
    expect(chunks.length).toBe(3);
    expect(chunks.every((chunk) => chunk.length <= 220 && chunk.endsWith("ok."))).toBe(true);
    expect(speechChunks("```\ncode only\n```")).toEqual([]);
  });
});
