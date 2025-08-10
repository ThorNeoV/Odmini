"use strict";

module.exports = {
    init: function (parent) {
        const server = parent;
        const module = this;
        
        // =========================================
        // 1. Add custom column to devices grid
        // =========================================
        server.addDeviceColumn({
            id: "servicePortsStatus",
            name: "Service Ports",
            width: 120,
            sortable: true,
            value: (device) => {
                if (!device.custom || !device.custom.servicePorts) return "❓ Not checked";
                
                const status = device.custom.servicePorts;
                const port20707 = status[20707] ? "🟢" : "🔴";
                const port20773 = status[20773] ? "🟢" : "🔴";
                
                return `${port20707} 20707 | ${port20773} 20773`;
            }
        });

        // =========================================
        // 2. Add custom tab to device view
        // =========================================
        server.addDeviceTab({
            id: "servicePortsTab",
            name: "Service Ports",
            get: (device, cb) => {
                let content = `<div class="servicePortsContainer" style="padding:20px">`;
                
                if (device.custom && device.custom.servicePorts) {
                    const status = device.custom.servicePorts;
                    content += `
                        <h3>Port Status</h3>
                        <table class="ui table">
                            <tr><td>Port 20707:</td><td>${status[20707] ? '<span class="ui green label">Open</span>' : '<span class="ui red label">Closed</span>'}</td></tr>
                            <tr><td>Port 20773:</td><td>${status[20773] ? '<span class="ui green label">Open</span>' : '<span class="ui red label">Closed</span>'}</td></tr>
                        </table>
                        <button class="ui button" onclick="refreshPortStatus('${device.agentid}')">Re-check Ports</button>
                    `;
                } else {
                    content += `<p>No port status data available. <button class="ui button" onclick="refreshPortStatus('${device.agentid}')">Check Ports</button></p>`;
                }
                
                content += `</div>
                <script>
                    function refreshPortStatus(agentid) {
                        meshserver.send({ action: 'refreshPortStatus', agentid: agentid });
                    }
                </script>`;
                
                cb(content);
            }
        });

        // =========================================
        // 3. Handle port check requests
        // =========================================
        server.on("connection", (socket) => {
            socket.on("refreshPortStatus", (data) => {
                const device = server.getDevice(data.agentid);
                if (device && device.conn === 1) { // Device is online
                    module.checkPorts(device);
                }
            });
        });

        // =========================================
        // 4. Core function to check ports
        // =========================================
        this.checkPorts = function(device) {
            // Send command to check ports
            server.sendAgentAction(device.agentid, {
                action: "runcommand",
                run: {
                    command: "node",
                    args: ["-e", getPortCheckScript()],
                    wait: true,
                    output: true
                }
            }, (response) => {
                if (response.error) {
                    console.error("Port check error:", response.error);
                    return;
                }

                try {
                    const result = JSON.parse(response.output);
                    device.custom = device.custom || {};
                    device.custom.servicePorts = result;
                    
                    // Save to database
                    server.setCustomDeviceRecord(device.agentid, "servicePorts", result, (err) => {
                        if (err) console.error("Failed to save port status:", err);
                    });
                    
                    // Refresh UI
                    server.refreshDevice(device.agentid);
                } catch (e) {
                    console.error("Failed to parse port check results:", e);
                }
            });
        };

        // =========================================
        // 5. Port check script (runs on agent)
        // =========================================
        function getPortCheckScript() {
            return `
                const net = require('net');
                const ports = [20707, 20773];
                const results = {};
                
                const checkPort = (port) => new Promise(resolve => {
                    const socket = new net.Socket();
                    socket.setTimeout(2000);
                    
                    socket.on('connect', () => {
                        socket.destroy();
                        resolve(true);
                    });
                    
                    socket.on('timeout', () => {
                        socket.destroy();
                        resolve(false);
                    });
                    
                    socket.on('error', () => resolve(false));
                    
                    socket.connect(port, '127.0.0.1');
                });
                
                (async () => {
                    for (const port of ports) {
                        results[port] = await checkPort(port);
                    }
                    console.log(JSON.stringify(results));
                })();
            `;
        }

        // =========================================
        // 6. Check ports when device connects
        // =========================================
        server.on("device-connect", (agentid) => {
            const device = server.getDevice(agentid);
            if (device) module.checkPorts(device);
        });

        // =========================================
        // 7. Check ports on existing devices
        // =========================================
        setTimeout(() => {
            server.getDevices().forEach(device => {
                if (device.conn === 1) module.checkPorts(device);
            });
        }, 10000);
        
        console.log("Service Ports Plugin loaded");
    }
};
