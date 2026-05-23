const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'estado.json');

// ── Cargar estado desde disco ────────────────────────────────────
function cargarEstado() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch(e) {
    console.log('Error cargando estado:', e.message);
  }
  return estadoDefault();
}

function estadoDefault() {
  return {
    turno: {
      id:          null,
      abierto:     false,
      domicilios:  [],
      domNum:      0,
      salesLog:    [],
      salesByProduct: {},
      cobroNum:    0,
      comNum:      0,
      cocina:      [],
      orders:      {},
      gastos:      [],
      gastoNum:    0
    },
    empleados: {},
    historialTurnos: []
  };
}

// ── Guardar estado en disco ──────────────────────────────────────
function guardarEstado() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ turno, empleados, historialTurnos }), 'utf8');
  } catch(e) {
    console.error('Error guardando estado:', e.message);
  }
}

// ── Inicializar ──────────────────────────────────────────────────
let { turno, empleados, historialTurnos } = cargarEstado();
if (!historialTurnos) historialTurnos = [];
console.log('Estado cargado: ' + turno.salesLog.length + ' ventas, turno=' + turno.id);

// ── Helpers ──────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
function body(req, cb) {
  let b = '';
  req.on('data', c => b += c.toString());
  req.on('end',  () => cb(b));
  req.on('error',() => cb(''));
}
function hoy() {
  return new Date().toLocaleDateString('es-MX',
    { timeZone:'America/Mexico_City', year:'numeric', month:'2-digit', day:'2-digit' }
  ).split('/').reverse().join('-');
}
function hora() {
  return new Date().toLocaleTimeString('es-MX',
    { timeZone:'America/Mexico_City', hour:'2-digit', minute:'2-digit' }
  );
}
function limpiarInactivos() {
  const ahora = Date.now();
  Object.keys(empleados).forEach(k => {
    const e = empleados[k];
    if (e.activo && ahora - e.ultima > 20000) {
      e.activo  = false;
      e.salida  = e.ultimaHora || hora();
      console.log('Desconectado:', e.nombre);
    }
  });
}

function estadoCompleto() {
  limpiarInactivos();
  return {
    ok:             true,
    turno: {
      id:      turno.id,
      abierto: turno.abierto,
      fecha:   turno.id || hoy(),
      domNum:  turno.domNum
    },
    empleados:      empleados,
    domicilios:     turno.domicilios,
    salesLog:       turno.salesLog,
    salesByProduct: turno.salesByProduct,
    cobroNum:       turno.cobroNum,
    comNum:         turno.comNum,
    cocina:         turno.cocina,
    orders:         turno.orders,
    gastos:         turno.gastos,
    gastoNum:       turno.gastoNum,
    historialTurnos: historialTurnos
  };
}

const ARCHIVOS = {
  '/':           'FAMES_PuntoDeVenta.html',
  '/pos':        'FAMES_PuntoDeVenta.html',
  '/pedidos':    'FAMES_Pedidos.html',
  '/repartidor': 'FAMES_Repartidor.html'
};

// ── Servidor ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  cors(res);
  const method = req.method.toUpperCase();
  const url    = req.url.split('?')[0];

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Archivos HTML
  if (ARCHIVOS[url] && method === 'GET') {
    fs.readFile(path.join(__dirname, ARCHIVOS[url]), (err, data) => {
      if (err) { cors(res); res.writeHead(404); res.end('No encontrado'); return; }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // GET /api/turno — estado completo
  if (url === '/api/turno' && method === 'GET') {
    json(res, 200, estadoCompleto());
    return;
  }

  // GET /api/historial — ver historial de turnos
  if (url === '/api/historial' && method === 'GET') {
    json(res, 200, { ok: true, historialTurnos: historialTurnos });
    return;
  }

  // GET /api/estado — compatibilidad
  if (url === '/api/estado' && method === 'GET') {
    json(res, 200, { ok: true, data: { domicilios: turno.domicilios, domNum: turno.domNum } });
    return;
  }

  // POST /api/login
  if (url === '/api/login' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b);
        if (!d.nombre) { json(res, 400, { ok: false, error: 'Nombre requerido' }); return; }
        const id = 'emp_' + d.nombre.toLowerCase().replace(/[^a-z0-9]/g,'_') + '_' + (d.id||'x');
        const yaExiste = empleados[id];
        empleados[id] = {
          id:        id,
          nombre:    d.nombre,
          rol:       d.rol || 'empleado',
          entrada:   yaExiste && yaExiste.entrada ? yaExiste.entrada : hora(),
          salida:    null,
          activo:    true,
          ultima:    Date.now(),
          ultimaHora:hora()
        };
        if (!turno.abierto || turno.id !== hoy()) {
          if (!turno.abierto) {
            // Nuevo turno — limpiar solo si es día diferente
            if (turno.id && turno.id !== hoy()) {
              turno = estadoDefault().turno;
            }
            turno.id      = hoy();
            turno.abierto = true;
            console.log('Turno abierto:', turno.id);
          }
        }
        guardarEstado();
        json(res, 200, {
          ok:        true,
          empId:     id,
          turno:     { id: turno.id, abierto: turno.abierto, fecha: turno.id },
          empleados: empleados
        });
        console.log('Login:', d.nombre, '|', d.rol);
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // POST /api/ping
  if (url === '/api/ping' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo      = true;
          empleados[d.empId].ultima      = Date.now();
          empleados[d.empId].ultimaHora  = hora();
          empleados[d.empId].salida      = null;
        }
        limpiarInactivos();
        json(res, 200, { ok: true, empleados: empleados });
      } catch(e) {
        json(res, 200, { ok: true, empleados: empleados });
      }
    });
    return;
  }

  // POST /api/logout
  if (url === '/api/logout' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo = false;
          empleados[d.empId].salida = hora();
          guardarEstado();
          console.log('Logout:', empleados[d.empId].nombre);
        }
        json(res, 200, { ok: true });
      } catch(e) {
        json(res, 200, { ok: true });
      }
    });
    return;
  }

  // POST /api/sync — guardar estado completo del POS
  if (url === '/api/sync' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (!turno.abierto) { turno.abierto = true; turno.id = turno.id || hoy(); }
        if (d.domicilios && Array.isArray(d.domicilios)) {
          d.domicilios.forEach(dom => {
            const idx = turno.domicilios.findIndex(x => x.id === dom.id);
            if (idx >= 0) turno.domicilios[idx].estado = dom.estado;
            else if (dom.id) turno.domicilios.push(dom);
          });
        }
        if (d.salesLog       !== undefined) turno.salesLog       = d.salesLog;
        if (d.salesByProduct !== undefined) turno.salesByProduct = d.salesByProduct;
        if (d.cobroNum       !== undefined) turno.cobroNum       = d.cobroNum;
        if (d.comNum         !== undefined) turno.comNum         = d.comNum;
        if (d.cocina         !== undefined) turno.cocina         = d.cocina;
        if (d.orders         !== undefined) turno.orders         = d.orders;
        if (d.gastos         !== undefined) turno.gastos         = d.gastos;
        if (d.gastoNum       !== undefined) turno.gastoNum       = d.gastoNum;
        guardarEstado();
        console.log('Sync OK: ' + turno.salesLog.length + ' ventas');
        json(res, 200, { ok: true });
      } catch(e) {
        console.error('Sync error:', e.message);
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // POST /api/pedido-online
  if (url === '/api/pedido-online' && method === 'POST') {
    body(req, b => {
      try {
        const pedido = JSON.parse(b);
        if (!pedido.nombre || !pedido.items || !pedido.items.length) {
          json(res, 400, { ok: false, error: 'Faltan datos' }); return;
        }
        turno.domNum++;
        pedido.id     = turno.domNum;
        pedido.label  = 'DOM-' + turno.domNum;
        pedido.estado = 'pendiente';
        pedido.origen = 'online';
        pedido.turnoId = turno.id;
        turno.domicilios.push(pedido);
        guardarEstado();
        console.log('Pedido online:', pedido.label, pedido.nombre, '$'+pedido.total);
        json(res, 200, { ok: true, id: pedido.label });
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // POST /api/historial — guardar turno cerrado
  if (url === '/api/historial' && method === 'POST') {
    body(req, b => {
      try {
        const turnoData = JSON.parse(b || '{}');
        historialTurnos.unshift(turnoData);
        // Guardar máximo 90 turnos
        if (historialTurnos.length > 90) historialTurnos = historialTurnos.slice(0, 90);
        guardarEstado();
        console.log('Turno guardado en historial:', turnoData.fecha);
        json(res, 200, { ok: true });
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // POST /api/reset — cierre de turno
  if (url === '/api/reset' && method === 'POST') {
    body(req, b => {
      turno = estadoDefault().turno;
      turno.id = hoy();
      guardarEstado();
      console.log('Turno reseteado');
      json(res, 200, { ok: true, turnoId: turno.id });
    });
    return;
  }

  json(res, 404, { ok: false, error: 'Ruta no encontrada: ' + url });
});

server.on('error', e => console.error('Error:', e.message));
server.listen(PORT, '0.0.0.0', () => {
  console.log('FAMES POS en puerto ' + PORT);
});
