"use strict";

// This is the main plugin function that MeshCentral expects
module.exports.odcmini = function (server, config) {
    const pluginName = "odcmini";
    const customRecordKey = pluginName + "-ports";
    
    console.log(pluginName + " Plugin: Initializing...");

    // =========================================
    // 1. Register plugin admin handler for iframe UI
    // =========================================
    server.pluginAdminRegisterHandler(pluginName, (req, res, next) => {
        const query = req.query || {};
        const nodeid = query.nodeid;
        const action = query.action;
        
        // Handle health check requests
        if (action === 'health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: "ok" }));
        }
        
        // Handle port status requests
        if (action === 'status' && nodeid) {
            server.db.Get(nodeid, customRecordKey, (err, record) => {
                const response = err || !record ? 
                    { error: "No status data" } : 
                    { ports: record.data, timestamp: record.ts };
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(response));
            });
            return;
        }
        
        // Handle port check execution
        if (action === 'check' && nodeid) {
            const agent = server.wsagents[nodeid];
            if (!agent || agent.state !== 1) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "Agent offline" }));
            }
            
            runPortCheck(nodeid, (result) => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            });
            return;
        }
        
        // Default: Serve UI iframe content
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(getUIHTML(pluginName));
    });

    // =========================================
    // 2. Core port check function (using netstat)
    // =========================================
    function runPortCheck(nodeid, callback) {
        const agent = server.wsagents[nodeid];
        if (!agent || agent.state !== 1) {
            return callback({ error: "Agent offline" });
        }
        
        // Platform-specific commands
        const commands = {
            win32: 'netstat -an | find "LISTENING" | findstr /C:":20707" /C:":20773"',
            linux: 'netstat -tuln | grep -E ":20707|:20773"',
            darwin: 'netstat -an | grep -E ".20707|.20773" | grep LISTEN'
        };
        
        // Create command object
        const cmd = {
            action: "runcommands",
            cmds: [{
                cmd: agent.core.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
                args: [
                    agent.core.platform === 'win32' ? '/c' : '-c',
                    commands[agent.core.platform] || commands.linux
                ]
            }],
            responseid: "odcmini-" + Date.now()
        };
        
        // Send command to agent
        agent.send(JSON.stringify(cmd));
        
        // Handle response
        const responseHandler = (agent, msg) => {
            if (msg.responseid === cmd.responseid) {
                server.removeListener('agentmessage', responseHandler);
                
                const result = { 20707: false, 20773: false };
                let output = "";
                
                // Collect output from all commands
                if (msg.cmds && msg.cmds.length > 0 && msg.cmds[0].output) {
                    output = msg.cmds[0].output;
                }
                
                // Parse output
                result[20707] = output.includes(':20707');
                result[20773] = output.includes(':20773');
                
                // Save result
                const record = {
                    data: result,
                    ts: Date.now()
                };
                
                server.db.Set(nodeid, customRecordKey, record, (err) => {
                    if (err) console.error(pluginName + " Plugin: Save error -", err);
                    callback({ success: true, ports: result });
                });
            }
        };
        
        server.on('agentmessage', responseHandler);
        
        // Set timeout in case no response
        setTimeout(() => {
            server.removeListener('agentmessage', responseHandler);
            callback({ error: "Timeout waiting for response" });
        }, 15000);
    }

    // =========================================
    // 3. Register UI elements safely
    // =========================================
    server.on("webui-startup-end", (req, res) => {
        // Add custom column
        res.end(`
            <script>
            $(function() {
                // Add custom column
                meshserver.addDeviceColumn({
                    id: "odcminiStatus",
                    name: "ODC Services",
                    width: 120,
                    sortable: true,
                    value: function(device) {
                        const record = device.customRecords && device.customRecords['${customRecordKey}'];
                        if (!record || !record.data) return '<span class="ui grey label">N/A</span>';
                        
                        const ports = record.data;
                        return ports[20707] 
                            ? '<span style="color:green">✓ 20707</span>' 
                            : '<span style="color:red">✗ 20707</span>';
                    }
                });
                
                // Add custom tab
                meshserver.addDeviceTab('odcminiTab', 'ODC Services', function(device) {
                    return '/pluginadmin.ashx?pin=${pluginName}&nodeid=' + device._id;
                });
            });
            </script>
        `);
    });

    // =========================================
    // 4. UI HTML Template
    // =========================================
    function getUIHTML(pluginName) {
        return `
<!DOCTYPE html>
<html>
<head>
    <title>ODC Services</title>
    <link rel="stylesheet" href="/public/semantic/semantic.min.css">
    <style>
        body { padding: 20px; background: #f8f8f8; }
        .ui.table { margin-top: 15px; }
        .refresh-btn { margin-top: 15px; }
        .status-badge { display: inline-block; width: 20px; text-align: center; }
    </style>
</head>
<body>
    <h2><i class="plug icon"></i> ODC Service Status</h2>
    <div id="status-container">Loading service status...</div>
    <button class="ui blue button refresh-btn" onclick="runCheck()">
        <i class="sync icon"></i> Refresh Status
    </button>
    
    <script src="/public/jquery-3.4.1.min.js"></script>
    <script>
        const nodeid = new URLSearchParams(window.location.search).get('nodeid');
        
        function loadStatus() {
            $.get('/pluginadmin.ashx?pin=${pluginName}&action=status&nodeid=' + nodeid)
                .done(data => {
                    if (data.error) {
                        $('#status-container').html('<div class="ui red message">' + data.error + '</div>');
                        return;
                    }
                    
                    const ports = data.ports;
                    const timestamp = new Date(data.timestamp).toLocaleString();
                    
                    let html = '<div class="ui two statistics">';
                    html += '<div class="statistic">';
                    html += '  <div class="value">';
                    html += ports[20707] ? '<span class="status-badge" style="color:green">✓</span>' : '<span class="status-badge" style="color:red">✗</span>';
                    html += '  </div>';
                    html += '  <div class="label">Port 20707<br>Main Service</div>';
                    html += '</div>';
                    html += '<div class="statistic">';
                    html += '  <div class="value">';
                    html += ports[20773] ? '<span class="status-badge" style="color:green">✓</span>' : '<span class="status-badge" style="color:red">✗</span>';
                    html += '  </div>';
                    html += '  <div class="label">Port 20773<br>Helper Service</div>';
                    html += '</div>';
                    html += '</div>';
                    html += '<p class="ui small text"><i class="clock icon"></i> Last checked: ' + timestamp + '</p>';
                    
                    $('#status-container').html(html);
                })
                .fail(() => {
                    $('#status-container').html('<div class="ui red message">Failed to load status</div>');
                });
        }
        
        function runCheck() {
            $('.refresh-btn').addClass('loading');
            $.get('/pluginadmin.ashx?pin=${pluginName}&action=check&nodeid=' + nodeid)
                .done(data => {
                    if (data.error) {
                        alert('Error: ' + data.error);
                    } else {
                        loadStatus();
                    }
                })
                .fail(() => alert('Refresh failed'))
                .always(() => $('.refresh-btn').removeClass('loading'));
        }
        
        $(document).ready(() => {
            loadStatus();
        });
    </script>
</body>
</html>
        `;
    }

    // =========================================
    // 5. Perform initial checks
    // =========================================
    setTimeout(() => {
        console.log(pluginName + " Plugin: Performing initial port checks");
        Object.keys(server.wsagents).forEach(nodeid => {
            const agent = server.wsagents[nodeid];
            if (agent && agent.state === 1) {
                runPortCheck(nodeid, () => {});
            }
        });
    }, 10000);
    
    console.log(pluginName + " Plugin: Loaded successfully");
};
