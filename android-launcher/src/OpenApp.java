package io.github.santos_cabbigat.personalledger.launcher;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;

public final class OpenApp extends Activity {
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        Intent open = new Intent(Intent.ACTION_VIEW, Uri.parse("https://santos-cabbigat.github.io/Personal-Ledger/"));
        open.addCategory(Intent.CATEGORY_BROWSABLE);
        try {
            startActivity(open);
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Install a browser to open Personal Ledger.", Toast.LENGTH_LONG).show();
        } finally {
            finish();
        }
    }
}
