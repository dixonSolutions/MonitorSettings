# Monitor Settings

A GNOME Shell extension that puts **every DDC/CI setting your external monitors support** into Quick Settings: brightness, contrast, color presets, RGB gains, input source, speaker volume, mute, OSD options, factory resets, and anything else the monitor reports.

Nothing is hard-coded per monitor. On startup and on every hot-plug, the extension asks each monitor for its capabilities through [`ddcutil`](https://www.ddcutil.com/). It checks every feature against the MCCS spec (read/write, continuous or list) and builds the right control:

| Monitor reports | You get |
|---|---|
| Continuous read/write feature (brightness, contrast, gains, volume…) | Slider with live value |
| Feature with a list of values (color preset, input source, mute, OSD language…) | Row of selectable chips |
| Write-only reset (restore factory / color / geometry defaults) | Button with click-again confirmation |
| Read-only counters, power-off, protocol plumbing | Hidden |
| Manufacturer-specific codes (0xE0–0xFF) | Hidden unless enabled in preferences |

## Features

- **GNOME's own brightness control drives your monitors.** By default each monitor's DDC/CI brightness is handed to GNOME Shell itself, so the built-in Quick Settings brightness slider, the brightness keys, the OSD, night-light dimming and ambient-light auto-brightness all control the external panels. One global slider; a slider per monitor in its menu. No second brightness slider is added by the extension, and the brightness slider you do see is GNOME's own, in GNOME's own position. Turn it off under *Preferences → Behaviour → Use GNOME's own brightness control* to go back to the extension's own slider; that one is placed in GNOME's brightness slot rather than appended at the bottom.
- **Per-monitor submenu** with every auto-detected control. When brightness is bridged, the remaining features (contrast, color, input, volume, resets, …) are published inside GNOME's brightness menu.
- **Detects ignored writes.** Some monitors accept a command but don't apply it (e.g. brightness locked by an eco, auto/ambient-brightness, low-blue-light or HDR mode). The extension reads the value back, marks the control *locked by monitor* and tells you why, instead of failing silently.
- **Smooth sliders.** Writes are serialized per I²C bus and coalesced, so dragging a slider sends only the latest value.
- **Keyboard shortcuts** with OSD (default `Ctrl+Brightness Up/Down`, configurable). When brightness is bridged, GNOME's own `XF86MonBrightnessUp/Down`/cycle keys work too.
- **Hot-plug aware.** Monitors are rescanned when the display layout changes.
- **Preferences** list every detected monitor and control. Hide anything you don't want, pick which monitors the global slider drives, set the step size, the ddcutil path and extra args.
- Laptop panels keep using GNOME's built-in brightness slider. This extension covers external DDC/CI monitors.

Supports GNOME Shell 49, 50 and 51.

### How the brightness bridge works

GNOME Shell builds its brightness UI from `Meta.Backlight` objects that mutter creates from `/sys/class/backlight`; external monitors have none, and an extension cannot synthesise one. So the extension registers a `BrightnessScale`-shaped object per monitor with `Main.brightnessManager` (`lib/brightness.js`) whose "backlight" is MCCS `0x10` over DDC/CI. From there everything upstream — the Quick Settings slider, keys, OSD, dimming, auto-brightness and the `org.gnome.Shell.Brightness` D-Bus interface — treats the monitor like a laptop panel. Nothing is written to a monitor unless the value actually changes, and disabling the extension hands GNOME back its original state.

Two things to know:

- This hooks `Main.brightnessManager`, which is not public extension API. It is verified against GNOME 49/50/51 behaviour; a future Shell release could change it. If the bridge cannot install, the extension silently falls back to its own slider.
- A monitor is matched to a screen by DRM connector (e.g. `card1-DP-2` → `DP-2`). *Preferences → Advanced → Bridge monitors missing from the display layout* attaches a monitor with no matching output to a free screen; it exists for nested/headless test shells whose only output is virtual, and is off by default.

## Requirements

1. **ddcutil** 2.x
   - Fedora / Silverblue / Bluefin: preinstalled on Bluefin; otherwise `sudo dnf install ddcutil` (or `rpm-ostree install ddcutil`)
   - Debian/Ubuntu: `sudo apt install ddcutil`
   - Arch: `sudo pacman -S ddcutil`
2. **I²C access** for your user. Most distros ship a udev rule with ddcutil. If `ddcutil detect` only works as root:
   ```sh
   sudo modprobe i2c-dev
   echo i2c-dev | sudo tee /etc/modules-load.d/i2c-dev.conf
   sudo usermod -aG i2c $USER   # then log out and back in
   ```
3. **DDC/CI enabled** in the monitor's own on-screen menu (some monitors ship with it off).

Check it works: `ddcutil detect` should list your monitor(s).

## Install

```sh
git clone https://github.com/dixonSolutions/MonitorSettings.git
cd MonitorSettings
make install
```
Then log out and back in (required on Wayland for a newly installed extension) and run:
```sh
gnome-extensions enable monitor-settings@dixonsolutions.github.io
```

If you used *Brightness control using ddcutil* before, disable it to avoid duplicate sliders and shortcut clashes.

## Command-line tool

The same backend can be used from a terminal:
```sh
gjs -m tools/monitor-settings-cli.js list            # monitors and all their controls
gjs -m tools/monitor-settings-cli.js get all 10       # brightness of every monitor
gjs -m tools/monitor-settings-cli.js set all 10 70    # set brightness to 70 on every monitor
gjs -m tools/monitor-settings-cli.js set 2 60 x11     # (codes are hex) switch monitor 2 input
```

## Testing

```sh
make test                   # parser unit tests on recorded ddcutil output (no hardware needed)
make test-hw                # nudges and restores each slider on real monitors, reports ignored ones
tests/run-shell-test.sh     # runs the extension in an isolated headless GNOME Shell, drives
                            # the UI (menus, sliders, chips, shortcuts, hot-plug, disable/enable,
                            # preferences, GNOME-brightness bridge) against the real monitor
```
The headless shell test uses its own D-Bus, dconf, data and cache dirs, so your session isn't affected. Every value it changes is restored.

### Watching it in a nested shell

GNOME 49 removed `gnome-shell --nested`; the supported way to run a nested **visible** shell is mutter's devkit viewer. `tests/run-nested-visible.sh` wraps all of it — it stages the extension with its own data/cache/dconf, fetches the one `mutter-devkit` viewer binary into `~/.local/share/ms-devkit` (no root needed), and opens a real GNOME Shell window on your desktop. Your session, extensions and dconf are untouched.

```sh
tests/run-nested-visible.sh start          # launch, leaves it running
MS_NESTED_HARNESS=1 tests/run-nested-visible.sh reload   # also enable the test harness
tests/run-nested-visible.sh gget org.gnome.shell.extensions.monitor-settings native-brightness
tests/run-nested-visible.sh stop
```

Two things about what you see in that window:

- While it runs, GNOME shows its **screen sharing** indicator in your real panel — that is the devkit viewer streaming the nested shell, and it disappears on `stop`.
- The `eval` and `shot` helpers use D-Bus methods GNOME restricts to unsafe mode. Enable it with `--unsafe` (e.g. `tests/run-nested-visible.sh reload --unsafe`); GNOME then shows its **Unsafe mode** padlock in the nested panel, which is correct. It is off by default, and the extension under test never needs it:

```sh
tests/run-nested-visible.sh reload --unsafe
tests/run-nested-visible.sh eval 'Main.brightnessManager.scales.length'   # inspect the shell
tests/run-nested-visible.sh shot           # screenshot the nested shell
```

Because the nested shell's only output is virtual, start it with `--set brightness-map-unmatched=true` to let it attach your real monitor:

```sh
tests/run-nested-visible.sh start --set debug=true --set brightness-map-unmatched=true
```

Settings passed with `--set` are applied inside the nested session's own dconf, never yours.

## Troubleshooting

- **"locked by monitor"**: the monitor ignored the change. Turn off modes like *Brightness Intelligence / B.I.+*, *Eco*, *Low Blue Light*, *Dynamic Contrast*, *HDR*, or switch the picture mode to *Standard/User* in the monitor's own menu.
- **No monitors found**: check `ddcutil detect` and the I²C permissions above. Displays without DDC/CI (laptop panels, some docks/KVMs) are listed in preferences with the reason.
- **Slow or flaky monitor**: add `--sleep-multiplier 2` (or similar) under *Preferences → Advanced → Extra ddcutil arguments*.
- **Debug**: enable *Debug logging*, then `journalctl --user -f -o cat | grep monitor-settings`.

## License

GPL-3.0-or-later
