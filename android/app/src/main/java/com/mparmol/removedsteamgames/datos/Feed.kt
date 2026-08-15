package com.mparmol.removedsteamgames.datos

import android.content.Context
import com.mparmol.removedsteamgames.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Lectura del feed estatico de GitHub Pages.
 *
 * No hay backend propio ni cuentas: la app solo descarga un JSON publico. Se guarda
 * una copia en disco para que el feed se vea al abrir sin esperar a la red.
 */
object Feed {

    private val json = Json { ignoreUnknownKeys = true }

    private fun cache(ctx: Context) = File(ctx.filesDir, "latest.json")

    /** Devuelve lo cacheado sin tocar la red. Vacio si aun no hay nada. */
    fun cacheado(ctx: Context): List<Evento> = runCatching {
        val f = cache(ctx)
        if (f.exists()) json.decodeFromString<List<Evento>>(f.readText()) else emptyList()
    }.getOrDefault(emptyList())

    /** Descarga el feed y actualiza la cache. Lanza si no hay red. */
    suspend fun descargar(ctx: Context): List<Evento> = withContext(Dispatchers.IO) {
        val url = URL(BuildConfig.FEED_URL + "latest.json")
        val con = (url.openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 20000
            setRequestProperty("Accept", "application/json")
        }
        try {
            if (con.responseCode != 200) error("HTTP ${con.responseCode}")
            val texto = con.inputStream.bufferedReader().readText()
            val eventos = json.decodeFromString<List<Evento>>(texto)
            cache(ctx).writeText(texto)
            eventos
        } finally {
            con.disconnect()
        }
    }
}
