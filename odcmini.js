"use strict";

/**
 * ODCMini – Minimal, safe admin-bridge plugin (Windows-only probe)
 *
 * Endpoints (when logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&listlocal=1                ← show local wsagents keys
 *   /pluginadmin.ashx?pin=odcmini&find=1&q=<shortOrPartial>  ← fuzzy-find an agent key
 *   /pluginadmin.ashx?pin=odcmini&svc=1&id=<shortOrLong>     ← run netstat+sc on agent
 *
 * No UI injection. No DB writes. No peering logic (local server only).
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

  // ===== helpers

  function wsAgents() {
    return (wsserver && wsserver.wsagents) || {};
  }

  // Try to resolve a provided id (short or long) to an exact wsagents key
  function resolveNodeId(input) {
    if (!input) return null;
    const a = wsAgents();
    const want = String(input).trim();
    const long = want.startsWith('node//') ? want : ('node//' + want);

    if (a[long]) return long; // exact match

    // If they passed short id, try exact short id match against keys
    const short = want.startsWith('node//') ? want.substring(6) : want;
    const keys = Object.keys(a);
    // exact short match after 'node//'
    let hit = keys.find(k => k.substring(6) === short);
    if (hit) return hit;

    // fallback: contains/startsWith search (best-effort)
    hit = keys.find(k => k.includes(short));
    if (hit) return hit;

    return null;
  }

  // RunCommands reply tracking
  const pend = new Map();
  const mkRid = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const w = pend.get(command.responseid);
        if (!w) return;
        pend.delete(command.responseid);
        clearTimeout(w.timeout);
        const raw = (command.console || command.result || '').toString();
        w.resolve({ ok:true, raw });
      }
    } catch (e) { err(e); }
  };

  function runBatAndWait(nodeId, batLine){
    return new Promise((resolve)=>{
      const agentKey = resolveNodeId(nodeId);
      if (!agentKey) { resolve({ ok:false, raw:'', meta:'agent_not_found' }); return; }
      const agent = wsAgents()[agentKey];
      if (!agent) { resolve({ ok:false, raw:'', meta:'offline' }); return; }

      const responseid = mkRid();
      const payload = {
        action: 'runcommands',
        type: 'bat',
        cmds: [ String(batLine||'') ],
        runAsUser: false,
        reply: true,
        responseid
      };

      const timeout = setTimeout(()=>{
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 20000);

      pend.set(responseid, { resolve, timeout });

      try { agent.send(JSON.stringify(payload)); }
      catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
    });
  }

  function buildWinProbe(){
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
    const service = m3 ? m3[1] : 'Unknown';
    let status = 'Offline';
    if (port20707) status = 'App Online';
    else if (port20773) status = 'Not signed in';
    else status = 'Offline';
    return { status, service, port20707, port20773 };
  }

  // ===== admin bridge
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      if (req.query.health == 1) { res.json({ ok:true, plugin:'odcmini', exports:obj.exports }); return; }

      if (req.query.listlocal == 1) {
        const out = {};
        const a = wsAgents();
        Object.keys(a).forEach(k => { out[k] = true; });
        res.json({ ok:true, agents: out });
        return;
      }

      if (req.query.find == 1) {
        const q = String(req.query.q || '').trim();
        if (!q) { res.json({ ok:false, reason:'missing q' }); return; }
        const a = wsAgents();
        const keys = Object.keys(a);
        const short = q.startsWith('node//') ? q.substring(6) : q;
        const hits = keys.filter(k => k.substring(6) === short || k.includes(short));
        res.json({ ok:true, q, hits });
        return;
      }

      if (req.query.svc == 1) {
        const provided = String(req.query.id || '').trim();
        if (!provided) { res.json({ ok:false, reason:'missing id' }); return; }

        const resolved = resolveNodeId(provided);
        if (!resolved) {
          res.json({ id: provided.startsWith('node//')?provided:('node//'+provided), ok:false, status:'Offline', service:'Unknown', port20707:false, port20773:false, raw:'', meta:'agent_not_found' });
          return;
        }

        const bat = buildWinProbe();
        const r = await runBatAndWait(resolved, bat);
        if (!r.ok) {
          res.json({ id: resolved, ok:false, status:'Offline', service:'Unknown', port20707:false, port20773:false, raw:r.raw||'', meta:r.meta });
          return;
        }
        const parsed = parseProbe(r.raw);
        res.json({ id: resolved, ok:true, raw:r.raw, ...parsed });
        return;
      }

      if (req.query.admin == 1) {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(`<!doctype html><meta charset="utf-8"><title>ODCMini</title>
          <h3>ODCMini</h3>
          <ul>
            <li><code>?pin=odcmini&health=1</code></li>
            <li><code>?pin=odcmini&listlocal=1</code></li>
            <li><code>?pin=odcmini&find=1&q=&lt;shortOrPartial&gt;</code></li>
            <li><code>?pin=odcmini&svc=1&id=&lt;shortOrLong&gt;</code></li>
          </ul>`);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log('loaded');
  return obj;
};
