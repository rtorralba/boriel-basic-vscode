/* turbo80.js — Cargador para embeber Turbo80 en cualquier web (2026-09-15).
 *
 *   <div id="spectrum"></div>
 *   <script src="https://turbo80.com/turbo80.js"></script>
 *   <script>Turbo80(document.getElementById('spectrum'), { load: 'juego.tap' });</script>
 *
 * O sin escribir JavaScript:
 *
 *   <div data-turbo80="juego.tap" data-model="128k"></div>
 *
 * De fábrica el emulador va DENTRO de tu página, en un Shadow DOM del propio
 * div (turbo80-core.js, que se carga solo la primera vez desde donde vive este
 * script: turbo80.com, o tu copia), con sus ventanas flotando sobre la página
 * y el emulador vivo en .main. Con iframe: true va aislado en un <iframe>
 * (mismos métodos y avisos, por postMessage): para quien prefiera no ejecutar
 * código ajeno en su página. El fichero de `load` lo descarga ESTA página,
 * desde su propio origen y sin CORS, y viaja en bytes al emulador; si no
 * puede (otro dominio), pasa por el relé y, si tampoco, lo intenta el emulador.
 *
 * Opciones: las de la URL de Turbo80 (model, ui, mode, speed, sound, crt,
 * size, border, touch, keyboard, issue2, turbo, ay) más open (arrancar con una
 * ventana abierta: settings, file, asm, debug, keyboard, net), tools (qué
 * botones se ven), load (URL, File, Blob o bytes), name, width, height, base,
 * iframe (el emulador aislado en un iframe en vez de en la página), watch
 * (vigilar el fichero y recargarlo cuando cambie: true o milisegundos; solo
 * ficheros del mismo origen que la página), lang ('es' | 'en': el idioma de
 * la interfaz; sin él, el del navegador) y
 * relay (false para no usar el relé de turbo80.com con ficheros de otros
 * dominios sin CORS, o la URL de un relé propio).
 * Devuelve un objeto con load, pause, resume, reset, setModel, sound, open,
 * close, type, press, asm, breakpoint, step, screenshot, state, fullscreen,
 * focus, watch, unwatch, on, off y destroy (y main, core y shadow en la
 * página; iframe con iframe: true); los avisos son ready, loaded, paused,
 * resumed, error y changed. Todo está explicado en la guía, apartado «Abrir
 * un juego por dirección y embeber Turbo80».
 */
(function (global) {
  var VERSION = '2';
  var SCRIPT_SRC = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  // Opciones que viajan tal cual en la URL del iframe (o en la que ve el componente).
  var PARAMS = ['model', 'ui', 'mode', 'speed', 'sound', 'crt', 'size', 'border',
                'touch', 'keyboard', 'issue2', 'turbo', 'ay', 'open', 'tools', 'lang'];
  // El relé público para ficheros de otros dominios sin CORS (api/relay.php).
  var RELAY_PUBLICO = 'https://turbo80.com/api/relay.php';

  // Carpeta de la que se cargó este script: ahí vive index.html.
  function baseFrom(src) {
    if (!src) return './';
    return String(src).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  }

  // Nombre de fichero de una URL, un File o lo que se pase; la extensión es lo
  // que le dice al emulador qué es (cinta, snapshot, disco…).
  function nameOf(x, fallback) {
    if (typeof x === 'string') {
      var n = x.replace(/[?#].*$/, '').split('/').pop();
      try { n = decodeURIComponent(n); } catch (e) {}
      return n || fallback || 'fichero.bin';
    }
    if (x && typeof x.name === 'string' && x.name) return x.name;
    return fallback || 'fichero.bin';
  }

  function valueOf(v) {
    if (v === true) return '1';
    if (v === false) return '0';
    if (Array.isArray(v)) return v.join(',');
    return String(v);
  }

  // Opciones → parámetros de la URL del iframe. embed=1 siempre; file=<nombre>
  // anuncia el fichero que llegará por mensaje (el emulador aplica los mismos
  // defectos que con load=: carga instantánea, sonido y modo limpio).
  function queryFrom(opts) {
    var p = ['embed=1'];
    for (var i = 0; i < PARAMS.length; i++) {
      var k = PARAMS[i];
      if (opts[k] == null || opts[k] === '') continue;
      p.push(k + '=' + encodeURIComponent(valueOf(opts[k])));
    }
    if (opts.load) p.push('file=' + encodeURIComponent(nameOf(opts.load, opts.name)));
    return '?' + p.join('&');
  }

  // data-turbo80="juego.tap" data-model="128k" → { load, model }.
  function optionsFromDataset(ds) {
    var o = {};
    Object.keys(ds).forEach(function (k) {
      var v = ds[k];
      if (k === 'turbo80') { if (v) o.load = v; return; }
      if (v === 'true') v = true; else if (v === 'false') v = false;
      o[k] = v;
    });
    return o;
  }

  // Vigilancia del fichero: la firma de una respuesta HEAD (fecha, etag y
  // tamaño), o null si el servidor no da ninguna y hay que comparar bytes.
  function firmaDe(headers) {
    var lm = headers.get('last-modified'), et = headers.get('etag'), cl = headers.get('content-length');
    if (!lm && !et && !cl) return null;
    return [lm || '', et || '', cl || ''].join('|');
  }
  // Huella rápida de unos bytes (FNV-1a) con su tamaño.
  function hashDe(buf) {
    var a = new Uint8Array(buf), h = 2166136261;
    for (var i = 0; i < a.length; i++) { h ^= a[i]; h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(16) + ':' + a.length;
  }
  // watch: true = cada segundo; un número = milisegundos (mínimo 300).
  function intervaloDe(v) {
    var n = (v === true || v == null || v === '') ? 1000 : parseInt(v, 10);
    if (isNaN(n)) n = 1000;
    return Math.max(300, n);
  }

  // Un div sin ancho propio dentro de un contenedor flex o grid (la manera
  // habitual de centrar algo) se encoge a lo mínimo, y el emulador salía de
  // 320 píxeles: que ocupe lo que pueda, a 4:3 y sin pasarse del alto de la
  // ventana. Si la página le da ancho (CSS o la opción width), se respeta.
  function anchoRazonable(el, opts) {
    try {
      if (opts.width || (el.style && el.style.width)) return;
      var padre = el.parentNode;
      if (!padre || padre.nodeType !== 1 || typeof getComputedStyle !== 'function') return;
      var d = getComputedStyle(padre).display || '';
      if (!/flex|grid/.test(d)) return;
      if (el.getBoundingClientRect().width >= 400) return;
      el.style.width = 'min(100%, 120vh)';
    } catch (e) {}
  }

  // El núcleo del componente (turbo80-core.js): se carga una sola vez, con el
  // primer emulador que va en la página (lo de fábrica; con iframe: true no
  // hace falta), desde la carpeta de Turbo80.
  var corePromesa = null;
  function cargarCore(baseAbs) {
    if (global.Turbo80Core) return Promise.resolve(global.Turbo80Core);
    if (corePromesa) return corePromesa;
    corePromesa = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = baseAbs + 'turbo80-core.js';
      s.async = true;
      s.onload = function () {
        if (global.Turbo80Core) resolve(global.Turbo80Core);
        else reject(new Error('Turbo80: turbo80-core.js no define Turbo80Core'));
      };
      s.onerror = function () { corePromesa = null; reject(new Error('Turbo80: no se pudo cargar ' + s.src)); };
      (document.head || document.documentElement).appendChild(s);
    });
    return corePromesa;
  }

  function Turbo80(el, opts) {
    if (typeof el === 'string') el = document.querySelector(el);
    if (!el || typeof el.appendChild !== 'function') throw new Error('Turbo80: hace falta el elemento donde ponerlo');
    opts = opts || {};
    anchoRazonable(el, opts);
    // En la página salvo que se pida el iframe (inline: false también vale).
    var inline = !(opts.iframe === true || opts.iframe === 'true' || opts.iframe === 1 || opts.inline === false);
    var base = opts.base ? String(opts.base).replace(/\/?$/, '/') : baseFrom(SCRIPT_SRC);
    var query = queryFrom(opts);
    var url = base + 'index.html' + query;
    var baseAbs = base;
    try { baseAbs = new URL(base, global.location.href).href; } catch (e) {}
    var origen = '*';
    try {
      var o = new URL(url, global.location.href).origin;
      if (o && o !== 'null') origen = o;
    } catch (e) {}

    // --- Estado común a los dos transportes ------------------------------------
    var listo = false, destruido = false, seq = 0;
    var cola = [], pendientes = {}, oyentes = {};
    var readyResolve;
    var ready = new Promise(function (r) { readyResolve = r; });

    function disparar(ev, datos) {
      var l = oyentes[ev] || [];
      for (var i = 0; i < l.length; i++) {
        try { l[i](datos, api); } catch (e) { if (global.console) console.error(e); }
      }
    }
    function marcarListo() {
      if (listo) return;
      listo = true;
      var c = cola; cola = [];
      c.forEach(function (f) { f(); });
      readyResolve(api);
    }
    function responder(id, ok, resultado, error) {
      if (id == null || !pendientes[id]) return;
      var p = pendientes[id];
      delete pendientes[id];
      if (ok) p.resolve(resultado === undefined ? null : resultado);
      else p.reject(new Error(error || 'Turbo80: error'));
    }
    // Una orden al emulador; se resuelve con su respuesta. Antes de «ready»
    // las órdenes esperan en cola.
    function enviar(cmd, datos, transfer) {
      return new Promise(function (resolve, reject) {
        if (destruido) { reject(new Error('Turbo80: instancia destruida')); return; }
        var m = { turbo80: 1, id: ++seq, cmd: cmd };
        if (datos) Object.keys(datos).forEach(function (k) { m[k] = datos[k]; });
        pendientes[m.id] = { resolve: resolve, reject: reject };
        var mandar = function () {
          try { transporte.mandar(m, transfer || []); }
          catch (e) { delete pendientes[m.id]; reject(e); }
        };
        if (listo) mandar(); else cola.push(mandar);
      });
    }

    // --- Transporte por iframe: el emulador en su propia página ------------------
    function transporteIframe() {
      var iframe = document.createElement('iframe');
      iframe.title = opts.title || 'Turbo80';
      // Pantalla completa y mando desde dentro; el sonido arranca con el primer
      // gesto en la página anfitriona (autoplay delegado al iframe). El
      // micrófono, para la voz de la partida en red (open/tools: 'net'): sin
      // delegarlo, el navegador lo veta dentro del iframe sin preguntar; con
      // él, sigue pidiendo permiso al usuario como siempre. La pantalla
      // encendida mientras se juega (screen-wake-lock), que en un marco de
      // otro dominio el navegador veta si no se delega. Y allowfullscreen,
      // además de «fullscreen» en allow: los Safari que no entienden la
      // pantalla completa en allow solo hacen caso del atributo (Chrome avisa
      // en la consola de que manda allow; para él es lo mismo).
      iframe.setAttribute('allow', 'fullscreen; autoplay; gamepad; clipboard-write; microphone; screen-wake-lock');
      iframe.setAttribute('allowfullscreen', '');
      // Ancho del contenedor; alto del contenedor si lo tiene, y si no 4:3.
      iframe.style.cssText = 'display:block;border:0;width:100%;height:100%;aspect-ratio:4/3;background:#000';
      if (opts.width) iframe.style.width = (typeof opts.width === 'number') ? opts.width + 'px' : String(opts.width);
      if (opts.height) {
        iframe.style.height = (typeof opts.height === 'number') ? opts.height + 'px' : String(opts.height);
        iframe.style.aspectRatio = 'auto';
      }
      // Con la interfaz entera el emulador avisa de su alto ('size') y el
      // marco se ajusta a él, salvo que el contenedor ya tenga alto propio o
      // se haya pedido height. (En modo limpio no hay avisos: manda el 4:3.)
      var ajustaAlto = !opts.height && !(el.clientHeight > 0);
      var ultimoAlto = 0;

      function onMessage(e) {
        if (e.source !== iframe.contentWindow) return;
        var m = e.data;
        if (!m || m.turbo80 !== 1) return;
        if (m.event) {
          if (m.event === 'size' && ajustaAlto && m.data && m.data.height > 0) {
            var h = Math.round(m.data.height);
            if (Math.abs(h - ultimoAlto) > 2) {
              ultimoAlto = h;
              iframe.style.aspectRatio = 'auto';
              iframe.style.height = h + 'px';
            }
          }
          if (m.event === 'ready') {
            // El origen de las órdenes es el del documento que DE VERDAD hay
            // en el marco (ya comprobado: el mensaje viene de su ventana), no
            // el de la URL pedida: si esa URL redirige (www → sin www, http →
            // https), postMessage descartaría en silencio cada orden y las
            // promesas de load(), pause()… no se resolverían jamás.
            origen = (e.origin && e.origin !== 'null') ? e.origin : '*';
            marcarListo();
          }
          disparar(m.event, m.data);
          return;
        }
        responder(m.id, !!m.ok, m.result, m.error);
      }
      global.addEventListener('message', onMessage);
      iframe.src = url;
      el.appendChild(iframe);

      return {
        iframe: iframe,
        mandar: function (m, transfer) { iframe.contentWindow.postMessage(m, origen, transfer); },
        fullscreen: function () {
          var f = iframe.requestFullscreen || iframe.webkitRequestFullscreen;
          if (!f) return Promise.reject(new Error('Turbo80: este navegador no permite la pantalla completa'));
          try { var p = f.call(iframe); return (p && p.then) ? p : Promise.resolve(); }
          catch (e) { return Promise.reject(e); }
        },
        focus: function () { try { iframe.focus(); if (iframe.contentWindow) iframe.contentWindow.focus(); } catch (e) {} },
        destruir: function () {
          global.removeEventListener('message', onMessage);
          if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
        }
      };
    }

    // --- Transporte en la página: el componente (turbo80-core.js) ------------------
    function transporteInline() {
      var inst = null;
      function engancha(i) {
        inst = i;
        inst.main._embedOyente = function (ev, datos) { disparar(ev, datos); };
      }
      function opcionesCrear(Core) {
        return {
          search: query,
          base: baseAbs, // las descargas del emulador (tema, ROMs) son de su carpeta, no de esta página
          // «Restablecer todo» recarga la página en turbo80.com; aquí, la instancia.
          onReload: function () {
            setTimeout(function () {
              if (destruido) return;
              var viejo = inst;
              try { if (viejo) viejo.destruir(); } catch (e) {}
              engancha(Core.crear(el, opcionesCrear(Core)));
              disparar('ready', { version: Core.version });
            }, 0);
          }
        };
      }
      function crear(Core) { engancha(Core.crear(el, opcionesCrear(Core))); }
      // Mientras llega el núcleo, un hueco negro a 4:3 donde irá la pantalla
      // (la página no salta cuando aparece). Con el Shadow DOM deja de verse.
      var marcador = document.createElement('div');
      marcador.style.cssText = 'width:100%;aspect-ratio:4/3;background:#000';
      el.appendChild(marcador);
      cargarCore(baseAbs).then(function (Core) {
        if (marcador.parentNode) marcador.parentNode.removeChild(marcador);
        if (destruido) return;
        crear(Core);
        marcarListo();
        disparar('ready', { version: Core.version });
      }, function (err) {
        if (marcador.parentNode) marcador.parentNode.removeChild(marcador);
        disparar('error', { message: err.message });
      });

      return {
        get main() { return inst ? inst.main : null; },
        get core() { return inst ? inst.nucleo : null; },
        get shadow() { return inst ? inst.shadow : null; },
        mandar: function (m) {
          var M = inst && inst.main;
          if (!M) { responder(m.id, false, null, 'Turbo80: el componente no está listo'); return; }
          var orden = Object.prototype.hasOwnProperty.call(M.ORDENES, m.cmd) ? M.ORDENES[m.cmd] : null;
          if (!orden) { responder(m.id, false, null, 'Orden desconocida: ' + m.cmd); return; }
          try {
            orden.call(M, m,
              function (resultado) { responder(m.id, true, resultado); },
              function (error) { responder(m.id, false, null, error); });
          } catch (e) {
            responder(m.id, false, null, (e && e.message) ? e.message : String(e));
          }
        },
        // La del propio emulador (píxel perfecto), no la del div entero: en la
        // página el gesto del usuario llega directo al emulador.
        fullscreen: function () { return enviar('fullscreen', { on: true }); },
        focus: function () {
          try { var c = inst && inst.shadow.getElementById('screen'); if (c) c.focus(); } catch (e) {}
        },
        destruir: function () { if (inst) { try { inst.destruir(); } catch (e) {} inst = null; } }
      };
    }

    var transporte = inline ? transporteInline() : transporteIframe();

    // --- Descargas y relés -------------------------------------------------------------
    // Otro dominio sin CORS: los relés, por orden (el propio, si se pidió;
    // el del servidor donde vive Turbo80; el de turbo80.com). relay: false
    // los desactiva. Solo para fuentes https (es lo único que admite el relé).
    function reles() {
      if (opts.relay === false) return [];
      var lista = [];
      if (typeof opts.relay === 'string' && opts.relay) lista.push(opts.relay);
      if (/^https?:/.test(baseAbs)) lista.push(baseAbs + 'api/relay.php');
      lista.push(RELAY_PUBLICO);
      return lista.filter(function (r, i) { return lista.indexOf(r) === i; });
    }
    function porRele(abs) {
      if (!/^https:/.test(abs)) return Promise.reject(new Error('Turbo80: el relé solo admite https'));
      var lista = reles();
      var intenta = function (i) {
        if (i >= lista.length) return Promise.reject(new Error('Turbo80: no se pudo descargar ' + abs));
        return fetch(lista[i] + '?u=' + encodeURIComponent(abs)).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(null, function () { return intenta(i + 1); });
      };
      return intenta(0);
    }

    // Lo que sea → { name, buf } (o { name, url } si esta página no pudo
    // descargarlo: otro dominio sin CORS; que lo intente el emulador).
    function bytesDe(x) {
      if (typeof x === 'string') {
        var abs = x;
        try { abs = new URL(x, global.location.href).href; } catch (e) {}
        return fetch(abs, { cache: 'no-store' }).then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        }).then(function (buf) { return { name: nameOf(x), buf: buf }; }, function (err) {
          // Un error HTTP (404…) es del fichero: se cuenta tal cual. Un fallo
          // de red o de CORS (otro dominio) se intenta por los relés y, si
          // tampoco, que lo pruebe el emulador desde su origen.
          if (err && /^HTTP \d+/.test(err.message || '')) throw err;
          return porRele(abs).then(function (buf) { return { name: nameOf(x), buf: buf }; },
                                   function () { return { name: nameOf(x), url: abs }; });
        });
      }
      if (typeof Blob !== 'undefined' && x instanceof Blob) {
        return x.arrayBuffer().then(function (buf) { return { name: nameOf(x, opts.name), buf: buf }; });
      }
      // Siempre una COPIA de los bytes, vengan en un typed array o en un
      // ArrayBuffer a pelo: con iframe: true se transfieren al emulador y el
      // buffer de quien llama se quedaría vacío (no podría volver a cargarlo,
      // ni usarlo para nada). Son ficheros de KB: copiar no cuesta.
      var copia = null;
      if (x && x.buffer instanceof ArrayBuffer) copia = x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength);
      else if (x instanceof ArrayBuffer) copia = x.slice(0);
      if (copia) return Promise.resolve({ name: opts.name || 'fichero.bin', buf: copia });
      return Promise.reject(new Error('Turbo80: no sé cargar eso (URL, File, Blob o bytes)'));
    }
    function cargar(x, nombre) {
      return bytesDe(x).then(function (d) {
        if (nombre) d.name = nombre;
        if (d.buf) return enviar('load', { name: d.name, bytes: d.buf }, [d.buf]);
        return enviar('load', { name: d.name, url: d.url });
      }).then(null, function (err) {
        disparar('error', { message: err.message });
        throw err;
      });
    }

    // --- Vigilar el fichero (para el programador que recompila) --------------
    // Cada intervalo, una petición HEAD al fichero: si el servidor da fecha,
    // etag o tamaño, con eso basta; si no, se descarga y se comparan los
    // bytes. Un cambio tiene que mantenerse un intervalo entero (el fichero
    // puede estar a medio escribir) y entonces se resetea la máquina y se
    // carga de nuevo.
    var vigilante = null;
    function vigilar(url, ms) {
      dejarDeVigilar();
      var abs = url;
      try { abs = new URL(url, global.location.href).href; } catch (e) {}
      // Solo ficheros del mismo origen que la página: vigilar uno ajeno sería
      // pedirle a otro servidor una petición por segundo por cada visitante
      // (y, con el relé, hacérsela pedir a turbo80.com). Un servidor de
      // desarrollo es siempre el propio.
      var propio = false;
      try { propio = new URL(abs).origin === new URL(global.location.href).origin; } catch (e) {}
      if (!propio) {
        try { console.warn('Turbo80: watch solo vigila ficheros del mismo origen que la página; ' + url + ' no se vigila.'); } catch (e) {}
        return;
      }
      var ultima = null, pendiente = null, ocupado = false;
      var tick = function () {
        if (destruido || ocupado) return;
        ocupado = true;
        fetch(abs, { method: 'HEAD', cache: 'no-store' }).then(function (r) {
          // Un servidor sin HEAD (405/501) no es un error: se comparan bytes.
          if (r.status === 405 || r.status === 501) return null;
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return firmaDe(r.headers);
        }).then(function (f) {
          if (f !== null) return f;
          return fetch(abs, { cache: 'no-store' }).then(function (r2) {
            if (!r2.ok) throw new Error('HTTP ' + r2.status);
            return r2.arrayBuffer();
          }).then(hashDe);
        }).then(function (f) {
          if (ultima === null) { ultima = f; return; }
          if (f === ultima) { pendiente = null; return; }
          if (pendiente !== f) { pendiente = f; return; }
          ultima = f; pendiente = null;
          disparar('changed', { name: nameOf(url) });
          return enviar('reset').then(function () { return cargar(url); });
        }).then(null, function () {}).then(function () { ocupado = false; });
      };
      vigilante = setInterval(tick, ms);
      tick();
    }
    function dejarDeVigilar() { if (vigilante) { clearInterval(vigilante); vigilante = null; } }

    var api = {
      element: el,
      url: url,
      ready: ready,
      inline: inline,
      load: function (x, nombre) { return cargar(x, nombre); },
      pause: function () { return enviar('pause'); },
      resume: function () { return enviar('resume'); },
      reset: function () { return enviar('reset'); },
      setModel: function (model) { return enviar('setModel', { model: model }); },
      sound: function (on) { return enviar('sound', { on: on !== false }); },
      open: function (name) { return enviar('open', { name: name }); },
      close: function (name) { return enviar('close', { name: name }); },
      type: function (text) { return enviar('type', { text: String(text) }); },
      press: function (key, frames) { return enviar('press', { key: key, frames: frames }); },
      // Fuente al editor de ensamblador (lo abre) y, salvo run: false, lo ejecuta.
      asm: function (source, run) { return enviar('asm', { source: String(source), run: run !== false }); },
      // Punto de ruptura (número o hexadecimal) y un paso de instrucción.
      breakpoint: function (addr) { return enviar('breakpoint', { addr: addr }); },
      step: function () { return enviar('step'); },
      screenshot: function () { return enviar('screenshot'); },
      state: function () { return enviar('state'); },
      // La pantalla completa la pide ESTA página (el gesto del usuario es suyo).
      fullscreen: function () { return transporte.fullscreen(); },
      focus: function () { transporte.focus(); return api; },
      // Vigilar un fichero (el de load, si no se dice otro) y dejar de hacerlo.
      watch: function (u, ms) { vigilar(u || opts.load, intervaloDe(ms == null ? opts.watch : ms)); return api; },
      unwatch: function () { dejarDeVigilar(); return api; },
      on: function (ev, fn) { (oyentes[ev] = oyentes[ev] || []).push(fn); return api; },
      off: function (ev, fn) {
        if (oyentes[ev]) oyentes[ev] = fn ? oyentes[ev].filter(function (f) { return f !== fn; }) : [];
        return api;
      },
      destroy: function () {
        destruido = true;
        dejarDeVigilar();
        transporte.destruir();
        Object.keys(pendientes).forEach(function (id) { pendientes[id].reject(new Error('Turbo80: instancia destruida')); });
        pendientes = {};
        if (el.turbo80 === api) { try { delete el.turbo80; } catch (e) {} }
      }
    };
    if (inline) {
      // El emulador vivo, para quien quiera ir más allá de los métodos.
      Object.defineProperty(api, 'main', { get: function () { return transporte.main; }, enumerable: true });
      Object.defineProperty(api, 'core', { get: function () { return transporte.core; }, enumerable: true });
      Object.defineProperty(api, 'shadow', { get: function () { return transporte.shadow; }, enumerable: true });
    } else {
      api.iframe = transporte.iframe;
    }

    el.turbo80 = api;
    if (opts.load) cargar(opts.load, opts.name).then(null, function () {}); // el fallo ya salió como aviso «error»
    if (opts.watch && typeof opts.load === 'string') vigilar(opts.load, intervaloDe(opts.watch));
    return api;
  }

  // Forma declarativa: cada [data-turbo80] se convierte al cargar la página.
  function auto() {
    if (typeof document === 'undefined') return;
    var nodos = document.querySelectorAll('[data-turbo80]');
    for (var i = 0; i < nodos.length; i++) {
      var n = nodos[i];
      if (n.turbo80) continue;
      try { Turbo80(n, optionsFromDataset(n.dataset)); }
      catch (e) { if (global.console) console.error(e); }
    }
  }

  Turbo80.version = VERSION;
  Turbo80.base = baseFrom(SCRIPT_SRC);
  Turbo80.auto = auto;
  // Cargar el componente por adelantado (opcional): Turbo80.precargar().
  Turbo80.precargar = function (base) { return cargarCore(base ? String(base).replace(/\/?$/, '/') : baseFrom(SCRIPT_SRC)); };
  Turbo80.util = { baseFrom: baseFrom, nameOf: nameOf, queryFrom: queryFrom, optionsFromDataset: optionsFromDataset,
                   firmaDe: firmaDe, hashDe: hashDe, intervaloDe: intervaloDe, PARAMS: PARAMS, RELAY_PUBLICO: RELAY_PUBLICO };

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', auto);
    else auto();
  }
  global.Turbo80 = Turbo80;
  if (typeof module !== 'undefined' && module.exports) module.exports = Turbo80;
})(typeof window !== 'undefined' ? window : this);
