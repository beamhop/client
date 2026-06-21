/// <reference lib="dom" />
/**
 * Capture every Beamhop surface (views + modals + wizard) headlessly via CDP for
 * design-fidelity review. Writes PNGs to /tmp/beamhop-shot/v2-*.png and prints any
 * console errors. Usage: bun scripts/capture-all.ts [theme]
 */
import { spawn } from "bun";

const IDENTITY = await Bun.file("/tmp/beamhop-shot/identity.json").text();
const THEME = process.argv[2] === "dark" ? "dark" : "light";
const PORT = 9251;
const BASE = "http://localhost:3000";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const chrome = spawn([
  CHROME, "--headless", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
  `--remote-debugging-port=${PORT}`, "--user-data-dir=/tmp/beamhop-shot/profile-v2",
  "--window-size=1340,940", "about:blank",
]);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const wsUrl = await (async (): Promise<string> => {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://localhost:${PORT}/json/version`);
      const json = (await res.json()) as { webSocketDebuggerUrl: string };
      if (json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
    } catch { /* not up */ }
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
  const msg = JSON.parse(String(ev.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)?.(msg.result ?? {}); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") {
    const p = msg.params as { exceptionDetails?: { exception?: { description?: string }; text?: string } };
    errors.push(`EXCEPTION: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
  }
  if (msg.method === "Runtime.consoleAPICalled") {
    const p = msg.params as { type: string; args: { value?: unknown; description?: string }[] };
    if (p.type === "error") errors.push(`CONSOLE.ERROR: ${p.args.map((a) => a.description ?? JSON.stringify(a.value)).join(" ")}`);
  }
};
const send = (method: string, params: Record<string, unknown> = {}, useSession = true): Promise<Record<string, unknown>> => {
  const id = ++seq;
  const payload: Record<string, unknown> = { id, method, params };
  if (useSession && sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res) => pending.set(id, res));
};

const targets = (await send("Target.getTargets", {}, false)) as { targetInfos: { targetId: string; type: string }[] };
const page = targets.targetInfos.find((t) => t.type === "page");
if (!page) throw new Error("no page target");
const attach = (await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }, false)) as { sessionId: string };
sessionId = attach.sessionId;
await send("Page.enable");
await send("Runtime.enable");

await send("Page.navigate", { url: BASE });
await sleep(1200);
await send("Runtime.evaluate", { expression: `localStorage.setItem('beamhop.identity.v1', ${JSON.stringify(IDENTITY)}); localStorage.setItem('beamhop.theme.v1','${THEME}');` });
await send("Page.reload", {});
await sleep(2600);

const evalJs = (expression: string) => send("Runtime.evaluate", { expression });
const clickTestId = (id: string) => evalJs(`(()=>{const e=document.querySelector('[data-testid="${id}"]'); if(e){e.click(); return 'ok'} return 'missing'})()`);
const clickText = (re: string) => evalJs(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>/${re}/i.test(x.textContent||'')); if(b){b.click(); return 'ok'} return 'missing'})()`);
const shot = async (name: string, wait = 900): Promise<void> => {
  await sleep(wait);
  const s = (await send("Page.captureScreenshot", { format: "png" })) as { data: string };
  await Bun.write(`/tmp/beamhop-shot/v2-${name}.png`, Buffer.from(s.data, "base64"));
  console.log(`captured ${name}`);
};

// Main views via sidebar nav
await shot("home", 1500);
await clickTestId("nav-explore"); await shot("explore");
await clickTestId("nav-docs"); await shot("docs", 4500);
await clickTestId("nav-messages"); await shot("messages", 1500);
await clickTestId("nav-agents"); await shot("agents");
await clickTestId("nav-profile"); await shot("profile", 2500);
await clickTestId("nav-security"); await shot("security");

// Modals / overlays
await clickTestId("nav-home"); await sleep(800);
await clickTestId("compose-button-sidebar"); await shot("compose-modal", 700);
await evalJs(`document.querySelector('[data-testid="compose-close"]')?.click()`); await sleep(400);

await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true}))`); await shot("command-palette", 700);
await evalJs(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);
// palette closes via its own Escape handler on the input; also click backdrop
await evalJs(`document.querySelector('[data-testid="command-palette"]')?.click()`); await sleep(400);

// Agent wizard
await clickTestId("nav-agents"); await sleep(800);
await clickText("Create"); await shot("agent-wizard", 800);
await evalJs(`document.querySelector('[data-testid="wizard-close"]')?.click() || document.querySelector('[data-testid="modal-wizard"]')?.click()`); await sleep(400);

// Article editor (from Home → Write article)
await clickTestId("nav-home"); await sleep(700);
await clickText("Write article"); await shot("article-editor", 900);

// Doc editor
await clickTestId("nav-docs"); await sleep(800);
await clickText("Write documentation"); await shot("doc-editor", 900);

await sleep(300);
console.log(`\n=== RUNTIME ERRORS (${errors.length}) [theme=${THEME}] ===`);
for (const e of [...new Set(errors)]) console.log(e);
ws.close();
chrome.kill();
await sleep(200);
process.exit(0);
