const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;

// Estado compartido
let estado = {
  orders: {}, cocina: [], domicilios: [], salesLog: [],
  salesByProduct: {}, cobroNum: 0, comNum: 0, domNum: 0,
  turnoActivo: null, historialTurnos: []
};

// Headers CORS para que Railway no bloquee nada
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// Servidor HTTP
const server = http.createServer((req, res) => {
  setCORSHeaders(res);

  // Preflight OPTIONS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // Rutas de archivos HTML
  if (url === '/' || url === '/pos') {
    servirArchivo(res, 'FAMES_PuntoDeVenta.html');
  } else if (url === '/pedidos') {
    servirArchivo(res, 'FAMES_Pedidos.html');
  } else if (url === '/repartidor') {
    servirArchivo(res, 'FAMES_Repartidor.html');

  // API: obtener estado
  } else if (url === '/api/estado' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, data: estado }));

  // API: recibir pedido online
  } else if (url === '/api/pedido-online' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const pedido = JSON.parse(body);

        // Validar campos mínimos
        if (!pedido.nombre || !pedido.items || !pedido.items.length) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Datos incompletos' }));
          return;
        }

        // Asignar ID
        estado.domNum = (estado.domNum || 0) + 1;
        pedido.id = estado.domNum;
        pedido.label = 'DOM-' + estado.domNum;
        pedido.estado = 'pendiente';
        pedido.origen = 'online';

        if (!estado.domicilios) estado.domicilios = [];
        estado.domicilios.push(pedido);

        // Notificar a todos los clientes WebSocket conectados
        const msg = JSON.stringify({ tipo: 'nuevo_pedido_online', data: pedido });
        const estadoMsg = JSON.stringify({ tipo: 'estado', data: estado });
        wss.clients.forEach(client => {
          if (client.readyState === WebSocket.OPEN) {
            try { client.send(msg); } catch(e) {}
            try { client.send(estadoMsg); } catch(e) {}
          }
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, id: pedido.label }));

      } catch(e) {
        console.error('Error procesando pedido:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Error interno' }));
      }
    });
    req.on('error', (e) => {
      console.error('Error en request:', e.message);
      res.writeHead(500);
      res.end();
    });

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'No encontrado' }));
  }
});

function servirArchivo(res, nombre) {
  const filePath = path.join(__dirname, nombre);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Archivo no encontrado: ' + nombre);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(data);
  });
}

// WebSocket
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  // Enviar estado actual al conectarse
  try {
    ws.send(JSON.stringify({ tipo: 'estado', data: estado }));
  } catch(e) {}

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      if (data.tipo === 'actualizar') {
        // Merge del estado
        Object.keys(data.data).forEach(k => { estado[k] = data.data[k]; });
        // Broadcast a todos los demás
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            try { client.send(JSON.stringify({ tipo: 'estado', data: estado })); } catch(e) {}
          }
        });
      }
    } catch(e) {}
  });

  ws.on('error', () => {});
  ws.on('close', () => {});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('FAMES POS corriendo en puerto ' + PORT);
});
