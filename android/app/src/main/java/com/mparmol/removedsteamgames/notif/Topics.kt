package com.mparmol.removedsteamgames.notif

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import com.google.firebase.messaging.FirebaseMessaging
import com.mparmol.removedsteamgames.datos.Evento
import com.mparmol.removedsteamgames.datos.ajustes
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.tasks.await

/**
 * El backend publica por topic, no por dispositivo. Desuscribirse de un topic corta
 * el trafico EN ORIGEN: el movil ni siquiera recibe lo que no quiere ver.
 */
data class Topic(val id: String, val etiqueta: String, val descripcion: String, val pordefecto: Boolean)

object Topics {

    /** Interruptores por tipo de suceso. */
    val EVENTOS = listOf(
        Topic("retirada_anunciada", "Van a retirarlo", "Aviso previo: última oportunidad de comprarlo", true),
        Topic("gratis_activo", "Gratis ahora", "Un juego se puede reclamar gratis para siempre", true),
        Topic("gratis_proximo", "Pronto gratis", "Promoción gratuita ya programada", true),
        Topic("finde_gratis", "Fines de semana gratis", "Jugable gratis durante unos días", false),
        Topic("resumen", "Resumen agrupado", "Una sola notificación con lo menos urgente", true),
    )

    /**
     * Interruptores por tipo de CONTENIDO.
     *
     * Antes solo cortaban `retirado_<tipo>`, y el grueso del ruido llega como
     * `no_comprable_<tipo>`, que ademas era un topic plano al que la app ni siquiera
     * se suscribia: apagar "demos" no apagaba nada. Ahora cada contenido gobierna sus
     * dos topics y, sobre todo, tambien FILTRA LA LISTA de la app, que es donde el
     * usuario los seguia viendo.
     */
    val CONTENIDOS = listOf(
        Topic("game", "Juegos", "Juegos completos", true),
        Topic("dlc", "DLC", "Contenido descargable", false),
        Topic("music", "Bandas sonoras", "Soundtracks", false),
        Topic("demo", "Demos", "Demos y versiones de prueba", false),
        Topic("playtest", "Playtests", "Pruebas cerradas, se abren y cierran a diario", false),
        Topic("application", "Software", "Aplicaciones y herramientas", false),
        Topic("video", "Vídeos", "Películas y series", false),
        Topic("otro", "Otros", "Todo lo que Steam no clasifica", false),
    )

    /** Valores de partida, para que la lista no parpadee vacia mientras carga DataStore. */
    val EVENTOS_POR_DEFECTO = EVENTOS.filter { it.pordefecto }.map { it.id }.toSet()
    val CONTENIDOS_POR_DEFECTO = CONTENIDOS.filter { it.pordefecto }.map { it.id }.toSet()

    /** Topics de FCM que gobierna un tipo de contenido. Debe cuadrar con `topicDe` del backend. */
    private fun topicsDe(contenido: String) = listOf("retirado_$contenido", "no_comprable_$contenido")

    private val TODOS_LOS_TOPICS = EVENTOS.map { it.id } + CONTENIDOS.flatMap { topicsDe(it.id) }

    private fun claveEvento(id: String) = booleanPreferencesKey("topic_$id")
    private fun claveContenido(id: String) = booleanPreferencesKey("contenido_$id")

    fun eventosActivos(ctx: Context): Flow<Set<String>> = ctx.ajustes.data.map { prefs ->
        EVENTOS.filter { prefs[claveEvento(it.id)] ?: it.pordefecto }.map { it.id }.toSet()
    }

    fun contenidosActivos(ctx: Context): Flow<Set<String>> = ctx.ajustes.data.map { prefs ->
        CONTENIDOS.filter { prefs[claveContenido(it.id)] ?: it.pordefecto }.map { it.id }.toSet()
    }

    suspend fun cambiarEvento(ctx: Context, id: String, activo: Boolean) {
        ctx.ajustes.edit { it[claveEvento(id)] = activo }
        aplicar(id, activo)
    }

    suspend fun cambiarContenido(ctx: Context, id: String, activo: Boolean) {
        ctx.ajustes.edit { it[claveContenido(id)] = activo }
        for (t in topicsDe(id)) aplicar(t, activo)
    }

    /**
     * ¿Debe verse este evento en la lista?
     *
     * Silenciar algo tiene que quitarlo tambien del feed: cortar solo la notificacion
     * dejaba la pantalla igual de llena de demos y de DLC.
     */
    fun visible(ev: Evento, eventos: Set<String>, contenidos: Set<String>): Boolean = when (ev.tipo) {
        // "ha vuelto a Steam" se retiro del sistema; quedan los del archivo antiguo
        "revivido" -> false
        "retirado", "no_comprable", "bloqueo_regional" -> ev.app_type in contenidos
        // un tipo que no conozcamos se muestra: mejor de mas que perderse algo nuevo
        else -> EVENTOS.none { it.id == ev.tipo } || ev.tipo in eventos
    }

    private suspend fun aplicar(topic: String, activo: Boolean) = runCatching {
        val fm = FirebaseMessaging.getInstance()
        if (activo) fm.subscribeToTopic(topic).await() else fm.unsubscribeFromTopic(topic).await()
    }

    /** Sincroniza las suscripciones con lo guardado. Se llama al arrancar. */
    suspend fun sincronizar(ctx: Context) {
        val eventos = eventosActivos(ctx).first()
        val contenidos = contenidosActivos(ctx).first()
        for (t in EVENTOS) aplicar(t.id, t.id in eventos)
        for (c in CONTENIDOS) for (t in topicsDe(c.id)) aplicar(t, c.id in contenidos)
    }

    /**
     * Vuelve a suscribir y DEVUELVE lo que ha pasado.
     *
     * `aplicar` traga los errores para no romper el arranque, lo cual deja ciego al
     * usuario si la suscripcion falla: el backend envia, FCM acepta el envio a un
     * topic sin suscriptores sin dar error, y al movil no llega nada. Esto lo destapa.
     */
    suspend fun diagnostico(ctx: Context): String = try {
        val fm = FirebaseMessaging.getInstance()
        val token = fm.token.await()
        val eventos = eventosActivos(ctx).first()
        val contenidos = contenidosActivos(ctx).first()

        val quiero = eventos + contenidos.flatMap { topicsDe(it) }
        var ok = 0
        val fallos = mutableListOf<String>()
        for (t in TODOS_LOS_TOPICS) {
            try {
                if (t in quiero) fm.subscribeToTopic(t).await() else fm.unsubscribeFromTopic(t).await()
                ok++
            } catch (e: Exception) {
                fallos.add("$t: ${e.message}")
            }
        }
        buildString {
            append("Token FCM: ${token.take(22)}…\n")
            append("Suscripciones al día: $ok de ${TODOS_LOS_TOPICS.size} (${quiero.size} activas)")
            if (fallos.isNotEmpty()) append("\n\nFallos:\n" + fallos.joinToString("\n"))
        }
    } catch (e: Exception) {
        "NO se pudo obtener el token FCM.\n${e::class.simpleName}: ${e.message}"
    }
}
