package com.pieces.android.companion;

import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * Quick Settings kill switch for typed-text summaries (A5-1 Section 4.9).
 * Bound to TypedTextGate.on; tap toggles on/off.
 */
public class TypedTextTileService extends TileService {

    @Override
    public void onStartListening() {
        super.onStartListening();
        updateTile();
    }

    @Override
    public void onClick() {
        super.onClick();
        if (TypedTextGate.isOn()) {
            TypedTextGate.turnOff(this);
        } else {
            TypedTextGate.turnOn(this);
        }
        updateTile();
    }

    private void updateTile() {
        Tile tile = getQsTile();
        if (tile == null) return;
        boolean on = TypedTextGate.isOn();
        tile.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        tile.setLabel("Typed text");
        tile.updateTile();
    }
}
