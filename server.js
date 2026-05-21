const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = 3000;

// Estado compartido
let estado = {
  orders: {}, cocina: [], salesLog: [], salesByProduct: {},
  cobroNum: 0, comNum: 0, turnoActivo: null, historialTurnos: [],
  empleadosTurno: [], domicilios: [], domNum: 0
};

let clientes = [];
let clienteId = 0;

function broadcast(msg, exceptSocket) {
  const data = JSON.stringify(msg);
  clientes.forEach(c => {
    if (c.ws !== exceptSocket && c.ws.readyState === 1) {
      try { c.ws.send(data); } catch(e) {}
    }
  });
}

function sendFrame(socket, data) {
  try {
    const buf = Buffer.from(data);
    const len = buf.length;
    let header;
    if (len < 126) { header = Buffer.alloc(2); header[0]=0x81; header[1]=len; }
    else if (len < 65536) { header=Buffer.alloc(4); header[0]=0x81; header[1]=126; header.writeUInt16BE(len,2); }
    else { header=Buffer.alloc(10); header[0]=0x81; header[1]=127; header.writeBigUInt64BE(BigInt(len),2); }
    socket.write(Buffer.concat([header, buf]));
  } catch(e) {}
}

const server = http.createServer((req, res) => {
  const cors = { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type' };

  // Página principal POS
  if (req.url === '/' || req.url === '/pos') {
    fs.readFile(path.join(__dirname,'FAMES_PuntoDeVenta.html'), (err,data) => {
      if(err){res.writeHead(404);res.end('No encontrado');return;}
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(data);
    }); return;
  }

  // Página del repartidor
  if (req.url === '/repartidor') {
    fs.readFile(path.join(__dirname,'FAMES_Repartidor.html'), (err,data) => {
      if(err){res.writeHead(404);res.end('No encontrado');return;}
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(data);
    }); return;
  }

  // Página de pedidos online (para clientes)
  if (req.url === '/pedidos' || req.url === '/menu') {
    fs.readFile(path.join(__dirname,'FAMES_Pedidos.html'), (err,data) => {
      if(err){res.writeHead(404);res.end('No encontrado');return;}
      res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(data);
    }); return;
  }

  // API: obtener estado
  if (req.url === '/api/estado' && req.method === 'GET') {
    res.writeHead(200, cors); res.end(JSON.stringify(estado)); return;
  }

  // API: actualizar estado (desde POS)
  if (req.url === '/api/estado' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body+=c);
    req.on('end', () => {
      try {
        Object.assign(estado, JSON.parse(body));
        broadcast({tipo:'estado', data:estado});
        res.writeHead(200,cors); res.end(JSON.stringify({ok:true}));
      } catch(e){res.writeHead(400);res.end('Error');}
    }); return;
  }

  // API: recibir pedido online del cliente
  if (req.url === '/api/pedido-online' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body+=c);
    req.on('end', () => {
      try {
        const pedido = JSON.parse(body);
        estado.domNum = (estado.domNum||0) + 1;
        pedido.id = estado.domNum;
        pedido.label = 'DOM-' + estado.domNum;
        pedido.estado = 'pendiente';
        pedido.origen = 'online';
        if(!estado.domicilios) estado.domicilios = [];
        estado.domicilios.push(pedido);

        // También crear comanda en cocina
        estado.comNum = (estado.comNum||0) + 1;
        const comandaItems = pedido.items.map(it => ({
          id: it.id, item: {name:it.name, price:it.price, emoji:it.emoji||'🍔'}, qty:it.qty, listo:false
        }));
        if(!estado.cocina) estado.cocina = [];
        estado.cocina.push({
          id: estado.comNum, mesa: pedido.label+'🌐', hora: pedido.hora,
          timestamp: Date.now(), items: comandaItems, cobrado: false,
          esDomicilio: true, domId: pedido.id, esOnline: true
        });

        // Notificar a todos los dispositivos POS
        broadcast({tipo:'estado', data:estado});
        broadcast({tipo:'nuevo_pedido_online', pedido:pedido});

        res.writeHead(200,cors);
        res.end(JSON.stringify({ok:true, num:pedido.label}));
        console.log('[PEDIDO ONLINE] '+pedido.label+' — '+pedido.nombre+' — $'+pedido.total);
      } catch(e){res.writeHead(400);res.end('Error');}
    }); return;
  }

  if (req.method === 'OPTIONS') { res.writeHead(200,cors); res.end(); return; }
  res.writeHead(404); res.end('No encontrado');
});

// WebSocket
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');

  const id = ++clienteId;
  const ws = { readyState:1, send:(data)=>sendFrame(socket,data) };
  const cliente = {id, ws};
  clientes.push(cliente);
  console.log(`[+] Dispositivo #${id} conectado. Total: ${clientes.length}`);
  try { ws.send(JSON.stringify({tipo:'estado', data:estado})); } catch(e){}

  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while(buffer.length >= 2){
      const opcode = buffer[0]&0x0f;
      if(opcode===8){socket.destroy();return;}
      const masked=(buffer[1]&0x80)!==0;
      let pLen=buffer[1]&0x7f, offset=2;
      if(pLen===126){if(buffer.length<4)break;pLen=buffer.readUInt16BE(2);offset=4;}
      else if(pLen===127){if(buffer.length<10)break;pLen=Number(buffer.readBigUInt64BE(2));offset=10;}
      const total=offset+(masked?4:0)+pLen;
      if(buffer.length<total)break;
      let payload;
      if(masked){const mask=buffer.slice(offset,offset+4);payload=buffer.slice(offset+4,offset+4+pLen);for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];}
      else{payload=buffer.slice(offset,offset+pLen);}
      buffer=buffer.slice(total);
      try{
        const msg=JSON.parse(payload.toString());
        if(msg.tipo==='actualizar'){Object.assign(estado,msg.data);broadcast({tipo:'estado',data:estado},ws);}
      }catch(e){}
    }
  });
  socket.on('close',()=>{clientes=clientes.filter(c=>c.id!==id);console.log(`[-] Dispositivo #${id} desconectado.`);});
  socket.on('error',()=>{clientes=clientes.filter(c=>c.id!==id);});
});

function getLocalIP(){
  const ifaces=os.networkInterfaces();
  for(const name of Object.keys(ifaces)) for(const i of ifaces[name]) if(i.family==='IPv4'&&!i.internal) return i.address;
  return 'localhost';
}

server.listen(PORT,'0.0.0.0',()=>{
  const ip=getLocalIP();
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║            FAMES — Servidor POS activo               ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  POS (caja):      http://localhost:${PORT}               ║`);
  console.log(`║  POS (red WiFi):  http://${ip}:${PORT}           ║`);
  console.log(`║  Pedidos online:  http://${ip}:${PORT}/pedidos   ║`);
  console.log(`║  Repartidor:      http://${ip}:${PORT}/repartidor║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  DISPOSITIVOS — abre en el navegador:                ║');
  console.log(`║  → Mesero / Caja:    http://${ip}:${PORT}        ║`);
  console.log(`║  → Cocina:           http://${ip}:${PORT}        ║`);
  console.log(`║  → Página clientes:  http://${ip}:${PORT}/pedidos║`);
  console.log(`║  → Repartidor:       http://${ip}:${PORT}/repartidor║`);
  console.log('╚══════════════════════════════════════════════════════╝\n');
  console.log('Deja esta ventana abierta. Ctrl+C para apagar.\n');
});
