"use strict";

/**
 * odcmini — SAFE port check for 20707/20773
 * - No UI injection, no DB writes, no peering, no columns/tabs.
 * - Use while logged in:
 *     /pluginadmin.ashx?pin=odcmini&health=1
 *     /pluginadmin.ashx?pin=odcmini&check=1&id=<shortOrLongNodeId>
 */
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
  const norm = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));

  function rid(){ return 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

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

  function runBat(nodeId, line){
    return new Promise((res)=>{
      const responseid = rid();
      const msg = { action:'runcommands', type:'bat', cmds:[line], runAsUser:false, reply:true, responseid };
      const t = setTimeout(()=>{ pend.delete(responseid); res({ ok:false, raw:'', meta:'timeout' }); }, 12000);
      pend.set(responseid, { res, t });
      const agent = wsserver && wsserver.wsagents ? wsserver.wsagents[nodeId] : null;
      if (agent && agent.authenticated === 2) {
        try { agent.send(JSON.stringify(msg)); } catch(ex){ err(ex); clearTimeout(t); pend.delete(responseid); res({ ok:false, raw:'', meta:'send_fail' }); }
      } else {
        clearTimeout(t); pend.delete(responseid); res({ ok:false, raw:'', meta:'offline' });
      }
    });
  }

  // Fast Windows netstat check: echo p20707=True/False & p20773=True/False
  async function checkWin(nodeId){
    const bat = [
      `(netstat -an | findstr /C::${PORTS[0]} >nul && echo p${PORTS[0]}=True || echo p${PORTS[0]}=False)`,
      `& (netstat -an | findstr /C::${PORTS[1]} >nul && echo p${PORTS[1]}=True || echo p${PORTS[1]}=False)`
    ].join(' ');
    const r = await runBat(nodeId, bat);
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
        const id = norm(String(req.query.id||'').trim());
        if (!id) { res.json({ ok:false, error:'missing id' }); return; }
        const agent = wsserver && wsserver.wsagents ? wsserver.wsagents[id] : null;
        if (!agent) { res.json({ id, ok:false, error:'offline' }); return; }

        // Treat as Windows fleet per your environment
        const r = await checkWin(id);
        if (!r.ok) { res.json({ id, ok:false, error:r.meta||'failed', raw:r.raw||'' }); return; }
        res.json({ id, ok:true, ports:r.data, raw:r.raw||'' });
        return;
      }

      res.sendStatus(404);
    }catch(e){ err(e); res.sendStatus(500); }
  };

  log('loaded');
  return obj;
};
