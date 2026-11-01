package ai.testiv.webviewfixture;

import android.app.Activity;
import android.os.Bundle;
import android.webkit.WebView;

/**
 * One WebView showing the bundled page. Web contents debugging is on, as a
 * hybrid app's test build must have it for Appium to switch into the WebView.
 */
public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WebView.setWebContentsDebuggingEnabled(true);
        WebView view = new WebView(this);
        view.getSettings().setJavaScriptEnabled(true);
        setContentView(view);
        view.loadUrl("file:///android_asset/index.html");
    }
}
