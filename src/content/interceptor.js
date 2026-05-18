// ShadeXX content script (ISOLATED world)
// Milestone 1: scaffold only.
//
// Real interceptor work happens in Milestone 2. The MetaMask provider
// (window.ethereum) is set in the page's MAIN world, which this ISOLATED
// content script cannot touch directly. The Milestone 2 plan is:
//   1. This script injects a <script> tag pointing at a bundled
//      MAIN-world wrapper.
//   2. The MAIN-world wrapper proxies window.ethereum.request() and
//      dispatches CustomEvents.
//   3. This script listens for those CustomEvents and forwards them to
//      the background SW via chrome.runtime.sendMessage.
//
// For now: prove the content script is being injected at document_start
// and that the SW message channel is alive.

console.log('[shadexx] content script loaded on', location.hostname, 'at', document.readyState);

chrome.runtime.sendMessage({ type: 'PING' }, (response) => {
  if (chrome.runtime.lastError) {
    console.warn('[shadexx] sendMessage failed:', chrome.runtime.lastError.message);
    return;
  }
  console.log('[shadexx] PING response:', response);
});
