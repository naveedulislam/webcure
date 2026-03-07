import * as http from 'http';
import * as vscode from 'vscode';

export class ApiServer {
    private server: http.Server | null = null;
    private outputChannel: vscode.OutputChannel;
    private toolMap: { [key: string]: vscode.LanguageModelTool<any> };
    private startTime: Date | null = null;

    constructor(
        toolInstances: any,
        outputChannel: vscode.OutputChannel
    ) {
        this.outputChannel = outputChannel;
        
        // Create comprehensive tool map with aliases (same as script runner)
        this.toolMap = {
            'navigate': toolInstances.navigate,
            'resize': toolInstances.resize,
            'extract': toolInstances.extract,
            'click': toolInstances.click,
            'hover': toolInstances.hover,
            'type': toolInstances.type,
            'typeFromFile': toolInstances.typeFromFile,
            'type_from_file': toolInstances.typeFromFile,
            'waitFor': toolInstances.waitFor,
            'wait_for': toolInstances.waitFor,
            'waitForElement': toolInstances.waitForElement,
            'wait_for_element': toolInstances.waitForElement,
            'select': toolInstances.select,
            'selectOption': toolInstances.select,
            'select_option': toolInstances.select,
            'fillForm': toolInstances.fillForm,
            'fill_form': toolInstances.fillForm,
            'screenshot': toolInstances.screenshot,
            'takeScreenshot': toolInstances.screenshot,
            'take_screenshot': toolInstances.screenshot,
            'close': toolInstances.close,
            'consoleMessages': toolInstances.consoleMessages,
            'console_messages': toolInstances.consoleMessages,
            'drag': toolInstances.drag,
            'evaluate': toolInstances.evaluate,
            'fileUpload': toolInstances.fileUpload,
            'file_upload': toolInstances.fileUpload,
            'handleDialog': toolInstances.handleDialog,
            'handle_dialog': toolInstances.handleDialog,
            'navigateBack': toolInstances.navigateBack,
            'navigate_back': toolInstances.navigateBack,
            'networkRequests': toolInstances.networkRequests,
            'network_requests': toolInstances.networkRequests,
            'pressKey': toolInstances.pressKey,
            'press_key': toolInstances.pressKey,
            'snapshot': toolInstances.snapshot,
            'tabs': toolInstances.tabs,
            'find': toolInstances.find,
            'interact': toolInstances.interact,
            'scrapeMenu': toolInstances.scrapeMenu,
            'scrape_menu': toolInstances.scrapeMenu,
            'scrapePage': toolInstances.scrapePage,
            'scrape_page': toolInstances.scrapePage
        };
    }

    public get actualPort(): number | null {
        return this._actualPort;
    }

    private _actualPort: number | null = null;

    public start(port: number, host: string = '127.0.0.1', maxRetries: number = 10): Promise<number> {
        if (this.server) {
            return Promise.resolve(this._actualPort!);
        }

        return new Promise((resolve, reject) => {
            this._tryListen(port, host, maxRetries, 0, resolve, reject);
        });
    }

    private _tryListen(port: number, host: string, maxRetries: number, attempt: number, resolve: (port: number) => void, reject: (err: Error) => void) {
        try {
            const server = http.createServer(async (req, res) => {
                // Enable CORS
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

                if (req.method === 'OPTIONS') {
                    res.writeHead(200);
                    res.end();
                    return;
                }

                // Health check endpoint
                if (req.url === '/health' && req.method === 'GET') {
                    const uptime = this.startTime ? Math.floor((Date.now() - this.startTime.getTime()) / 1000) : 0;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        status: 'ok',
                        uptime: uptime,
                        tools: Object.keys(this.toolMap).filter((k, i, arr) => arr.indexOf(k) === i).length
                    }));
                    return;
                }

                // List available tools endpoint
                if (req.url === '/tools' && req.method === 'GET') {
                    const uniqueTools = [...new Set(Object.keys(this.toolMap))].sort();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ tools: uniqueTools }));
                    return;
                }

                if (req.method !== 'POST') {
                    res.writeHead(405, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Method not allowed' }));
                    return;
                }

                if (req.url !== '/invoke') {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Not found. Available endpoints: /invoke (POST), /health (GET), /tools (GET)' }));
                    return;
                }

                let body = '';
                req.on('data', chunk => body += chunk);
                req.on('end', async () => {
                    try {
                        const data = JSON.parse(body);
                        const { tool, params } = data;

                        if (!tool || !this.toolMap[tool]) {
                            res.writeHead(400, { 'Content-Type': 'application/json' });
                            res.end(JSON.stringify({ error: `Unknown tool: ${tool}` }));
                            return;
                        }

                        const toolInstance = this.toolMap[tool];
                        
                        this.outputChannel.appendLine(`API Invoke: ${tool}`);
                        
                        const result = await toolInstance.invoke({
                            input: params || {},
                            toolInvocationToken: undefined as any
                        }, new vscode.CancellationTokenSource().token);

                        let output = '';
                        if (result && result.content) {
                            for (const part of result.content) {
                                if (part instanceof vscode.LanguageModelTextPart) {
                                    output += part.value;
                                }
                            }
                        }

                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: true, output }));

                    } catch (error: any) {
                        res.writeHead(500, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: error.message }));
                    }
                });
            });

            server.listen(port, host, () => {
                this.server = server;
                this._actualPort = port;
                this.startTime = new Date();
                this.outputChannel.appendLine(`API Server started on ${host}:${port}`);
                resolve(port);
            });
            
            server.on('error', (err: any) => {
                if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
                    const nextPort = port + 1;
                    this.outputChannel.appendLine(`Port ${port} in use, trying ${nextPort}...`);
                    this._tryListen(nextPort, host, maxRetries, attempt + 1, resolve, reject);
                } else {
                    this.outputChannel.appendLine(`API Server error: ${err.message}`);
                    reject(err);
                }
            });
        } catch (error: any) {
            this.outputChannel.appendLine(`Failed to start API Server: ${error.message}`);
            reject(error);
        }
    }

    public stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            this._actualPort = null;
            this.startTime = null;
            this.outputChannel.appendLine('API Server stopped');
        }
    }
}
