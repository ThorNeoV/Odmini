"use strict";

module.exports = {
    init: function (parent) {
        const server = parent;
        const module = this;
        const ports = [20707, 20773]; // Ports to check
        
        console.log("ODCMini Plugin: Initializing...");

        // =========================================
        // 1. Core port check function
        // =========================================
        this.checkPorts = function(device) {
            if (device.conn !== 1) return; // Skip offline devices
            
            server.sendAgentAction(device.agentid, {
                action: "runcommand",
                run: {
                    command: "node",
                    args: ["-e", module.getPortCheckScript(ports)],
                    wait: true,
                    output: true
                }
            }, (response) => {
                if (response.error) {
                    console.error(`ODCMini Plugin: Error checking ${device.name} -`, response.error);
                    return;
                }

                try {
                    const result = JSON.parse(response.output);
                    device.custom = device.custom || {};
                    device.custom.servicePorts = result;
                    
                    server.setCustomDeviceRecord(device.agentid, "servicePorts", result, (err) => {
                        if (err) console.error("ODCMini Plugin: Save error -", err);
                    });
                    
                    server.refreshDevice(device.agentid);
                } catch (e) {
                    console.error("ODCMini Plugin: Parse error -", e, "Output:", response.output);
                }
            });
        };

        // =========================================
        // 2. Port check script generator
        // =========================================
        this.getPortCheckScript = function(ports) {
            return Buffer.from(`
                const net = require('net');
                const ports = ${JSON.stringify(ports)};
                const timeout = 1500;
                const results = {};
                
                const checkPort = (port) => new Promise(resolve => {
                    const socket = new net.Socket();
                    socket.setTimeout(timeout);
                    
                    socket.once('connect', () => {
                        socket.destroy();
                        resolve(true);
                    }).once('timeout', () => {
                        socket.destroy();
                        resolve(false);
                    }).once('error', () => resolve(false));
                    
                    socket.connect(port, '127.0.0.1');
                });
                
                (async () => {
                    for (const port of ports) {
                        results[port] = await checkPort(port);
                    }
                    console.log(JSON.stringify(results));
                })();
            `).toString('base64');
        };

        // =========================================
        // 3. Device column for port status
        // =========================================
        server.addDeviceColumn({
            id: "odcminiServices",
            name: "ODC Services",
            width: 150,
            sortable: true,
            value: (device) => {
                if (!device.custom?.servicePorts) return '<span class="ui grey label">N/A</span>';
                
                let statusHtml = '';
                for (const port of ports) {
                    if (device.custom.servicePorts[port]) {
                        statusHtml += `<span style="color:green;margin-right:10px">✓ ${port}</span>`;
                    } else {
                        statusHtml += `<span style="color:red;margin-right:10px">✗ ${port}</span>`;
                    }
                }
                return statusHtml;
            }
        });

        // =========================================
        // 4. Device tab for detailed status
        // =========================================
        server.addDeviceTab({
            id: "odcminiTab",
            name: "ODC Services",
            get: (device, cb) => {
                const status = device.custom?.servicePorts || {};
                const refreshFn = `refreshODCStatus('${device.agentid}')`;
                
                const content = `
                    <div style="padding:20px">
                        <h3><i class="plug icon"></i> ODC Service Port Status</h3>
                        <table class="ui compact celled table">
                            <thead>
                                <tr>
                                    <th>Port</th>
                                    <th>Service</th>
                                    <th>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr>
                                    <td>20707</td>
                                    <td>Main Service</td>
                                    <td>${status[20707] ? '<span class="ui green label">Running</span>' : '<span class="ui red label">Stopped</span>'}</td>
                                </tr>
                                <tr>
                                    <td>20773</td>
                                    <td>Helper Service</td>
                                    <td>${status[20773] ? '<span class="ui green label">Running</span>' : '<span class="ui red label">Stopped</span>'}</td>
                                </tr>
                            </tbody>
                        </table>
                        <button class="ui blue button" onclick="${refreshFn}">
                            <i class="sync icon"></i> Refresh Status
                        </button>
                        <script>
                            function refreshODCStatus(agentid) {
                                meshserver.send({ action: 'refreshODCStatus', agentid: agentid });
                            }
                        </script>
                    </div>
                `;
                cb(content);
            }
        });

        // =========================================
        // 5. Handle refresh requests
        // =========================================
        server.on("connection", (socket) => {
            socket.on("refreshODCStatus", (data) => {
                const device = server.getDevice(data.agentid);
                if (device) {
                    console.log(`ODCMini Plugin: Manual refresh for ${device.name}`);
                    module.checkPorts(device);
                }
            });
        });

        // =========================================
        // 6. Automatic checks
        // =========================================
        server.on("device-connect", (agentid) => {
            setTimeout(() => {
                const device = server.getDevice(agentid);
                if (device) {
                    console.log(`ODCMini Plugin: Checking ${device.name} on connect`);
                    module.checkPorts(device);
                }
            }, 10000); // Check 10 seconds after connection
        });

        // Initial check after 20 seconds
        setTimeout(() => {
            console.log("ODCMini Plugin: Performing initial port checks");
            server.getDevices().forEach(device => {
                if (device.conn === 1) module.checkPorts(device);
            });
        }, 20000);
        
        console.log("ODCMini Plugin: Loaded successfully");
    }
};
