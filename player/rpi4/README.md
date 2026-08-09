# Format Player — Raspberry Pi 4B

This turns a Pi 4B running Raspberry Pi OS Bookworm Desktop into a dedicated
Format touchscreen player. Music remains on the Format gateway. Chromium
streams it over the LAN and sends audio to the Pi's default ALSA/PipeWire DAC.

## Pi preparation

- Raspberry Pi OS Bookworm Desktop, 64-bit
- wired Ethernet recommended
- supported USB Audio Class DAC or Pi 4-compatible I2S DAC HAT
- disable the DAC's software volume if the amplifier is handling volume

Copy this directory to the Pi, then run as the normal desktop user:

```bash
chmod +x install.sh
./install.sh http://192.168.68.60:4534/#library
```

Select the DAC as Raspberry Pi OS's default audio output. Verify it before
starting Format:

```bash
speaker-test -c 2 -t wav
```

Reboot. Format starts full-screen after the desktop session starts. Press
`Alt+F4` from an attached keyboard to leave kiosk mode.

Configuration is stored in `~/.config/signal-player/player.env`. Set
`SIGNAL_AUDIO_SINK_MATCH` to part of the PipeWire DAC name if the Pi changes
back to HDMI after reboots.

## Current playback model

Playback occurs on the Pi inside Chromium, so the DAC is local to the Pi and
the gateway only serves audio. The queue belongs to this touchscreen session.
A later shared-player service is required if other phones or browsers must
control the same live queue and playback position.
