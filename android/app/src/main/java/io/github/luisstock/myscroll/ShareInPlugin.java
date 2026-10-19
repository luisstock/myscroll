package io.github.luisstock.myscroll;

import android.content.Intent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * "Share to MyScroll": receives ACTION_SEND text/plain from other apps.
 * JS: Capacitor.Plugins.ShareIn.getPending() -> { text? } (returns and clears a share that arrived before the page
 * was ready) and addListener("share", ({ text }) => ...) for shares that arrive while the app is running.
 * Capacitor calls handleOnNewIntent for the launch intent and for every later one.
 */
@CapacitorPlugin(name = "ShareIn")
public class ShareInPlugin extends Plugin {
    // Static: the text can arrive before the plugin instance is asked for it, and survives an activity recreation.
    private static String pending = null;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = readShare(intent);
        if (text == null) return;
        if (hasListeners("share")) {
            JSObject data = new JSObject();
            data.put("text", text);
            notifyListeners("share", data, true);
        } else {
            pending = text; // no listener yet: the page will ask with getPending()
        }
    }

    /** Returns the shared text of an ACTION_SEND intent and removes it so it is handled only once. */
    private static String readShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/")) return null;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        intent.removeExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return null;
        return text.trim();
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject ret = new JSObject();
        if (pending != null) ret.put("text", pending);
        pending = null;
        call.resolve(ret);
    }
}
