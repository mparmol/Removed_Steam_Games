package com.mparmol.removedsteamgames.notif

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.content.getSystemService

/**
 * Canales separados por tipo, para poder darles sonido e importancia distintos
 * desde los ajustes del sistema. Un juego gratis que caduca en horas no deberia
 * sonar igual que un DLC retirado.
 */
object Canales {

    private val definiciones = listOf(
        Triple("gratis_activo", "Gratis ahora", NotificationManager.IMPORTANCE_HIGH),
        Triple("gratis_proximo", "Pronto gratis", NotificationManager.IMPORTANCE_DEFAULT),
        Triple("finde_gratis", "Fines de semana gratis", NotificationManager.IMPORTANCE_LOW),
        Triple("retirada_anunciada", "Van a retirarlo", NotificationManager.IMPORTANCE_HIGH),
        Triple("retirado", "Retirados", NotificationManager.IMPORTANCE_DEFAULT),
        Triple("revivido", "Han vuelto", NotificationManager.IMPORTANCE_LOW),
        Triple("resumen", "Resumen agrupado", NotificationManager.IMPORTANCE_LOW),
    )

    fun crear(ctx: Context) {
        val nm = ctx.getSystemService<NotificationManager>() ?: return
        for ((id, nombre, importancia) in definiciones) {
            nm.createNotificationChannel(NotificationChannel(id, nombre, importancia))
        }
    }
}
