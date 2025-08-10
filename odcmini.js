"use strict";

/**
 * odcmini – Service/port status column + device strip (safe, minimal)
 *
 * What it does:
 *  - Adds a "Ports" column to the devices list (overview) with quick status.
 *  - Adds a small strip on the device page showing 20707/20773 + service state.
 *  - Uses admin-bridge endpoints, no DB writes, no Express, and no peering logic.
 *  - Runs a single BAT line on the agent (RunCommands + reply:true), local agents only.
 *
 * Endpoints (while logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 *   /pluginadmin.ashx?pin=odcmini&whoami=1
 *   /pluginadmin.ashx?pin=odcmini&listlocal=1
 *   /pluginadmin.ashx?pin=odcmini&svc=1&id=<shortOrLongNodeId>
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;                 // plugin handler
  obj.meshServer = parent.parent;      // MeshCentral server
  const wsserver = obj.meshServer && obj.meshServer.webserver;

  // Hooks we use
  obj.exports = ["handleAdminReq", "hook_processAgentData", "onWebUIStartupEnd", "onDeviceRefreshEnd"];

  // --- settings
  const SERVICE_NAME = "OneDriveCheckService";
  const PORTS = { p1: 20707, p2: 20773 };
  const TIMEOUT_MS = 12000;

  // --- logging
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ console.log("odcmini:", m); } };
  const err = (e)=>{ try{ obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); }catch{ console.error("odcmini error:", e); } };

  // --- helpers
  const summarizeUser = (u)=> u ? ({ name:u.name, userid:u.userid, domain:u.domain, siteadmin:u.siteadmin }) : null;
  const normalizeId = (id)=> (!id ? id : (/^node\/\/.+/i.test(id) ? id : ('node//' + id)));
  const parseBool = (v)=> /^true$/i.test(String(v || '').trim());
  const isLocalAgent = (nodeId)=> {
    try { return !!(wsserver && wsserver.wsagents && wsserver.wsagents[nodeId] && wsserver.wsagents[nodeId].authenticated === 2); }
    catch { return false; }
  };

  // --- list locally connected agents
  function listLocal() {
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

  // --- reply waiter (responseid -> resolver)
  const pend = new Map();
  function makeResponseId(){ return 'odc_' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

  // Handle runcommands replies
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

  // Send runcommands to a **local** agent and wait for reply
  function runCommandsAndWait(nodeId, type, lines, runAsUser){
    return new Promise((resolve) => {
      if (!isLocalAgent(nodeId)) { resolve({ ok:false, raw:'', meta:'not_local' }); return; }

      const responseid = makeResponseId();
      const theCommand = {
        action: 'runcommands',
        type,                                // 'bat'
        cmds: Array.isArray(lines) ? lines : [ String(lines||'') ],
        runAsUser: !!runAsUser,              // false = run as agent
        reply: true,
        responseid
      };

      const timeout = setTimeout(() => {
        if (pend.has(responseid)) pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'timeout' });
      }, TIMEOUT_MS);

      pend.set(responseid, { resolve, timeout });

      try {
        wsserver.wsagents[nodeId].send(JSON.stringify(theCommand));
      } catch (ex) {
        clearTimeout(timeout);
        pend.delete(responseid);
        resolve({ ok:false, raw:'', meta:'send_fail' });
      }
    });
  }

  // Build the fast BAT probe (netstat + sc query)
  function makeBatProbe() {
    return [
      `(netstat -an | findstr /C::${PORTS.p1} >nul && echo p1=True || echo p1=False)`,
      `& (netstat -an | findstr /C::${PORTS.p2} >nul && echo p2=True || echo p2=False)`,
      `& (sc query "${SERVICE_NAME}" | findstr /I RUNNING >nul && echo svc=Running || echo svc=NotRunning)`
    ].join(' ');
  }

  async function checkServiceAndPorts(nodeId){
    const res = await runCommandsAndWait(nodeId, 'bat', makeBatProbe(), false);
    if (!res.ok) {
      if (res.meta === 'not_local') {
        // Tell the UI we can’t run here, but don’t claim Offline.
        return {
          id: nodeId, ok:false,
          status: 'Remote/other server (no check)',
          service: 'Unknown', port20707:false, port20773:false, raw:''
        };
      }
    }

    const raw = (res.raw || '').toString();
    const m1 = /p1\s*=\s*(true|false)/i.exec(raw);
    const m2 = /p2\s*=\s*(true|false)/i.exec(raw);
    const ms = /svc\s*=\s*(Running|NotRunning)/i.exec(raw);

    const p1 = m1 ? parseBool(m1[1]) : false;
    const p2 = m2 ? parseBool(m2[1]) : false;
    const svc = ms ? ms[1] : 'Unknown';
    const status = p1 ? 'App Online' : (p2 ? 'Not signed in' : 'Offline');

    return {
      id: nodeId, ok:true,
      status, service: svc,
      port20707: !!p1, port20773: !!p2,
      raw
    };
  }

  // --- Admin bridge endpoints
  obj.handleAdminReq = async function(req, res, user) {
    try {
      if (req.query.health == 1) { res.json({ ok:true, plugin:"odcmini", exports:obj.exports }); return; }
      if (req.query.whoami == 1) {
        if (!user) { res.status(401).json({ ok:false, reason:"no user" }); return; }
        res.json({ ok:true, user: summarizeUser(user) }); return;
      }
      if (req.query.listlocal == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        res.json({ ok:true, agents: listLocal() }); return;
      }
      if (req.query.svc == 1) {
        if (!user) { res.status(401).end('Unauthorized'); return; }
        const raw = req.query.id;
        const id = normalizeId(Array.isArray(raw) ? raw[0] : raw);
        if (!id) { res.json({ ok:false, reason:'missing id' }); return; }
        try {
          const out = await checkServiceAndPorts(id);
          // If runCommands failed (timeout etc.), out might be undefined
          if (!out) { res.json({ id, ok:false, status:'Error', service:'Unknown', port20707:false, port20773:false, raw:'' }); return; }
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

  // --- Tiny, defensive UI script (runs in Mesh UI). No external loads.
  obj.onWebUIStartupEnd = function () {
    // inline script allowed by Mesh CSP ('unsafe-inline' present)
    const v = Date.now() % 1e6;
    return `<script id="odcmini-js-${v}">(function(){
      try{
        var COL_ID='odcmini-col';
        function table(){
          return document.querySelector('#devices')||
                 document.querySelector('#devicesTable')||
                 document.querySelector('table#devicetable')||
                 document.querySelector('table[data-list="devices"]')||null;
        }
        function getRowId(tr){
          if(!tr) return null;
          return tr.getAttribute('deviceid')||tr.dataset.deviceid||
                 tr.getAttribute('nodeid')||tr.dataset.nodeid||
                 (tr.id&&tr.id.indexOf('d_')===0?tr.id.substring(2):null)||null;
        }
        function addHeader(){
          var g=table(); if(!g) return false;
          var thead=g.querySelector('thead'); if(!thead) return false;
          var tr=thead.querySelector('tr'); if(!tr) return false;
          if(!document.getElementById(COL_ID)){
            var th=document.createElement('th'); th.id=COL_ID; th.textContent='Ports';
            th.style.whiteSpace='nowrap';
            tr.appendChild(th);
          }
          return true;
        }
        function ensureCells(){
          var g=table(); if(!g) return [];
          var tb=g.querySelector('tbody'); if(!tb) return [];
          var ids=[];
          tb.querySelectorAll('tr').forEach(function(r){
            if(!r.querySelector('.odcmini-cell')){
              var td=document.createElement('td'); td.className='odcmini-cell'; td.textContent='…';
              td.style.whiteSpace='nowrap'; r.appendChild(td);
            }
            var id=getRowId(r); if(id) ids.push(id);
          });
          return ids;
        }
        function paintList(map){
          var g=table(); if(!g) return;
          var tb=g.querySelector('tbody'); if(!tb) return;
          tb.querySelectorAll('tr').forEach(function(r){
            var id=getRowId(r); var td=r.querySelector('.odcmini-cell'); if(!td) return;
            var s=(id&&map&&map['node//'+id])?map['node//'+id]:null;
            if(!s){ td.textContent='—'; td.style.color=''; td.title=''; return; }
            td.textContent = s.status||'—';
            td.title='Svc:'+ (s.service||'Unknown') + '  20707:'+(s.port20707?'open':'closed')+'  20773:'+(s.port20773?'open':'closed');
            var color = s.port20707 ? '#0a0' : (s.port20773 ? '#b80' : '#c00');
            td.style.color=color;
            td.style.fontWeight='600';
          });
        }
        function apiSvc(ids){
          // call per-id, merge as they resolve (keeps server light, avoids giant querystrings)
          var out={}; var pending=0;
          return new Promise(function(resolve){
            if(!ids||!ids.length){ resolve({}); return; }
            pending=ids.length;
            ids.forEach(function(shortId){
              fetch('/pluginadmin.ashx?pin=odcmini&svc=1&id='+encodeURIComponent(shortId),{credentials:'same-origin'})
                .then(function(r){ return r.json(); })
                .then(function(j){ out['node//'+shortId]=j; })
                .catch(function(){ out['node//'+shortId]=null; })
                .finally(function(){ if(--pending===0) resolve(out); });
            });
          });
        }
        function tickList(){
          if(!addHeader()) return;
          var ids=ensureCells(); if(ids.length===0) return;
          // only poll visible rows to avoid spam
          var vis=ids.slice(0,25);
          apiSvc(vis).then(paintList);
        }

        // Device page strip
        function currentNodeId(){
          var x=document.querySelector('[data-nodeid]'); if(x&&x.dataset.nodeid) return x.dataset.nodeid;
          var info=document.getElementById('deviceInfo'); if(info&&info.dataset&&info.dataset.nodeid) return info.dataset.nodeid;
          var h=location.hash||''; var m=h.match(/nodeid=([^&]+)/i); return m?decodeURIComponent(m[1]):null;
        }
        function ensurePill(){
          var host=document.getElementById('deviceInfo')||document.querySelector('#p1')||document.querySelector('#p11')||document.querySelector('.General');
          if(!host) return null;
          var id='odcmini-pill'; var pill=document.getElementById(id);
          if(!pill){
            pill=document.createElement('div'); pill.id=id; pill.style.marginTop='6px'; pill.style.fontWeight='600';
            host.appendChild(pill);
          }
          return pill;
        }
        function tickDevice(){
          var id=currentNodeId(); if(!id) return;
          fetch('/pluginadmin.ashx?pin=odcmini&svc=1&id='+encodeURIComponent(id),{credentials:'same-origin'})
            .then(function(r){return r.json();})
            .then(function(s){
              var pill=ensurePill(); if(!pill) return;
              if(!s||s.ok===false&&s.status==='Remote/other server (no check)'){
                pill.textContent='Ports: —';
                pill.style.color='#666';
                return;
              }
              if(!s||s.ok===false){ pill.textContent='Ports: Error'; pill.style.color='#c00'; return; }
              var state = s.port20707 ? 'App Online' : (s.port20773 ? 'Not signed in' : 'Offline');
              pill.textContent='Ports: '+state+'  (Svc:'+ (s.service||'Unknown') +', 20707:'+(s.port20707?'open':'closed')+', 20773:'+(s.port20773?'open':'closed')+')';
              pill.style.color = s.port20707 ? '#0a0' : (s.port20773 ? '#b80' : '#c00');
            })
            .catch(function(){});
        }

        // Hook & poll lightly
        document.addEventListener('meshcentralDeviceListRefreshEnd', function(){ setTimeout(tickList, 200); });
        document.addEventListener('meshcentralDeviceRefreshEnd', function(){ setTimeout(tickDevice, 200); });
        window.addEventListener('hashchange', function(){ setTimeout(function(){ tickList(); tickDevice(); }, 250); });

        setInterval(function(){ tickList(); tickDevice(); }, 8000);
        setTimeout(function(){ tickList(); tickDevice(); }, 900);
      }catch(e){ /* never break the UI */ }
    })();</script>`;
  };

  // We don’t need to do anything here; the inline script handles device page paint.
  obj.onDeviceRefreshEnd = function(){ return; };

  log("odcmini loaded");
  return obj;
};
