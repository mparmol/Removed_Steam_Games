package com.mparmol.removedsteamgames.notif

import android.content.Context
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import com.google.firebase.messaging.FirebaseMessaging
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
    val TODOS = listOf(
        Topic("gratis_activo", "Gratis ahora", "Un juego se puede reclamar gratis para siempre", true),
        Topic("gratis_proximo", "Pronto gratis", "Promocion gratuita ya programada", true),
        Topic("finde_gratis", "Fines de semana gratis", "Jugable gratis durante unos dias", false),
        Topic("retirada_anunciada", "Van a retirarlo", "Aviso previo: ultima oportunidad de comprarlo", true),
        Topic("retirado_game", "Juegos retirados", "Un juego ha dejado de venderse", true),
        Topic("retirado_dlc", "DLC retirado", "Contenido descargable retirado", false),
        Topic("retirado_music", "Bandas sonoras retiradas", "Soundtracks retirados", false),
        Topic("retirado_demo", "Demos retiradas", "Demos retiradas", false),
        Topic("retirado_video", "Vídeos retirados", "Peliculas y vídeos retirados", false),
        Topic("retirado_application", "Software retirado", "Aplicaciones y herramientas retiradas", false),
        Topic("retirado_otro", "Otros retirados", "Resto de contenido retirado", false),
        Topic("resumen", "Resumen agrupado", "Una sola notificacion cada varias horas con lo menos urgente", true),
    )

    private fun clave(id: String) = booleanPreferencesKey("topic_$id")

    fun activos(ctx: Context): Flow<Set<String>> = ctx.ajustes.data.map { prefs ->
        TODOS.filter { prefs[clave(it.id)] ?: it.pordefecto }.map { it.id }.toSet()
    }

    suspend fun cambiar(ctx: Context, id: String, activo: Boolean) {
        ctx.ajustes.edit { it[clave(id)] = activo }
        aplicar(id, activo)
    }

    private suspend fun aplicar(id: String, activo: Boolean) = runCatching {
        val fm = FirebaseMessaging.getInstance()
        if (activo) fm.subscribeToTopic(id).await() else fm.unsubscribeFromTopic(id).await()
    }

    /** Sincroniza las suscripciones con lo guardado. Se llama al arrancar. */
    suspend fun sincronizar(ctx: Context, activos: Set<String>) {
        for (t in TODOS) aplicar(t.id, t.id in activos)
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
        val activos = activos(ctx).first()

        var ok = 0
        val fallos = mutableListOf<String>()
        for (t in TODOS) {
            try {
                if (t.id in activos) fm.subscribeToTopic(t.id).await() else fm.unsubscribeFromTopic(t.id).await()
                ok++
            } catch (e: Exception) {
                fallos.add("${t.id}: ${e.message}")
            }
        }
        buildString {
            append("Token FCM: ${token.take(22)}…\n")
            append("Suscrito a $ok de ${TODOS.size} categorías")
            if (fallos.isNotEmpty()) append("\n\nFallos:\n" + fallos.joinToString("\n"))
        }
    } catch (e: Exception) {
        "NO se pudo obtener el token FCM.\n${e::class.simpleName}: ${e.message}"
    }
}
