// Página web local para analizar tu exportación de Instagram en el navegador.
// Uso: npm start  → abre Chrome en http://localhost:4000
//
// El servidor solo entrega la página. Los archivos que subes se analizan en el propio
// navegador: no se envían al servidor ni a ningún otro sitio.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PUERTO = Number(process.env.PORT) || 4000;
const URL = `http://localhost:${PUERTO}`;
const PAGINA = path.join(__dirname, 'web', 'index.html');

const servidor = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(PAGINA).pipe(res);
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('No encontrado');
});

servidor.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ El puerto ${PUERTO} ya está en uso: probablemente la app ya está abierta en otra terminal.`);
    process.exit(1);
  }
  throw error;
});

servidor.listen(PUERTO, () => {
  console.log(`📊 Instagram Checker funcionando en ${URL}  (Ctrl + C para parar)`);

  // Abrir Chrome (o el navegador por defecto si no está). Para no abrirlo: OPEN_BROWSER=false
  if (process.env.OPEN_BROWSER !== 'false') {
    const comandos = {
      win32: `start "" chrome "${URL}" || start "" "${URL}"`,
      darwin: `open -a "Google Chrome" "${URL}" || open "${URL}"`,
      linux: `google-chrome "${URL}" || xdg-open "${URL}"`,
    };
    exec(comandos[process.platform] || `xdg-open "${URL}"`, { shell: true });
  }
});
