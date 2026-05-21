const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Estado compartido en memoria
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

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, code, data){
  res.writeHead(code, {'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  cors(res);
  const url = req.url.split('?')[0];

  if(req.method === 'OPTIONS'){
    res.writeHead(204); res.end(); return;
  }

  // Servir HTML
  if(ARCHIVOS[url]){
    const fp = path.join(__dirname, ARCHIVOS[url]);
    fs.readFile(fp, (err, data) => {
      if(err){ res.writeHead(404); res.end('No encontrado: '+ARCHIVOS[url]); return; }
      res.writeHead(200, {'Content-Type':'text/html;charset=utf-8'});
      res.end(data);
    });
    return;
  }

  // GET /api/estado — el POS y repartidor leen esto
  if(url === '/api/estado' && req.method === 'GET'){
    json(res, 200, {ok:true, data:estado});
    return;
  }

  // POST /api/pedido-online — cliente envía pedido
  if(url === '/api/pedido-online' && req.method === 'POST'){
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try {
        const pedido = JSON.parse(body);
        if(!pedido.nombre || !pedido.items || !pedido.items.length){
          json(res, 400, {ok:false, error:'Faltan datos'}); return;
        }
        estado.domNum++;
        pedido.id    = estado.domNum;
        pedido.label = 'DOM-' + estado.domNum;
        pedido.estado = 'pendiente';
        pedido.origen = 'online';
        estado.domicilios.push(pedido);
        console.log('✅ Pedido recibido:', pedido.label, '-', pedido.nombre, '- $'+pedido.total);
        json(res, 200, {ok:true, id:pedido.label});
      } catch(e){
        console.error('Error pedido:', e.message);
        json(res, 500, {ok:false, error:e.message});
      }
    });
    return;
  }

  // POST /api/sync — POS y repartidor sincronizan estados de domicilios
  if(url === '/api/sync' && req.method === 'POST'){
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if(data.domicilios && Array.isArray(data.domicilios)){
          // Actualizar estados de domicilios existentes
          data.domicilios.forEach(function(d){
            const idx = estado.domicilios.findIndex(x => x.id === d.id);
            if(idx >= 0){
              estado.domicilios[idx].estado = d.estado;
            }
          });
        }
        json(res, 200, {ok:true});
      } catch(e){
        json(res, 500, {ok:false, error:e.message});
      }
    });
    return;
  }

  json(res, 404, {ok:false, error:'Ruta no encontrada: '+url});
});

server.on('error', e => console.error('Server error:', e.message));

server.listen(PORT, '0.0.0.0', () => {
  console.log('🍔 FAMES POS corriendo en puerto ' + PORT);
});
