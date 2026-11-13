// Demo/test helper: opens the real side panel in this window and starts a check. Not used by normal users.
document.getElementById("open").addEventListener("click", async () => {
  const win = await chrome.windows.getCurrent();
  await chrome.sidePanel.open({ windowId: win.id });
});
document.getElementById("run").addEventListener("click", () => chrome.runtime.sendMessage({ type: "firstscreen-run" }));
