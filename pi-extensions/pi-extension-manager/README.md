# pi-extension-manager

Pi extension inventory and settings manager for vstack-installed packages.

Commands:

- `/extensions` — open the full Extensions manager popup.
- `/extension-settings` — quick inline settings editor for packages that expose vstack settings. Booleans/enums toggle with Enter/Space; strings/numbers/paths edit directly in the popup with Enter/Space or `e`, then Enter saves and Esc cancels.
- `/settings` — vstack settings shell with General, Extensions, and Audit tabs when command shadowing is explicitly enabled.

Settings are persisted under `vstack.extensionManager` in Pi `settings.json` files so they do not collide with Pi's own top-level `extensions` array.

Known runtime limitation: Pi does not currently expose a public API to add a native tab to its built-in `/settings` UI or to unload already-loaded extension modules. This package provides a Pi-styled settings shell and edits settings so package/provider enable-disable takes effect after `/reload` or restart where live unloading is not possible. Tool enable-disable is applied live with `pi.setActiveTools()`.
