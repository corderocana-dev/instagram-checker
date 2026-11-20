// Lógica de Instagram Checker: lectura de la exportación, análisis y pantalla.
// Todo se ejecuta en el navegador: los archivos nunca salen del ordenador.

/* =========================================================
   LECTURA DE ARCHIVOS (JSON y HTML de la exportación de Instagram)
   Cada archivo se convierte en una lista de { usuario, fecha }.
   ========================================================= */

const $ = (id) => document.getElementById(id);
const numero = (n) => n.toLocaleString('es-ES');

// Nombre de usuario a partir de un enlace: instagram.com/usuario o instagram.com/_u/usuario
function usuarioDeEnlace(href) {
    try {
        const partes = new URL(href).pathname.split('/').filter((p) => p && p !== '_u');
        return partes[0] || null;
    } catch (e) {
        return null;
    }
}

function limpiar(u) {
    if (!u || typeof u !== 'string') return null;
    const limpio = u.trim().replace(/^@/, '').toLowerCase();
    return limpio || null;
}

// ¿Es de seguidores o de seguidos? Se mira el nombre del archivo, porque la exportación trae
// muchos otros archivos con el mismo formato (amigos íntimos, bloqueados, solicitudes...) que hay que ignorar.
function tipoDeArchivo(nombre, json) {
    const n = nombre.toLowerCase().split(/[\\/]/).pop();
    if (/hashtag/.test(n)) return null;                       // following_hashtags no son personas
    if (/^following\b|following\.(json|html?)$/.test(n)) return 'seguidos';
    if (/^followers_\d+|^followers\.(json|html?)$/.test(n)) return 'seguidores';
    if (/^pending_follow_requests/.test(n)) return 'pendientes';      // solicitudes que has enviado sin aceptar
    if (/^follow_requests_you/.test(n)) return 'recibidas';          // solicitudes que te han enviado
    if (/^recent_follow_requests/.test(n)) return 'recientes';       // solicitudes enviadas en los últimos meses
    if (/^close_friends/.test(n)) return 'mejoresAmigos';
    if (/^profiles_you.*favorited/.test(n)) return 'favoritos';
    if (/^blocked_(profiles|accounts)/.test(n)) return 'bloqueados';
    if (/^recently_unfollowed/.test(n)) return 'dejasteDeSeguir';
    if (/^removed_suggestions/.test(n)) return 'sugerencias';
    // Si el archivo se ha renombrado, se reconoce el de seguidos por su contenido
    if (json && json.relationships_following) return 'seguidos';
    return null;
}

// Nombre para mostrar de cada tipo de archivo
const NOMBRES_TIPO = {
    seguidores: 'Seguidores',
    seguidos: 'Seguidos',
    pendientes: 'Solicitudes enviadas pendientes',
    recibidas: 'Solicitudes recibidas',
    recientes: 'Solicitudes enviadas recientes',
    mejoresAmigos: 'Mejores amigos',
    favoritos: 'Favoritos',
    bloqueados: 'Bloqueados',
    dejasteDeSeguir: 'Dejaste de seguir',
    sugerencias: 'Sugerencias eliminadas',
};

function leerJSON(texto) {
    const json = JSON.parse(texto);
    const entradas = [];
    (function recorrer(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) return obj.forEach(recorrer);
        // Formato de "pending_follow_requests": { timestamp, label_values: [{ label, value }] }
        // Se usa primero "Nombre de usuario" (es el nombre ACTUAL): si la cuenta cambió de nombre,
        // la URL de estos archivos todavía lleva el nombre antiguo.
        if (Array.isArray(obj.label_values)) {
            const valores = obj.label_values.filter((lv) => lv && typeof lv.value === 'string');
            const campoUsuario = valores.find((lv) => /usuario|username/i.test(lv.label || ''));
            const campoUrl = valores.find((lv) => /instagram\.com/i.test(lv.value));
            const usuario = (campoUsuario && limpiar(campoUsuario.value)) || (campoUrl && limpiar(usuarioDeEnlace(campoUrl.value)));
            if (usuario) entradas.push({ usuario, fecha: obj.timestamp || null });
            return;
        }
        if (Array.isArray(obj.string_list_data)) {
            obj.string_list_data.forEach((s) => {
                const usuario = limpiar(s.value) || limpiar(obj.title) || limpiar(usuarioDeEnlace(s.href));
                if (usuario) entradas.push({ usuario, fecha: s.timestamp || null });
            });
            return;
        }
        Object.values(obj).forEach(recorrer);
    })(json);
    return { json, entradas };
}

function leerHTML(texto) {
    const doc = new DOMParser().parseFromString(texto, 'text/html');
    const entradas = [];
    doc.querySelectorAll('a[href*="instagram.com"]').forEach((a) => {
        const usuario = limpiar(usuarioDeEnlace(a.getAttribute('href'))) || limpiar(a.textContent);
        if (!usuario) return;
        // La fecha suele ir en el elemento siguiente al enlace
        let fecha = null;
        const siguiente = a.parentElement && a.parentElement.nextElementSibling;
        const ms = siguiente ? Date.parse(siguiente.textContent.trim()) : NaN;
        if (!Number.isNaN(ms)) fecha = Math.round(ms / 1000);
        entradas.push({ usuario, fecha });
    });
    return { entradas, titulo: doc.title || '' };
}

// Lee un archivo { nombre, contenido } y devuelve { nombre, tipo, entradas } o un error
function procesarArchivo(nombre, contenido) {
    try {
        if (/\.json$/i.test(nombre)) {
            const { json, entradas } = leerJSON(contenido);
            return { nombre, tipo: tipoDeArchivo(nombre, json), entradas };
        }
        const { entradas, titulo } = leerHTML(contenido);
        return { nombre, tipo: tipoDeArchivo(nombre + ' ' + titulo, null), entradas };
    } catch (e) {
        return { nombre, error: 'No se pudo leer (¿archivo dañado?)' };
    }
}

/* =========================================================
   ESTADO: dos exportaciones (actual y anterior)
   ========================================================= */

const exportaciones = { actual: [], anterior: [] };

// Junta los archivos de una exportación en un mapa (usuario -> fecha) por cada tipo de archivo
function unir(archivos) {
    const mapas = {};
    Object.keys(NOMBRES_TIPO).forEach((tipo) => { mapas[tipo] = new Map(); });
    archivos.forEach((a) => {
        if (a.error || !a.tipo) return;
        const destino = mapas[a.tipo];
        a.entradas.forEach((e) => { if (!destino.has(e.usuario)) destino.set(e.usuario, e.fecha); });
    });
    return mapas;
}

/* Marcas del usuario: cuentas que no le importan ("ignorada") o que ya no existen ("noExiste").
   Se guardan en este navegador para la próxima vez (si el navegador no deja, solo duran esta visita). */
const CLAVE_MARCAS = 'instagram-checker-marcas';
let marcas = {};
try { marcas = JSON.parse(localStorage.getItem(CLAVE_MARCAS)) || {}; } catch (e) { marcas = {}; }

function guardarMarcas() {
    try { localStorage.setItem(CLAVE_MARCAS, JSON.stringify(marcas)); } catch (e) { /* sin almacenamiento: solo en memoria */ }
}

function marcar(usuario, tipo) {
    if (tipo) marcas[usuario] = tipo; else delete marcas[usuario];
    guardarMarcas();
    actualizar();
}

const alfabetico = (a, b) => a.localeCompare(b, 'es');
const porUsuario = (a, b) => alfabetico(a.usuario, b.usuario);

const esEliminada = (u) => /__deleted__|deleted/i.test(u);

// Detecta cambios de nombre entre dos mapas (antes / ahora) usando la fecha exacta del follow
function cambiosDeNombre(antes, ahora) {
    const nuevosPorFecha = new Map();
    ahora.forEach((fecha, u) => {
        if (antes.has(u) || !fecha) return;
        if (!nuevosPorFecha.has(fecha)) nuevosPorFecha.set(fecha, []);
        nuevosPorFecha.get(fecha).push(u);
    });
    const renombrados = [];
    const usados = new Set();
    antes.forEach((fecha, u) => {
        if (ahora.has(u) || !fecha) return;
        const candidatos = nuevosPorFecha.get(fecha) || [];
        if (candidatos.length === 1 && !usados.has(candidatos[0])) {
            renombrados.push({ antes: u, ahora: candidatos[0], fecha });
            usados.add(candidatos[0]);
        }
    });
    return renombrados;
}

function analizar() {
    const actual = unir(exportaciones.actual);
    const hayActual = actual.seguidores.size > 0 && actual.seguidos.size > 0;
    if (!hayActual) return null;

    const eliminadas = [...actual.seguidos.keys(), ...actual.seguidores.keys()]
        .filter(esEliminada)
        .filter((u, i, a) => a.indexOf(u) === i)
        .sort(alfabetico);

    // Cambios de nombre (solo si hay exportación anterior)
    const anterior = unir(exportaciones.anterior);
    const hayAnterior = anterior.seguidores.size > 0 || anterior.seguidos.size > 0;
    let cambios = [];
    if (hayAnterior) {
        cambios = [...cambiosDeNombre(anterior.seguidos, actual.seguidos), ...cambiosDeNombre(anterior.seguidores, actual.seguidores)]
            .filter((x, i, a) => a.findIndex((y) => y.antes === x.antes) === i);
    }
    // Si el "nombre nuevo" es __deleted__..., no es un cambio de nombre: la cuenta se eliminó
    // (y así sabemos cómo se llamaba antes)
    const nombreAntesDeEliminar = new Map(cambios.filter((x) => esEliminada(x.ahora)).map((x) => [x.ahora, x.antes]));
    const renombradas = cambios.filter((x) => !esEliminada(x.ahora)).sort((a, b) => alfabetico(a.ahora, b.ahora));
    const renombradoAntes = new Set(cambios.map((x) => x.antes));
    const renombradoAhora = new Set(renombradas.map((x) => x.ahora));

    // "No te siguen de vuelta" SIN las cuentas eliminadas ni las que cambiaron de nombre
    // (esas van en su propia lista, aunque tampoco te sigan)
    const noTeSiguenTodos = [...actual.seguidos.keys()]
        .filter((u) => !actual.seguidores.has(u) && !esEliminada(u) && !renombradoAhora.has(u))
        .sort(alfabetico);
    // Las que el usuario ha marcado como "Ignorar" o "No existe" salen de la lista principal
    const noTeSiguen = noTeSiguenTodos.filter((u) => !marcas[u]);
    const noSigues = [...actual.seguidores.keys()]
        .filter((u) => !actual.seguidos.has(u) && !esEliminada(u) && !renombradoAhora.has(u))
        .sort(alfabetico);

    // El orden de "listas" es el orden de las pestañas
    const r = {
        seguidores: actual.seguidores.size,
        seguidos: actual.seguidos.size,
        listas: {
            noTeSiguen: noTeSiguen.map((u) => ({ usuario: u, fecha: actual.seguidos.get(u), mejorAmigo: actual.mejoresAmigos.has(u) })),
        },
        conAnterior: hayAnterior,
    };

    if (hayAnterior) {
        r.listas.renombradas = renombradas.map((x) => ({
            usuario: x.ahora,
            antes: x.antes,
            loSigues: actual.seguidos.has(x.ahora),
            teSigue: actual.seguidores.has(x.ahora),
        }));
    }

    r.listas.eliminadas = eliminadas.map((u) => ({ usuario: u, eliminada: true, antes: nombreAntesDeEliminar.get(u) || null }));
    r.listas.noSigues = noSigues.map((u) => ({ usuario: u, fecha: actual.seguidores.get(u) }));

    // Listas que dependen de archivos opcionales (solo aparecen si se han subido)
    const deMapa = (mapa, extra) => [...mapa.keys()].filter((u) => !esEliminada(u)).sort(alfabetico)
        .map((u) => Object.assign({ usuario: u, fecha: mapa.get(u) }, extra ? extra(u) : {}));

    if (actual.pendientes.size) r.listas.pendientes = deMapa(actual.pendientes);
    if (actual.recibidas.size) r.listas.recibidas = deMapa(actual.recibidas);
    if (actual.mejoresAmigos.size) {
        r.listas.amigosNoTeSiguen = [...actual.mejoresAmigos.keys()]
            .filter((u) => !actual.seguidores.has(u) && !esEliminada(u)).sort(alfabetico)
            .map((u) => ({ usuario: u, fecha: actual.mejoresAmigos.get(u) }));
    }

    // Cuentas marcadas por el usuario (de la lista "No te siguen de vuelta")
    const marcadas = (tipo) => noTeSiguenTodos.filter((u) => marcas[u] === tipo)
        .map((u) => ({ usuario: u, fecha: actual.seguidos.get(u), marca: tipo }));
    if (marcadas('ignorada').length) r.listas.ignoradas = marcadas('ignorada');
    if (marcadas('noExiste').length) r.listas.noExisten = marcadas('noExiste');

    // "Más datos de tu cuenta" (informativas)
    if (actual.mejoresAmigos.size) r.listas.mejoresAmigos = deMapa(actual.mejoresAmigos, (u) => ({ teSigue: actual.seguidores.has(u) }));
    if (actual.favoritos.size) r.listas.favoritos = deMapa(actual.favoritos);
    if (actual.recientes.size) {
        r.listas.recientes = deMapa(actual.recientes, (u) => ({
            estado: actual.seguidos.has(u) ? 'aceptada' : actual.pendientes.has(u) ? 'pendiente' : 'otra',
        }));
    }
    if (actual.dejasteDeSeguir.size) r.listas.dejasteDeSeguir = deMapa(actual.dejasteDeSeguir);
    if (actual.bloqueados.size) r.listas.bloqueados = deMapa(actual.bloqueados);
    if (actual.sugerencias.size) r.listas.sugerencias = deMapa(actual.sugerencias);

    if (hayAnterior) {
        r.listas.dejaronDeSeguirte = anterior.seguidores.size
            ? [...anterior.seguidores.keys()].filter((u) => !actual.seguidores.has(u) && !renombradoAntes.has(u) && !esEliminada(u)).sort(alfabetico).map((u) => ({ usuario: u }))
            : [];
        r.listas.nuevosSeguidores = anterior.seguidores.size
            ? [...actual.seguidores.keys()].filter((u) => !anterior.seguidores.has(u) && !renombradoAhora.has(u)).sort(alfabetico).map((u) => ({ usuario: u }))
            : [];
        r.listas.yaNoAparecen = anterior.seguidos.size
            ? [...anterior.seguidos.keys()].filter((u) => !actual.seguidos.has(u) && !renombradoAntes.has(u) && !esEliminada(u)).sort(alfabetico).map((u) => ({ usuario: u }))
            : [];
    }
    return r;
}

/* =========================================================
   PANTALLA
   ========================================================= */

// El orden de este objeto es el orden de las pestañas. "extra" = apartado "Más datos de tu cuenta"
const PESTANAS = {
    noTeSiguen: { titulo: 'No te siguen de vuelta', texto: 'Cuentas que tú sigues y que no te siguen. No incluye las cuentas eliminadas, las que han cambiado de nombre ni las que has marcado como "Ignorar" o "No existe". Si al abrir un perfil sale "Esta página no está disponible", márcalo con "No existe".' },
    renombradas: { titulo: 'Cambiaron de nombre', texto: 'Nombre antiguo → nombre nuevo. Se detecta comparando con la exportación anterior: el nombre antiguo desaparece y aparece otro con la misma fecha exacta de seguimiento, así que es la misma cuenta. Si además no te sigue de vuelta, se indica en rojo.' },
    eliminadas: { titulo: 'Cuentas eliminadas', texto: 'Instagram marca en la exportación las cuentas que se han borrado (aparecen como "__deleted__"). Con una exportación anterior se recupera cómo se llamaban, porque la cuenta borrada conserva la misma fecha de seguimiento.' },
    noSigues: { titulo: 'Te siguen y no los sigues', texto: 'Cuentas que te siguen y a las que tú no sigues.' },
    pendientes: { titulo: 'Solicitudes enviadas pendientes', texto: 'Cuentas privadas a las que has pedido seguir y todavía no han aceptado tu solicitud. No cuentan como "seguidos" hasta que la aceptan.' },
    recibidas: { titulo: 'Solicitudes recibidas', texto: 'Personas que te han pedido seguirte y todavía no has aceptado ni rechazado.' },
    amigosNoTeSiguen: { titulo: 'Mejores amigos que no te siguen', texto: 'Cuentas que tienes en tu lista de Mejores amigos pero que no te siguen (o que cambiaron de nombre).' },
    dejaronDeSeguirte: { titulo: 'Dejaron de seguirte', texto: 'Te seguían en la exportación anterior y ahora no (sin contar cambios de nombre). Puede ser que te dejaran de seguir o que desactivaran su cuenta.' },
    nuevosSeguidores: { titulo: 'Nuevos seguidores', texto: 'Te siguen ahora y no te seguían en la exportación anterior.' },
    yaNoAparecen: { titulo: 'Ya no los sigues', texto: 'Los seguías en la exportación anterior y ahora no (sin contar cambios de nombre): los dejaste de seguir o borraron la cuenta.' },
    ignoradas: { titulo: 'Ignoradas', texto: 'Cuentas que no te siguen pero has marcado como "Ignorar" (famosos, marcas…). Se recuerdan en este navegador. Pulsa "Restaurar" para devolverlas a la lista principal.' },
    noExisten: { titulo: 'No disponibles', texto: 'Cuentas que has marcado como "No existe" porque su perfil sale como no disponible: suelen estar desactivadas, suspendidas o haber cambiado de nombre. Se recuerdan en este navegador.' },

    mejoresAmigos: { extra: true, titulo: 'Mejores amigos', texto: 'Tu lista de Mejores amigos (las historias con el círculo verde).' },
    favoritos: { extra: true, titulo: 'Favoritos', texto: 'Cuentas marcadas como Favoritos: sus publicaciones te salen antes en el inicio.' },
    recientes: { extra: true, titulo: 'Solicitudes enviadas recientes', texto: 'Solicitudes que has enviado en los últimos meses, con su estado actual: aceptada (ya la sigues), pendiente, o rechazada / cancelada.' },
    dejasteDeSeguir: { extra: true, titulo: 'Dejaste de seguir', texto: 'Cuentas que has dejado de seguir recientemente (Instagram solo guarda las de los últimos meses).' },
    bloqueados: { extra: true, titulo: 'Bloqueados', texto: 'Cuentas que has bloqueado.' },
    sugerencias: { extra: true, titulo: 'Sugerencias eliminadas', texto: 'Cuentas que quitaste de "Personas que quizá conozcas".' },
};

// Texto de la fecha según la pestaña
const TEXTO_FECHA = {
    noTeSiguen: 'La sigues desde', noSigues: 'Te sigue desde', pendientes: 'Solicitud enviada el',
    recibidas: 'Te la envió el', amigosNoTeSiguen: 'En Mejores amigos desde', ignoradas: 'La sigues desde',
    noExisten: 'La sigues desde', mejoresAmigos: 'Añadida el', favoritos: 'Añadida el', recientes: 'Enviada el',
    dejasteDeSeguir: 'Dejaste de seguirla el', bloqueados: 'Bloqueada el', sugerencias: 'Quitada el',
};

let resultado = null;
let pestanaActual = 'noTeSiguen';

function avisar(texto) {
    const aviso = $('aviso');
    aviso.textContent = texto;
    aviso.classList.add('visible');
    setTimeout(() => aviso.classList.remove('visible'), 1800);
}

function fechaLegible(segundos) {
    if (!segundos) return '';
    return new Date(segundos * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

function filtrados() {
    const q = $('buscar').value.trim().toLowerCase();
    const lista = resultado ? resultado.listas[pestanaActual] || [] : [];
    return q ? lista.filter((x) => x.usuario.includes(q) || (x.antes && x.antes.includes(q))) : lista;
}

function pintarPestanas() {
    const principal = $('pestanas');
    const extra = $('pestanas-extra');
    principal.innerHTML = '';
    extra.innerHTML = '';
    Object.keys(PESTANAS).filter((clave) => resultado.listas[clave]).forEach((clave) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.className = clave === pestanaActual ? 'activa' : '';
        b.setAttribute('aria-selected', String(clave === pestanaActual));
        b.innerHTML = `${PESTANAS[clave].titulo} <span class="num">${numero(resultado.listas[clave].length)}</span>`;
        b.addEventListener('click', () => { pestanaActual = clave; pintarPestanas(); pintarLista(); });
        (PESTANAS[clave].extra ? extra : principal).appendChild(b);
    });
    $('grupo-extra').classList.toggle('oculto', !extra.children.length);
    $('explicacion').textContent = PESTANAS[pestanaActual].texto;
}

// Botón pequeño dentro de cada cuenta
function botonMini(texto, titulo, accion) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mini';
    b.textContent = texto;
    b.title = titulo;
    b.addEventListener('click', accion);
    return b;
}

function pintarLista() {
    const usuarios = filtrados();
    const ul = $('lista');
    ul.innerHTML = '';

    if (usuarios.length === 0) {
        ul.innerHTML = '<li class="vacio">No hay usuarios que mostrar.</li>';
    }

    const fragmento = document.createDocumentFragment();
    usuarios.forEach((x) => {
        const li = document.createElement('li');
        li.className = 'usuario';

        const avatar = document.createElement('span');
        avatar.className = 'avatar' + (x.eliminada ? ' gris' : '');
        avatar.textContent = x.eliminada ? '✕' : (x.usuario.replace(/[^a-z0-9]/i, '').charAt(0) || '?');

        const info = document.createElement('span');
        info.className = 'info';
        const nombre = document.createElement('span');
        nombre.className = 'nombre';
        nombre.textContent = x.eliminada ? 'Cuenta eliminada' : '@' + x.usuario;
        nombre.title = '@' + x.usuario;
        info.appendChild(nombre);

        const detalle = document.createElement('span');
        detalle.className = 'detalle';
        if (x.eliminada) {
            // Cuenta eliminada: si había exportación anterior, se sabe cómo se llamaba
            if (x.antes) {
                nombre.textContent = '@' + x.antes;
                nombre.title = '@' + x.antes + ' (eliminada)';
                detalle.textContent = 'Cuenta eliminada';
            } else {
                detalle.textContent = 'Nombre desconocido (sube una exportación anterior para verlo)';
            }
        }
        else if (x.antes) {
            // Cambio de nombre: nombre antiguo → nombre nuevo, y si te sigue o no
            nombre.textContent = '';
            const viejo = document.createElement('s');
            viejo.className = 'antiguo';
            viejo.textContent = '@' + x.antes;
            const nuevo = document.createElement('b');
            nuevo.textContent = '@' + x.usuario;
            nombre.append(viejo, ' → ', nuevo);
            nombre.title = '@' + x.antes + ' → @' + x.usuario;

            const etiqueta = document.createElement('span');
            if (x.loSigues && !x.teSigue) { etiqueta.className = 'etiqueta mal'; etiqueta.textContent = 'No te sigue de vuelta'; }
            else if (x.loSigues && x.teSigue) { etiqueta.className = 'etiqueta bien'; etiqueta.textContent = 'Os seguís'; }
            else if (x.teSigue) { etiqueta.className = 'etiqueta neutra'; etiqueta.textContent = 'Te sigue (tú no)'; }
            detalle.appendChild(etiqueta);
        }
        else if (x.fecha && TEXTO_FECHA[pestanaActual]) detalle.textContent = TEXTO_FECHA[pestanaActual] + ' ' + fechaLegible(x.fecha);
        if (detalle.textContent) info.appendChild(detalle);

        // Etiquetas
        const etiquetas = [];
        if (x.mejorAmigo) etiquetas.push(['neutra', '⭐ Mejor amigo']);
        if (x.estado === 'aceptada') etiquetas.push(['bien', 'Aceptada']);
        if (x.estado === 'pendiente') etiquetas.push(['neutra', 'Pendiente']);
        if (x.estado === 'otra') etiquetas.push(['mal', 'Rechazada o cancelada']);
        if (pestanaActual === 'mejoresAmigos' && x.teSigue === false) etiquetas.push(['mal', 'No te sigue']);
        etiquetas.forEach(([clase, texto]) => {
            const e = document.createElement('span');
            e.className = 'etiqueta ' + clase;
            e.textContent = texto;
            info.appendChild(document.createTextNode(' '));
            info.appendChild(e);
        });

        // Acciones: en la lista principal, "Ignorar" y "No existe"; en las marcadas, "Restaurar"
        if (pestanaActual === 'noTeSiguen' || x.marca) {
            const acciones = document.createElement('span');
            acciones.className = 'acciones-usuario';
            if (x.marca) {
                acciones.appendChild(botonMini('↩ Restaurar', 'Devolver a "No te siguen de vuelta"', () => { marcar(x.usuario, null); avisar('Devuelta a la lista principal'); }));
            } else {
                acciones.appendChild(botonMini('Ignorar', 'No me importa que no me siga (famosos, marcas…)', () => { marcar(x.usuario, 'ignorada'); avisar('@' + x.usuario + ' → Ignoradas'); }));
                acciones.appendChild(botonMini('No existe', 'El perfil sale como no disponible', () => { marcar(x.usuario, 'noExiste'); avisar('@' + x.usuario + ' → No disponibles'); }));
            }
            info.appendChild(acciones);
        }

        li.append(avatar, info);

        if (!x.eliminada) {
            const enlace = document.createElement('a');
            enlace.href = 'https://www.instagram.com/' + encodeURIComponent(x.usuario) + '/';
            enlace.target = '_blank';
            enlace.rel = 'noopener noreferrer';
            enlace.textContent = 'Ver perfil ↗';
            li.appendChild(enlace);
        }
        fragmento.appendChild(li);
    });
    ul.appendChild(fragmento);

    const total = resultado ? (resultado.listas[pestanaActual] || []).length : 0;
    $('contador').textContent = $('buscar').value
        ? `${numero(usuarios.length)} de ${numero(total)} usuarios`
        : `${numero(total)} usuarios`;
}

function actualizar() {
    resultado = analizar();
    if (!resultado) {
        $('resultados').classList.add('oculto');
        return;
    }
    if (!resultado.listas[pestanaActual]) pestanaActual = 'noTeSiguen';
    $('resultados').classList.remove('oculto');
    $('c-seguidores').textContent = numero(resultado.seguidores);
    $('c-seguidos').textContent = numero(resultado.seguidos);
    $('c-noteSiguen').textContent = numero(resultado.listas.noTeSiguen.length);
    $('c-eliminadas').textContent = numero(resultado.listas.eliminadas.length);
    pintarPestanas();
    pintarLista();
}

// Lista de archivos de una zona, con lo que se ha detectado en cada uno
function pintarArchivos(cual) {
    const ul = $('archivos-' + cual);
    ul.innerHTML = '';
    exportaciones[cual].forEach((a) => {
        const li = document.createElement('li');
        if (a.error) {
            li.innerHTML = `<span class="error">✕</span><span></span>`;
            li.lastChild.textContent = `${a.nombre}: ${a.error}`;
        } else if (!a.tipo) {
            li.innerHTML = `<span class="ignorado">–</span><span class="ignorado"></span>`;
            li.lastChild.textContent = `${a.nombre}: ignorado (no se usa)`;
        } else {
            li.innerHTML = `<span class="ok">✓</span><span></span>`;
            li.lastChild.textContent = `${a.nombre} → ${NOMBRES_TIPO[a.tipo]} (${numero(a.entradas.length)})`;
        }
        ul.appendChild(li);
    });

    if (cual === 'actual' && exportaciones.actual.length) {
        const u = unir(exportaciones.actual);
        if (!u.seguidores.size || !u.seguidos.size) {
            const li = document.createElement('li');
            li.innerHTML = '<span class="error">!</span><span class="error"></span>';
            li.lastChild.textContent = !u.seguidores.size ? 'Falta el archivo de seguidores (followers_1)' : 'Falta el archivo de seguidos (following)';
            ul.appendChild(li);
        }
    }
}

// Fecha más reciente que aparece en una exportación (sirve para saber cuál es la más nueva)
function fechaMasReciente(archivos) {
    let max = 0;
    archivos.forEach((a) => (a.entradas || []).forEach((e) => { if (e.fecha > max) max = e.fecha; }));
    return max;
}

// De una carpeta solo interesan los archivos que la app sabe leer (el resto se ignora sin avisar)
const esUtil = (archivo) => /\.(json|html?)$/i.test(archivo.name) && tipoDeArchivo(archivo.name, null) !== null;

async function anadirArchivos(cual, listaArchivos, deCarpeta) {
    const archivos = deCarpeta ? listaArchivos.filter(esUtil) : listaArchivos;
    if (deCarpeta && !archivos.length) {
        avisar('En esa carpeta no hay archivos de seguidores ni seguidos');
        return;
    }
    for (const archivo of archivos) {
        const contenido = await archivo.text();
        exportaciones[cual] = exportaciones[cual].filter((a) => a.nombre !== archivo.name);
        exportaciones[cual].push(procesarArchivo(archivo.name, contenido));
    }

    // Si la "anterior" resulta ser más nueva que la "actual", se intercambian
    const fActual = fechaMasReciente(exportaciones.actual);
    const fAnterior = fechaMasReciente(exportaciones.anterior);
    if (exportaciones.actual.length && exportaciones.anterior.length && fAnterior > fActual) {
        [exportaciones.actual, exportaciones.anterior] = [exportaciones.anterior, exportaciones.actual];
        avisar('La exportación anterior era la más reciente: las he intercambiado ✓');
    }

    pintarArchivos('actual');
    pintarArchivos('anterior');
    actualizar();
}

// Lee recursivamente lo que se arrastra (archivos sueltos o carpetas enteras)
function leerEntrada(entrada) {
    if (entrada.isFile) return new Promise((ok, mal) => entrada.file((f) => ok([f]), mal));
    return new Promise((ok, mal) => {
        const lector = entrada.createReader();
        const hijos = [];
        (function siguiente() {
            // readEntries devuelve los archivos por tandas: se llama hasta que vuelve vacío
            lector.readEntries(async (tanda) => {
                if (tanda.length) { hijos.push(...tanda); return siguiente(); }
                const listas = await Promise.all(hijos.map(leerEntrada));
                ok(listas.flat());
            }, mal);
        })();
    });
}

// Zonas de subida (clic, elegir carpeta o arrastrar)
['actual', 'anterior'].forEach((cual) => {
    const zona = $('zona-' + cual);
    const input = $('input-' + cual);
    const inputCarpeta = $('carpeta-' + cual);
    // Se copian los archivos a una lista ANTES de vaciar el selector
    // (si no, al vaciarlo se pierden los que aún no se han leído)
    input.addEventListener('change', () => {
        const archivos = [...input.files];
        input.value = '';
        anadirArchivos(cual, archivos, false);
    });
    inputCarpeta.addEventListener('change', () => {
        const archivos = [...inputCarpeta.files];
        inputCarpeta.value = '';
        anadirArchivos(cual, archivos, true);
    });
    zona.querySelector('.boton-carpeta').addEventListener('click', (e) => {
        e.preventDefault();
        inputCarpeta.click();
    });
    zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('encima'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
    zona.addEventListener('drop', async (e) => {
        e.preventDefault();
        zona.classList.remove('encima');
        // Las entradas hay que pedirlas ya: después del evento el navegador las borra
        const entradas = [...e.dataTransfer.items]
            .map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry())
            .filter(Boolean);
        if (!entradas.length) return anadirArchivos(cual, [...e.dataTransfer.files], false);
        const hayCarpeta = entradas.some((x) => x.isDirectory);
        try {
            const archivos = (await Promise.all(entradas.map(leerEntrada))).flat();
            anadirArchivos(cual, archivos, hayCarpeta);
        } catch (err) {
            avisar('No se pudo leer lo que has arrastrado');
        }
    });
});

$('limpiar').addEventListener('click', () => {
    exportaciones.actual = [];
    exportaciones.anterior = [];
    pintarArchivos('actual');
    pintarArchivos('anterior');
    actualizar();
});

$('buscar').addEventListener('input', pintarLista);

function textoLista() {
    return filtrados().map((x) => {
        if (x.eliminada) return x.antes ? `${x.antes} (eliminada)` : x.usuario;
        return x.antes ? `${x.antes} -> ${x.usuario}` : x.usuario;
    }).join('\n');
}

$('copiar').addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(textoLista());
        avisar('Lista copiada ✓');
    } catch (e) {
        avisar('No se pudo copiar');
    }
});

$('descargar').addEventListener('click', () => {
    const blob = new Blob([textoLista()], { type: 'text/plain' });
    const enlace = document.createElement('a');
    enlace.href = URL.createObjectURL(blob);
    enlace.download = pestanaActual + '.txt';
    enlace.click();
    URL.revokeObjectURL(enlace.href);
});
