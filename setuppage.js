'use strict';

/**
 * The page that fixes a locked-out frontend.
 *
 * Served by this server, so it is same-origin: the browser applies no CORS
 * check to its requests, and it can therefore edit the allowlist that every
 * other origin is judged against. That is the whole reason it exists here
 * rather than in the app — the app, at a new address, cannot reach the API at
 * all.
 *
 * No framework and no build step, because the one time this page matters is
 * when something else is already broken.
 */

function setupPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PatternDesk backend — allowed sites</title>
<style>
  :root { color-scheme: dark; --bg:#0f1216; --card:#171c22; --edge:#2a323b; --txt:#e6edf3;
          --dim:#8b98a5; --accent:#2f81f7; --dn:#f85149; --up:#3fb950; }
  * { box-sizing: border-box; }
  body { margin:0; padding:20px; background:var(--bg); color:var(--txt);
         font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { max-width:640px; margin:0 auto; }
  h1 { font-size:19px; margin:0 0 4px; }
  p.sub { color:var(--dim); font-size:13px; margin:0 0 20px; }
  .card { background:var(--card); border:1px solid var(--edge); border-radius:10px; padding:16px; margin-bottom:14px; }
  label { display:block; font-size:12px; color:var(--dim); margin-bottom:6px; }
  input { width:100%; padding:10px; font:inherit; background:var(--bg); color:var(--txt);
          border:1px solid var(--edge); border-radius:6px; }
  button { padding:10px 14px; font:inherit; font-weight:600; background:var(--accent); color:#fff;
           border:0; border-radius:6px; cursor:pointer; }
  button.ghost { background:transparent; color:var(--dim); border:1px solid var(--edge); font-weight:400; padding:6px 10px; }
  button:disabled { opacity:.5; cursor:default; }
  .row { display:flex; gap:8px; align-items:center; }
  .row input { flex:1; }
  ul { list-style:none; margin:12px 0 0; padding:0; }
  li { display:flex; align-items:center; gap:10px; padding:9px 0; border-top:1px solid var(--edge); }
  li code { flex:1; font-size:13px; word-break:break-all; }
  .msg { margin-top:12px; font-size:13px; }
  .err { color:var(--dn); }
  .ok { color:var(--up); }
  .note { font-size:12px; color:var(--dim); margin-top:14px; line-height:1.6; }
</style>
</head>
<body>
<main>
  <h1>Allowed sites</h1>
  <p class="sub">Browsers may call this backend only from an address on this list.
    Add your frontend's address here after moving it.</p>

  <div class="card">
    <label for="token">Auth token</label>
    <input id="token" type="password" autocomplete="off" spellcheck="false"
      placeholder="the same token the app uses">
    <div class="row" style="margin-top:10px">
      <button id="load">Show the list</button>
      <label style="margin:0;display:flex;align-items:center;gap:6px;color:var(--dim)">
        <input id="remember" type="checkbox" style="width:auto"> remember on this device
      </label>
    </div>
    <div id="authMsg" class="msg"></div>
  </div>

  <div class="card" id="listCard" hidden>
    <div class="row">
      <input id="newOrigin" placeholder="https://your-site.netlify.app" spellcheck="false" autocomplete="off">
      <button id="add">Add</button>
    </div>
    <ul id="list"></ul>
    <div id="listMsg" class="msg"></div>
    <div class="note" id="persistNote"></div>
  </div>

  <div class="note">
    This page is served by the backend itself, so it keeps working even when every
    frontend is locked out. Paste an address exactly as it appears in the browser's
    address bar — the path is ignored, only the site matters.
  </div>
</main>

<script>
(function(){
  var KEY = "pd-setup-token";
  var $ = function(id){ return document.getElementById(id); };
  var token = "";

  try { var saved = localStorage.getItem(KEY); if (saved) { $("token").value = saved; $("remember").checked = true; } } catch (e) {}

  // The app links here with its own address in the fragment, which browsers
  // never send to a server — it exists only so the box arrives filled in,
  // rather than asking someone to retype a Netlify address on a phone.
  try {
    var m = /(?:^|[#&])origin=([^&]+)/.exec(location.hash || "");
    if (m) $("newOrigin").value = decodeURIComponent(m[1]);
  } catch (e) {}

  function say(el, text, cls){ el.textContent = text; el.className = "msg" + (cls ? " " + cls : ""); }

  async function api(method, body){
    var res = await fetch("/api/origins", {
      method: method,
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: body ? JSON.stringify(body) : undefined
    });
    var data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data.success) {
      throw new Error(data.error || ("HTTP " + res.status + (res.status === 401 ? " — token rejected" : "")));
    }
    return data.allowed;
  }

  function render(state){
    var ul = $("list");
    ul.innerHTML = "";
    if (!state.origins.length) {
      var li = document.createElement("li");
      li.innerHTML = '<code style="color:var(--dim)">No sites allowed — every browser is locked out.</code>';
      ul.appendChild(li);
    }
    state.origins.forEach(function(o){
      var li = document.createElement("li");
      var code = document.createElement("code");
      code.textContent = o;
      var btn = document.createElement("button");
      btn.className = "ghost";
      btn.textContent = "remove";
      btn.onclick = function(){ act({ remove: o }, "Removed " + o); };
      li.appendChild(code); li.appendChild(btn);
      ul.appendChild(li);
    });
    $("persistNote").textContent = state.persistsAcrossRestart
      ? "Saved to disk — these survive a restart."
      : "This server has no disk, so a restart reverts to ALLOWED_ORIGINS.";
    $("listCard").hidden = false;
  }

  async function act(body, okText){
    say($("listMsg"), "Working…");
    try { render(await api("POST", body)); say($("listMsg"), okText, "ok"); }
    catch (err) { say($("listMsg"), err.message, "err"); }
  }

  $("load").onclick = async function(){
    token = $("token").value.trim();
    if (!token) { say($("authMsg"), "Enter the auth token first.", "err"); return; }
    say($("authMsg"), "Checking…");
    try {
      var state = await api("GET");
      say($("authMsg"), "", "");
      try {
        if ($("remember").checked) localStorage.setItem(KEY, token);
        else localStorage.removeItem(KEY);
      } catch (e) {}
      render(state);
    } catch (err) { say($("authMsg"), err.message, "err"); $("listCard").hidden = true; }
  };

  $("add").onclick = function(){
    var v = $("newOrigin").value.trim();
    if (!v) { say($("listMsg"), "Paste an address first.", "err"); return; }
    act({ add: v }, "Added " + v);
    $("newOrigin").value = "";
  };
  $("newOrigin").addEventListener("keydown", function(ev){ if (ev.key === "Enter") $("add").click(); });
})();
</script>
</body>
</html>`;
}

module.exports = { setupPage };
