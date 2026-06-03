# assets/

Optional icons for the system tray app and webui favicon.

## tray.ico / tray.png

The `tray.ps1` app looks for these here. If absent, it falls back to the default Windows app icon (clean, no branding).

To add a custom icon:

1. Save your icon as `assets\tray.ico` (Windows ICO format, 16x16 or 32x32) OR `assets\tray.png` (128x128+ recommended)
2. Restart the tray app — the new icon loads automatically

## favicon.ico

The webui uses `webui\public\favicon.png` by default (managed by Vite). Drop a `favicon.ico` here if you want to override the browser tab icon.
