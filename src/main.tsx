import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./state/store.tsx";
import { App } from "./App.tsx";

// PWA links injected at runtime (not static HTML) so Bun's HTML bundler doesn't
// try to resolve these runtime-served, root-absolute asset paths. Installability
// and iOS Add-to-Home-Screen both read the live DOM, so this is sufficient.
const addHeadLink = (rel: string, href: string, attrs: Record<string, string> = {}): void => {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = href;
  for (const [key, value] of Object.entries(attrs)) link.setAttribute(key, value);
  document.head.appendChild(link);
};
addHeadLink("manifest", "/manifest.webmanifest");
addHeadLink("apple-touch-icon", "/icons/apple-touch-icon-180.png", { sizes: "180x180" });

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
