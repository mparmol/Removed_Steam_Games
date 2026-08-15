package com.mparmol.removedsteamgames.datos

import kotlinx.serialization.Serializable

/** Un evento tal y como lo publica el backend en feed/latest.json. */
@Serializable
data class Evento(
    val id: String,
    val tipo: String,
    val appid: Int,
    val nombre: String = "",
    val app_type: String = "otro",
    val detectado: String = "",
    val fuente: String = "",
    /** Último precio conocido antes de desaparecer; Steam ya no lo da una vez retirado. */
    val precio: String? = null,
    /** Países donde sigue a la venta, o el extracto del aviso del estudio. */
    val detalle: String? = null,
    val vence: String? = null,
    val enlaces: Enlaces = Enlaces(),
    val confianza: String = "confirmado",
) {
    val titulo: String get() = nombre.ifBlank { "appid $appid" }
}

@Serializable
data class Enlaces(
    val steam: String? = null,
    val steamdb: String? = null,
    val allkeyshop: String? = null,
    val anuncio: String? = null,
)

/** Etiquetas de los tipos de evento, para no repetir cadenas por toda la UI. */
object Tipos {
    const val RETIRADO = "retirado"
    const val ANUNCIADA = "retirada_anunciada"
    const val GRATIS = "gratis_activo"
    const val GRATIS_PROXIMO = "gratis_proximo"
    const val FINDE = "finde_gratis"
    const val REVIVIDO = "revivido"

    /** No comprable aquí pero vivo en otros mercados. Solo feed, nunca notificación. */
    const val REGIONAL = "bloqueo_regional"

    fun etiqueta(tipo: String) = when (tipo) {
        RETIRADO -> "Retirado"
        ANUNCIADA -> "Lo van a retirar"
        GRATIS -> "Gratis"
        GRATIS_PROXIMO -> "Pronto gratis"
        FINDE -> "Finde gratis"
        REVIVIDO -> "Ha vuelto"
        REGIONAL -> "Bloqueado en España"
        else -> tipo
    }

    fun etiquetaContenido(t: String) = when (t) {
        "game" -> "Juego"
        "dlc" -> "DLC"
        "music" -> "Banda sonora"
        "demo" -> "Demo"
        "video" -> "Vídeo"
        "application" -> "Software"
        else -> "Otro"
    }
}
