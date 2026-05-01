# pi-extension-manager

Pi extension inventory and settings manager for vstack-installed packages.

Commands:

- `/extensions` — open the full Extensions manager popup. `All` shows packages by default; selecting a package shows grouped resources/settings in the inspector. Package tabs show that package's overview plus child resources. Use Alt+R to toggle the raw resource list and Alt+A for diagnostics/audit. Tab/Shift+Tab cycles tabs.
- `/extension-settings` — quick inline settings editor for packages that expose vstack settings. The top tab row starts with `All`, then each extension with settings; Tab/Shift+Tab cycles through them. Typing printable characters filters search; Enter toggles booleans/enums or starts editing strings/numbers/paths, then Enter saves and Esc cancels.
- `/settings` — optional vstack settings shell alias when command shadowing is explicitly enabled.

Settings are persisted under `vstack.extensionManager` in Pi `settings.json` files so they do not collide with Pi's own top-level `extensions` array.

Known runtime limitation: Pi does not currently expose a public API to add a native tab to its built-in `/settings` UI or to unload already-loaded extension modules. This package provides a Pi-styled settings shell and edits settings so package/provider enable-disable takes effect after `/reload` or restart where live unloading is not possible. Tool enable-disable is applied live with `pi.setActiveTools()`.
