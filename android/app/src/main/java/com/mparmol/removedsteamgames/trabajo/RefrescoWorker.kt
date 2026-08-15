package com.mparmol.removedsteamgames.trabajo

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.mparmol.removedsteamgames.datos.Feed

/** Descarga periodica del feed por si el push no llega. */
class RefrescoWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result =
        runCatching { Feed.descargar(applicationContext) }
            .fold({ Result.success() }, { Result.retry() })
}
