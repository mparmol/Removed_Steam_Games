package com.mparmol.removedsteamgames

import android.app.Application
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.mparmol.removedsteamgames.notif.Canales
import com.mparmol.removedsteamgames.notif.Topics
import com.mparmol.removedsteamgames.trabajo.RefrescoWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

class App : Application() {

    override fun onCreate() {
        super.onCreate()
        Canales.crear(this)

        CoroutineScope(Dispatchers.IO).launch {
            runCatching { Topics.sincronizar(this@App, Topics.activos(this@App).first()) }
        }

        // Red de seguridad: si una notificacion se pierde (push caido, movil apagado),
        // el feed se refresca igualmente cada 6 h.
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "refresco",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<RefrescoWorker>(6, TimeUnit.HOURS)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build(),
        )
    }
}
