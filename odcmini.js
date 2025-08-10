"use strict";

/**
 * ODC Mini – single endpoint, admin bridge only.
 * URLs (when logged in):
 *   /pluginadmin.ashx?pin=odcmini&health=1
 */

module.exports.odcmini = function (parent) {
  const obj = {};
  obj.parent = parent;
  obj.meshServer = parent.parent;

  // SAFETY: only expose the admin bridge handler. No other hooks.
  obj.exports = ["handleAdminReq"];

  // (Optional) tiny logger that won’t crash if server methods change.
  const log = (m)=>{ try{ obj.meshServer.info("odcmini: " + m); }catch{ /*noop*/ } };

  obj.handleAdminReq = function(req, res, user) {
    try {
      if (req.query.health == 1) {
        res.json({
          ok: true,
          plugin: "odcmini",
          exports: obj.exports,
          hasUser: !!user
        });
        return;
      }
      res.sendStatus(404);
    } catch (e) {
      try { obj.meshServer.debug("odcmini error: " + (e && e.stack || e)); } catch {}
      res.sendStatus(500);
    }
  };

  log("loaded");
  return obj;
};
