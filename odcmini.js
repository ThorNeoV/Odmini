"use strict";

/**
 * odc-tagwatch
 * - No UI injection, no web handlers.
 * - Polls online Windows agents every X minutes with a short BAT+netstat.
 * - Parses result and maintains two device tags: P20707=UP|DOWN, P20773=UP|DOWN.
 *
 * Safe hooks only:
 *   - server_startup (start timer)
 *   - hook_processAgentData (match replies)
 */

module.exports["odcmini"] = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer.webserver;

  // ---- config
  const CHECK_EVERY_MS = 5 * 60 * 1000; // 5 minutes
  const PORTS = [20707, 20773];
  const TAG_PREFIX = "P"; // e.g. P20707=UP
  const CMD = '(netstat -an | findstr /C::20707 >nul && echo P20707=UP || echo P20707=DOWN) & (netstat -an | findstr /C::20773 >nul && echo P20773=UP || echo P20773=DOWN)';

  // ---- exports (only server-side)
  obj.exports = ["server_startup", "hook_processAgentData"];

  // ---- logging
  const log = (m)=>{ try{ obj.meshServer.info("odc-tagwatch: " + m); }catch{ console.log("odc-tagwatch:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odc-tagwatch error: " + (e && e.stack || e)); }catch{ console.error("odc-tagwatch error:", e); } };

  // ---- reply tracking
  const pend = new Map();
  function makeResponseId(){ return 'odct_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

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

  function runCommandsAndWait(nodeId, lines){
    return new Promise((resolve) => {
      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type: 'bat',
        cmds: [ CMD ],
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

  function parseNetstatEcho(raw){
    // Expect lines like: "P20707=UP" and "P20773=UP"
    const out = {};
    const s = String(raw||'').split(/\r?\n/);
    for (const line of s) {
      const m = /^\s*P(20707|20773)\s*=\s*(UP|DOWN)\s*$/i.exec(line.trim());
      if (m) out['P'+m[1]] = (m[2].toUpperCase() === 'UP') ? 'UP' : 'DOWN';
    }
    // fill defaults if missing
    for (const p of PORTS) if (!out['P'+p]) out['P'+p] = 'DOWN';
    return out; // { P20707:'UP', P20773:'DOWN' }
  }

  // ---- tag helpers
  function mergeTags(existing, desired){
    // Remove any older P20707=/P20773= tags, then add new
    const keep = (existing || []).filter(t => !/^P(20707|20773)=/i.test(t));
    const next = [...keep, `${TAG_PREFIX}20707=${desired.P20707}`, `${TAG_PREFIX}20773=${desired.P20773}`];
    // de-dup
    return Array.from(new Set(next));
  }

  async function setNodeTags(nodeId, desiredObj){
    try {
      // Try supported high-level helper if present
      if (typeof obj.meshServer.changeDeviceTags === 'function') {
        const node = wsserver.db.GetNode ? await new Promise((res)=> wsserver.db.GetNode(nodeId, (e,n)=>res(n))) : null;
        const currentTags = (node && Array.isArray(node.tags)) ? node.tags : [];
        const newTags = mergeTags(currentTags, desiredObj);
        if (JSON.stringify(currentTags) === JSON.stringify(newTags)) return; // nothing to do
        // changeDeviceTags(user, nodeId, addTags[], removeTags[], flags)
        const rm = currentTags.filter(t => /^P(20707|20773)=/i.test(t));
        const add = newTags.filter(t => rm.indexOf(t) === -1);
        obj.meshServer.changeDeviceTags(null, nodeId, add, rm, 0);
        return;
      }

      // Fallback: read node, update tags, write back
      if (wsserver && wsserver.db && typeof wsserver.db.GetNode === 'function') {
        const node = await new Promise((resolve) => { wsserver.db.GetNode(nodeId, (err, x)=> resolve(x||null)); });
        if (!node) return;
        const currentTags = Array.isArray(node.tags) ? node.tags : [];
        const newTags = mergeTags(currentTags, desiredObj);
        if (JSON.stringify(currentTags) === JSON.stringify(newTags)) return;
        node.tags = newTags;
        // wsserver.db.SetNode(node) exists on 1.1.x
        if (typeof wsserver.db.SetNode === 'function') {
          await new Promise((resolve)=> wsserver.db.SetNode(node, ()=>resolve()));
        } else if (typeof wsserver.db.Set === 'function') {
          // very old fallback (may not be needed)
          await new Promise((resolve)=> wsserver.db.Set(node._id, node, ()=>resolve()));
        }
        // notify users of tag change
        try { obj.meshServer.DispatchEvent(['*','server-users'], obj, { action:'nodechange', node: { _id: nodeId, tags: node.tags } }); } catch {}
        return;
      }
    } catch (e) { err(e); }
  }

  async function checkOne(nodeId, agent){
    // Windows only
    const isWin =
      (agent && agent.agentInfo && /win/i.test(agent.agentInfo.platform||'')) ||
      (agent && agent.dbNode && /Windows/i.test(agent.dbNode.osdesc||'')) ||
      true; // default true for your fleet
    if (!isWin) return;

    const r = await runCommandsAndWait(nodeId, CMD);
    if (!r.ok) return;

    const result = parseNetstatEcho(r.raw);
    await setNodeTags(nodeId, { P20707: result.P20707, P20773: result.P20773 });
  }

  function sweepOnline(){
    try {
      const agents = (wsserver && wsserver.wsagents) ? wsserver.wsagents : {};
      for (const nodeId of Object.keys(agents)) {
        const a = agents[nodeId];
        if (a && a.authenticated === 2) { checkOne(nodeId, a); }
      }
    } catch (e) { err(e); }
  }

  obj.server_startup = function () {
    log("started");
    // first sweep after 20s, then periodic
    setTimeout(sweepOnline, 20000);
    setInterval(sweepOnline, CHECK_EVERY_MS);
  };

  return obj;
};
