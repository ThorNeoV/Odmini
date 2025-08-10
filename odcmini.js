"use strict";

/**
 * ODC Mini – admin-bridge only, no UI injection.
 * Endpoints (when logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&listonline=1       ← local server only (peering note)
 *   /pluginadmin.ashx?pin=odcmini&svc=1&id=<id>      ← check OneDriveCheckService + ports (Windows)
 *
 * Uses RunCommands with reply:true and resolves via hook_processAgentData.
 * Works whether the agent is connected to this server or a peer (Mesh ≥ 1.1.40).
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Only the hooks we actually use
  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  // ---- config
  const SERVICE_NAME = "OneDriveCheckService";

  // ---- logging (quiet, won’t crash if methods not present)
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{} };
  const dbg = (m)=>{ try{ obj.meshServer.debug("odcmini: " + m); }catch{} };

  // ---- helpers
  const parseBool = (v)=> /^true$/i.test(String(v).trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));
  function isAgentOnline(nodeId){ try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]); } catch { return false; } }
  function listOnline() {
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const k of Object.keys(a)) {
      try {
        const n = a[k].dbNode || a[k].dbNodeKey || null;
        out[k] = { key:k, name:(n && (n.name||n.computername))||null, os:(n && (n.osdesc||n.agentcaps))||null };
      } catch { out[k] = { key:k }; }
    }
    return out;
  }

  // ---- reply tracker
  const pend = new Map(); // responseid -> { resolve, timeout }
  const makeResponseId = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Receive runcommands replies
  obj.hook_processAgentData = function(agent, command) {
    try {
      if (!command) return;
      if (command.action === 'runcommands' && command.responseid) {
        const p = pend.get(command.responseid);
        if (!p) return;
        pend.delete(command.responseid);
        clearTimeout(p.timeout);
        const raw = (command.console || command.result || '').toString();
        p.resolve({ ok:true, raw });
      }
    } catch (e) { dbg("hook_processAgentData err: " + e); }
  };

  // Send runcommands; handle local or peer; wait for reply
  function runCommandsAndWait(nodeId, type, lines, runAsUser){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                                 // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,               // false -> run as agent
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
        try { agent.send(JSON.stringify(theCommand)); } catch (ex) { dbg("send local fail: " + ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
        return;
      }

      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { dbg("dispatch peer fail: " + ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }

      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  // Fast Windows probe with CMD (no admin needed). Prints:
  //   svc=Running|NotRunning|Unknown
  //   p1=True|False
  //   p2=True|False
  async function checkServiceAndPorts(nodeId){
    const bat = [
      // service
      `sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || (sc query "${SERVICE_NAME}" | findstr /I STOPPED >nul && echo svc=NotRunning || echo svc=Unknown)`,
      // ports
      `(netstat -an | findstr /C::20707 >nul && echo p1=True || echo p1=False)`,
      `(netstat -an | findstr /C::20773 >nul && echo p2=True || echo p2=False)`
    ].join(' & ');

    const res = await runCommandsAndWait(nodeId, 'bat', bat, false);
    const raw = (res && res.raw) ? String(res.raw) : '';

    // Parse
    const ms = /svc\s*=\s*(Running|NotRunning|Unknown)/i.exec(raw);
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const svc = ms ? ms[1] : 'Unknown';
    const p1  = m1 ? parseBool(m1[1]) : false;
    const p2  = m2 ? parseBool(m2[1]) : false;

    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : 'Offline');
    return { ok: !!res && res.ok === true, status, service: svc, port20707: !!p1, port20773: !!p2, raw };
  }

  // ---- admin bridge
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      if (req.query.health == 1) {
        res.json({ ok:true, plugin:"odcmini", exports: obj.exports, hasUser: !!user });
        return;
      }

      if (req.query.listonline == 1) {
        res.json({ ok:true, agents: listOnline() });
        return;
      }

      if (req.query.svc == 1) {
        let id = req.query.id;
        if (!id) { res.json({ ok:false, reason:'missing id' }); return; }
        id = normalizeId(id);

        // Always attempt; runCommands will return meta: 'no_route' if it can't reach the agent
        try {
          const out = await checkServiceAndPorts(id);
          res.json({ id, ...out });
        } catch (e) {
          res.json({ id, ok:false, status:'Error', port20707:false, port20773:false, service:'Unknown', raw:'' });
        }
        return;

        try {
          const out = await checkServiceAndPorts(id);
          res.json({ id, ...out });
        } catch (e) {
          dbg("svc err: " + e);
          res.json({ id, ok:false, status:'Error', port20707:false, port20773:false, service:'Unknown', raw:'' });
        }
        return;
      }

      res.sendStatus(404);
    } catch (e) {
      dbg("handleAdminReq err: " + e);
      res.sendStatus(500);
    }
  };

  log("loaded");
  return obj;
};
