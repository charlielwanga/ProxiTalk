package com.proxitalk.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
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

/** Android 13+ secure-origin WebView host; no Bluetooth packet transport is implemented yet. */
public class MainActivity extends Activity {

    private static final String APP_ORIGIN = "https://appassets.androidplatform.net";
    private static final String APP_ASSET_PREFIX = APP_ORIGIN + "/assets/www/";
    private static final String APP_ENTRY_URL = APP_ASSET_PREFIX + "index.html";
    private static final String AUTH_SCHEME = "com.proxitalk.app";
    private static final String AUTH_HOST = "auth";
    private static final String AUTH_PATH = "/callback";
    private static final String AUTH_REDIRECT_URI = AUTH_SCHEME + "://" + AUTH_HOST + AUTH_PATH;
    private static final int FILE_CHOOSER_REQUEST = 1;

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

        // The only JavaScript interface method returns a fixed redirect URI. The page is
        // served from the bundled, HTTPS-like WebViewAssetLoader origin; external pages are
        // opened outside this WebView and never receive this interface.
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
        if (code == null || code.isEmpty() || code.length() > 4096) return;
        pendingAuthUrl = APP_ENTRY_URL + "?code=" + Uri.encode(code);
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
    }
}
