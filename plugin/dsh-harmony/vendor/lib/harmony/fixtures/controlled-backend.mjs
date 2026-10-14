/** Fault injection shared by device-runtime behavior tests. No real HDC calls. */
export function controlledBackend() {
  const calls = [];
  const capabilities = { uiTree: true, screenshot: true, tap: true, swipe: true, inputText: true, keys: true, launchApp: true };
  const state = {
    devices: ["phone-1", "phone-2"].map(serial => ({ serial, state: "online", capabilities })),
    observation: {
      quality: { treeStatus: "valid", scopeComplete: true, scope: "window", appId: "com.test.app", windowId: "1" },
      tree: { children: [] },
      nodes: [{ id: "open", text: "Open", type: "Button", clickable: true, enabled: true, visible: true,
        bounds: { left: 10, top: 20, right: 110, bottom: 60 } }],
    },
    snapshotHook: undefined,
    tapHook: undefined,
  };
  const backend = {
    kind: "controlled-fixture",
    async displayGeometry() { return { nativeWidth: 1440, nativeHeight: 3200, displayRotation: 0, displayId: "0" }; },
    async listDevices() { return structuredClone(state.devices); },
    async snapshot(serial, options) {
      calls.push({ action: "snapshot", serial });
      await state.snapshotHook?.(serial, options);
      return structuredClone(state.observation);
    },
    async tap(serial, x, y, signal) {
      calls.push({ action: "tap", serial, x, y });
      await state.tapHook?.(serial, signal);
    },
    async swipe(serial, ...args) { calls.push({ action: "swipe", serial, args }); },
    async inputText(serial, text) { calls.push({ action: "input_text", serial, text }); },
    async pressKey(serial, key) { calls.push({ action: "press_key", serial, key }); },
    async launchApp(serial, bundleName) { calls.push({ action: "launch_app", serial, bundleName }); },
    async installPackage(serial, hapPath) { calls.push({ action: "install_app", serial, hapPath }); },
    async clearAppData(serial, bundleName) { calls.push({ action: "clear_app_data", serial, bundleName }); },
    async uninstallPackage(serial, bundleName) { calls.push({ action: "uninstall_app", serial, bundleName }); },
  };
  return { backend, calls, state };
}

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
