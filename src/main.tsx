import React from "react";
import ReactDOM from "react-dom/client";
// Bundled (offline-safe) fonts — Vite emits the woff2 into the build and the
// PWA workbox config precaches **/*.woff2, so they render with no network.
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
