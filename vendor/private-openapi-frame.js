/* global window, document, URL */
(() => {
  "use strict";

  const script = document.currentScript;
  // Capture the non-credential channel label before Scalar changes its own hash.
  const frameKey = new URL(window.location.href).hash.slice(1);
  if (!script || !frameKey || window.parent === window) return;
  const parentOrigin = new URL(script.src).origin;
  let port = null;
  let reference = null;
  let destroyed = false;
  let rendering = false;
  let reportedLoaded = false;
  let scalarLoading = null;
  let pendingError = null;
  let content = null;
  const preference = window.matchMedia("(prefers-color-scheme: dark)");

  // Scalar 1.73.1 unconditionally reads localStorage during module initialization.
  // Its explicitly configured backing here is volatile and unique to this document,
  // not a fallback to persistent/native storage (which stays denied by the sandbox).
  class MemoryStorage {
    #values = new Map();
    get length() { return this.#values.size; }
    key(index) {
      if (arguments.length < 1) throw new TypeError("Storage.key requires an index.");
      const position = index >>> 0;
      let current = 0;
      for (const key of this.#values.keys()) {
        if (current++ === position) return key;
      }
      return null;
    }
    getItem(key) {
      if (arguments.length < 1) throw new TypeError("Storage.getItem requires a key.");
      return this.#values.get(storageString(key)) ?? null;
    }
    setItem(key, value) {
      if (arguments.length < 2) throw new TypeError("Storage.setItem requires a key and value.");
      this.#values.set(storageString(key), storageString(value));
    }
    removeItem(key) {
      if (arguments.length < 1) throw new TypeError("Storage.removeItem requires a key.");
      this.#values.delete(storageString(key));
    }
    clear() { this.#values.clear(); }
  }
  function storageString(value) {
    if (typeof value === "symbol") throw new TypeError("A Storage value must be convertible to a string.");
    return String(value);
  }
  const storage = new MemoryStorage();

  function dispose() {
    if (destroyed) return;
    destroyed = true;
    content = null;
    preference.removeEventListener("change", updateTheme);
    window.removeEventListener("message", onConnect);
    try {
      reference?.destroy();
    } finally {
      reference = null;
      storage.clear();
      if (port) {
        port.onmessage = null;
        port.onmessageerror = null;
        port.close();
        port = null;
      }
    }
  }

  function errorText(error) {
    return error instanceof Error ? error.message.slice(0, 300) : "The local renderer raised an unexpected error.";
  }
  function fail(error) {
    if (destroyed) return;
    const message = errorText(error);
    if (!port) {
      pendingError = message;
      return;
    }
    port.postMessage({ type: "error", message });
    dispose();
  }

  function updateTheme() {
    reference?.updateConfiguration({
      darkMode: preference.matches,
      forceDarkModeState: preference.matches ? "dark" : "light",
    });
  }

  // A single cached load per frame. The unchanged licensed library is a fixed local
  // asset; no URL from the schema, a message or the API can choose executable code.
  function loadScalar() {
    if (!scalarLoading) {
      scalarLoading = new Promise((resolve, reject) => {
        try {
          Object.defineProperty(window, "localStorage", {
            value: storage,
            writable: false,
            configurable: false,
          });
          if (window.localStorage !== storage) throw new Error("Volatile renderer storage could not be installed.");
        } catch (error) {
          reject(error);
          return;
        }
        const vendor = document.createElement("script");
        vendor.src = new URL("/vendor/scalar-1.73.1.js", parentOrigin).href;
        vendor.onload = () => {
          if (typeof window.Scalar?.createApiReference !== "function") {
            reject(new Error("The local Scalar library did not initialize."));
          } else {
            resolve(window.Scalar);
          }
        };
        vendor.onerror = () => reject(new Error("The local Scalar library could not be loaded."));
        document.head.append(vendor);
      });
    }
    return scalarLoading;
  }

  async function render() {
    try {
      const scalar = await loadScalar();
      if (destroyed) return;
      reference = scalar.createApiReference(document.getElementById("scalar-docs"), {
        content,
        // SDK document readiness is independent of offscreen/background paint scheduling.
        onLoaded: () => {
          if (destroyed || reportedLoaded) return;
          reportedLoaded = true;
          port?.postMessage({ type: "rendered" });
        },
        proxyUrl: "",
        persistAuth: false,
        withDefaultFonts: false,
        telemetry: false,
        agent: { disabled: true },
        mcp: { disabled: true },
        hideClientButton: true,
        hideTestRequestButton: true,
        showDeveloperTools: "never",
        darkMode: preference.matches,
        forceDarkModeState: preference.matches ? "dark" : "light",
        hideDarkModeToggle: true,
      });
      content = null;
      // Report Vue render failures as failures, never as a working empty reference.
      if (reference.app?.config) reference.app.config.errorHandler = fail;
      preference.addEventListener("change", updateTheme);
    } catch (error) {
      content = null;
      fail(error);
    }
  }

  function onConnect(event) {
    if (destroyed || port || event.source !== window.parent || event.origin !== parentOrigin ||
        event.data?.type !== "deceipt-openapi-connect" || event.data.frameKey !== frameKey ||
        event.ports.length !== 1) return;
    window.removeEventListener("message", onConnect);
    port = event.ports[0];
    port.onmessageerror = () => fail(new Error("The private reference message could not be read."));
    port.onmessage = (message) => {
      if (destroyed) return;
      if (message.data?.type === "dispose") {
        dispose();
      } else if (message.data?.type === "render" && !rendering) {
        const specification = message.data.content;
        if (!specification || typeof specification !== "object" || Array.isArray(specification)) {
          fail(new Error("The private reference document was not an object."));
          return;
        }
        rendering = true;
        content = specification;
        void render();
      }
    };
    port.start();
    if (pendingError) {
      fail(new Error(pendingError));
      pendingError = null;
      return;
    }
    port.postMessage({ type: "connected" });
  }

  window.addEventListener("message", onConnect);
  window.addEventListener("error", (event) => fail(event.error ?? new Error(event.message)));
  window.addEventListener("unhandledrejection", (event) => fail(event.reason));
  window.addEventListener("pagehide", dispose, { once: true });
  window.addEventListener("unload", dispose, { once: true });
})();
