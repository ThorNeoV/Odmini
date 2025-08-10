"use strict";

/**
 * ODCMini – Service column only (safe & minimal)
 * - Adds ONE column in the devices list that shows OneDriveCheckService status.
 * - Uses agent RunCommands (bat) to run: sc query "OneDriveCheckService".
 * - No DB writes, no iframes, no external scripts, peering ignored.
 *
 * Endpoints (while logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&status=1&id=<shortOrLong>[&id=...]
 *   /pluginadmin.ashx?pin=odcmini&include=1&path=col.js   ← small UI injector
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;
  const wsserver = obj.meshServer.webserver;

  // Only what we need
  obj.exports = ["handleAdminReq", "hook_processAgentData", "onWebUIStartupEnd"];

  const SERVICE_NAME = "OneDriveCheckService";
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: "+m); }catch{ console.log("odcmini:",m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: "+(e && e.stack || e)); }catch{ console.error("odcmini error:",e); } };

  // -------- agent map helpers
  function wsAgents() { return (wsserver && wsserver.wsagents) || {}; }

  // Accept short or long id; resolve to exact wsagents key (local server only)
  function resolveNodeId(input) {
    if (!input) return null;
    const a = wsAgents();
    const want = String(input).trim();
    const long = want.startsWith('node//') ? want : ('node//' + want);
    if (a[long]) return long;
    const short = want.startsWith('node//') ? want.substring(6) : want;
    const keys = Object.keys(a);
    let hit = keys.find(k => k.substring(6) === short);
    if (hit) return hit;
    hit = keys.find(k => k.includes(short));
    return hit || null;
  }

  // -------- replies (responseid -> resolver)
  const pend = new Map();
  const mkRid = ()=> 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);

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
    } catch (e) { err(e); }
  };

  // -------- run a BAT line and wait
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
      }, 15000);

      pend.set(responseid, { resolve, timeout });

      try { agent.send(JSON.stringify(payload)); }
      catch (ex) { err(ex); resolve({ ok:false, raw:'', meta:'send_fail' }); }
    });
  }

  // -------- build + parse service probe
  function buildServiceProbe(){
    // Will echo exactly one of: svc=Running | svc=NotRunning | svc=NotFound
    return 'sc query "' + SERVICE_NAME + '" | findstr /I RUNNING >nul && echo svc=Running || (sc query "' + SERVICE_NAME + '" | findstr /I STATE >nul && echo svc=NotRunning || echo svc=NotFound)';
  }
  function parseService(raw){
    const m = /svc\s*=\s*(Running|NotRunning|NotFound)/i.exec(String(raw||''));
    return m ? m[1] : 'Unknown';
  }

  // -------- simple 30s cache (id -> {ts, service})
  const cache = new Map();
  function getCached(id){
    const c = cache.get(id);
    if (!c) return null;
    if ((Date.now() - c.ts) > 30000) { cache.delete(id); return null; }
    return c.service;
  }
  function putCache(id, service){
    cache.set(id, { ts: Date.now(), service });
  }

  // -------- admin bridge endpoints
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (!user) { res.status(401).end('Unauthorized'); return; }

      if (req.query.health == 1) { res.json({ ok:true, plugin:'odcmini', exports:obj.exports }); return; }

      // Serve the tiny UI injector
      if (req.query.include == 1) {
        const file = String(req.query.path||'').replace(/\\/g,'/').trim();
        if (file !== 'col.js') { res.sendStatus(404); return; }
        res.setHeader('Content-Type','application/javascript; charset=utf-8');
        res.end(buildClientJS());
        return;
      }

      if (req.query.status == 1) {
        let ids = req.query.id;
        if (!ids) { res.json({}); return; }
        if (!Array.isArray(ids)) ids = [ids];

        const result = {};
        // process sequentially to avoid blasting the agent
        for (const original of ids) {
          const id = resolveNodeId(original) || (original.startsWith('node//')?original:('node//'+original));
          const cached = getCached(id);
          if (cached) { result[id] = { service: cached, ok:true }; continue; }

          // If agent unknown locally → Offline
          if (!resolveNodeId(original)) { result[id] = { service:'Offline', ok:false }; continue; }

          const bat = buildServiceProbe();
          const r = await runBatAndWait(id, bat);
          if (!r.ok) { result[id] = { service:'Offline', ok:false }; continue; }
          const svc = parseService(r.raw);
          putCache(id, svc);
          result[id] = { service: svc, ok:true };
        }
        res.json(result);
        return;
      }

      res.sendStatus(404);
    } catch (e) { err(e); res.sendStatus(500); }
  };

  // -------- inject one small script into the Mesh UI
  obj.onWebUIStartupEnd = function () {
    const v = (Date.now() % 1e6);
    return `<script src="/pluginadmin.ashx?pin=odcmini&include=1&path=col.js&v=${v}"></script>`;
  };

  // -------- client-side JS (adds one column & polls our status endpoint)
  function buildClientJS(){
    return `(()=>{"use strict";
  const COL_ID = "col_odcmini_service";
  const TITLE = "OneDriveCheckService";

  function table(){
    return document.querySelector('#devices')
        || document.querySelector('#devicesTable')
        || document.querySelector('table#devicetable')
        || document.querySelector('table[data-list="devices"]')
        || null;
  }
  function rowId(row){
    return row.getAttribute('deviceid') || row.dataset.deviceid ||
           row.getAttribute('nodeid')   || row.dataset.nodeid   ||
           (row.id && row.id.startsWith('d_') ? row.id.substring(2) : null) || null;
  }
  function addHeader(){
    const g=table(); if(!g) return false;
    const thead=g.querySelector('thead'); if(!thead) return false;
    const tr=thead.querySelector('tr'); if(!tr) return false;
    if(!document.getElementById(COL_ID)){
      const th=document.createElement('th'); th.id=COL_ID; th.textContent=TITLE; th.style.whiteSpace='nowrap';
      tr.appendChild(th);
    }
    return true;
  }
  function ensureCells(){
    const g=table(); if(!g) return [];
    const tbody=g.querySelector('tbody'); if(!tbody) return [];
    const ids=[];
    tbody.querySelectorAll('tr').forEach(r=>{
      if(!r.querySelector('.odcmini-cell')){
        const td=document.createElement('td'); td.className='odcmini-cell'; td.textContent='—'; td.style.whiteSpace='nowrap';
        r.appendChild(td);
      }
      const id=rowId(r); if(id) ids.push(id);
    });
    return ids;
  }
  function paint(map){
    const g=table(); if(!g) return;
    g.querySelectorAll('tbody tr').forEach(r=>{
      const id=rowId(r); const td=r.querySelector('.odcmini-cell'); if(!td) return;
      const info = id && map && map['node//'+id];
      const svc = info && info.service;
      if(!svc){ td.textContent='—'; td.style.color=''; td.style.fontWeight=''; return; }
      td.textContent = svc;
      td.style.fontWeight='600';
      td.style.color = (svc==='Running'?'#0a0':(svc==='NotRunning'?'#c60':(svc==='Offline'?'#c00':'#555')));
      td.title = TITLE;
    });
  }
  function fetchStatus(shortIds){
    const qs = shortIds.map(id=>'&id='+encodeURIComponent(id)).join('');
    return fetch('/pluginadmin.ashx?pin=odcmini&status=1'+qs, { credentials:'same-origin' })
      .then(r=>r.json()).catch(()=>({}));
  }
  function tick(){
    if(!addHeader()) return;
    const ids=ensureCells(); if(ids.length===0) return;
    fetchStatus(ids).then(paint);
  }

  document.addEventListener('meshcentralDeviceListRefreshEnd', ()=> setTimeout(tick, 200));
  window.addEventListener('hashchange', ()=> setTimeout(tick, 200));
  setInterval(tick, 10000);
  setTimeout(tick, 600);
})();`;
  }

  log("service column loaded");
  return obj;
};
