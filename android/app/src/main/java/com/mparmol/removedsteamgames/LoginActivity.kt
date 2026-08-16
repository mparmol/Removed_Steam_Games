package com.mparmol.removedsteamgames

import android.annotation.SuppressLint
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity

/**
 * Inicio de sesion de Steam dentro de la app.
 *
 * Es la unica forma de saber de verdad que tienes: la API publica NO devuelve los
 * free-to-play sin jugar (lo dice su propia documentacion) y el XML del perfil pide
 * sesion. Con la cookie se puede llamar a /dynamicstore/userdata/, que es el endpoint
 * que usa la tienda para pintar en verde lo que ya posees.
 *
 * La cookie se queda en el WebView de este movil. No se envia a ningun sitio: las
 * llamadas salen del propio telefono y el repositorio nunca la ve.
 */
class LoginActivity : ComponentActivity() {

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        CookieManager.getInstance().setAcceptCookie(true)

        val web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            // sin esto Steam sirve la version movil, que a veces rompe el login
            settings.userAgentString =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    // steamLoginSecure solo aparece cuando la sesion es valida
                    val cookies = CookieManager.getInstance().getCookie("https://store.steampowered.com") ?: ""
                    if (cookies.contains("steamLoginSecure")) {
                        CookieManager.getInstance().flush()
                        setResult(RESULT_OK)
                        finish()
                    }
                }
            }
        }

        setContentView(web)
        web.loadUrl("https://store.steampowered.com/login/?redir=%2F")
    }
}
