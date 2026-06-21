import { describe, expect, test } from "bun:test";
import { renderMarkdown, countWords, readingMinutes } from "../markdown.ts";

describe("renderMarkdown", () => {
  test("renders headings and builds a table of contents with slug ids", () => {
    const { html, toc } = renderMarkdown("# Title\n\n## Section one\n\nBody\n\n### Deep");
    expect(html).toContain('<h1 id="title">Title</h1>');
    expect(html).toContain('<h2 id="section-one">Section one</h2>');
    expect(toc).toEqual([
      { id: "title", text: "Title", level: 1 },
      { id: "section-one", text: "Section one", level: 2 },
      { id: "deep", text: "Deep", level: 3 },
    ]);
  });

  test("renders bold, italic and inline code", () => {
    const { html } = renderMarkdown("a **bold** and *em* and `code` here");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code</code>");
  });

  test("renders fenced code blocks verbatim and escaped", () => {
    const { html } = renderMarkdown("```\nconst x = 1 < 2;\n```");
    expect(html).toContain("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });

  test("renders unordered and ordered lists", () => {
    expect(renderMarkdown("- a\n- b").html).toBe("<ul><li>a</li><li>b</li></ul>");
    expect(renderMarkdown("1. a\n2. b").html).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  test("renders tables with header and rows", () => {
    const { html } = renderMarkdown("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<td>2</td>");
  });

  test("renders blockquotes", () => {
    expect(renderMarkdown("> quoted").html).toBe("<blockquote><p>quoted</p></blockquote>");
  });

  test("renders a horizontal rule from a thematic break", () => {
    expect(renderMarkdown("above\n\n---\n\nbelow").html).toContain("<hr>");
  });

  test("sanitizes dangerous link and image URL schemes", () => {
    const link = renderMarkdown("[x](javascript:alert(1))").html;
    expect(link).toContain('href="#"');
    expect(link).not.toContain("javascript:");
    const img = renderMarkdown("![x](javascript:alert(1))").html;
    expect(img).toContain('src="#"');
  });

  test("allows safe https links with target/rel", () => {
    const { html } = renderMarkdown("[ok](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  test("escapes raw html in text", () => {
    expect(renderMarkdown("a < b & c").html).toContain("a &lt; b &amp; c");
  });

  test("empty input yields empty output", () => {
    expect(renderMarkdown("")).toEqual({ html: "", toc: [] });
  });
});

describe("word counting", () => {
  test("countWords counts whitespace-separated tokens", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });

  test("readingMinutes is at least one and scales with length", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(400)).toBe(2);
  });
});
