const http = require('http');
const fs   = require('fs');
const path = require('path');
const { Client } = require('pg');

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:PZPhSTzPEGisSkMZUxsUIrRbelJojwgL@postgres.railway.internal:5432/railway';

// ── Base de datos ────────────────────────────────────────────────
let db = null;

async function conectarDB() {
  db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  // Crear tablas si no existen
  await db.query(`
    CREATE TABLE IF NOT EXISTS estado (
      clave TEXT PRIMARY KEY,
      valor JSONB NOT NULL,
      actualizado TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS historial (
      id SERIAL PRIMARY KEY,
      fecha TEXT NOT NULL,
      datos JSONB NOT NULL,
      creado TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('✅ Base de datos conectada');
}

async function leerEstado(clave) {
  try {
    const r = await db.query('SELECT valor FROM estado WHERE clave=$1', [clave]);
    return r.rows.length ? r.rows[0].valor : null;
  } catch(e) { console.error('leerEstado error:', e.message); return null; }
}

async function guardarEstado(clave, valor) {
  try {
    await db.query(`
      INSERT INTO estado (clave, valor, actualizado) VALUES ($1, $2, NOW())
      ON CONFLICT (clave) DO UPDATE SET valor=$2, actualizado=NOW()
    `, [clave, JSON.stringify(valor)]);
  } catch(e) { console.error('guardarEstado error:', e.message); }
}

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

function turnoDefault() {
  return {
    id: null, abierto: false,
    domicilios: [], domNum: 0,
    salesLog: [], salesByProduct: {},
    cobroNum: 0, comNum: 0,
    cocina: [], orders: {},
    gastos: [], gastoNum: 0
  };
}

// Estado en memoria (cacheado desde DB)
let turno = turnoDefault();
let empleados = {};

async function cargarDesdeDB() {
  const t = await leerEstado('turno');
  const e = await leerEstado('empleados');
  if (t) turno = t;
  if (e) empleados = e;
  console.log('Estado cargado: ' + turno.salesLog.length + ' ventas, turno=' + turno.id);
}

function limpiarInactivos() {
  const ahora = Date.now();
  Object.keys(empleados).forEach(k => {
    const e = empleados[k];
    if (e.activo && ahora - e.ultima > 20000) {
      e.activo = false;
      e.salida = e.ultimaHora || hora();
    }
  });
}

function estadoCompleto() {
  limpiarInactivos();
  return {
    ok: true,
    turno: { id: turno.id, abierto: turno.abierto, fecha: turno.id || hoy(), domNum: turno.domNum },
    empleados, domicilios: turno.domicilios,
    salesLog: turno.salesLog, salesByProduct: turno.salesByProduct,
    cobroNum: turno.cobroNum, comNum: turno.comNum,
    cocina: turno.cocina, orders: turno.orders,
    gastos: turno.gastos, gastoNum: turno.gastoNum
  };
}

const ARCHIVOS = {
  '/': 'FAMES_PuntoDeVenta.html',
  '/pos': 'FAMES_PuntoDeVenta.html',
  '/pedidos': 'FAMES_Pedidos.html',
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
      cors(res); res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' }); res.end(data);
    });
    return;
  }

  // GET /api/turno
  if (url === '/api/turno' && method === 'GET') {
    json(res, 200, estadoCompleto()); return;
  }

  // GET /api/estado
  if (url === '/api/estado' && method === 'GET') {
    json(res, 200, { ok: true, data: { domicilios: turno.domicilios, domNum: turno.domNum } }); return;
  }

  // GET /api/historial
  if (url === '/api/historial' && method === 'GET') {
    db.query('SELECT datos FROM historial ORDER BY creado DESC LIMIT 90')
      .then(r => {
        const turnos = r.rows.map(row => row.datos);
        json(res, 200, { ok: true, historialTurnos: turnos });
      })
      .catch(e => json(res, 500, { ok: false, error: e.message }));
    return;
  }

  // POST /api/historial — guardar turno cerrado
  if (url === '/api/historial' && method === 'POST') {
    body(req, async b => {
      try {
        const datos = JSON.parse(b);
        await db.query('INSERT INTO historial (fecha, datos) VALUES ($1, $2)', [datos.fecha || hoy(), JSON.stringify(datos)]);
        console.log('✅ Turno guardado en historial:', datos.fecha);
        json(res, 200, { ok: true });
      } catch(e) { json(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // POST /api/login
  if (url === '/api/login' && method === 'POST') {
    body(req, async b => {
      try {
        const d = JSON.parse(b);
        if (!d.nombre) { json(res, 400, { ok: false, error: 'Nombre requerido' }); return; }
        const id = 'emp_' + d.nombre.toLowerCase().replace(/[^a-z0-9]/g,'_') + '_' + (d.id||'x');
        const yaExiste = empleados[id];
        empleados[id] = {
          id, nombre: d.nombre, rol: d.rol || 'empleado',
          entrada: yaExiste && yaExiste.entrada ? yaExiste.entrada : hora(),
          salida: null, activo: true, ultima: Date.now(), ultimaHora: hora()
        };
        if (!turno.abierto) {
          if (turno.id && turno.id !== hoy()) turno = turnoDefault();
          turno.id = hoy(); turno.abierto = true;
          console.log('Turno abierto:', turno.id);
        }
        await guardarEstado('turno', turno);
        await guardarEstado('empleados', empleados);
        json(res, 200, { ok: true, empId: id, turno: { id: turno.id, abierto: turno.abierto, fecha: turno.id }, empleados });
        console.log('Login:', d.nombre, '|', d.rol);
      } catch(e) { json(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // POST /api/ping
  if (url === '/api/ping' && method === 'POST') {
    body(req, async b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo = true;
          empleados[d.empId].ultima = Date.now();
          empleados[d.empId].ultimaHora = hora();
          empleados[d.empId].salida = null;
        }
        limpiarInactivos();
        await guardarEstado('empleados', empleados);
        json(res, 200, { ok: true, empleados });
      } catch(e) { json(res, 200, { ok: true, empleados }); }
    });
    return;
  }

  // POST /api/logout
  if (url === '/api/logout' && method === 'POST') {
    body(req, async b => {
      try {
        const d = JSON.parse(b || '{}');
        if (d.empId && empleados[d.empId]) {
          empleados[d.empId].activo = false;
          empleados[d.empId].salida = hora();
          await guardarEstado('empleados', empleados);
        }
        json(res, 200, { ok: true });
      } catch(e) { json(res, 200, { ok: true }); }
    });
    return;
  }

  // POST /api/sync — guardar estado completo
  if (url === '/api/sync' && method === 'POST') {
    body(req, async b => {
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
        if (d.cocina !== undefined) {
          // Mergear: agregar nuevas, actualizar existentes, respetar cobradas
          d.cocina.filter(c => !c.cobrado).forEach(comNueva => {
            const idx = turno.cocina.findIndex(c => c.id === comNueva.id);
            if (idx < 0) {
              turno.cocina.push(comNueva); // Nueva comanda
            } else if (!turno.cocina[idx].cobrado) {
              turno.cocina[idx] = comNueva; // Actualizar existente
            }
          });
        }
        if (d.orders         !== undefined) turno.orders         = d.orders;
        if (d.gastos         !== undefined) turno.gastos         = d.gastos;
        if (d.gastoNum       !== undefined) turno.gastoNum       = d.gastoNum;
        await guardarEstado('turno', turno);
        // Marcar como cobradas las que vinieron con cobrado=true
        if (d.cobradasIds && Array.isArray(d.cobradasIds)) {
          d.cobradasIds.forEach(cid => {
            const idx = turno.cocina.findIndex(c => c.id === cid);
            if (idx >= 0) turno.cocina[idx].cobrado = true;
          });
        }
        console.log('Sync: ' + turno.salesLog.length + ' ventas, ' + turno.cocina.filter(c=>!c.cobrado).length + ' comandas activas');
        json(res, 200, { ok: true });
      } catch(e) { json(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // POST /api/pedido-online
  if (url === '/api/pedido-online' && method === 'POST') {
    body(req, async b => {
      try {
        const pedido = JSON.parse(b);
        if (!pedido.nombre || !pedido.items || !pedido.items.length) {
          json(res, 400, { ok: false, error: 'Faltan datos' }); return;
        }
        turno.domNum++;
        pedido.id = turno.domNum; pedido.label = 'DOM-' + turno.domNum;
        pedido.estado = 'pendiente'; pedido.origen = 'online'; pedido.turnoId = turno.id;
        turno.domicilios.push(pedido);
        await guardarEstado('turno', turno);
        console.log('Pedido online:', pedido.label, pedido.nombre);
        json(res, 200, { ok: true, id: pedido.label });
      } catch(e) { json(res, 500, { ok: false, error: e.message }); }
    });
    return;
  }

  // POST /api/reset — cierre de turno
  if (url === '/api/reset' && method === 'POST') {
    body(req, async b => {
      turno = turnoDefault();
      turno.id = hoy();
      empleados = {};
      await guardarEstado('turno', turno);
      await guardarEstado('empleados', empleados);
      console.log('✅ Turno reseteado');
      json(res, 200, { ok: true, turnoId: turno.id });
    });
    return;
  }

  json(res, 404, { ok: false, error: 'Ruta no encontrada: ' + url });
});

server.on('error', e => console.error('Server error:', e.message));

// ── Arrancar ─────────────────────────────────────────────────────
conectarDB()
  .then(() => cargarDesdeDB())
  .then(() => {
    server.listen(PORT, '0.0.0.0', () => {
      console.log('🍔 FAMES POS en puerto ' + PORT);
    });
  })
  .catch(e => {
    console.error('❌ Error conectando a DB:', e.message);
    // Arrancar sin DB como fallback
    server.listen(PORT, '0.0.0.0', () => {
      console.log('⚠ FAMES POS en puerto ' + PORT + ' (sin DB)');
    });
  });
