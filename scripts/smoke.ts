/// <reference lib="dom" />
/**
 * Headless runtime smoke test: launches Chrome via CDP, injects a test identity,
 * visits each view, captures console errors + uncaught exceptions, and screenshots.
 * Usage: bun scripts/smoke.ts
 */
import { spawn } from "bun";

const IDENTITY = await Bun.file("/tmp/beamhop-shot/identity.json").text();
const PORT = 9242;
const BASE = "http://localhost:3000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chrome = spawn([
  CHROME,
  "--headless",
  "--disable-gpu",
  "--no-sandbox",
  "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`,
  "--user-data-dir=/tmp/beamhop-shot/profile",
  "--window-size=1340,940",
  "about:blank",
]);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const wsUrl = await (async (): Promise<string> => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl: string };
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch {
      // not up yet
    }
    await sleep(150);
  }
  throw new Error("Chrome CDP never came up");
})();

const ws = new WebSocket(wsUrl);
await new Promise<void>((res) => (ws.onopen = () => res()));

let seq = 0;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
const errors: string[] = [];
let sessionId: string | undefined;

ws.onmessage = (ev) => {
  const msg = JSON.parse(String(ev.data)) as {
    id?: number;
    method?: string;
    params?: Record<string, unknown>;
    result?: Record<string, unknown>;
  };
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.result ?? {});
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") {
    const p = msg.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } };
    errors.push(`EXCEPTION: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const p = msg.params as { type: string; args: { value?: unknown; description?: string }[] };
    if (p.type === "error") {
      errors.push(`CONSOLE.ERROR: ${p.args.map((a) => a.description ?? JSON.stringify(a.value)).join(" ")}`);
    }
  }
};

const send = (method: string, params: Record<string, unknown> = {}, useSession = true): Promise<Record<string, unknown>> => {
  const id = ++seq;
  const payload: Record<string, unknown> = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res) => pending.set(id, res));
};

// Attach to a page target.
const targets = (await send("Target.getTargets", {}, false)) as { targetInfos: { targetId: string; type: string }[] };
const page = targets.targetInfos.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const attach = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false)) as {
  sessionId: string;
};
sessionId = attach.sessionId;

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// Seed localStorage with the identity, then load the app.
await send("Page.navigate", { url: BASE });
await sleep(1500);
await send("Runtime.evaluate", {
  expression: `localStorage.setItem('beamhop.identity.v1', ${JSON.stringify(IDENTITY)}); localStorage.setItem('beamhop.theme.v1','light');`,
});
await send("Page.reload", {});
await sleep(2500);

const views: { name: string; nav: string }[] = [
  { name: "home", nav: "" },
  { name: "explore", nav: "explore" },
  { name: "docs", nav: "docs" },
  { name: "doc-editor", nav: "docEditor" },
  { name: "messages", nav: "messages" },
  { name: "agents", nav: "agents" },
  { name: "profile", nav: "profile" },
  { name: "security", nav: "security" },
];

for (const v of views) {
  if (v.nav) {
    // drive navigation through the app's store by dispatching a click is hard; instead
    // reach into React is not exposed — so we use a hash-free approach: simulate via
    // window by calling the exposed navigate if present, else click the sidebar button.
    await send("Runtime.evaluate", {
      expression: `(() => {
        const labels = { explore:'Explore', docs:'Docs', messages:'Messages', agents:'Agents', profile:'Profile', security:'Keys & Security', docEditor:'__docEditor__' };
        const want = ${JSON.stringify(v.nav)};
        const btns = [...document.querySelectorAll('button')];
        if (want === 'docEditor') {
          const docsBtn = btns.find(b => b.textContent.trim() === 'Docs'); if (docsBtn) docsBtn.click();
          setTimeout(() => { const w = [...document.querySelectorAll('button')].find(b => /Write documentation/i.test(b.textContent)); if (w) w.click(); }, 400);
          return 'docEditor';
        }
        const lbl = labels[want];
        const btn = btns.find(b => b.textContent.trim() === lbl);
        if (btn) { btn.click(); return 'clicked ' + lbl; }
        return 'no button for ' + want;
      })()`,
    });
    await sleep(900);
  }
  const shot = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Bun.write(`/tmp/beamhop-shot/app-${v.name}.png`, Buffer.from(shot.data, "base64"));
  console.log(`captured ${v.name}`);
}

await sleep(400);
console.log("\n=== RUNTIME ERRORS (" + errors.length + ") ===");
for (const e of [...new Set(errors)]) console.log(e);

ws.close();
chrome.kill();
await sleep(200);
process.exit(0);
