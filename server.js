const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// ── Estado global ────────────────────────────────────────────────
let turno = {
  id:        null,       // fecha YYYY-MM-DD
  abierto:   false,
  domicilios:[],
  domNum:    0
};

// Empleados: { id: { nombre, rol, entrada, salida, activo, ultima } }
let empleados = {};

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
      console.log('⬤ Desconectado:', e.nombre, 'a las', e.salida);
    }
  });
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

  // ── Archivos HTML ─────────────────────────────────────────────
  if (ARCHIVOS[url] && method === 'GET') {
    fs.readFile(path.join(__dirname, ARCHIVOS[url]), (err, data) => {
      if (err) { cors(res); res.writeHead(404); res.end('No encontrado'); return; }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // ── GET /api/turno — estado del turno + empleados ─────────────
  if (url === '/api/turno' && method === 'GET') {
    limpiarInactivos();
    json(res, 200, {
      ok: true,
      turno: {
        id:      turno.id,
        abierto: turno.abierto,
        fecha:   turno.id || hoy(),
        domNum:  turno.domNum
      },
      empleados: empleados,
      domicilios: turno.domicilios
    });
    return;
  }

  // ── POST /api/login — empleado entra al turno ─────────────────
  if (url === '/api/login' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b);
        if (!d.nombre) { json(res, 400, { ok: false, error: 'Nombre requerido' }); return; }
        const id = 'emp_' + d.nombre.toLowerCase().replace(/\s+/g,'_') + '_' + (d.id||'');
        const yaExiste = empleados[id];
        empleados[id] = {
          id:       id,
          nombre:   d.nombre,
          rol:      d.rol || 'empleado',
          entrada:  yaExiste && yaExiste.entrada ? yaExiste.entrada : hora(),
          salida:   null,
          activo:   true,
          ultima:   Date.now(),
          ultimaHora: hora()
        };
        // Si no hay turno abierto hoy, abrirlo
        if (!turno.abierto || turno.id !== hoy()) {
          turno.id       = hoy();
          turno.abierto  = true;
          turno.domicilios = [];
          turno.domNum   = 0;
          console.log('📅 Turno abierto:', turno.id);
        }
        console.log('✅ Conectado:', d.nombre, '|', d.rol);
        limpiarInactivos();
        json(res, 200, {
          ok:        true,
          empId:     id,
          turno:     { id: turno.id, abierto: turno.abierto, fecha: turno.id },
          empleados: empleados
        });
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── POST /api/ping — keepalive del empleado ───────────────────
  if (url === '/api/ping' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo     = true;
          empleados[d.empId].ultima     = Date.now();
          empleados[d.empId].ultimaHora = hora();
          empleados[d.empId].salida     = null;
        }
        limpiarInactivos();
        json(res, 200, { ok: true, empleados: empleados });
      } catch(e) {
        json(res, 200, { ok: true, empleados: empleados });
      }
    });
    return;
  }

  // ── POST /api/logout — empleado cierra sesión ─────────────────
  if (url === '/api/logout' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo = false;
          empleados[d.empId].salida = hora();
          console.log('👋 Desconectado:', empleados[d.empId].nombre);
        }
        json(res, 200, { ok: true });
      } catch(e) {
        json(res, 200, { ok: true });
      }
    });
    return;
  }

  // ── POST /api/pedido-online — cliente hace pedido ─────────────
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
        console.log('🛵 Pedido:', pedido.label, pedido.nombre, '$'+pedido.total);
        json(res, 200, { ok: true, id: pedido.label });
      } catch(e) {
        console.error('Error pedido:', e.message);
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── POST /api/sync — sincronizar estados de domicilios ────────
  if (url === '/api/sync' && method === 'POST') {
    body(req, b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.domicilios && Array.isArray(d.domicilios)) {
          d.domicilios.forEach(dom => {
            const idx = turno.domicilios.findIndex(x => x.id === dom.id);
            if (idx >= 0) turno.domicilios[idx].estado = dom.estado;
          });
        }
        json(res, 200, { ok: true });
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // ── POST /api/reset — limpiar domicilios al cerrar turno ──────
  if (url === '/api/reset' && method === 'POST') {
    body(req, b => {
      turno.domicilios = [];
      turno.domNum     = 0;
      turno.id         = hoy();
      console.log('🔄 Domicilios limpiados');
      json(res, 200, { ok: true, turnoId: turno.id });
    });
    return;
  }

  // ── GET /api/estado — compatibilidad ─────────────────────────
  if (url === '/api/estado' && method === 'GET') {
    limpiarInactivos();
    json(res, 200, { ok: true, data: { domicilios: turno.domicilios, domNum: turno.domNum } });
    return;
  }

  json(res, 404, { ok: false, error: 'Ruta no encontrada: ' + url });
});

server.on('error', e => console.error('Server error:', e.message));
server.listen(PORT, '0.0.0.0', () => {
  console.log('🍔 FAMES POS en puerto ' + PORT);
});
