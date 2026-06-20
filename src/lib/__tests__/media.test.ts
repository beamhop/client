import { describe, expect, test } from "bun:test";
import { parseMedia } from "../media.ts";

describe("parseMedia", () => {
  test("text with no URLs is returned unchanged with no embeds", () => {
    expect(parseMedia("just some words")).toEqual({ text: "just some words", embeds: [] });
  });

  test("extracts an image URL as an image embed and strips it from the text", () => {
    const { text, embeds } = parseMedia("look https://cdn.example/cat.png cute");
    expect(embeds).toEqual([{ type: "image", url: "https://cdn.example/cat.png" }]);
    expect(text).toBe("look cute");
  });

  test("recognizes every supported image extension", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "avif"]) {
      const { embeds } = parseMedia(`https://x/y.${ext}`);
      expect(embeds[0]).toEqual({ type: "image", url: `https://x/y.${ext}` });
    }
  });

  test("recognizes every supported video extension", () => {
    for (const ext of ["mp4", "webm", "mov", "m4v"]) {
      const { embeds } = parseMedia(`https://x/y.${ext}`);
      expect(embeds[0]).toEqual({ type: "video", url: `https://x/y.${ext}` });
    }
  });

  test("ignores the query string and fragment when sniffing the extension", () => {
    const { embeds } = parseMedia("https://cdn.example/clip.mp4?token=abc#t=10");
    expect(embeds).toEqual([{ type: "video", url: "https://cdn.example/clip.mp4?token=abc#t=10" }]);
  });

  test("non-media links are left inline and produce no embed", () => {
    const { text, embeds } = parseMedia("read https://example.com/post here");
    expect(embeds).toEqual([]);
    expect(text).toBe("read https://example.com/post here");
  });

  test("collects multiple embeds of mixed types", () => {
    const { embeds } = parseMedia("https://a/1.png and https://b/2.webm");
    expect(embeds).toEqual([
      { type: "image", url: "https://a/1.png" },
      { type: "video", url: "https://b/2.webm" },
    ]);
  });

  test("extension matching is case-insensitive", () => {
    expect(parseMedia("https://x/Y.PNG").embeds[0]?.type).toBe("image");
  });
});
