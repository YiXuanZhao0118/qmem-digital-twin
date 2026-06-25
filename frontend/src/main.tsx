import React from "react";
import ReactDOM from "react-dom/client";
import * as THREE from "three";

import App from "./App";
import "./styles.css";

// Cache fetched asset files (GLB/STL/…) by URL across every three.js loader for
// the whole session. Without this, switching views re-fetches the same mesh
// every time — over a LAN (phone client) that's slow enough that a cable's
// connector shows its procedural low-detail fallback until the GLB finishes
// loading, and only "snaps" to full detail after another view (the ASSET3D
// editor) has already pulled it into the browser cache. Asset URLs are unique
// per upload (UUID filename), so a cached entry can never go stale.
THREE.Cache.enabled = true;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

