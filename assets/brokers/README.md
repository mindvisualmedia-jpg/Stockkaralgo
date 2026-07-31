# Broker logos

Drop each broker's official logo here and Stockkar renders it as the circular
mark in the broker switcher and the Settings broker pane.

## File names

The file name must match the broker id used by the app:

| Broker        | File                       |
|---------------|----------------------------|
| Dhan          | `dhan.svg`  or `dhan.png`  |
| Zerodha Kite  | `zerodha.svg`              |
| Angel One     | `angelone.svg`             |
| FYERS         | `fyers.svg`                |
| Upstox        | `upstox.svg`               |
| Alice Blue    | `aliceblue.svg`            |

`.svg` is preferred (sharp at any size); `.png` also works. Square artwork
looks best — the app centres it inside a 38px white circle with 6px padding.

## Until you add a file

Nothing breaks. A broker with no logo file falls back to a brand-coloured
monogram tile (D, Z, A, F, …), so the switcher always looks finished.

## Where to get them

Each broker publishes its mark on its own brand/press/media page. Download the
official file from there rather than screenshotting it — you get the correct
colours and a transparent background.

Note that these are the brokers' trademarks. Using them to identify a broker
you connect to is ordinary nominative use, but the files themselves stay
theirs; don't restyle or recolour the artwork.

## Serving

`server.js` exposes them at `/logo/<id>.svg`. The route accepts only
lowercase-alphanumeric ids with an `.svg`/`.png` extension, so it cannot be
used to read anything else from disk.
