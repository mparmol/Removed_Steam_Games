package com.mparmol.removedsteamgames.datos

import android.content.Context
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URLEncoder
import java.net.URL

/**
 * Tu biblioteca y tu lista de deseados de Steam.
 *
 * Todo esto vive SOLO en el movil: la clave de API y el SteamID se guardan en el
 * DataStore local y las llamadas salen desde el propio telefono. Nada de esto pasa
 * por el repositorio, que es publico.
 */
object Biblioteca {

    private val CLAVE = stringPreferencesKey("steam_api_key")
    private val STEAMID = stringPreferencesKey("steam_id")
    private val POSEIDOS = stringSetPreferencesKey("appids_poseidos")
    private val DESEADOS = stringSetPreferencesKey("appids_deseados")
    private val SINCRONIZADO = stringPreferencesKey("sincronizado")

    // Correcciones a mano, por encima de lo que diga la API.
    // Steam no siempre reporta bien los free-to-play, asi que hace falta una salida
    // manual en vez de depender de que la API acierte siempre.
    private val MARCADOS = stringSetPreferencesKey("appids_marcados")
    private val DESMARCADOS = stringSetPreferencesKey("appids_desmarcados")

    data class Config(val clave: String, val steamId: String, val sincronizado: String?)

    fun config(ctx: Context): Flow<Config> = ctx.ajustes.data.map {
        Config(it[CLAVE].orEmpty(), it[STEAMID].orEmpty(), it[SINCRONIZADO])
    }

    /** Lo que la API dice que tienes, mas tus correcciones manuales. */
    fun poseidos(ctx: Context): Flow<Set<Int>> = ctx.ajustes.data.map { p ->
        val api = p[POSEIDOS].orEmpty().mapNotNull { it.toIntOrNull() }
        val mas = p[MARCADOS].orEmpty().mapNotNull { it.toIntOrNull() }
        val menos = p[DESMARCADOS].orEmpty().mapNotNull { it.toIntOrNull() }.toSet()
        (api + mas).toSet() - menos
    }

    /** Corrige a mano si la tienes o no, ganando siempre a lo que diga la API. */
    suspend fun marcarPoseido(ctx: Context, appid: Int, tengo: Boolean) {
        ctx.ajustes.edit { p ->
            val mas = p[MARCADOS].orEmpty().toMutableSet()
            val menos = p[DESMARCADOS].orEmpty().toMutableSet()
            if (tengo) { mas += appid.toString(); menos -= appid.toString() }
            else { menos += appid.toString(); mas -= appid.toString() }
            p[MARCADOS] = mas
            p[DESMARCADOS] = menos
        }
    }

    fun deseados(ctx: Context): Flow<Set<Int>> =
        ctx.ajustes.data.map { p -> p[DESEADOS].orEmpty().mapNotNull { it.toIntOrNull() }.toSet() }

    suspend fun guardarCredenciales(ctx: Context, clave: String, steamId: String) {
        ctx.ajustes.edit {
            it[CLAVE] = clave.trim()
            it[STEAMID] = steamId.trim()
        }
    }

    private fun leer(url: String): JSONObject {
        val con = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 25000
        }
        try {
            if (con.responseCode != 200) error("HTTP ${con.responseCode}")
            return JSONObject(con.inputStream.bufferedReader().readText())
        } finally {
            con.disconnect()
        }
    }

    /** Acepta tanto un SteamID64 como el nombre corto del perfil. */
    private fun resolverId(clave: String, entrada: String): String {
        if (entrada.matches(Regex("\\d{17}"))) return entrada
        val vanity = entrada.substringAfterLast('/').ifBlank { entrada }
        val r = leer(
            "https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/" +
                "?key=$clave&vanityurl=${URLEncoder.encode(vanity, "UTF-8")}",
        ).getJSONObject("response")
        if (r.optInt("success") != 1) error("no se pudo resolver el perfil \"$entrada\"")
        return r.getString("steamid")
    }

    /**
     * Descarga biblioteca y lista de deseados y las cachea.
     * @return mensaje legible con el resultado
     */
    suspend fun sincronizar(ctx: Context, clave: String, entradaId: String): String = withContext(Dispatchers.IO) {
        if (clave.isBlank() || entradaId.isBlank()) return@withContext "Falta la clave de API o el SteamID."
        try {
            val steamId = resolverId(clave, entradaId)

            // include_played_free_games solo trae los F2P que se HAN JUGADO: un juego
            // gratis reclamado y nunca abierto no aparece. include_free_sub anade las
            // licencias gratuitas, que es como se poseen los free-to-play.
            val juegos = leer(
                "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/" +
                    "?key=$clave&steamid=$steamId&include_played_free_games=1" +
                    "&include_free_sub=1&skip_unvetted_apps=0&format=json",
            ).getJSONObject("response")

            if (!juegos.has("games")) {
                return@withContext "El perfil no comparte la lista de juegos.\n" +
                    "En Steam: Perfil → Editar → Privacidad → Detalles del juego: Público."
            }

            val arr = juegos.getJSONArray("games")
            val poseidos = buildSet { for (i in 0 until arr.length()) add(arr.getJSONObject(i).getInt("appid").toString()) }

            // la wishlist es un endpoint aparte y puede no estar disponible
            val deseados = runCatching {
                val w = leer("https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=$steamId")
                    .getJSONObject("response").optJSONArray("items")
                buildSet<String> { if (w != null) for (i in 0 until w.length()) add(w.getJSONObject(i).getInt("appid").toString()) }
            }.getOrDefault(emptySet())

            ctx.ajustes.edit {
                it[CLAVE] = clave.trim()
                it[STEAMID] = steamId
                it[POSEIDOS] = poseidos
                it[DESEADOS] = deseados
                it[SINCRONIZADO] = java.time.Instant.now().toString()
            }
            "Sincronizado: ${poseidos.size} juegos en tu biblioteca" +
                if (deseados.isNotEmpty()) ", ${deseados.size} deseados" else ""
        } catch (e: Exception) {
            "Error: ${e.message}"
        }
    }
}
