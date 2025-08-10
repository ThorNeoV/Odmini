"use strict";

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  obj.exports = ["handleAdminReq", "hook_processAgentData"];

  const PORTS = [20707, 20773];
  const pend = new Map();
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ console.log("odcmini:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); }catch{ console.error("odcmini error:", e); } };

  function rid(){ return 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // ---- ID resolver: map short or long to live agent key
  function resolveAgentKey(inputId){
    if (!wsserver || !wsserver.wsagents) return null;
    if (!inputId) return null;
    const wantShort = inputId.replace(/^node\/\//i,'').trim();
    const wantLong  = inputId.startsWith('node//') ? inputId : ('node//' + wantShort);

    const agents = wsserver.wsagents;
    // Fast paths
    if (agents[wantLong]) return wantLong;
    if (agents[inputId])  return inputId;

    // Scan and try to match dbNode._id or key suffix
    for (const k of Object.keys(agents)) {
      try {
        if (k === wantLong || k === inputId) return k;
        const a = agents[k];
        const dn = a.dbNode || a.dbNodeKey || {};
        if (dn && (dn._id === wantLong || dn._id === inputId)) return k;
        if (k.endsWith(wantShort)) return k; // helpful when domain/hash is appended
      } catch {}
    }
    return null;
  }

  obj.hook_processAgentData = function(agent, cmd){
    try{
      if (!cmd) return;
      if (cmd.action === 'runcommands' && cmd.responseid) {
        const p = pend.get(cmd.responseid);
        if (p) {
          pend.delete(cmd.responseid);
          clearTimeout(p.t);
          const raw = (cmd.console || cmd.result || '').toString();
          p.res({ ok:true, raw });
        }
      }
    }catch(e){ err(e); }
  };

  function runBat(agentKey, line){
    return new Promise((res)=>{
      const responseid = rid();
      const msg = { action:'runcommands', type:'bat', cmds:[line], runAsUser:false, reply:true, responseid };
      const t = setTimeout(()=>{ pend.delete(responseid); res({ ok:false, raw:'', meta:'timeout' }); }, 12000);
      pend.set(responseid, { res, t });
      const agent = wsserver && wsserver.wsagents ? wsserver.wsagents[agentKey] : null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(msg)); } catch(ex){ err(ex); clearTimeout(t); pend.delete(responseid); res({ ok:false, raw:'', meta:'send_fail' }); }
      } else {
        clearTimeout(t); pend.delete(responseid); res({ ok:false, raw:'', meta:'offline' });
      }
    });
  }

  async function checkWin(agentKey){
    const bat = `(netstat -an | findstr /C::${PORTS[0]} >nul && echo p${PORTS[0]}=True || echo p${PORTS[0]}=False) & (netstat -an | findstr /C::${PORTS[1]} >nul && echo p${PORTS[1]}=True || echo p${PORTS[1]}=False)`;
    const r = await runBat(agentKey, bat);
    if (!r.ok) return { ok:false, data:null, raw:r.raw||'', meta:r.meta||'fail' };
    const out = String(r.raw||'');
    const mA = new RegExp(`p${PORTS[0]}\\s*=\\s*(True|False)`, 'i').exec(out);
    const mB = new RegExp(`p${PORTS[1]}\\s*=\\s*(True|False)`, 'i').exec(out);
    const a = mA ? /true/i.test(mA[1]) : false;
    const b = mB ? /true/i.test(mB[1]) : false;
    return { ok:true, data: { [PORTS[0]]: a, [PORTS[1]]: b }, raw: out };
  }

  obj.handleAdminReq = async function(req, res, user){
    try{
      if (!user) { res.status(401).end('Unauthorized'); return; }

      if (req.query.health == 1) { res.json({ ok:true, plugin:'odcmini', exports:obj.exports, hasUser:!!user }); return; }

      if (req.query.check == 1) {
        const rawId = String(req.query.id||'').trim();
        const agentKey = resolveAgentKey(rawId);
        if (!agentKey) { res.json({ id:rawId, ok:false, error:'offline_or_not_found' }); return; }

        const r = await checkWin(agentKey);
        if (!r.ok) { res.json({ id:agentKey, ok:false, error:r.meta||'failed', raw:r.raw||'' }); return; }
        res.json({ id:agentKey, ok:true, ports:r.data, raw:r.raw||'' });
        return;
      }

      // Optional: debug which agents the server sees
      if (req.query.list == 1) {
        const keys = Object.keys((wsserver && wsserver.wsagents) || {});
        res.json({ ok:true, count: keys.length, agents: keys });
        return;
      }

      res.sendStatus(404);
    }catch(e){ err(e); res.sendStatus(500); }
  };

  log('loaded');
  return obj;
};
