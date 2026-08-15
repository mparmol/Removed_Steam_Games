package com.mparmol.removedsteamgames

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mparmol.removedsteamgames.datos.Biblioteca
import com.mparmol.removedsteamgames.datos.Evento
import com.mparmol.removedsteamgames.datos.Feed
import com.mparmol.removedsteamgames.datos.Tipos
import com.mparmol.removedsteamgames.notif.Topics
import kotlinx.coroutines.launch
import java.time.LocalDate

class MainActivity : ComponentActivity() {

    private val pedirNotificaciones = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= 33) pedirNotificaciones.launch(Manifest.permission.POST_NOTIFICATIONS)

        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Pantalla()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun Pantalla() {
    val ctx = LocalContext.current
    val ambito = rememberCoroutineScope()

    var eventos by remember { mutableStateOf(Feed.cacheado(ctx)) }
    var cargando by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var seleccionado by remember { mutableStateOf<Evento?>(null) }
    var enAjustes by remember { mutableStateOf(false) }

    // Filtros de marcar/desmarcar: se parte de "todo visible" y se van ocultando.
    var ocultos by remember { mutableStateOf(setOf<String>()) }
    var soloHoy by remember { mutableStateOf(false) }
    var ocultarPoseidos by remember { mutableStateOf(false) }

    val poseidos by Biblioteca.poseidos(ctx).collectAsStateWithLifecycle(initialValue = emptySet())
    val deseados by Biblioteca.deseados(ctx).collectAsStateWithLifecycle(initialValue = emptySet())

    fun refrescar() {
        if (cargando) return
        cargando = true
        error = null
        ambito.launch {
            runCatching { Feed.descargar(ctx) }
                .onSuccess { eventos = it }
                .onFailure { error = it.message ?: "no se pudo actualizar" }
            cargando = false
        }
    }

    LaunchedEffect(Unit) { refrescar() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(if (enAjustes) "Ajustes" else "Juegos retirados") },
                actions = {
                    if (!enAjustes) TextButton(onClick = { refrescar() }, enabled = !cargando) { Text("Actualizar") }
                    TextButton(onClick = { enAjustes = !enAjustes }) { Text(if (enAjustes) "Volver" else "Ajustes") }
                },
            )
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            if (enAjustes) {
                Ajustes()
            } else {
                Listado(
                    eventos = eventos,
                    ocultos = ocultos,
                    soloHoy = soloHoy,
                    ocultarPoseidos = ocultarPoseidos,
                    poseidos = poseidos,
                    deseados = deseados,
                    cargando = cargando,
                    error = error,
                    alAlternarTipo = { ocultos = if (it in ocultos) ocultos - it else ocultos + it },
                    alAlternarHoy = { soloHoy = !soloHoy },
                    alAlternarPoseidos = { ocultarPoseidos = !ocultarPoseidos },
                    alPulsar = { seleccionado = it },
                    alMarcar = { appid, tengo -> ambito.launch { Biblioteca.marcarPoseido(ctx, appid, tengo) } },
                )
            }
        }
    }

    seleccionado?.let { ev ->
        Detalle(ev, ev.appid in poseidos, ev.appid in deseados) { seleccionado = null }
    }
}

private fun esDeHoy(iso: String): Boolean = runCatching {
    iso.take(10) == LocalDate.now().toString()
}.getOrDefault(false)

@Composable
private fun Listado(
    eventos: List<Evento>,
    ocultos: Set<String>,
    soloHoy: Boolean,
    ocultarPoseidos: Boolean,
    poseidos: Set<Int>,
    deseados: Set<Int>,
    cargando: Boolean,
    error: String?,
    alAlternarTipo: (String) -> Unit,
    alAlternarHoy: () -> Unit,
    alAlternarPoseidos: () -> Unit,
    alPulsar: (Evento) -> Unit,
    alMarcar: (Int, Boolean) -> Unit,
) {
    val tiposPresentes = remember(eventos) { eventos.map { it.tipo }.distinct().sorted() }

    val visibles = remember(eventos, ocultos, soloHoy, ocultarPoseidos, poseidos) {
        eventos.filter { ev ->
            ev.tipo !in ocultos &&
                (!soloHoy || esDeHoy(ev.detectado)) &&
                (!ocultarPoseidos || ev.appid !in poseidos)
        }
    }
    val hoy = remember(eventos) { eventos.count { esDeHoy(it.detectado) } }

    Column {
        if (cargando) LinearProgressIndicator(Modifier.fillMaxWidth())
        error?.let {
            Text(
                "Sin conexión: mostrando lo último guardado ($it)",
                Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }

        // Chips de tipo: marcado = se muestra, desmarcado = oculto
        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            tiposPresentes.forEach { t ->
                val cuantos = eventos.count { it.tipo == t }
                FilterChip(
                    selected = t !in ocultos,
                    onClick = { alAlternarTipo(t) },
                    label = { Text("${Tipos.etiqueta(t)} ($cuantos)") },
                )
            }
        }

        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            FilterChip(
                selected = soloHoy,
                onClick = alAlternarHoy,
                label = { Text(if (soloHoy) "Solo hoy ($hoy)" else "Todo el histórico") },
            )
            if (poseidos.isNotEmpty()) {
                FilterChip(
                    selected = ocultarPoseidos,
                    onClick = alAlternarPoseidos,
                    label = { Text("Ocultar los que tengo") },
                )
            }
        }

        HorizontalDivider()

        if (visibles.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (cargando) "Cargando…" else "Nada que mostrar con estos filtros")
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(visibles, key = { it.id }) { ev ->
                    Fila(ev, ev.appid in poseidos, ev.appid in deseados, alPulsar, alMarcar)
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun Fila(
    ev: Evento,
    lotengo: Boolean,
    lodeseo: Boolean,
    alPulsar: (Evento) -> Unit,
    alMarcar: (Int, Boolean) -> Unit,
) {
    ListItem(
        // Steam no reporta la posesion de los free-to-play sin jugar, asi que corregirlo
        // tiene que costar un toque desde la lista, no abrir una ficha.
        trailingContent = {
            Checkbox(checked = lotengo, onCheckedChange = { alMarcar(ev.appid, it) })
        },
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(ev.titulo, fontWeight = FontWeight.Medium, modifier = Modifier.weight(1f, fill = false))
                // lo que ya tienes deja de ser urgente; lo deseado es justo lo contrario
                if (lotengo) Marca("La tienes", MaterialTheme.colorScheme.secondaryContainer)
                else if (lodeseo) Marca("Deseado", MaterialTheme.colorScheme.tertiaryContainer)
            }
        },
        supportingContent = {
            val precio = ev.precio?.let { " · $it" } ?: ""
            val extra = ev.vence?.let { " · se retira ${it.take(10)}" } ?: ""
            Text("${Tipos.etiqueta(ev.tipo)} · ${Tipos.etiquetaContenido(ev.app_type)}$precio$extra")
        },
        overlineContent = { Text(ev.detectado.take(16).replace('T', ' ')) },
        modifier = Modifier.clickable { alPulsar(ev) },
    )
}

@Composable
private fun Marca(texto: String, color: androidx.compose.ui.graphics.Color) {
    Surface(color = color, shape = MaterialTheme.shapes.small) {
        Text(texto, Modifier.padding(horizontal = 6.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun Detalle(ev: Evento, lotengo: Boolean, lodeseo: Boolean, alCerrar: () -> Unit) {
    val ctx = LocalContext.current
    val ambito = rememberCoroutineScope()
    fun abrir(url: String) = ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text(ev.titulo) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                // Steam no reporta bien los free-to-play sin jugar, asi que se puede
                // corregir a mano y la correccion manda sobre la API.
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(
                        checked = lotengo,
                        onCheckedChange = { v -> ambito.launch { Biblioteca.marcarPoseido(ctx, ev.appid, v) } },
                    )
                    Text(if (lotengo) "La tienes" else "No la tienes")
                }
                if (lodeseo) Text("Está en tu lista de deseados", color = MaterialTheme.colorScheme.primary)
                Text("${Tipos.etiqueta(ev.tipo)} · ${Tipos.etiquetaContenido(ev.app_type)}")
                ev.detalle?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
                ev.precio?.let { Text("Precio: $it") }
                ev.vence?.let { Text("Se retira: ${it.take(10)}") }
                Text("Detectado: ${ev.detectado.take(16).replace('T', ' ')}")
                Text("Fuente: ${ev.fuente}")
                Spacer(Modifier.height(8.dp))
                ev.enlaces.allkeyshop?.let {
                    Button(onClick = { abrir(it) }, Modifier.fillMaxWidth()) { Text("Buscar clave en Allkeyshop") }
                }
                ev.enlaces.steam?.let {
                    OutlinedButton(onClick = { abrir(it) }, Modifier.fillMaxWidth()) { Text("Ver en Steam") }
                }
                ev.enlaces.steamdb?.let {
                    OutlinedButton(onClick = { abrir(it) }, Modifier.fillMaxWidth()) { Text("Ver en SteamDB") }
                }
                ev.enlaces.anuncio?.let {
                    OutlinedButton(onClick = { abrir(it) }, Modifier.fillMaxWidth()) { Text("Anuncio del desarrollador") }
                }
            }
        },
        confirmButton = { TextButton(onClick = alCerrar) { Text("Cerrar") } },
    )
}

@Composable
private fun Ajustes() {
    val ctx = LocalContext.current
    val ambito = rememberCoroutineScope()
    val activos by Topics.activos(ctx).collectAsStateWithLifecycle(initialValue = emptySet())
    val config by Biblioteca.config(ctx).collectAsStateWithLifecycle(initialValue = Biblioteca.Config("", "", null))

    var diagnostico by remember { mutableStateOf<String?>(null) }
    var comprobando by remember { mutableStateOf(false) }
    var clave by remember(config.clave) { mutableStateOf(config.clave) }
    var steamId by remember(config.steamId) { mutableStateOf(config.steamId) }
    var estadoSync by remember { mutableStateOf<String?>(null) }
    var sincronizando by remember { mutableStateOf(false) }

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Tu cuenta de Steam", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Sirve para marcar lo que ya tienes y poder ocultarlo. La clave y el ID se " +
                        "guardan solo en este móvil: no se envían a ningún servidor ni al repositorio.",
                    style = MaterialTheme.typography.bodySmall,
                )
                OutlinedTextField(
                    value = steamId,
                    onValueChange = { steamId = it },
                    label = { Text("SteamID64 o nombre del perfil") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = clave,
                    onValueChange = { clave = it },
                    label = { Text("Clave de la API de Steam") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions.Default,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = {
                        sincronizando = true
                        ambito.launch {
                            estadoSync = Biblioteca.sincronizar(ctx, clave, steamId)
                            sincronizando = false
                        }
                    },
                    enabled = !sincronizando,
                ) { Text(if (sincronizando) "Sincronizando…" else "Sincronizar biblioteca") }

                (estadoSync ?: config.sincronizado?.let { "Última sincronización: ${it.take(16).replace('T', ' ')}" })
                    ?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary) }
            }
            HorizontalDivider()

            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Diagnóstico de notificaciones", style = MaterialTheme.typography.titleMedium)
                Text(
                    "Si el feed se actualiza pero no llegan avisos, casi siempre es que el " +
                        "móvil no está suscrito. Esto lo comprueba y lo reintenta.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Button(
                    onClick = {
                        comprobando = true
                        ambito.launch {
                            diagnostico = Topics.diagnostico(ctx)
                            comprobando = false
                        }
                    },
                    enabled = !comprobando,
                ) { Text(if (comprobando) "Comprobando…" else "Comprobar y reintentar") }

                diagnostico?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            HorizontalDivider()

            Text(
                "Qué quieres que te notifique",
                Modifier.padding(16.dp, 16.dp, 16.dp, 4.dp),
                style = MaterialTheme.typography.titleMedium,
            )
        }
        items(Topics.TODOS, key = { it.id }) { t ->
            ListItem(
                headlineContent = { Text(t.etiqueta) },
                supportingContent = { Text(t.descripcion, style = MaterialTheme.typography.bodySmall) },
                trailingContent = {
                    Switch(
                        checked = t.id in activos,
                        onCheckedChange = { v -> ambito.launch { Topics.cambiar(ctx, t.id, v) } },
                    )
                },
            )
            HorizontalDivider()
        }
    }
}
