package com.mparmol.removedsteamgames.notif

import android.app.Notification
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

    /**
     * Generacion de los canales.
     *
     * Android NO deja modificar un canal ya creado (protege lo que haya configurado
     * el usuario), asi que cambiar importancia o visibilidad obliga a estrenar id.
     * Subir este sufijo aplica los ajustes nuevos sin tener que desinstalar la app.
     */
    private const val GEN = "_v2"

    fun id(base: String) = base + GEN

    // base, nombre, importancia, salta el No molestar
    private data class Def(val base: String, val nombre: String, val importancia: Int, val saltaDnd: Boolean)

    private val definiciones = listOf(
        Def("gratis_activo", "Gratis ahora", NotificationManager.IMPORTANCE_HIGH, true),
        Def("gratis_proximo", "Pronto gratis", NotificationManager.IMPORTANCE_DEFAULT, false),
        Def("finde_gratis", "Fines de semana gratis", NotificationManager.IMPORTANCE_LOW, false),
        Def("retirada_anunciada", "Van a retirarlo", NotificationManager.IMPORTANCE_HIGH, true),
        Def("retirado", "Retirados", NotificationManager.IMPORTANCE_DEFAULT, false),
        Def("revivido", "Han vuelto", NotificationManager.IMPORTANCE_LOW, false),
        Def("resumen", "Resumen agrupado", NotificationManager.IMPORTANCE_DEFAULT, false),
    )

    fun crear(ctx: Context) {
        val nm = ctx.getSystemService<NotificationManager>() ?: return

        for (d in definiciones) {
            // fuera la generacion anterior, que ya no se puede reconfigurar
            runCatching { nm.deleteNotificationChannel(d.base) }

            val canal = NotificationChannel(id(d.base), d.nombre, d.importancia).apply {
                // Que el contenido se lea en la pantalla de bloqueo sin desbloquear:
                // de nada sirve enterarse de que quedan horas si hay que abrir el movil.
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                enableVibration(d.importancia >= NotificationManager.IMPORTANCE_DEFAULT)
                setShowBadge(true)
                // Solo lo urgente pide saltarse el No molestar, y Android unicamente lo
                // concede si el usuario da acceso a la politica de notificaciones.
                setBypassDnd(d.saltaDnd)
            }
            nm.createNotificationChannel(canal)
        }
    }

    /** ¿Nos ha dado el usuario permiso para saltarnos el No molestar? */
    fun puedeSaltarseDnd(ctx: Context): Boolean =
        ctx.getSystemService<NotificationManager>()?.isNotificationPolicyAccessGranted == true
}
