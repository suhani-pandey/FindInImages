// On install, create a dynamic declarativeNetRequest rule that redirects PDF
// navigations to our viewer with the original URL preserved as ?url=<encoded>.
// We can't do this in a static JSON rule because we need the extension ID at runtime.
chrome.runtime.onInstalled.addListener(async () => {
  const viewerBase = chrome.runtime.getURL("viewer/viewer.html");

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [
      {
        id: 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: {
            // \0 = the full matched URL; encoded into the ?url= param
            regexSubstitution: `${viewerBase}?url=\\0`,
          },
        },
        condition: {
          // Match http, https, and file URLs ending in .pdf
          // file:// interception also requires "Allow access to file URLs" in chrome://extensions
          regexFilter: "^(https?|file)://.*\\.pdf(\\?.*)?$",
          resourceTypes: ["main_frame", "sub_frame"],
        },
      },
    ],
  });

  console.log("[FindInImages] PDF redirect rule installed.");
});

// Listen for messages from the viewer or content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PING") {
    sendResponse({ type: "PONG" });
  }
});
