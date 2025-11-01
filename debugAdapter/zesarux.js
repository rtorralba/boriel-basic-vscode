const net = require('net');

/**
 * Módulo de comunicación con ZEsarUX
 * Gestiona la conexión socket y los comandos del protocolo remoto de debug
 */
class ZesaruxClient {
    constructor(session) {
        this.session = session;
        this._debugSocket = null;
        this._socketBuffer = '';
        this._lastCommandSent = null;
        this._breakpointsEnabled = false;
        this._breakpointIdCounter = 1;
        this._breakpoints = new Map();
        this._breakpointAddrToId = new Map();
        this._pendingBreakpoints = [];
    }

    /**
     * Conecta al puerto de debug remoto de ZEsarUX
     */
    async connect(port, maxRetries = 5) {
        for (let i = 0; i < maxRetries; i++) {
            try {
                await this._attemptConnection(port);
                // Al conectar, habilitar breakpoints y aplicar breakpoints pendientes
                try {
                    await this.ensureBreakpointsEnabled();
                } catch (e) {
                    // No fatal
                }
                try {
                    await this.flushPendingBreakpoints();
                } catch (e) {
                    const { OutputEvent } = require('@vscode/debugadapter');
                    this.session.sendEvent(new OutputEvent(`⚠ Error aplicando breakpoints pendientes: ${e.message}\n`, 'stderr'));
                }
                return;
            } catch (err) {
                if (i < maxRetries - 1) {
                    this.session.sendEvent(new (require('@vscode/debugadapter').OutputEvent)(`Reintento ${i + 1}/${maxRetries}...\n`));
                    await this._wait(1000);
                } else {
                    throw err;
                }
            }
        }
    }

    /**
     * Intenta establecer conexión socket con ZEsarUX
     */
    async _attemptConnection(port) {
        return new Promise((resolve, reject) => {
            this._debugSocket = new net.Socket();
            
            let connected = false;
            const timeout = setTimeout(() => {
                if (!connected) {
                    this._debugSocket.destroy();
                    reject(new Error('Timeout al conectar'));
                }
            }, 2000);

            this._debugSocket.on('data', (data) => {
                this.session._handleSocketData(data);
            });

            this._debugSocket.on('error', (err) => {
                clearTimeout(timeout);
                if (!connected) {
                    reject(err);
                }
            });

            this._debugSocket.on('close', () => {
                if (connected) {
                    const { OutputEvent, TerminatedEvent } = require('@vscode/debugadapter');
                    this.session.sendEvent(new OutputEvent('Conexión con ZEsarUX cerrada\n'));
                    this.session.sendEvent(new TerminatedEvent());
                }
            });

            this._debugSocket.connect(port, 'localhost', () => {
                clearTimeout(timeout);
                connected = true;
                resolve();
            });
        });
    }

    /**
     * Envía un comando a ZEsarUX sin esperar respuesta específica
     */
    async sendCommand(command) {
        return new Promise((resolve, reject) => {
            if (!this._debugSocket || this._debugSocket.destroyed) {
                reject(new Error('No hay conexión con ZEsarUX'));
                return;
            }

            this._lastCommandSent = command;
            const { OutputEvent } = require('@vscode/debugadapter');
            this.session.sendEvent(new OutputEvent(`> ${command}\n`, 'console'));
            this._debugSocket.write(command + '\n');

            // Esperar un poco para la respuesta
            setTimeout(() => resolve(), 100);
        });
    }

    /**
     * Envía un comando y espera su respuesta
     */
    async sendCommandAndWait(command) {
        return new Promise((resolve, reject) => {
            if (!this._debugSocket || this._debugSocket.destroyed) {
                reject(new Error('No hay conexión con ZEsarUX'));
                return;
            }
            
            const { OutputEvent } = require('@vscode/debugadapter');
            this.session.sendEvent(new OutputEvent(`> ${command}\n`, 'console'));
            
            let resolved = false;
            const dataListener = (data) => {
                try {
                    const txt = data.toString();
                    if (!resolved) {
                        resolved = true;
                        this._debugSocket.removeListener('data', dataListener);
                        resolve(txt);
                    }
                } catch (e) {
                    if (!resolved) {
                        resolved = true;
                        this._debugSocket.removeListener('data', dataListener);
                        resolve('');
                    }
                }
            };
            
            this._debugSocket.on('data', dataListener);
            this._debugSocket.write(command + '\n');
        });
    }

    /**
     * Lee memoria desde ZEsarUX
     */
    async readMemory(addrNum, length = 1) {
        if (!this._debugSocket || this._debugSocket.destroyed) return null;
        
        try {
            const { OutputEvent } = require('@vscode/debugadapter');
            const hex = parseInt(addrNum, 10).toString(16).toUpperCase().padStart(4, '0');
            const cmd = `read-memory ${hex}H ${length}`;
            this.session.sendEvent(new OutputEvent(`> ${cmd}\n`, 'console'));
            const resp = await this.sendCommandAndWait(cmd);
            const txt = String(resp || '').trim();

            // Common response formats vary. Extract hex byte pairs from the response.
            const bytes = [];
            // First, try to find sequences of 2-hex-digit tokens
            const mPairs = txt.match(/\b[0-9A-Fa-f]{2}\b/g);
            if (mPairs && mPairs.length > 0) {
                for (let i = 0; i < Math.min(mPairs.length, length); i++) {
                    bytes.push(parseInt(mPairs[i], 16));
                }
                return bytes;
            }

            // Next, try to find longer hex and split
            const mLong = txt.match(/\b[0-9A-Fa-f]+\b/);
            if (mLong && mLong[0].length >= 2) {
                const s = mLong[0];
                // If the string length is even, split into bytes
                if (s.length % 2 === 0) {
                    for (let i = 0; i < Math.min(s.length / 2, length); i++) {
                        const hexPart = s.substr(i * 2, 2);
                        bytes.push(parseInt(hexPart, 16));
                    }
                    return bytes;
                }
            }

            // If nothing parsed, return null
            return null;
        } catch (e) {
            const { OutputEvent } = require('@vscode/debugadapter');
            this.session.sendEvent(new OutputEvent(`[Debug] readMemory error: ${e.message}\n`, 'stderr'));
            return null;
        }
    }

    /**
     * Habilita el sistema de breakpoints moderno de ZEsarUX
     */
    async ensureBreakpointsEnabled() {
        if (this._breakpointsEnabled) return;
        if (!this._debugSocket || this._debugSocket.destroyed) return;
        
        try {
            const { OutputEvent } = require('@vscode/debugadapter');
            const resp = await this.sendCommandAndWait('enable-breakpoints');
            const lower = String(resp || '').toLowerCase();
            
            if (lower.includes('unknown command')) {
                this._breakpointsEnabled = false;
                this.session.sendEvent(new OutputEvent(`⚠ enable-breakpoints no soportado por el emulador: respuesta='${resp.replace(/\n/g,' ')}'\n`));
            } else {
                this._breakpointsEnabled = true;
                this.session.sendEvent(new OutputEvent(`✓ enable-breakpoints soportado y activado en el emulador (resp: ${resp.replace(/\n/g,' ')})\n`));
            }
        } catch (e) {
            this._breakpointsEnabled = false;
            const { OutputEvent } = require('@vscode/debugadapter');
            this.session.sendEvent(new OutputEvent(`⚠ enable-breakpoints no soportado por el emulador: ${e.message}\n`));
        }
    }

    /**
     * Instala un breakpoint en la dirección indicada
     * Devuelve truthy si se instaló (id o true), o false si falló.
     */
    async installBreakpoint(addrToken, clientLine) {
        // addrToken expected like '8000h' or '1F3Ah'
        const hexPart = String(addrToken).replace(/h$/i, '');
        const addrNum = parseInt(hexPart, 16);
        if (isNaN(addrNum)) throw new Error('Dirección de breakpoint inválida: ' + addrToken);

        // Si el emulador soporta set-breakpoint, usarlo
        if (this._breakpointsEnabled && this._debugSocket && !this._debugSocket.destroyed) {
            const bpId = this._breakpointIdCounter++;
            const hexNoPrefix = addrNum.toString(16).toUpperCase();
            const cmd = `set-breakpoint ${bpId} PC=${hexNoPrefix}H`;
            
            try {
                const resp = await this.sendCommandAndWait(cmd);
                const lower = String(resp || '').toLowerCase();
                
                if (lower.includes('unknown command') || lower.includes('error setting breakpoint') || 
                    lower.includes('error adding breakpoint') || lower.includes('error')) {
                    const { OutputEvent } = require('@vscode/debugadapter');
                    this.session.sendEvent(new OutputEvent(`⚠ set-breakpoint respondió con: ${resp.replace(/\n/g,' ')}; usando fallback legacy\n`, 'stderr'));
                    try {
                        await this.sendCommand(`break set ${addrToken}`);
                        return true;
                    } catch (e2) {
                        return false;
                    }
                }
                
                // éxito
                this._breakpointAddrToId.set(addrNum, bpId);
                this._breakpoints.set(bpId, { addr: addrNum, clientLine, remoteCmd: cmd });
                return bpId;
            } catch (e) {
                // fallback legacy
                try {
                    await this.sendCommand(`break set ${addrToken}`);
                    return true;
                } catch (e2) {
                    return false;
                }
            }
        }

        // Legacy path
        try {
            await this.sendCommand(`break set ${addrToken}`);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Aplica breakpoints que se solicitaron antes de que hubiera conexión
     */
    async flushPendingBreakpoints() {
        if (!this._pendingBreakpoints || this._pendingBreakpoints.length === 0) return;
        if (!this._debugSocket || this._debugSocket.destroyed) {
            throw new Error('No hay conexión para aplicar breakpoints pendientes');
        }
        
        const { OutputEvent } = require('@vscode/debugadapter');
        this.session.sendEvent(new OutputEvent(`Aplicando ${this._pendingBreakpoints.length} breakpoints pendientes...\n`));
        
        while (this._pendingBreakpoints.length > 0) {
            const pb = this._pendingBreakpoints.shift();
            try {
                const installed = await this.installBreakpoint(pb.addrToken, pb.clientLine);
                if (installed) {
                    this.session.sendEvent(new OutputEvent(`✓ Breakpoint aplicado en ${pb.addrToken} (línea Boriel: ${pb.clientLine})\n`));
                } else {
                    this.session.sendEvent(new OutputEvent(`✗ No se pudo aplicar breakpoint en ${pb.addrToken}\n`, 'stderr'));
                }
            } catch (err) {
                this.session.sendEvent(new OutputEvent(`✗ Falló al aplicar breakpoint ${pb.addrToken}: ${err.message}\n`, 'stderr'));
            }
        }
    }

    /**
     * Añade un breakpoint a la lista de pendientes
     */
    addPendingBreakpoint(addrToken, clientLine) {
        this._pendingBreakpoints.push({ addrToken, clientLine });
    }

    /**
     * Establece un breakpoint en una dirección (API simple)
     */
    async setBreakpoint(bpId, addr) {
        const hexNoPrefix = addr.toString(16).toUpperCase();
        const cmd = `set-breakpoint ${bpId} PC=${hexNoPrefix}H`;
        return await this.sendCommandAndWait(cmd);
    }

    /**
     * Elimina un breakpoint por ID
     */
    async clearBreakpoint(bpId) {
        return await this.sendCommandAndWait(`clear-breakpoint ${bpId}`);
    }

    /**
     * Cierra la conexión con ZEsarUX
     */
    async disconnect() {
        if (this._debugSocket) {
            try {
                await this.sendCommand('quit');
            } catch (e) {
                // Ignorar errores al cerrar
            }
            this._debugSocket.destroy();
            this._debugSocket = null;
        }
    }

    /**
     * Verifica si hay conexión activa
     */
    isConnected() {
        return this._debugSocket && !this._debugSocket.destroyed;
    }

    /**
     * Obtiene el socket para uso directo (cuando sea necesario)
     */
    getSocket() {
        return this._debugSocket;
    }

    /**
     * Obtiene el último comando enviado
     */
    getLastCommandSent() {
        return this._lastCommandSent;
    }

    /**
     * Obtiene el estado de breakpoints
     */
    getBreakpointsEnabled() {
        return this._breakpointsEnabled;
    }

    /**
     * Obtiene el ID de contador de breakpoints
     */
    getBreakpointIdCounter() {
        return this._breakpointIdCounter;
    }

    /**
     * Incrementa el ID de contador de breakpoints
     */
    incrementBreakpointIdCounter() {
        return this._breakpointIdCounter++;
    }

    /**
     * Función auxiliar de espera
     */
    _wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { ZesaruxClient };
