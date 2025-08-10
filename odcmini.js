"use strict";

/**
 * odcmini – Device Plugins tab: show OneDriveCheckService status
 * SAFE:
 * - Only adds a tab inside the device → Plugins page (no global UI injection)
 * - Uses pluginadmin bridge for the iframe page
 * - Uses runcommands(reply:true) only when the agent is online
 * - No DB writes
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer.webserver;

  // Export the minimal hooks we use
  obj.exports = ["onDeviceRefreshEnd", "handleAdminReq", "hook_processAgentData"];

  // Hardcoded Windows service name as requested
  const SERVICE_NAME = "OneDriveCheckService";

  // --- tiny log helpers (never throw)
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ console.log("odcmini:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); }catch{ console.error("odcmini error:", e); } };

  // --- reply waiter map
  const pend = new Map();
  const makeResponseId = () => 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Receive agent replies (server-side)
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

  // Send runcommands and wait (only local agent; you said “ignore peering”)
  function runCommandsAndWait(nodeId, type, lines){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type, // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: false,
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
      } else {
        resolve({ ok:false, raw:'', meta:'offline' });
      }
    });
  }

  // Windows service query → Running / NotRunning
  async function winSvcStatus(nodeId){
    // Fast & safe: echo our own marker so we’re not dependent on SC text shapes
    const line = `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning`;
    const res = await runCommandsAndWait(nodeId, 'bat', line);
    if (!res.ok) return { ok:false, status:'Offline', raw:res.raw||'', meta:res.meta };
    const m = /svc\s*=\s*(Running|NotRunning)/i.exec(res.raw||'');
    return { ok:true, status: m ? m[1] : 'NotRunning', raw: res.raw||'' };
  }

  // --------- Admin bridge endpoints (used by our device-tab iframe) ----------
  obj.handleAdminReq = async function (req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      // health probe
      if (req.query.health == 1) {
        res.json({ ok:true, plugin:'odcmini', exports:obj.exports });
        return;
      }

      // serve the tiny panel (loaded inside our tab as an iframe)
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
      const r = await fetch('/pluginadmin.ashx?pin=odcmini&status=1&id=' + encodeURIComponent(nodeid), { credentials:'same-origin' });
      const j = await r.json();
      const s = j && j.status ? j.status : 'Unknown';
      out.innerHTML = '<b>Status:</b> ' + s;
    }catch(e){ out.textContent = 'Error'; }
  }
  btn.addEventListener('click', check);
  check();
})();
</script>`);
        return;
      }

      // status query (Windows only; we default to Windows for your fleet)
      if (req.query.status == 1) {
        const id = String(req.query.id||'').trim();
        const nodeId = id.startsWith('node//') ? id : ('node//' + id);
        const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
        if (!agent) { res.json({ id:nodeId, ok:false, status:'Offline', raw:'' }); return; }

        const isWin = (agent.agentInfo && /win/i.test(String(agent.agentInfo.platform||''))) ||
                      (agent.dbNode && /Windows/i.test(String(agent.dbNode.osdesc||''))) || true;

        if (!isWin) { res.json({ id:nodeId, ok:false, status:'NotSupported', raw:'' }); return; }

        const r = await winSvcStatus(nodeId);
        res.json({ id:nodeId, ok:r.ok, status:r.status, raw:r.raw||'' });
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // --------- Web UI hook: add our tab on the device page (Plugins) ----------
  obj.onDeviceRefreshEnd = function () {
    try {
      // Register the tab (safe to call multiple times)
      pluginHandler.registerPluginTab({ tabId: 'odcmini', tabTitle: 'Service: OneDriveCheck' });

      // Best-effort node id detection (don’t break UI if missing)
      function getNodeId(){
        try { if (typeof currentNodeId === 'function') return currentNodeId(); } catch {}
        try { if (typeof currentNode === 'object' && currentNode && currentNode._id) return currentNode._id; } catch {}
        try {
          const el = document.querySelector('[data-nodeid]');
          if (el && el.dataset && el.dataset.nodeid) return el.dataset.nodeid;
        } catch {}
        try {
          const h = location.hash || '';
          const m = h.match(/nodeid=([^&]+)/i);
          if (m) return decodeURIComponent(m[1]);
        } catch {}
        return null;
      }

      const nid = getNodeId();
      if (!nid) { QA('odcmini', '<div style="padding:12px">Select a device to view.</div>'); return; }

      // Render our iframe into this tab
      const src = '/pluginadmin.ashx?pin=odcmini&panel=1&nodeid=' + encodeURIComponent(nid);
      QA('odcmini', '<iframe style="width:100%;height:420px;border:0" src="' + src + '"></iframe>');
    } catch (e) {
      // Fail closed (no white screen)
    }
  };

  log('loaded');
  return obj;
};