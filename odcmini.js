"use strict";

/**
 * ODCMini – Minimal, safe admin-bridge plugin
 * Endpoints (when logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&svc=1&id=<nodeid or short id>
 * Notes:
 *   - Windows-only check (BAT + netstat + sc)
 *   - No UI injection, no DB writes, no peering
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  const SERVICE_NAME = "OneDriveCheckService";
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: "+m); }catch{ console.log("odcmini:",m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: "+(e && e.stack || e)); }catch{ console.error("odcmini error:",e); } };

  // ---- reply waiters (responseid -> {resolve,reject,timeout})
  const pend = new Map();
  const mkRid = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // normalize node id to long form
  const norm = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));

  function agentOnline(nodeId){
    try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId] && wsserver.wsagents[nodeId].authenticated === 2); }
    catch { return false; }
  }

  // Receive agent replies
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const waiter = pend.get(command.responseid);
        if (!waiter) return;
        pend.delete(command.responseid);
        clearTimeout(waiter.timeout);

        // Mesh may put output in command.console (preferred) or command.result
        const raw = (command.console || command.result || '').toString();
        waiter.resolve({ ok:true, raw });
      }
    } catch (e) { err(e); }
  };

  // Send RunCommands (BAT) and wait for reply
  function runBatAndWait(nodeId, batLine){
    return new Promise((resolve)=>{
      const agent = wsserver && wsserver.wsagents && wsserver.wsagents[nodeId];
      if (!agent || agent.authenticated !== 2) { resolve({ ok:false, raw:'', meta:'offline' }); return; }

      const responseid = mkRid();
      const payload = {
        action: 'runcommands',
        type: 'bat',                // run as Windows batch
        cmds: [ batLine ],
        runAsUser: false,           // run as agent
        reply: true,
        responseid
      };

      const timeout = setTimeout(()=>{
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      try { agent.send(JSON.stringify(payload)); }
      catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
    });
  }

  // Build fast Windows probe (no admin needed): check ports + service state
  function buildWinProbe(){
    // Outputs 3 lines like:
    // p1=True
    // p2=False
    // svc=Running / NotRunning / NotFound
    return [
      '(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False)',
      '& (netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)',
      '& (sc query "' + SERVICE_NAME + '" | findstr /I RUNNING >nul && echo svc=Running || (sc query "' + SERVICE_NAME + '" | findstr /I STATE >nul && echo svc=NotRunning || echo svc=NotFound))'
    ].join(' ');
  }

  function parseProbe(raw){
    const s = String(raw||'');
    const m1 = /p1\s*=\s*(true|false)/i.exec(s);
    const m2 = /p2\s*=\s*(true|false)/i.exec(s);
    const m3 = /svc\s*=\s*(Running|NotRunning|NotFound)/i.exec(s);
    const port20707 = m1 ? (/true/i.test(m1[1])) : false;
    const port20773 = m2 ? (/true/i.test(m2[1])) : false;
    const svc = m3 ? m3[1] : 'Unknown';

    let status = 'Offline';
    if (port20707) status = 'App Online';
    else if (port20773) status = 'Not signed in';
    else status = 'Offline';
    return { status, service: svc, port20707, port20773 };
  }

  // ===== Admin bridge =====
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      if (req.query.health == 1) { res.json({ ok:true, plugin:'odcmini', exports:obj.exports }); return; }

      if (req.query.svc == 1) {
        const id = norm(req.query.id || '');
        if (!id) { res.json({ ok:false, reason:'missing id' }); return; }
        if (!agentOnline(id)) { res.json({ id, ok:false, status:'Offline', service:'Unknown', port20707:false, port20773:false, raw:'' }); return; }

        const bat = buildWinProbe();
        const r = await runBatAndWait(id, bat);
        if (!r.ok) { res.json({ id, ok:false, status:'Offline', service:'Unknown', port20707:false, port20773:false, raw:r.raw||'', meta:r.meta }); return; }
        const parsed = parseProbe(r.raw);
        res.json({ id, ok:true, raw:r.raw, ...parsed });
        return;
      }

      // tiny help page
      if (req.query.admin == 1) {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>ODCMini</title>
          <h3>ODCMini</h3>
          <p>Use:<br>
          <code>/pluginadmin.ashx?pin=odcmini&amp;svc=1&amp;id=&lt;node or short id&gt;</code></p>`);
        return;
      }

      res.sendStatus(404);
    } catch(e) { err(e); res.sendStatus(500); }
  };

  log('loaded');
  return obj;
};
