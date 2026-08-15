package com.mparmol.removedsteamgames.datos

import android.content.Context
import androidx.datastore.preferences.preferencesDataStore

/**
 * Un unico DataStore para toda la app.
 *
 * Declarar el delegate dos veces sobre el mismo fichero revienta en tiempo de
 * ejecucion ("There are multiple DataStores active for the same file"), asi que vive
 * aqui y lo importan todos.
 */
val Context.ajustes by preferencesDataStore("ajustes")
