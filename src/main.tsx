import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { StoreProvider } from "./state/store.tsx";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
);
