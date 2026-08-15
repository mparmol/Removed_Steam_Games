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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.mparmol.removedsteamgames.datos.Evento
import com.mparmol.removedsteamgames.datos.Feed
import com.mparmol.removedsteamgames.datos.Tipos
import com.mparmol.removedsteamgames.notif.Topics
import kotlinx.coroutines.launch

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
    var filtro by remember { mutableStateOf<String?>(null) }
    var seleccionado by remember { mutableStateOf<Evento?>(null) }
    var enAjustes by remember { mutableStateOf(false) }

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
                    if (!enAjustes) {
                        TextButton(onClick = { refrescar() }, enabled = !cargando) { Text("Actualizar") }
                    }
                    TextButton(onClick = { enAjustes = !enAjustes }) { Text(if (enAjustes) "Volver" else "Ajustes") }
                },
            )
        },
    ) { pad ->
        Box(Modifier.padding(pad)) {
            when {
                enAjustes -> Ajustes()
                else -> Listado(
                    eventos = eventos,
                    filtro = filtro,
                    cargando = cargando,
                    error = error,
                    alFiltrar = { filtro = if (filtro == it) null else it },
                    alPulsar = { seleccionado = it },
                )
            }
        }
    }

    seleccionado?.let { ev ->
        Detalle(ev) { seleccionado = null }
    }
}

@Composable
private fun Listado(
    eventos: List<Evento>,
    filtro: String?,
    cargando: Boolean,
    error: String?,
    alFiltrar: (String) -> Unit,
    alPulsar: (Evento) -> Unit,
) {
    val visibles = remember(eventos, filtro) {
        if (filtro == null) eventos else eventos.filter { it.tipo == filtro }
    }
    val tiposPresentes = remember(eventos) { eventos.map { it.tipo }.distinct() }

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

        Row(
            Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            tiposPresentes.forEach { t ->
                FilterChip(
                    selected = filtro == t,
                    onClick = { alFiltrar(t) },
                    label = { Text(Tipos.etiqueta(t)) },
                )
            }
        }

        if (visibles.isEmpty()) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(if (cargando) "Cargando…" else "Nada por aquí todavía")
            }
        } else {
            LazyColumn(Modifier.fillMaxSize()) {
                items(visibles, key = { it.id }) { ev ->
                    Fila(ev, alPulsar)
                    HorizontalDivider()
                }
            }
        }
    }
}

@Composable
private fun Fila(ev: Evento, alPulsar: (Evento) -> Unit) {
    ListItem(
        headlineContent = { Text(ev.titulo, fontWeight = FontWeight.Medium) },
        supportingContent = {
            val precio = ev.precio?.let { " · $it" } ?: ""
            val extra = ev.vence?.let { " · vence ${it.take(16).replace('T', ' ')}" } ?: ""
            Text("${Tipos.etiqueta(ev.tipo)} · ${Tipos.etiquetaContenido(ev.app_type)}$precio$extra")
        },
        overlineContent = { Text(ev.detectado.take(16).replace('T', ' ')) },
        modifier = Modifier.clickable { alPulsar(ev) },
    )
}

@Composable
private fun Detalle(ev: Evento, alCerrar: () -> Unit) {
    val ctx = LocalContext.current
    fun abrir(url: String) = ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))

    AlertDialog(
        onDismissRequest = alCerrar,
        title = { Text(ev.titulo) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text("${Tipos.etiqueta(ev.tipo)} · ${Tipos.etiquetaContenido(ev.app_type)}")
                Text("Detectado: ${ev.detectado.take(16).replace('T', ' ')}")
                Text("Fuente: ${ev.fuente}")
                ev.vence?.let { Text("Vence: ${it.take(16).replace('T', ' ')}") }
                Spacer(Modifier.height(8.dp))
                // En una retirada este es el enlace util: Steam ya no te lo vende.
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

    LazyColumn(Modifier.fillMaxSize()) {
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
