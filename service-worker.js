// Fires when the extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  console.log("[FindInImages] Extension installed.");
});

// Listen for messages from content scripts or the viewer
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ type: "PONG" });
  }
});
