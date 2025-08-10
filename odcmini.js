"use strict";

/**
 * svcstatus – Device Plugins tab: show OneDriveCheckService status
 *
 * SAFE:
 * - No UI injection into global pages
 * - No DB writes
 * - No Express hooks
 * - Uses only: onDeviceRefreshEnd + pluginadmin bridge + runcommands (reply:true)
 *
 * How it shows up:
 * - Open a device → Plugins tab → "Service: OneDriveCheck"
 * - You’ll see status + a Refresh button
 */

module.exports.svcstatus = function (parent) {
  const obj = {};
  obj.parent = parent;            // plugin handler
  obj.meshServer = parent.parent; // MeshCentral server
  const wsserver = obj.meshServer.webserver;

  // Exported hooks (keep it minimal)
  obj.exports = [ "onDeviceRefreshEnd", "handleAdminReq", "hook_processAgentData" ];

  // ---- config: service name (hardcoded per your request)
  const SERVICE_NAME = "OneDriveCheckService";

  // ---- small logger helpers
  const log = (m)=>{ try{ obj.meshServer.info("svcstatus: " + m); }catch{ console.log("svcstatus:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("svcstatus error: " + (e && e.stack || e)); }catch{ console.error("svcstatus error:", e); } };

  // ---- reply tracking
  const pend = new Map();
  function makeResponseId(){ return 'svc_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // Handle agent replies
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (p) {
          pend.delete(command.responseid);
          clearTimeout(p.timeout);
          const raw = (command.console || command.result || '').toString();
          p.resolve({ ok:true, raw });
        }
      }
    } catch (e) { err(e); }
  };

  // Send runcommands to an agent and await reply (local or peer not required; you said direct)
  function runCommandsAndWait(nodeId, type, lines){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                     // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: false,         // run as agent
        reply: true,
        responseid
      };

      // timeout
      const timeout = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      const agent = wsserver && wsserver.wsagents ? wsserver.wsagents[nodeId] : null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
      } else {
        resolve({ ok:false, raw:'', meta:'offline' });
      }
    });
  }

  // Parse Windows SC output → Running / NotRunning / NotFound
  function parseSvc(raw){
    const s = String(raw||'');
    if (/RUNNING/i.test(s)) return 'Running';
    if (/does not exist|OpenService FAILED|SERVICE_NAME:.*\bFAILED\b/i.test(s)) return 'NotFound';
    // If it mentions STOPPED or we didn’t match RUNNING, call it NotRunning
    if (/STOPPED|STATE\s*:\s*\d+\s+STOPPED/i.test(s)) return 'NotRunning';
    return 'NotRunning';
  }

  // Query service status on Windows (fast BAT)
  async function svcStatusWin(nodeId){
    const line = `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning`;
    const res = await runCommandsAndWait(nodeId, 'bat', line);
    if (!res.ok) return { ok:false, status:'Offline', raw:res.raw||'', meta:res.meta };
    const m = /svc\s*=\s*(Running|NotRunning)/i.exec(res.raw||'');
    const status = m ? (m[1]==='Running'?'Running':'NotRunning') : parseSvc(res.raw);
    return { ok:true, status, raw:res.raw||'' };
  }

  // ---- admin bridge endpoints (used only by our device-tab iframe)
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      // Health
      if (req.query.health == 1) { res.json({ ok:true, plugin:'svcstatus', exports:obj.exports }); return; }

      // UI panel (iframe)
      if (req.query.panel == 1) {
        const nodeid = String(req.query.nodeid||'');
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8">
<title>Service: OneDriveCheck</title>
<link rel="stylesheet" href="/public/semantic/semantic.min.css">
<div style="padding:14px">
  <h3 class="ui header">
    <i class="cog icon"></i>
    <div class="content">Service: OneDriveCheck <div class="sub header">${SERVICE_NAME}</div></div>
  </h3>
  <div id="out" class="ui segment">Checking…</div>
  <button class="ui button" id="refresh">Refresh</button>
</div>
<script>
  (function(){
    const nodeid = ${JSON.stringify(nodeid)};
    const out = document.getElementById('out');
    const btn = document.getElementById('refresh');
    async function check(){
      out.textContent = 'Checking…';
      try{
        const r = await fetch('/pluginadmin.ashx?pin=svcstatus&status=1&id=' + encodeURIComponent(nodeid), { credentials:'same-origin' });
        const j = await r.json();
        const s = j && j.status ? j.status : 'Unknown';
        const raw = j && j.raw ? j.raw : '';
        out.innerHTML = '<b>Status:</b> ' + s + (raw ? '<pre style="margin-top:8px;white-space:pre-wrap">'+String(raw).replace(/[&<>]/g, c=>({\"&\":\"&amp;\",\"<\":\"&lt;\",\">\":\"&gt;\"}[c]))+'</pre>':'');
      }catch(e){ out.textContent = 'Error'; }
    }
    btn.addEventListener('click', check);
    check();
  })();
</script>`);
        return;
      }

      // Status (Windows only)
      if (req.query.status == 1) {
        const id = String(req.query.id||'').trim();
        const nodeId = id.startsWith('node//') ? id : ('node//' + id);
        const agent = wsserver && wsserver.wsagents ? wsserver.wsagents[nodeId] : null;
        if (!agent) { res.json({ id:nodeId, ok:false, status:'Offline', raw:'' }); return; }

        // OS detection (very light)
        const isWin = (agent.agentInfo && agent.agentInfo.platform && /win/i.test(agent.agentInfo.platform)) ||
                      (agent.dbNode && /Windows/i.test(agent.dbNode.osdesc||'')) || true; // default to Windows for your fleet

        if (!isWin) { res.json({ id:nodeId, ok:false, status:'NotSupported', raw:'' }); return; }

        const r = await svcStatusWin(nodeId);
        res.json({ id:nodeId, ok:r.ok, status:r.status, raw:r.raw||'' });
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // ---- Web UI hook: add a Plugins tab on the device page
  obj.onDeviceRefreshEnd = function() {
    // This runs in the browser context (Mesh UI). Use the standard pattern to add a plugin tab.
    // Keep it VERY small and safe.
    pluginHandler.registerPluginTab({ tabId: 'svcstatus', tabTitle: 'Service: OneDriveCheck' });
    // Render an iframe pointing to our admin bridge with the node id.
    // QA() helper exists in Mesh UI to put HTML into the tab div.
    try {
      // 'currentNode' is available in this context for the selected device.
      var nid = (typeof currentNodeId === 'function') ? currentNodeId() : (typeof currentNode === 'object' && currentNode && currentNode._id ? currentNode._id : null);
      if (!nid) { QA('svcstatus', '<div style="padding:12px">Select a device to view.</div>'); return; }
      QA('svcstatus', '<iframe style="width:100%;height:420px;border:0" src="/pluginadmin.ashx?pin=svcstatus&panel=1&nodeid=' + encodeURIComponent(nid) + '"></iframe>');
    } catch (e) {
      // If anything goes wrong, fail silently—no white screens.
    }
  };

  log("loaded");
  return obj;
};