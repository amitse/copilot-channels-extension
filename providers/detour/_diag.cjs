const http = require("http");
const payload = JSON.stringify({
  code: `(function() {
    var b = window.__detourBridge;
    var badge = document.getElementById("__detour-badge");
    var host = document.getElementById("__detour-panel-host");
    return JSON.stringify({
      connected: b && b.connected,
      badgeExists: !!badge,
      badgeText: badge ? badge.textContent : null,
      badgeDisplay: badge ? badge.style.display : null,
      hostExists: !!host,
      hostChildren: host ? host.childNodes.length : 0
    });
  })()`
});
const req = http.request("http://localhost:9401/eval", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
}, (res) => {
  let d = "";
  res.on("data", (c) => d += c);
  res.on("end", () => console.log(d));
});
req.end(payload);
