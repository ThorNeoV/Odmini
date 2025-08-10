"use strict";

/**
 * odcmini – minimal, safe
 * - NO UI hooks (prevents white screens)
 * - Admin bridge only
 * - Windows: checks OneDriveCheckService via runcommands(reply:true)
 * Endpoints (while logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&panel=1&nodeid=<shortOrLongId>
 *   /pluginadmin.ashx?pin=odcmini&status=1&id=<shortOrLongId>
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer.webserver;

  // Only server-side hooks (no client code at all)
  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  const SERVICE_NAME = "OneDriveCheckService";

  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ console.log("odcmini:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); }catch{ console.error("odcmini error:", e); } };

  // --- wait-for-reply map
  const pend = new Map();
  const makeResponseId = () => 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // receive agent replies
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (command && command.action === 'runcommands' && command.responseid) {
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

  function runCommandsAndWait(nodeId, type, lines){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                   // 'bat' or 'ps'
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

  async function winSvcStatus(nodeId){
    // quick marker-based output
    const line = `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning`;
    const res = await runCommandsAndWait(nodeId, 'bat', line);
    if (!res.ok) return { ok:false, status:'Offline', raw:res.raw||'', meta:res.meta };
    const m = /svc\s*=\s*(Running|NotRunning)/i.exec(res.raw||'');
    return { ok:true, status: m ? m[1] : 'NotRunning', raw:res.raw||'' };
  }

  // -------- Admin bridge only --------
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      // health
      if (req.query.health == 1) { res.json({ ok:true, plugin:'odcmini', exports:obj.exports }); return; }

      // tiny standalone panel (no UI injection needed)
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
      out.innerHTML = '<b>Status:</b> ' + (j.status || 'Unknown');
    }catch(e){ out.textContent = 'Error'; }
  }
  btn.addEventListener('click', check);
  check();
})();
</script>`);
        return;
      }

      // status
      if (req.query.status == 1) {
        const id = String(req.query.id||'').trim();
        const nodeId = id.startsWith('node//') ? id : ('node//' + id);
        const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
        if (!agent) { res.json({ id:nodeId, ok:false, status:'Offline', raw:'' }); return; }

        // default to Windows for your fleet
        const r = await winSvcStatus(nodeId);
        res.json({ id:nodeId, ok:r.ok, status:r.status, raw:r.raw||'' });
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("loaded");
  return obj;
};