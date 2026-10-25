const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const { getTurbo80Html } = require('./turbo80Html');

class Turbo80Manager extends EventEmitter {
    constructor() {
        super();
        this.context = null;
        this.currentPanel = null;
        this.isDebugging = false;
        this.isPaused = false;
        this.activeDoc = null;
        this.lastPausedPC = null;
        this.lastRegisters = null;
        this.lastMemoryBuffer = null;
        this._pendingPayload = null;
    }

    init(context) {
        this.context = context;
    }

    createOrShowPanel(options = {}) {
        const config = vscode.workspace.getConfiguration('borielBasic');
        const model = options.model || config.get('turbo80Model', '48k') || '48k';
        const crt = options.crt !== undefined ? options.crt : config.get('turbo80Crt', true);
        const filename = options.filename || 'main.tap';
        const isDebug = !!options.debug;

        this.isDebugging = isDebug;
        this.activeDoc = options.doc || null;

        const payload = {
            command: 'loadTap',
            base64: options.base64,
            filename: filename,
            model: model,
            crt: crt,
            debug: isDebug,
            breakpoints: options.breakpoints || [],
            entryAddr: options.entryAddr || null,
            stopOnEntry: options.stopOnEntry !== undefined ? options.stopOnEntry : true,
            mappedAddresses: options.mappedAddresses || []
        };
        this._pendingPayload = payload;

        if (this.currentPanel) {
            this.currentPanel.reveal(vscode.ViewColumn.Beside, false);
            this.currentPanel.title = `ZX: ${filename}${isDebug ? ' (Debug)' : ''}`;
            this.currentPanel.webview.postMessage(payload);
            return this.currentPanel;
        }

        const extensionUri = this.context ? this.context.extensionUri : vscode.Uri.file(__dirname);

        this.currentPanel = vscode.window.createWebviewPanel(
            'borielBasicTurbo80',
            `ZX: ${filename}${isDebug ? ' (Debug)' : ''}`,
            {
                viewColumn: vscode.ViewColumn.Beside,
                preserveFocus: false
            },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.joinPath(extensionUri, 'media')
                ]
            }
        );

        this.currentPanel.webview.html = getTurbo80Html(this.currentPanel.webview, extensionUri, vscode);

        this.currentPanel.webview.onDidReceiveMessage(message => {
            if (!message) return;
            if (message.command === 'ready') {
                if (this._pendingPayload) {
                    this.currentPanel.webview.postMessage(this._pendingPayload);
                }
            } else if (message.command === 'cpuPaused') {
                this.isPaused = true;
                this.lastPausedPC = message.pc;
                this.lastRegisters = message.registers;
                if (message.ramBase64) {
                    try {
                        this.lastMemoryBuffer = Buffer.from(message.ramBase64, 'base64');
                    } catch (e) {}
                }
                this.emit('cpuPaused', message);
            } else if (message.command === 'cpuResumed') {
                this.isPaused = false;
                this.emit('cpuResumed');
            } else if (message.command === 'programEnded') {
                this.isDebugging = false;
                this.isPaused = false;
                this.emit('programEnded', message);
            } else if (message.command === 'debugStopped') {
                this.isDebugging = false;
                this.isPaused = false;
                this.emit('debugStopped');
            }
        });

        this.currentPanel.onDidDispose(() => {
            this.currentPanel = null;
            this.isDebugging = false;
            this.isPaused = false;
            this.emit('closed');
        });

        return this.currentPanel;
    }

    continue() {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'continue' });
        }
    }

    pause() {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'pause' });
        }
    }

    stepOver(mappedAddresses) {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'stepOver', mappedAddresses });
        }
    }

    stepInto(mappedAddresses) {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'stepInto', mappedAddresses });
        }
    }

    stepOut(mappedAddresses) {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'stepOut', mappedAddresses });
        }
    }

    setBreakpoints(breakpoints) {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'setBreakpoints', breakpoints });
        }
    }

    stop() {
        if (this.currentPanel) {
            this.currentPanel.webview.postMessage({ command: 'stop' });
        }
        this.isDebugging = false;
        this.isPaused = false;
    }
}

const turbo80Manager = new Turbo80Manager();
module.exports = turbo80Manager;
