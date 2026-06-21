import { describe, expect, test } from "bun:test";
import { parseHashRoute, routeToHash, type Nav } from "../store.tsx";

const pk = "a".repeat(64);

describe("routeToHash", () => {
  test.each<[Nav, string]>([
    [{ view: "home", params: {} }, "#/"],
    [{ view: "explore", params: {} }, "#/explore"],
    [{ view: "notifications", params: {} }, "#/notifications"],
    [{ view: "docs", params: {} }, "#/docs"],
    [{ view: "agents", params: {} }, "#/agents"],
    [{ view: "security", params: {} }, "#/settings"],
    [{ view: "messages", params: {} }, "#/messages"],
    [{ view: "messages", params: { pubkey: pk } }, `#/messages/${pk}`],
    [{ view: "docReader", params: { id: "guide" } }, "#/docs/guide"],
    [{ view: "docReader", params: { pubkey: pk, id: "guide" } }, `#/docs/${pk}/guide`],
    [{ view: "docEditor", params: {} }, "#/docs/new"],
    [{ view: "docEditor", params: { id: "guide" } }, "#/docs/guide/edit"],
    [{ view: "docEditor", params: { pubkey: pk, id: "guide" } }, `#/docs/${pk}/guide/edit`],
    [{ view: "postDetail", params: { id: "note1" } }, "#/posts/note1"],
    [{ view: "postDetail", params: {} }, "#/"],
    [{ view: "articleReader", params: { id: "x" } }, "#/articles/x"],
    [{ view: "articleReader", params: { pubkey: pk, id: "x" } }, `#/articles/${pk}/x`],
    [{ view: "articleEditor", params: {} }, "#/articles/new"],
    [{ view: "articleEditor", params: { id: "x" } }, "#/articles/x/edit"],
  ])("%o → %s", (nav, hash) => {
    expect(routeToHash(nav)).toBe(hash);
  });

  test("encodes a tab query for profile and agent detail", () => {
    expect(routeToHash({ view: "profile", params: { pubkey: pk, tab: "replies" } })).toBe(
      `#/profile/${pk}?tab=replies`,
    );
    expect(routeToHash({ view: "agentDetail", params: { id: "bot", agentTab: "activity" } })).toBe(
      "#/agents/bot?tab=activity",
    );
  });

  test("drops an invalid tab during normalization", () => {
    expect(routeToHash({ view: "profile", params: { pubkey: pk, tab: "bogus" } })).toBe(`#/profile/${pk}`);
  });

  test("profile without a pubkey routes to the signed-in profile", () => {
    expect(routeToHash({ view: "profile", params: {} })).toBe("#/profile");
  });
});

describe("parseHashRoute", () => {
  test.each<[string, Nav]>([
    ["", { view: "home", params: {} }],
    ["#/", { view: "home", params: {} }],
    ["#/explore", { view: "explore", params: {} }],
    ["#/notifications", { view: "notifications", params: {} }],
    ["#/docs", { view: "docs", params: {} }],
    ["#/docs/new", { view: "docEditor", params: {} }],
    ["#/docs/guide", { view: "docReader", params: { id: "guide" } }],
    ["#/docs/guide/edit", { view: "docEditor", params: { id: "guide" } }],
    [`#/docs/${pk}/guide`, { view: "docReader", params: { pubkey: pk, id: "guide" } }],
    [`#/docs/${pk}/guide/edit`, { view: "docEditor", params: { pubkey: pk, id: "guide" } }],
    ["#/messages", { view: "messages", params: {} }],
    [`#/messages/${pk}`, { view: "messages", params: { pubkey: pk } }],
    ["#/agents", { view: "agents", params: {} }],
    ["#/settings", { view: "security", params: {} }],
    ["#/me", { view: "profile", params: {} }],
    ["#/posts/n1", { view: "postDetail", params: { id: "n1" } }],
    ["#/articles/new", { view: "articleEditor", params: {} }],
    ["#/articles/x/edit", { view: "articleEditor", params: { id: "x" } }],
  ])("%s → %o", (hash, nav) => {
    expect(parseHashRoute(hash)).toEqual(nav);
  });

  test("accepts short aliases (d/p/n/a/people/notes)", () => {
    expect(parseHashRoute("#/d/guide")).toEqual({ view: "docReader", params: { id: "guide" } });
    expect(parseHashRoute("#/n/n1")).toEqual({ view: "postDetail", params: { id: "n1" } });
    expect(parseHashRoute("#/notes/n1")).toEqual({ view: "postDetail", params: { id: "n1" } });
    expect(parseHashRoute("#/a/x")).toEqual({ view: "articleReader", params: { id: "x" } });
    expect(parseHashRoute(`#/p/${pk}`)).toEqual({ view: "profile", params: { pubkey: pk, tab: undefined } });
    expect(parseHashRoute(`#/people/${pk}`)).toEqual({ view: "profile", params: { pubkey: pk, tab: undefined } });
  });

  test("reads a valid ?tab= query and ignores an invalid one", () => {
    expect(parseHashRoute(`#/profile/${pk}?tab=replies`)).toEqual({
      view: "profile",
      params: { pubkey: pk, tab: "replies" },
    });
    expect(parseHashRoute(`#/profile/${pk}?tab=nope`)).toEqual({
      view: "profile",
      params: { pubkey: pk, tab: undefined },
    });
  });

  test("an unknown path falls back to home", () => {
    expect(parseHashRoute("#/totally-unknown")).toEqual({ view: "home", params: {} });
  });

  test("bare agents alias with no id stays on the agents list", () => {
    expect(parseHashRoute("#/agents")).toEqual({ view: "agents", params: {} });
  });

  test("agent detail reads its tab from the query string", () => {
    expect(parseHashRoute("#/agents/bot?tab=activity")).toEqual({
      view: "agentDetail",
      params: { id: "bot", agentTab: "activity" },
    });
  });
});

describe("route round-trips", () => {
  test.each<Nav>([
    { view: "home", params: {} },
    { view: "explore", params: {} },
    { view: "docReader", params: { pubkey: pk, id: "guide" } },
    { view: "docEditor", params: { id: "guide" } },
    { view: "messages", params: { pubkey: pk } },
    { view: "postDetail", params: { id: "n1" } },
    { view: "articleReader", params: { pubkey: pk, id: "x" } },
    { view: "profile", params: { pubkey: pk, tab: "replies" } },
    { view: "agentDetail", params: { id: "bot", agentTab: "activity" } },
  ])("parse(routeToHash(%o)) is stable", (nav) => {
    expect(parseHashRoute(routeToHash(nav))).toEqual(nav);
  });
});
