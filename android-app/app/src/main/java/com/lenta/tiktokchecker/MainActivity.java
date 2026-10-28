package com.lenta.tiktokchecker;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private static final int FILE_CHOOSER_REQUEST = 2001;
    private WebView webView;
    private FrameLayout root;
    private ValueCallback<Uri[]> filePathCallback;
    private TextView errorView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.rgb(14, 14, 12));
        getWindow().setNavigationBarColor(Color.rgb(14, 14, 12));
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(14, 14, 12));
        setContentView(root);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.rgb(14, 14, 12));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                if ("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme)) {
                    String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
                    String startHost = Uri.parse(BuildConfig.START_URL).getHost();
                    if (startHost != null && (host.equalsIgnoreCase(startHost) || host.endsWith(".vercel.app"))) {
                        return false;
                    }
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (ActivityNotFoundException ignored) {
                        Toast.makeText(MainActivity.this, "Не удалось открыть ссылку", Toast.LENGTH_SHORT).show();
                    }
                    return true;
                }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (errorView != null) {
                    root.removeView(errorView);
                    errorView = null;
                }
                webView.setVisibility(View.VISIBLE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent;
                try {
                    intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "Не удалось открыть выбор файла", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        root.addView(webView, new FrameLayout.LayoutParams(-1, -1));
        if (BuildConfig.START_URL.contains("YOUR-APP")) {
            showSetupMessage();
        } else {
            webView.loadUrl(BuildConfig.START_URL);
        }
    }

    private void showSetupMessage() {
        TextView message = new TextView(this);
        message.setText("Приложение почти готово.\n\nСначала опубликуйте сайт и укажите его HTTPS-адрес при сборке APK.\n\nВ инструкции README-RU.md есть пошаговые действия.");
        message.setTextColor(Color.WHITE);
        message.setTextSize(18);
        message.setGravity(17);
        message.setPadding(32, 32, 32, 32);
        root.addView(message, new FrameLayout.LayoutParams(-1, -1));
    }

    private void showError() {
        if (errorView != null) return;
        webView.setVisibility(View.GONE);
        errorView = new TextView(this);
        errorView.setText("Не удалось загрузить «Лента».\nПроверьте интернет и адрес сайта, затем нажмите здесь для повтора.");
        errorView.setTextColor(Color.WHITE);
        errorView.setTextSize(17);
        errorView.setGravity(17);
        errorView.setPadding(32, 32, 32, 32);
        errorView.setOnClickListener(v -> {
            root.removeView(errorView);
            errorView = null;
            webView.setVisibility(View.VISIBLE);
            webView.loadUrl(BuildConfig.START_URL);
        });
        root.addView(errorView, new FrameLayout.LayoutParams(-1, -1));
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            Uri[] results = null;
            if (resultCode == Activity.RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    results = new Uri[count];
                    for (int i = 0; i < count; i++) results[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    results = new Uri[]{data.getData()};
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
        }
        super.onDestroy();
    }
}
