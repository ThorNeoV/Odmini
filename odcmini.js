"use strict";

/**
 * odcmini – minimal, admin-bridge only plugin
 * - No UI injection, no Express, no DB writes.
 * - Uses RunCommands with reply:true and hook_processAgentData to collect output.
 *
 * Endpoints (logged-in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&whoami=1
 *   /pluginadmin.ashx?pin=odcmini&listlocal=1     (alias of listonline)
 *   /pluginadmin.ashx?pin=odcmini&listonline=1    (agents on THIS server only)
 *   /pluginadmin.ashx?pin=odcmini&where=1&id=<id> (is agent local? peering available?)
 *   /pluginadmin.ashx?pin=odcmini&echotest=1&id=<id>
 *   /pluginadmin.ashx?pin=odcmini&svc=1&id=<id>   (service+ports via fast CMD)
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  // Config
  const SERVICE_NAME = "OneDriveCheckService";
  const PORT1 = 20707;
  const PORT2 = 20773;

  // Logging
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ console.log("odcmini:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); }catch{ console.error("odcmini error:", e); } };

  // Helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const parseBool   = (v)=> /^true$/i.test(String(v).trim());
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));
  const isLocalAgent = (nodeId)=> !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]);

  function listLocalAgents(){
    const a = (wsserver && wsserver.wsagents) || {};
    const out = {};
    for (const key of Object.keys(a)) {
      try {
        const n = a[key].dbNode || a[key].dbNodeKey || null;
        out[key] = {
          key,
          name: (n && (n.name || n.computername)) || null,
          os:   (n && (n.osdesc || n.agentcaps)) || null
        };
      } catch { out[key] = { key }; }
    }
    return out;
  }

  // ===== Reply handling for RunCommands =====
  const pend = new Map(); // responseid -> { resolve, timeout }
  const makeResponseId = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

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

  // Peering-safe RunCommands with reply:true
  function runCommandsAndWait(nodeId, type, lines, runAsUser) {
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type, // 'bat' or 'ps'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser, // false: agent account
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      // Try local first
      const agent = (wsserver && wsserver.wsagents && wsserver.wsagents[nodeId]) || null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(theCommand)); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail_local' }); }
        return;
      }

      // Then peering
      const ms = obj.meshServer && obj.meshServer.multiServer;
      if (ms) {
        try { ms.DispatchMessage({ action:'agentCommand', nodeid: nodeId, command: theCommand }); }
        catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'peer_send_fail' }); }
        return;
      }

      // No route
      resolve({ ok:false, raw:'', meta:'no_route' });
    });
  }

  // Fast service + ports check
  async function checkServiceAndPorts(nodeId){
    const bat = [
      `(netstat -an | findstr /C::${PORT1} >nul && echo p1=True || echo p1=False)`,
      `& (netstat -an | findstr /C::${PORT2} >nul && echo p2=True || echo p2=False)`,
      `& (sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || (sc query "${SERVICE_NAME}" | findstr /I STOPPED >nul && echo svc=Stopped || echo svc=NotFound))`
    ].join(' ');

    const res = await runCommandsAndWait(nodeId, 'bat', bat, false);
    const raw = (res && res.raw) ? String(res.raw) : '';

    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;

    const ms = /svc\s*=\s*([A-Za-z]+)/i.exec(raw);
    const svc = ms ? ms[1] : 'Unknown';

    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : (isLocalAgent(nodeId) ? 'Online (agent)' : 'Offline'));

    return { id: nodeId, ok: !!(res && res.ok), status, service: svc, port20707: !!p1, port20773: !!p2, raw };
  }

  async function echoTest(nodeId){
    const res = await runCommandsAndWait(nodeId, 'bat', 'echo odc_ok', false);
    return { id: nodeId, ok: !!(res && res.ok), raw: (res && res.raw) || '', meta: res && res.meta };
  }

  // ===== Admin bridge =====
  obj.handleAdminReq = async function(req, res, user) {
    try {
      // health
      if (req.query.health == 1) {
        res.json({ ok:true, plugin:'odcmini', exports: obj.exports, hasUser: !!user });
        return;
      }

      // who am I
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:'no user' }); return; }
        res.json({ ok:true, user: summarizeUser(user) });
        return;
      }

      // listlocal and listonline (alias)
      if (req.query.listlocal == 1 || req.query.listonline == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.json({ ok:true, agents: listLocalAgents() });
        return;
      }

      // where is this node
      if (req.query.where == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        const raw = req.query.id;
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        const local = isLocalAgent(id);
        const hasPeers = !!(obj.meshServer && obj.meshServer.multiServer);
        res.json({ ok:true, id, local, hasPeers });
        return;
      }

      // simple echo test
      if (req.query.echotest == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        const raw = req.query.id;
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        const out = await echoTest(id);
        res.json(out);
        return;
      }

      // service + ports
      if (req.query.svc == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        const raw = req.query.id;
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        try {
          const out = await checkServiceAndPorts(id);
          res.json(out);
        } catch (e) {
          err(e);
          res.json({ id, ok:false, status:'Error', service:'Unknown', port20707:false, port20773:false, raw:'' });
        }
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  log("odcmini loaded");
  return obj;
};
