package com.proxitalk.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

/** Android 13+ secure-origin WebView host with PKCE auth callbacks and opt-in BLE discovery. */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_ASSET_PREFIX = APP_ORIGIN + "/assets/www/";
    private static final String APP_ENTRY_URL = APP_ASSET_PREFIX + "index.html";
    private static final String AUTH_SCHEME = "com.proxitalk.app";
    private static final String AUTH_HOST = "auth";
    private static final String AUTH_PATH = "/callback";
    private static final String AUTH_REDIRECT_URI = AUTH_SCHEME + "://" + AUTH_HOST + AUTH_PATH;
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int BLE_PERMISSION_REQUEST = 2;
    private boolean bleStartPending;

    private WebView webView;
    private ValueCallback<Uri[]> filePathCallback;
    private WebViewAssetLoader assetLoader;
    private boolean pageReady;
    private String pendingAuthUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(false);

        assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleNavigation(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleNavigation(Uri.parse(url));
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                loadPendingAuthUrl();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(android.webkit.PermissionRequest request) {
                // Camera, microphone, and Web Bluetooth permissions are not in this release slice.
                request.deny();
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    callback.onReceiveValue(null);
                    return false;
                }
            }
        });

        // The JavaScript interface is available only to the bundled app origin. External
        // pages are opened outside this WebView and never receive the native BLE controls.
        webView.addJavascriptInterface(new ProxiTalkBridge(), "ProxiTalkNative");
        handleAuthIntent(getIntent());
        webView.loadUrl(APP_ENTRY_URL);
    }

    private boolean handleNavigation(Uri uri) {
        if (APP_ORIGIN.equals(uri.getScheme() + "://" + uri.getAuthority())
                && uri.getPath() != null && uri.getPath().startsWith("/assets/www/")) {
            return false;
        }
        String scheme = uri.getScheme();
        if ("https".equalsIgnoreCase(scheme) || "mailto".equalsIgnoreCase(scheme)) {
            try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); }
            catch (Exception ignored) { /* No installed handler; navigation remains blocked. */ }
        }
        return true;
    }

    private void handleAuthIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return;
        Uri data = intent.getData();
        if (data == null || !AUTH_SCHEME.equals(data.getScheme())
                || !AUTH_HOST.equals(data.getHost()) || !AUTH_PATH.equals(data.getPath())) return;
        String code = data.getQueryParameter("code");
        if (code != null && !code.isEmpty() && code.length() <= 4096) {
            pendingAuthUrl = APP_ENTRY_URL + "?code=" + Uri.encode(code);
        } else {
            String error = data.getQueryParameter("error");
            if (error == null || error.isEmpty() || error.length() > 256) return;
            String description = data.getQueryParameter("error_description");
            pendingAuthUrl = APP_ENTRY_URL + "?error=" + Uri.encode(error)
                    + (description == null ? "" : "&error_description=" + Uri.encode(description.substring(0, Math.min(description.length(), 1024))));
        }
        loadPendingAuthUrl();
    }

    private void loadPendingAuthUrl() {
        if (!pageReady || webView == null || pendingAuthUrl == null) return;
        String callbackUrl = pendingAuthUrl;
        pendingAuthUrl = null;
        webView.post(() -> webView.loadUrl(callbackUrl));
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleAuthIntent(intent);
    }

    private java.util.List<String> missingMeshPermissions() {
        java.util.List<String> missing = new java.util.ArrayList<>();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            for (String permission : new String[]{Manifest.permission.BLUETOOTH_SCAN,
                    Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT}) {
                if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) missing.add(permission);
            }
        } else if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        return missing;
    }

    private boolean hasRequiredMeshPermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.BLUETOOTH_ADVERTISE) == PackageManager.PERMISSION_GRANTED
                    && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestOrStartMesh() {
        java.util.List<String> missing = missingMeshPermissions();
        if (!missing.isEmpty()) {
            bleStartPending = true;
            requestPermissions(missing.toArray(new String[0]), BLE_PERMISSION_REQUEST);
            return;
        }
        launchMeshService();
    }

    private void launchMeshService() {
        Intent intent = new Intent(this, BleMeshService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) startForegroundService(intent);
        else startService(intent);
    }

    private void stopMeshService() {
        bleStartPending = false;
        stopService(new Intent(this, BleMeshService.class));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != BLE_PERMISSION_REQUEST) return;
        boolean start = bleStartPending;
        bleStartPending = false;
        if (!start) return;
        if (hasRequiredMeshPermissions()) launchMeshService();
        else if (webView != null) webView.evaluateJavascript(
                "window.dispatchEvent(new CustomEvent('proxitalk-ble-error',{detail:'Bluetooth permission was not granted'}))", null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getData() != null) results = new Uri[]{data.getData()};
                else if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) results[i] = data.getClipData().getItemAt(i).getUri();
                }
            }
            filePathCallback.onReceiveValue(results);
            filePathCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (filePathCallback != null) filePathCallback.onReceiveValue(null);
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    public final class ProxiTalkBridge {
        @JavascriptInterface
        public String getAuthRedirectUrl() { return AUTH_REDIRECT_URI; }

        @JavascriptInterface
        public String getBleStatus() { return BleMeshService.snapshotJson(); }

        @JavascriptInterface
        public String startBleDiscovery() {
            runOnUiThread(() -> requestOrStartMesh());
            return "{\"ok\":true,\"state\":\"starting\"}";
        }

        @JavascriptInterface
        public String stopBleDiscovery() {
            runOnUiThread(() -> stopMeshService());
            return "{\"ok\":true,\"state\":\"stopping\"}";
        }

        @JavascriptInterface
        public String sendBlePacket(String encryptedPacketJson) {
            return BleMeshService.enqueuePacket(encryptedPacketJson);
        }

        @JavascriptInterface
        public String drainBlePackets() { return BleMeshService.drainInboundPackets(); }
    }
}
