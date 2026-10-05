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

- **Main brightness slider** in Quick Settings that drives **any selection of monitors** (all by default; toggle each monitor in the slider's menu or in preferences).
- **Per-monitor submenu** with every auto-detected control.
- **Detects ignored writes.** Some monitors accept a command but don't apply it (e.g. brightness locked by an eco, auto/ambient-brightness, low-blue-light or HDR mode). The extension reads the value back, marks the control *locked by monitor* and tells you why, instead of failing silently.
- **Smooth sliders.** Writes are serialized per I²C bus and coalesced, so dragging a slider sends only the latest value.
- **Keyboard shortcuts** with OSD (default `Ctrl+Brightness Up/Down`, configurable).
- **Hot-plug aware.** Monitors are rescanned when the display layout changes.
- **Preferences** list every detected monitor and control. Hide anything you don't want, pick which monitors the main slider drives, set the step size, the ddcutil path and extra args.
- Laptop panels keep using GNOME's built-in brightness slider. This extension covers external DDC/CI monitors.

Supports GNOME Shell 49, 50 and 51.

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
                            # preferences) against the real monitor and saves screenshots
```
The headless shell test uses its own D-Bus, dconf, data and cache dirs, so your session isn't affected. Every value it changes is restored.

## Troubleshooting

- **"locked by monitor"**: the monitor ignored the change. Turn off modes like *Brightness Intelligence / B.I.+*, *Eco*, *Low Blue Light*, *Dynamic Contrast*, *HDR*, or switch the picture mode to *Standard/User* in the monitor's own menu.
- **No monitors found**: check `ddcutil detect` and the I²C permissions above. Displays without DDC/CI (laptop panels, some docks/KVMs) are listed in preferences with the reason.
- **Slow or flaky monitor**: add `--sleep-multiplier 2` (or similar) under *Preferences → Advanced → Extra ddcutil arguments*.
- **Debug**: enable *Debug logging*, then `journalctl --user -f -o cat | grep monitor-settings`.

## License

GPL-3.0-or-later
