package io.github.luisstock.myscroll;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins must be registered before the bridge is created in super.onCreate.
        registerPlugin(ShareInPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        // singleTask: a share into the running app arrives here; keep it as the current intent.
        // BridgeActivity.onNewIntent hands it to the plugins (ShareInPlugin.handleOnNewIntent).
        setIntent(intent);
        super.onNewIntent(intent);
    }
}
