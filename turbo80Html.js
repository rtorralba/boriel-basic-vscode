/**
 * Boriel Basic - Turbo80 Webview HTML Generator
 * Generates the complete HTML document for the Turbo80 ZX Spectrum web emulator
 * with embedded offline runtime, styling, and step-by-step Boriel Basic (Z80) debugger.
 */

function getTurbo80Html(webview, extensionUri, vscode) {
  const turbo80CoreUri = (webview && extensionUri && vscode)
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'turbo80', 'turbo80-core.js'))
    : '';
  const turbo80Uri = (webview && extensionUri && vscode)
    ? webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'turbo80', 'turbo80.js'))
    : '';
  const cspSource = (webview && webview.cspSource) ? webview.cspSource : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    script-src 'unsafe-inline' 'unsafe-eval' ${cspSource} https://turbo80.com;
    frame-src https://turbo80.com;
    style-src 'unsafe-inline' ${cspSource};
    img-src https: data: ${cspSource};
    font-src ${cspSource} data:;
    connect-src https://turbo80.com ${cspSource} data: blob:;
  ">
  <title>Turbo80 - Boriel Basic ZX Spectrum</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #0c0c11;
      color: #e9e9f2;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    #emulator-wrap {
      flex: 1;
      min-height: 0;
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow-y: auto;
      overflow-x: hidden;
    }
    #spectrum {
      width: 100% !important;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    #spectrum iframe {
      border: 0;
      width: 100% !important;
      height: auto !important;
      aspect-ratio: 4 / 3 !important;
      max-width: 100vw;
    }
    #footer {
      height: 34px;
      background: #14141e;
      border-top: 1px solid #28283a;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 1.2rem;
      font-size: 12px;
      color: #9b9bb0;
      user-select: none;
      flex-shrink: 0;
    }
    #footer a {
      color: #37d0ff;
      text-decoration: none;
      font-weight: 500;
      transition: color 0.15s ease;
    }
    #footer a:hover {
      color: #57ef9e;
      text-decoration: underline;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
      font-size: 12px;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #57ef9e;
      box-shadow: 0 0 8px rgba(87, 239, 158, 0.7);
    }
    .attribution {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 11.5px;
    }
  </style>
</head>
<body>
  <div id="emulator-wrap">
    <div id="spectrum" style="width: 100%;"></div>
  </div>
  <footer id="footer">
    <div class="status-badge">
      <span class="status-dot"></span>
      <span id="game-title">Iniciando ZX Spectrum...</span>
    </div>
    <div class="attribution">
      Emulado con <a href="https://turbo80.com" target="_blank" rel="noopener">Turbo80</a> &bull; Emulador de ZX Spectrum por Jos&eacute; Enrique Garc&iacute;a (Incinerator)
    </div>
  </footer>

  <script src="${turbo80CoreUri}"></script>
  <script src="${turbo80Uri}"></script>
  <script>
    if (typeof Turbo80 === 'undefined') {
      const s = document.createElement('script');
      s.src = 'https://turbo80.com/turbo80.js';
      document.head.appendChild(s);
    }
  </script>
  <script>
    const vscode = acquireVsCodeApi();
    let emulator = null;
    let pendingData = null;

    function adjustEmulatorSizing() {
      const spectrum = document.getElementById('spectrum');
      if (!spectrum) return;
      const shadow = spectrum.shadowRoot;
      if (shadow && !shadow.getElementById('t80-responsive-size')) {
        const style = document.createElement('style');
        style.id = 't80-responsive-size';
        style.textContent = [
          ':host { width: 100% !important; max-width: 100% !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; }',
          '.t80-body { width: 100% !important; max-width: 100% !important; min-height: 0 !important; height: auto !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; background: transparent !important; }',
          'main { width: 100% !important; max-width: 100% !important; min-height: 0 !important; height: auto !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; margin: 0 !important; padding: 0 !important; }',
          '.screen-zone { width: 100% !important; max-width: 100% !important; height: auto !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; gap: 0 !important; }',
          '.bezel { width: 100% !important; max-width: 100% !important; height: auto !important; margin: 0 !important; padding: 0 !important; display: flex !important; flex-direction: column !important; align-items: center !important; justify-content: center !important; }',
          '.screen-wrap { width: 100% !important; max-width: 100% !important; height: auto !important; aspect-ratio: 4 / 3 !important; margin: 0 auto !important; }',
          '#screen { width: 100% !important; max-width: 100% !important; height: auto !important; aspect-ratio: 4 / 3 !important; display: block !important; }',
          '#crt-gl { width: 100% !important; height: 100% !important; }'
        ].join('\\n');
        shadow.appendChild(style);
      }
    }

    function focusEmulator() {
      try {
        if (emulator && typeof emulator.focus === 'function') {
          emulator.focus();
        }
      } catch (e) {}
      try {
        const shadow = (document.querySelector('#spectrum') && document.querySelector('#spectrum').shadowRoot) || (emulator && emulator.shadow);
        const screen = shadow ? (shadow.getElementById('screen') || shadow.querySelector('canvas')) : document.querySelector('#spectrum canvas');
        if (screen) {
          if (!screen.hasAttribute('tabindex')) {
            screen.setAttribute('tabindex', '0');
          }
          screen.focus();
        }
      } catch (e) {}
      try {
        const iframe = document.querySelector('#spectrum iframe') || (emulator && emulator.iframe);
        if (iframe) {
          if (!iframe.hasAttribute('tabindex')) {
            iframe.setAttribute('tabindex', '0');
          }
          iframe.focus();
          if (iframe.contentWindow) {
            iframe.contentWindow.focus();
          }
          if (typeof iframe.click === 'function') {
            iframe.click();
          }
        }
      } catch (e) {}
    }

    function attachIframeListeners() {
      try {
        const iframe = document.querySelector('#spectrum iframe') || (emulator && emulator.iframe);
        if (iframe && !iframe._hasLoadedListener) {
          iframe._hasLoadedListener = true;
          iframe.addEventListener('load', () => {
            scheduleFocus();
          });
        }
      } catch (e) {}
    }

    function scheduleFocus() {
      adjustEmulatorSizing();
      focusEmulator();
      attachIframeListeners();
      [50, 150, 300, 500, 800, 1200, 1800].forEach(delay => {
        setTimeout(() => {
          adjustEmulatorSizing();
          focusEmulator();
        }, delay);
      });
    }

    function applyTap(data) {
      try {
        const binaryString = atob(data.base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        const currentModel = data.model || '128k';
        document.getElementById('game-title').textContent = (data.filename || 'game.tap') + ' (' + currentModel.toUpperCase() + ')';

        if (typeof Turbo80 === 'undefined') {
          document.getElementById('game-title').textContent = 'Error cargando Turbo80 (comprueba tu conexión a internet)';
          return;
        }

        if (!emulator) {
          emulator = Turbo80(document.getElementById('spectrum'), {
            load: bytes,
            name: data.filename || 'game.tap',
            model: currentModel,
            crt: data.crt ? 'on' : 'off',
            width: '100%'
          });
          if (emulator && typeof emulator.on === 'function') {
            emulator.on('ready', () => {
              adjustEmulatorSizing();
              scheduleFocus();
            });
            emulator.on('loaded', () => {
              adjustEmulatorSizing();
              scheduleFocus();
            });
          }
          attachIframeListeners();
        } else {
          const doLoad = () => emulator.load(bytes, data.filename || 'game.tap');
          if (emulator.setModel) {
            Promise.resolve(emulator.setModel(currentModel))
              .then(() => {
                if (emulator.reset) emulator.reset();
                return doLoad();
              })
              .then(() => {
                adjustEmulatorSizing();
                scheduleFocus();
              })
              .catch(() => {
                doLoad();
                adjustEmulatorSizing();
                scheduleFocus();
              });
          } else {
            doLoad();
            adjustEmulatorSizing();
            scheduleFocus();
          }
        }
        adjustEmulatorSizing();
        scheduleFocus();
      } catch (err) {
        console.error('Error loading TAP into Turbo80:', err);
        document.getElementById('game-title').textContent = 'Error al cargar TAP: ' + err.message;
      }
    }

    // Boriel Basic Z80 Debugger Engine for Turbo80
    const borielDebugger = {
      enabled: false,
      attached: false,
      userBreakpoints: new Set(),
      mappedAddresses: new Set(),
      entryAddr: null,
      stopOnEntry: false,
      lastPausedPC: null,
      isPaused: false,

      setBreakpoints(bps) {
        this.userBreakpoints = new Set();
        if (Array.isArray(bps)) {
          for (const bp of bps) {
            let addr = typeof bp === 'number' ? bp : (bp && bp.addr);
            if (typeof addr === 'string') {
              addr = parseInt(addr.replace(/H$/i, ''), 16);
            }
            if (typeof addr === 'number' && !isNaN(addr)) {
              this.userBreakpoints.add(addr);
            }
          }
        }
        this.syncBreakpoints();
      },

      setMappedAddresses(addrs) {
        this.mappedAddresses = new Set();
        if (Array.isArray(addrs)) {
          for (const a of addrs) {
            let n = typeof a === 'number' ? a : parseInt(String(a).replace(/H$/i, ''), 10);
            if (isNaN(n)) n = parseInt(String(a).replace(/H$/i, ''), 16);
            if (!isNaN(n)) {
              this.mappedAddresses.add(n);
            }
          }
        }
      },

      syncBreakpoints() {
        if (!emulator || !emulator.main || !emulator.main.spectrum) return;
        const sp = emulator.main.spectrum;
        const main = emulator.main;
        if (!sp.breakpoints) sp.breakpoints = new Set();
        sp.breakpoints.clear();

        if (main && !main.breakpoints) main.breakpoints = new Set();
        if (main && main.breakpoints) main.breakpoints.clear();

        for (const addr of this.userBreakpoints) {
          sp.breakpoints.add(addr);
          if (main && main.breakpoints) main.breakpoints.add(addr);
        }

        if (this.stopOnEntry && this.entryAddr != null) {
          sp.breakpoints.add(this.entryAddr);
          if (main && main.breakpoints) main.breakpoints.add(this.entryAddr);
        }
      },

      attach(sp, main) {
        if (!sp || !main || this.attached) return;
        this.attached = true;
        this.syncBreakpoints();

        // Hook into main.setPaused to intercept pause and resume events reliably
        const origSetPaused = main.setPaused.bind(main);
        const self = this;
        main.setPaused = function(paused) {
          origSetPaused(paused);
          if (paused) {
            self.onPaused(main, sp, 'paused');
          } else {
            self.onResumed();
          }
        };

        // Hook frame execution to catch breakpoint hits immediately
        if (sp.bpConds == null) sp.bpConds = new Map();
      },

      onPaused(main, sp, reason) {
        if (!this.enabled) return;
        this.isPaused = true;
        const cpu = sp.cpu;
        this.lastPausedPC = cpu.pc;

        // If stopped at entryAddr due to stopOnEntry, disable entry breakpoint so next continue runs freely
        if (this.stopOnEntry && cpu.pc === this.entryAddr) {
          this.stopOnEntry = false;
          if (!this.userBreakpoints.has(this.entryAddr) && sp.breakpoints) {
            sp.breakpoints.delete(this.entryAddr);
          }
        }

        // Build registers map
        const regs = {
          PC: cpu.pc,
          SP: cpu.sp,
          AF: ((cpu.a & 0xFF) << 8) | (cpu.f & 0xFF),
          BC: cpu.bc & 0xFFFF,
          DE: cpu.de & 0xFFFF,
          HL: cpu.hl & 0xFFFF,
          IX: cpu.ix & 0xFFFF,
          IY: cpu.iy & 0xFFFF,
          A: cpu.a & 0xFF,
          F: cpu.f & 0xFF,
          B: (cpu.bc >> 8) & 0xFF,
          C: cpu.bc & 0xFF,
          D: (cpu.de >> 8) & 0xFF,
          E: cpu.de & 0xFF,
          H: (cpu.hl >> 8) & 0xFF,
          L: cpu.hl & 0xFF,
          I: (cpu.i || 0) & 0xFF,
          R: (cpu.r || 0) & 0xFF
        };

        // Extract 48KB of RAM (from 0x4000 to 0xFFFF) for ultra-fast, synchronous variable inspection
        let ramBase64 = '';
        try {
          const memSlice = new Uint8Array(0xC000);
          for (let a = 0x4000; a < 0x10000; a++) {
            memSlice[a - 0x4000] = sp.memory.read(a);
          }
          let binary = '';
          const len = memSlice.byteLength;
          const chunkSize = 8192;
          for (let i = 0; i < len; i += chunkSize) {
            binary += String.fromCharCode.apply(null, memSlice.subarray(i, Math.min(i + chunkSize, len)));
          }
          ramBase64 = btoa(binary);
        } catch (e) {
          console.error('Error snapshotting RAM:', e);
        }

        updateFooterStatus('paused', cpu.pc);

        vscode.postMessage({
          command: 'cpuPaused',
          pc: cpu.pc,
          sp: cpu.sp,
          registers: regs,
          ramBase64: ramBase64,
          reason: reason || 'breakpoint'
        });
      },

      onResumed() {
        this.isPaused = false;
        updateFooterStatus('running');
        vscode.postMessage({ command: 'cpuResumed' });
      }
    };

    function updateFooterStatus(status, pc) {
      const title = document.getElementById('game-title');
      const dot = document.querySelector('.status-dot');
      if (!title) return;

      if (!borielDebugger.enabled) {
        if (dot) {
          dot.style.background = '#57ef9e';
          dot.style.boxShadow = '0 0 8px rgba(87, 239, 158, 0.7)';
        }
        return;
      }

      if (status === 'paused') {
        if (dot) {
          dot.style.background = '#ffcc00';
          dot.style.boxShadow = '0 0 8px rgba(255, 204, 0, 0.8)';
        }
        const hex = pc != null ? '0x' + pc.toString(16).toUpperCase().padStart(4, '0') : '';
        title.textContent = (pendingData && pendingData.filename ? pendingData.filename + ' — ' : '') + 'Pausado (PC: ' + hex + ')';
      } else if (status === 'ended') {
        if (dot) {
          dot.style.background = '#57ef9e';
          dot.style.boxShadow = '0 0 8px rgba(87, 239, 158, 0.7)';
        }
        title.textContent = (pendingData && pendingData.filename ? pendingData.filename + ' — ' : '') + 'Programa finalizado';
      } else {
        if (dot) {
          dot.style.background = '#57ef9e';
          dot.style.boxShadow = '0 0 8px rgba(87, 239, 158, 0.7)';
        }
        title.textContent = (pendingData && pendingData.filename) ? (pendingData.filename + ' (Ejecutando)') : 'ZX Spectrum';
      }
    }

    function doContinue() {
      if (!emulator || !emulator.main || !emulator.main.spectrum) return;
      const sp = emulator.main.spectrum;
      const main = emulator.main;

      // If stopped on a breakpoint instruction, advance it once so we don't re-trigger on the exact same PC
      if (sp.breakpoints && sp.breakpoints.has(sp.cpu.pc)) {
        sp.stepInstruction();
      }
      sp.breakHit = null;
      main.atBreak = false;
      borielDebugger.isPaused = false;
      updateFooterStatus('running');
      vscode.postMessage({ command: 'cpuResumed' });
      emulator.resume();
    }

    function doPause() {
      if (emulator && emulator.main) {
        emulator.main.setPaused(true);
      }
    }

    function doStepOver(customMapped) {
      if (!emulator || !emulator.main || !emulator.main.spectrum) return;
      const sp = emulator.main.spectrum;
      const main = emulator.main;
      const initialPc = sp.cpu.pc;
      const addrSet = (customMapped && customMapped.length > 0)
        ? new Set(customMapped.map(a => {
            let n = typeof a === 'number' ? a : parseInt(String(a).replace(/H$/i, ''), 10);
            if (isNaN(n)) n = parseInt(String(a).replace(/H$/i, ''), 16);
            return n;
          }).filter(n => !isNaN(n)))
        : borielDebugger.mappedAddresses;
      const userBps = borielDebugger.userBreakpoints;

      function shouldStop(pc) {
        if (pc === initialPc) return false;
        if (userBps && userBps.has(pc)) return true;
        if (addrSet && addrSet.has(pc)) return true;
        return false;
      }

      let steps = 0;
      const maxSteps = 30000;
      sp.breakHit = null;
      let programEnded = false;

      while (steps < maxSteps && !sp.cpu.halted) {
        const pcBefore = sp.cpu.pc;
        const read = sp.memory.read.bind(sp.memory);
        const op = read(pcBefore);
        const op2 = read((pcBefore + 1) & 0xFFFF);
        const esCall = (op === 0xCD) || ((op & 0xC7) === 0xC4);
        const esRst = (op & 0xC7) === 0xC7;
        const esRep = (op === 0xED) && ((op2 & 0xF4) === 0xB0);

        if (esCall || esRst || esRep) {
          sp.breakHit = null;
          main.stepOver();
        } else {
          sp.stepInstruction();
        }
        steps++;

        const currentPc = sp.cpu.pc;
        if (currentPc < 0x4000) {
          programEnded = true;
          break;
        }
        if (shouldStop(currentPc)) {
          break;
        }
      }

      sp.breakHit = null;
      main.atBreak = false;
      if (typeof main.followPC === 'function') main.followPC();
      if (typeof main.blit === 'function') main.blit();
      if (typeof main.updateDebugger === 'function') main.updateDebugger();

      if (programEnded || sp.cpu.pc < 0x4000) {
        borielDebugger.isPaused = false;
        updateFooterStatus('ended');
        vscode.postMessage({
          command: 'programEnded',
          pc: sp.cpu.pc
        });
        if (typeof emulator.resume === 'function') emulator.resume();
        return;
      }

      borielDebugger.onPaused(main, sp, 'step');
    }

    function doStepInto(customMapped) {
      if (!emulator || !emulator.main || !emulator.main.spectrum) return;
      const sp = emulator.main.spectrum;
      const main = emulator.main;
      const initialPc = sp.cpu.pc;
      const addrSet = (customMapped && customMapped.length > 0)
        ? new Set(customMapped.map(a => {
            let n = typeof a === 'number' ? a : parseInt(String(a).replace(/H$/i, ''), 10);
            if (isNaN(n)) n = parseInt(String(a).replace(/H$/i, ''), 16);
            return n;
          }).filter(n => !isNaN(n)))
        : borielDebugger.mappedAddresses;
      const userBps = borielDebugger.userBreakpoints;

      function shouldStop(pc) {
        if (pc === initialPc) return false;
        if (userBps && userBps.has(pc)) return true;
        if (addrSet && addrSet.has(pc)) return true;
        return false;
      }

      let steps = 0;
      const maxSteps = 30000;
      sp.breakHit = null;
      let programEnded = false;

      while (steps < maxSteps && !sp.cpu.halted) {
        const pcBefore = sp.cpu.pc;
        const read = sp.memory.read.bind(sp.memory);
        const op = read(pcBefore);
        const op2 = read((pcBefore + 1) & 0xFFFF);
        const esCall = (op === 0xCD) || ((op & 0xC7) === 0xC4);
        const esRep = (op === 0xED) && ((op2 & 0xF4) === 0xB0);

        let targetIsRom = false;
        if (esCall) {
          const target = op === 0xCD ? (op2 | (read((pcBefore + 2) & 0xFFFF) << 8)) : null;
          if (target != null && target < 0x4000) targetIsRom = true;
        }

        if (esRep || targetIsRom) {
          sp.breakHit = null;
          main.stepOver();
        } else {
          sp.stepInstruction();
        }
        steps++;

        const currentPc = sp.cpu.pc;
        if (currentPc < 0x4000) {
          programEnded = true;
          break;
        }
        if (shouldStop(currentPc)) {
          break;
        }
      }

      sp.breakHit = null;
      main.atBreak = false;
      if (typeof main.followPC === 'function') main.followPC();
      if (typeof main.blit === 'function') main.blit();
      if (typeof main.updateDebugger === 'function') main.updateDebugger();

      if (programEnded || sp.cpu.pc < 0x4000) {
        borielDebugger.isPaused = false;
        updateFooterStatus('ended');
        vscode.postMessage({
          command: 'programEnded',
          pc: sp.cpu.pc
        });
        if (typeof emulator.resume === 'function') emulator.resume();
        return;
      }

      borielDebugger.onPaused(main, sp, 'step');
    }

    function doStepOut(customMapped) {
      if (!emulator || !emulator.main || !emulator.main.spectrum) return;
      const sp = emulator.main.spectrum;
      const main = emulator.main;
      const initialPc = sp.cpu.pc;
      const addrSet = (customMapped && customMapped.length > 0)
        ? new Set(customMapped.map(a => {
            let n = typeof a === 'number' ? a : parseInt(String(a).replace(/H$/i, ''), 10);
            if (isNaN(n)) n = parseInt(String(a).replace(/H$/i, ''), 16);
            return n;
          }).filter(n => !isNaN(n)))
        : borielDebugger.mappedAddresses;
      const userBps = borielDebugger.userBreakpoints;

      function shouldStop(pc) {
        if (pc === initialPc) return false;
        if (userBps && userBps.has(pc)) return true;
        if (addrSet && addrSet.has(pc)) return true;
        return false;
      }

      if (typeof main.stepOut === 'function') {
        sp.breakHit = null;
        main.stepOut();
      }

      let steps = 0;
      const maxSteps = 30000;
      let programEnded = false;

      while (steps < maxSteps && !sp.cpu.halted) {
        const currentPc = sp.cpu.pc;
        if (currentPc < 0x4000) {
          programEnded = true;
          break;
        }
        if (shouldStop(currentPc)) {
          break;
        }
        sp.stepInstruction();
        steps++;
      }

      sp.breakHit = null;
      main.atBreak = false;
      if (typeof main.followPC === 'function') main.followPC();
      if (typeof main.blit === 'function') main.blit();
      if (typeof main.updateDebugger === 'function') main.updateDebugger();

      if (programEnded || sp.cpu.pc < 0x4000) {
        borielDebugger.isPaused = false;
        updateFooterStatus('ended');
        vscode.postMessage({
          command: 'programEnded',
          pc: sp.cpu.pc
        });
        if (typeof emulator.resume === 'function') emulator.resume();
        return;
      }

      borielDebugger.onPaused(main, sp, 'step');
    }

    function doRestart() {
      if (pendingData) {
        borielDebugger.stopOnEntry = true;
        applyTap(pendingData);
      }
    }

    function doStop() {
      borielDebugger.enabled = false;
      updateFooterStatus('running');
      vscode.postMessage({ command: 'debugStopped' });
      if (emulator) emulator.resume();
    }

    window.addEventListener('keydown', function (e) {
      if (!borielDebugger.enabled) return;
      if (e.key === 'F5') { e.preventDefault(); doContinue(); }
      else if (e.key === 'F6') { e.preventDefault(); doPause(); }
      else if (e.key === 'F10') { e.preventDefault(); doStepOver(); }
      else if (e.key === 'F11' && !e.shiftKey) { e.preventDefault(); doStepInto(); }
      else if (e.key === 'F11' && e.shiftKey) { e.preventDefault(); doStepOut(); }
    });

    function checkAttach() {
      try {
        if (emulator && emulator.main && emulator.main.spectrum) {
          borielDebugger.attach(emulator.main.spectrum, emulator.main);
        }
      } catch (e) {
        console.error('Error attaching borielDebugger:', e);
      }
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (!msg) return;

      if (msg.command === 'loadTap') {
        pendingData = msg;
        if (msg.debug) {
          borielDebugger.enabled = true;
          borielDebugger.entryAddr = msg.entryAddr || null;
          borielDebugger.stopOnEntry = !!msg.stopOnEntry;
          borielDebugger.setBreakpoints(msg.breakpoints || []);
          borielDebugger.setMappedAddresses(msg.mappedAddresses || []);
          updateFooterStatus(borielDebugger.stopOnEntry ? 'paused' : 'running', borielDebugger.entryAddr);
        } else {
          borielDebugger.enabled = false;
          updateFooterStatus('running');
        }

        if (document.readyState === 'complete' || document.readyState === 'interactive') {
          applyTap(msg);
          checkAttach();
          [50, 150, 300, 600, 1200, 2000].forEach(d => setTimeout(checkAttach, d));
        }
      } else if (msg.command === 'setBreakpoints') {
        const bps = Array.isArray(msg.breakpoints) ? msg.breakpoints : [];
        borielDebugger.setBreakpoints(bps);
      } else if (msg.command === 'continue') {
        doContinue();
      } else if (msg.command === 'pause') {
        doPause();
      } else if (msg.command === 'stepOver') {
        doStepOver(msg.mappedAddresses);
      } else if (msg.command === 'stepInto') {
        doStepInto(msg.mappedAddresses);
      } else if (msg.command === 'stepOut') {
        doStepOut(msg.mappedAddresses);
      } else if (msg.command === 'restart') {
        doRestart();
      } else if (msg.command === 'stop') {
        doStop();
      }
    });

    window.addEventListener('DOMContentLoaded', () => {
      adjustEmulatorSizing();
      if (pendingData) {
        applyTap(pendingData);
        checkAttach();
        [50, 150, 300, 600, 1200, 2000].forEach(d => setTimeout(checkAttach, d));
        pendingData = null;
      }
      vscode.postMessage({ command: 'ready' });
    });

    window.addEventListener('resize', adjustEmulatorSizing);
    setInterval(adjustEmulatorSizing, 250);

    window.addEventListener('focus', focusEmulator);
    window.addEventListener('pointerdown', focusEmulator);
    window.addEventListener('click', focusEmulator);
    window.addEventListener('keydown', focusEmulator);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scheduleFocus();
      }
    });
  </script>
</body>
</html>`;
}

module.exports = {
  getTurbo80Html
};
