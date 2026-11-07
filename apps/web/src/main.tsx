import "@shabboo/kit/fonts.css";
import "@shabboo/kit/styles.css";
import "@shabboo/kit/react.css";
import "./styles/app.css";
// the page language and direction (?lang=fa), before any module reads them
import "./lib/locale.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
