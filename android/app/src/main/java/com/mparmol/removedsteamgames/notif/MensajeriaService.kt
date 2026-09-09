package com.mparmol.removedsteamgames.notif

import android.app.PendingIntent
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.mparmol.removedsteamgames.MainActivity
import com.mparmol.removedsteamgames.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Construye la notificacion en el cliente a partir del payload de datos, en vez de
 * dejar que la muestre Firebase: asi puede llevar los botones de accion que llevan
 * directos a Steam y a Allkeyshop sin tener que abrir la app.
 */
class MensajeriaService : FirebaseMessagingService() {

    override fun onMessageReceived(mensaje: RemoteMessage) {
        val datos = mensaje.data
        val tipo = datos["tipo"] ?: "resumen"

        // Cinturon y tirantes por si una suscripcion queda desfasada. Usa la MISMA
        // regla que la lista, asi que los preavisos pasan siempre: filtrarlos por tipo
        // de contenido dejaba mudos los "van a retirarlo" de DLC y software.
        if (!Topics.debeNotificar(this, tipo, datos["app_type"])) {
            android.util.Log.i("Mensajeria", "silenciado: $tipo / ${datos["app_type"]}")
            return
        }

        val titulo = mensaje.notification?.title ?: tituloPara(tipo)
        val cuerpo = mensaje.notification?.body ?: datos["nombre"].orEmpty()

        // el canal del resumen es distinto del de los eventos individuales
        val canal = Canales.id(if (tipo == "resumen") "resumen" else canalPara(tipo))

        val abrirApp = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra("evento_id", datos["id"])
            },
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val n = NotificationCompat.Builder(this, canal)
            .setSmallIcon(R.drawable.ic_notificacion)
            .setContentTitle(titulo)
            .setContentText(cuerpo)
            .setStyle(NotificationCompat.BigTextStyle().bigText(cuerpo))
            .setAutoCancel(true)
            .setContentIntent(abrirApp)
            // visible en pantalla de bloqueo sin tener que desbloquear
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setPriority(
                if (tipo == "resumen") NotificationCompat.PRIORITY_DEFAULT
                else NotificationCompat.PRIORITY_HIGH,
            )
            .setCategory(NotificationCompat.CATEGORY_REMINDER)

        // Steam primero; en una retirada lo util de verdad es Allkeyshop, porque
        // Steam ya no te lo vende.
        datos["steam"]?.takeIf { it.isNotBlank() }?.let {
            n.addAction(0, "Steam", enlace(it, 1))
        }
        datos["allkeyshop"]?.takeIf { it.isNotBlank() }?.let {
            n.addAction(0, "Buscar clave", enlace(it, 2))
        }

        val id = (datos["id"] ?: tipo).hashCode()
        runCatching { NotificationManagerCompat.from(this).notify(id, n.build()) }
    }

    private fun enlace(url: String, codigo: Int): PendingIntent = PendingIntent.getActivity(
        this, codigo,
        Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    // `tipo` viaja sin sufijo de contenido, pero el canal se elige por familia
    private fun canalPara(tipo: String) = when {
        tipo.startsWith("retirado") -> "retirado"
        tipo.startsWith("no_comprable") -> "no_comprable"
        else -> tipo
    }

    private fun tituloPara(tipo: String) = when (tipo) {
        "gratis_activo" -> "Gratis para siempre"
        "gratis_proximo" -> "Pronto gratis"
        "finde_gratis" -> "Fin de semana gratis"
        "retirada_anunciada" -> "Van a retirarlo de Steam"
        "no_comprable" -> "Ya no se puede comprar"
        else -> "Retirado de Steam"
    }

    /**
     * Al renovarse el token hay que rehacer las suscripciones a topics.
     *
     * Esto estaba VACIO, con un comentario que decia que Firebase las reaplicaba solo.
     * Cuando no lo hace, el backend sigue publicando, FCM acepta el envio a un topic
     * sin suscriptores sin dar error, y al movil deja de llegar nada: un fallo mudo y
     * permanente hasta el siguiente arranque de la app.
     */
    override fun onNewToken(token: String) {
        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Topics.sincronizar(applicationContext) }
        }
    }
}
