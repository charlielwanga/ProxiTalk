package com.proxitalk.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * ProxiTalk Android host.
 * Loads the bundled web app from assets/www and exposes a JS bridge
 * (window.ProxiTalkNative) for the future native BLE mesh layer.
 */
public class MainActivity extends Activity {

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webView = new WebView(this);
        setContentView(webView);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);

        webView.setWebViewClient(new WebViewClient());
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                request.grant(request.getResources());
            }
            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> cb,
                                             WebChromeClient.FileChooserParams params) {
                filePathCallback = cb;
                try {
                    Intent intent = params.createIntent();
                    startActivityForResult(intent, 1);
                } catch (Exception e) {
                    cb.onReceiveValue(null);
                    return false;
                }
                return true;
            }
        });

        // JS bridge for native BLE mesh (to be implemented)
        webView.addJavascriptInterface(new MeshBridge(), "ProxiTalkNative");

        webView.loadUrl("file:///android_asset/www/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == 1 && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                results = new Uri[]{ data.getData() };
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    /** Bridge stub — native BLE mesh plugs in here. */
    public class MeshBridge {
        @android.webkit.JavascriptInterface
        public void sendPacket(String json) {
            // TODO: advertise/send via BluetoothLeAdvertiser + GATT server
            // Packet format: { id, ttl, path, toName, cipher, type }
        }
        @android.webkit.JavascriptInterface
        public String getDeviceId() {
            return android.provider.Settings.Secure.getString(getContentResolver(),
                    android.provider.Settings.Secure.ANDROID_ID);
        }
    }
}
