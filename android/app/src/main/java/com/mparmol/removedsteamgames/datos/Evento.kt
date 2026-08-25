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
    /** Nota estilo SteamDB (porcentaje ponderado por número de reseñas). */
    val nota: Double? = null,
    val resenas: Int = 0,
    /** Días desde el último cambio de la app en Steam. Null si no se pudo fechar. */
    val antiguedad_dias: Int? = null,
    val vence: String? = null,
    val enlaces: Enlaces = Enlaces(),
    val confianza: String = "confirmado",
) {
    val titulo: String get() = nombre.ifBlank { "appid $appid" }

    /** "82% (4.659)" — vacío si el juego no tiene reseñas. */
    val valoracion: String? get() = nota?.let {
        "${it.toInt()}%" + if (resenas > 0) " (${"%,d".format(resenas)})" else ""
    }

    /**
     * Lo que el feed fecha es cuándo lo vimos nosotros, no cuándo pasó. Cuando Steam
     * deja fecharlo se dice, para no vender como novedad algo de hace meses.
     */
    val antiguedad: String? get() = antiguedad_dias?.let {
        when {
            it <= 2 -> null
            it < 30 -> "hace $it días"
            it < 60 -> "hace un mes"
            else -> "hace ${it / 30} meses"
        }
    }
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
    /** Retirado del sistema por falso positivo masivo; solo queda en el archivo viejo. */
    const val REVIVIDO = "revivido"

    /** No comprable aquí pero vivo en otros mercados. Solo feed, nunca notificación. */
    const val REGIONAL = "bloqueo_regional"

    /** La ficha sigue publicada pero no hay forma de comprarlo en ningún mercado. */
    const val NO_COMPRABLE = "no_comprable"

    fun etiqueta(tipo: String) = when (tipo) {
        RETIRADO -> "Retirado"
        ANUNCIADA -> "Lo van a retirar"
        GRATIS -> "Gratis"
        GRATIS_PROXIMO -> "Pronto gratis"
        FINDE -> "Finde gratis"
        REVIVIDO -> "Ha vuelto"
        REGIONAL -> "Bloqueado en España"
        NO_COMPRABLE -> "Ya no se vende"
        else -> tipo
    }

    fun etiquetaContenido(t: String) = when (t) {
        "game" -> "Juego"
        "dlc" -> "DLC"
        "music" -> "Banda sonora"
        "demo" -> "Demo"
        "playtest" -> "Playtest"
        "hardware" -> "Hardware"
        "video" -> "Vídeo"
        "application" -> "Software"
        else -> "Otro"
    }
}
