package com.mparmol.removedsteamgames.notif

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.mparmol.removedsteamgames.MainActivity
import com.mparmol.removedsteamgames.R

/**
 * Notificacion de prueba, local.
 *
 * Usa el MISMO canal, prioridad, visibilidad y botones que una alerta real de
 * retirada. Si no fuese identica no serviria para nada: lo que se quiere comprobar
 * es justo el comportamiento en pantalla bloqueada, que depende de esos ajustes.
 */
object Prueba {

    fun enviar(ctx: Context): String {
        if (!NotificationManagerCompat.from(ctx).areNotificationsEnabled()) {
            return "Las notificaciones están DESACTIVADAS para esta app.\n" +
                "Ajustes de Android → Aplicaciones → Juegos retirados → Notificaciones."
        }

        val abrir = PendingIntent.getActivity(
            ctx, 900,
            Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        fun enlace(url: String, codigo: Int) = PendingIntent.getActivity(
            ctx, codigo,
            Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(ctx, Canales.id("retirada_anunciada"))
            .setSmallIcon(R.drawable.ic_notificacion)
            .setContentTitle("Van a retirarlo de Steam")
            .setContentText("Ejemplo de prueba (49,99€) — última oportunidad para comprarlo")
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText("Esto es una prueba. Una alerta real se ve exactamente así: mismo canal, misma prioridad y los mismos botones."),
            )
            .setAutoCancel(true)
            .setContentIntent(abrir)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .addAction(0, "Steam", enlace("https://store.steampowered.com/app/620/", 901))
            .addAction(0, "Buscar clave", enlace("https://www.allkeyshop.com/blog/products/?search_name=Portal%202", 902))
            .build()

        return try {
            NotificationManagerCompat.from(ctx).notify(9001, n)
            buildString {
                append("Enviada. Bloquea la pantalla ahora para ver cómo se comporta.\n")
                append("Canal: «Van a retirarlo» (importancia alta).\n")
                append(
                    if (Canales.puedeSaltarseDnd(ctx)) "Puede saltarse el modo No molestar."
                    else "NO puede saltarse el modo No molestar: si lo tienes activo, no la verás. " +
                        "Púlsalo en el botón de abajo para permitirlo.",
                )
            }
        } catch (e: SecurityException) {
            "Falta el permiso de notificaciones: ${e.message}"
        }
    }
}
