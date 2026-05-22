const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

let estado = {
  domicilios: [],
  domNum: 0
};

const ARCHIVOS = {
  '/':           'FAMES_PuntoDeVenta.html',
  '/pos':        'FAMES_PuntoDeVenta.html',
  '/pedidos':    'FAMES_Pedidos.html',
  '/repartidor': 'FAMES_Repartidor.html'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function recibirBody(req, callback) {
  let body = '';
  req.on('data', chunk => { body += chunk.toString(); });
  req.on('end', () => { callback(body); });
  req.on('error', () => { callback(''); });
}

const server = http.createServer((req, res) => {
  const method = req.method.toUpperCase();
  const url = req.url.split('?')[0].split('#')[0];

  console.log(method, url);

  // CORS preflight
  if (method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // API: obtener estado
  if (url === '/api/estado') {
    json(res, 200, { ok: true, data: estado });
    return;
  }

  // API: recibir pedido online
  if (url === '/api/pedido-online') {
    if (method !== 'POST') {
      json(res, 405, { ok: false, error: 'Método no permitido' });
      return;
    }
    recibirBody(req, function(body) {
      try {
        const pedido = JSON.parse(body);
        if (!pedido.nombre || !pedido.items || !pedido.items.length) {
          json(res, 400, { ok: false, error: 'Faltan datos: nombre e items requeridos' });
          return;
        }
        estado.domNum++;
        pedido.id     = estado.domNum;
        pedido.label  = 'DOM-' + estado.domNum;
        pedido.estado = 'pendiente';
        pedido.origen = 'online';
        estado.domicilios.push(pedido);
        console.log('PEDIDO OK:', pedido.label, pedido.nombre, '$' + pedido.total);
        json(res, 200, { ok: true, id: pedido.label });
      } catch(e) {
        console.error('ERROR parseando pedido:', e.message, '| Body:', body.substring(0, 100));
        json(res, 500, { ok: false, error: 'Error interno: ' + e.message });
      }
    });
    return;
  }

  // API: reset al cerrar turno
  if (url === '/api/reset') {
    if (method !== 'POST') { json(res, 405, { ok: false, error: 'Método no permitido' }); return; }
    estado.domicilios = [];
    estado.domNum = 0;
    console.log('Turno cerrado — estado reseteado');
    json(res, 200, { ok: true });
    return;
  }

  // API: sincronizar estados de domicilios
  if (url === '/api/sync') {
    if (method !== 'POST') {
      json(res, 405, { ok: false, error: 'Método no permitido' });
      return;
    }
    recibirBody(req, function(body) {
      try {
        const data = JSON.parse(body);
        if (data.domicilios && Array.isArray(data.domicilios)) {
          data.domicilios.forEach(function(d) {
            const idx = estado.domicilios.findIndex(x => x.id === d.id);
            if (idx >= 0) estado.domicilios[idx].estado = d.estado;
          });
        }
        json(res, 200, { ok: true });
      } catch(e) {
        json(res, 500, { ok: false, error: e.message });
      }
    });
    return;
  }

  // Servir archivos HTML
  if (ARCHIVOS[url]) {
    const fp = path.join(__dirname, ARCHIVOS[url]);
    fs.readFile(fp, function(err, data) {
      if (err) {
        cors(res);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Archivo no encontrado: ' + ARCHIVOS[url]);
        return;
      }
      cors(res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
    return;
  }

  // 404 para todo lo demás
  json(res, 404, { ok: false, error: 'Ruta no encontrada: ' + url });
});

server.on('error', e => console.error('Server error:', e.message));

server.listen(PORT, '0.0.0.0', function() {
  console.log('FAMES POS corriendo en puerto ' + PORT);
  console.log('Rutas: / /pedidos /repartidor /api/estado /api/pedido-online /api/sync');
});
