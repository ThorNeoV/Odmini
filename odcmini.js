"use strict";

module.exports = {
    init: function (parent) {
        const server = parent;
        const module = this;
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
                    if (err || !record) {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        return res.end(JSON.stringify({ error: "No status data" }));
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        ports: record.data,
                        timestamp: record.ts
                    }));
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
                
                module.runPortCheck(nodeid, (result) => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                });
                return;
            }
            
            // Default: Serve UI iframe content
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
<!DOCTYPE html>
<html>
<head>
    <title>ODC Services</title>
    <link rel="stylesheet" href="/public/semantic/semantic.min.css">
    <style>
        body { padding: 20px; background: #f8f8f8; }
        .ui.table { margin-top: 15px; }
        .refresh-btn { margin-top: 15px; }
    </style>
</head>
<body>
    <h2>ODC Service Status</h2>
    <div id="status-container">Loading...</div>
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
                    
                    let html = '<table class="ui compact table">';
                    html += '<thead><tr><th>Port</th><th>Service</th><th>Status</th></tr></thead>';
                    html += '<tbody>';
                    html += '<tr><td>20707</td><td>Main Service</td><td>' + 
                        (ports[20707] ? '<span class="ui green label">Running</span>' : '<span class="ui red label">Stopped</span>') + 
                        '</td></tr>';
                    html += '<tr><td>20773</td><td>Helper Service</td><td>' + 
                        (ports[20773] ? '<span class="ui green label">Running</span>' : '<span class="ui red label">Stopped</span>') + 
                        '</td></tr>';
                    html += '</tbody></table>';
                    html += '<p><small>Last checked: ' + timestamp + '</small></p>';
                    
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
            // Auto-refresh every 5 minutes
            setInterval(loadStatus, 300000);
        });
    </script>
</body>
</html>
            `);
        });

        // =========================================
        // 2. Core port check function (using netstat)
        // =========================================
        this.runPortCheck = function(nodeid, callback) {
            const agent = server.wsagents[nodeid];
            if (!agent || agent.state !== 1) {
                return callback({ error: "Agent offline" });
            }
            
            // Platform-specific commands
            const commands = {
                win32: [
                    'netstat -an | find "LISTENING" | find ":20707" > nul && echo 20707:true || echo 20707:false',
                    'netstat -an | find "LISTENING" | find ":20773" > nul && echo 20773:true || echo 20773:false'
                ].join(' & '),
                linux: [
                    'netstat -tuln | grep -E ":20707\\s" > /dev/null && echo "20707:true" || echo "20707:false"',
                    'netstat -tuln | grep -E ":20773\\s" > /dev/null && echo "20773:true" || echo "20773:false"'
                ].join(' ; '),
                darwin: [
                    'netstat -an | grep -E ".20707\\s" | grep LISTEN > /dev/null && echo "20707:true" || echo "20707:false"',
                    'netstat -an | grep -E ".20773\\s" | grep LISTEN > /dev/null && echo "20773:true" || echo "20773:false"'
                ].join(' ; ')
            };
            
            // Create command object
            const cmd = {
                action: "runcommands",
                cmds: [],
                responseid: "odcmini-" + Date.now()
            };
            
            // Add platform-appropriate command
            if (agent.core && agent.core.platform === 'win32') {
                cmd.cmds.push({ cmd: 'cmd.exe', args: ['/c', commands.win32] });
            } else if (agent.core && agent.core.platform === 'darwin') {
                cmd.cmds.push({ cmd: '/bin/bash', args: ['-c', commands.darwin] });
            } else {
                cmd.cmds.push({ cmd: '/bin/sh', args: ['-c', commands.linux] });
            }
            
            // Send command to agent
            agent.send(JSON.stringify(cmd));
            
            // Handle response
            const responseHandler = (agent, msg) => {
                if (msg.responseid === cmd.responseid) {
                    server.removeListener('agentmessage', responseHandler);
                    
                    let result = { 20707: false, 20773: false };
                    let output = "";
                    
                    // Collect output from all commands
                    if (msg.cmds) {
                        msg.cmds.forEach(c => {
                            if (c.output) output += c.output;
                        });
                    }
                    
                    // Parse output
                    output.split('\n').forEach(line => {
                        const match = line.match(/(20707|20773):(true|false)/);
                        if (match) {
                            result[parseInt(match[1])] = match[2] === 'true';
                        }
                    });
                    
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
            }, 30000);
        };

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
                            let html = '';
                            html += ports[20707] ? '<span style="color:green">✓ 20707</span> ' : '<span style="color:red">✗ 20707</span> ';
                            html += ports[20773] ? '<span style="color:green">✓ 20773</span>' : '<span style="color:red">✗ 20773</span>';
                            return html;
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
        // 4. Perform initial checks
        // =========================================
        setTimeout(() => {
            console.log(pluginName + " Plugin: Performing initial port checks");
            Object.keys(server.wsagents).forEach(nodeid => {
                const agent = server.wsagents[nodeid];
                if (agent && agent.state === 1) {
                    module.runPortCheck(nodeid, () => {});
                }
            });
        }, 30000);
        
        console.log(pluginName + " Plugin: Loaded successfully");
    }
};
